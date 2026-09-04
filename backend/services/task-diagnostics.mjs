const DEFAULT_STALE_AFTER_MS = 90_000;
const DEFAULT_QUEUE_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_PROGRESS_STALE_AFTER_MS = 15 * 60_000;
const RESOURCE_BLOCKING_TYPES = new Set([
  "history-backfill",
  "pit-enrichment",
  "corporate-action-backfill",
  "cn-corporate-action-backfill",
  "backtest",
  "historical-backtest-symbol",
  "factor-lab",
  "factor-research",
  "factor-evolution",
  "model-report",
]);

function timestampMs(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkpointSummary(job = {}) {
  const detail = job.detail && typeof job.detail === "object" ? job.detail : {};
  const checkpoints = job.checkpoints && typeof job.checkpoints === "object" ? job.checkpoints : {};
  const foldKeys = Object.keys(checkpoints).filter((key) => /^fold[-_]?\d+$/i.test(key));
  const completedFromCheckpoints = foldKeys.filter((key) => checkpoints[key]?.completedAt).length;
  const completed = numberOrNull(detail.completedFoldCheckpoints) ?? (foldKeys.length ? completedFromCheckpoints : null);
  const expected = numberOrNull(detail.expectedFoldCheckpoints) ?? numberOrNull(detail.foldCount);
  const phaseCompleted = numberOrNull(detail.completed);
  const phaseExpected = numberOrNull(detail.total);
  const lastCheckpointAt = Object.values(checkpoints)
    .map((value) => timestampMs(value?.completedAt))
    .filter((value) => value !== null)
    .sort((left, right) => right - left)[0] || null;
  return {
    completed: completed === null ? null : Math.max(0, completed),
    expected: expected === null ? null : Math.max(0, expected),
    remaining: completed !== null && expected !== null ? Math.max(0, expected - completed) : null,
    phaseCompleted,
    phaseExpected,
    phaseRemaining: phaseCompleted !== null && phaseExpected !== null ? Math.max(0, phaseExpected - phaseCompleted) : null,
    lastCheckpointAt: lastCheckpointAt ? new Date(lastCheckpointAt).toISOString() : null,
    phase: detail.phase || null,
  };
}

function classifyTaskHealth(job = {}, options = {}) {
  const now = Number(options.now ?? Date.now());
  const staleAfterMs = Math.max(10_000, Number(options.staleAfterMs || DEFAULT_STALE_AFTER_MS));
  const queueStaleAfterMs = Math.max(staleAfterMs, Number(options.queueStaleAfterMs || DEFAULT_QUEUE_STALE_AFTER_MS));
  const progressStaleAfterMs = Math.max(staleAfterMs, Number(options.progressStaleAfterMs || DEFAULT_PROGRESS_STALE_AFTER_MS));
  const status = String(job.status || "unknown");
  const heartbeatAtMs = timestampMs(job.heartbeatAt || job.updatedAt || job.createdAt);
  // Do not fall back to updatedAt here: the job manager updates updatedAt on
  // every heartbeat. That would make a live process look as if its actual
  // percentage/checkpoint progress had advanced.
  const progressAtMs = timestampMs(job.progressAt || job.progressUpdatedAt);
  const createdAtMs = timestampMs(job.createdAt);
  const heartbeatAgeMs = heartbeatAtMs === null ? null : Math.max(0, now - heartbeatAtMs);
  const progressAgeMs = progressAtMs === null ? null : Math.max(0, now - progressAtMs);
  const queueAgeMs = createdAtMs === null ? null : Math.max(0, now - createdAtMs);
  const activeBlockers = Array.isArray(options.activeBlockers) ? options.activeBlockers : [];
  const checkpoint = checkpointSummary(job);

  let state = status;
  let health = "unknown";
  let isStalled = false;
  let needsDiagnosis = false;
  let reason = null;
  let recommendation = null;

  // A supervisor can intentionally pause after a failed evidence gate. This is
  // not a worker stall and should not look like an abandoned queue item.
  if (job.supervisorState === "rework_scheduled") {
    state = "queued";
    health = "awaiting-manual-rework";
    reason = job.detail?.nextActionAt
      ? "返工已排程，等待资源释放"
      : "本轮未通过，等待新增数据或手动启动返工";
    recommendation = "不要无改变地重复训练；补充数据或改变标签/特征假设后再启动返工。";
    return {
      state,
      health,
      isStalled,
      heartbeatAt: heartbeatAtMs === null ? null : new Date(heartbeatAtMs).toISOString(),
      heartbeatAgeMs,
      progressAt: progressAtMs === null ? null : new Date(progressAtMs).toISOString(),
      progressAgeMs,
      queueAgeMs,
      hasFreshHeartbeat: heartbeatAgeMs !== null && heartbeatAgeMs <= staleAfterMs,
      hasRecentProgress: progressAgeMs !== null && progressAgeMs <= progressStaleAfterMs,
      needsDiagnosis,
      stagnation: job.stagnation || null,
      reason,
      recommendation,
      checkpoint,
    };
  }

  if (status === "running") {
    if (heartbeatAgeMs === null || heartbeatAgeMs > staleAfterMs) {
      state = "stalled";
      health = "stalled-no-heartbeat";
      isStalled = true;
      reason = heartbeatAgeMs === null ? "没有可用心跳时间" : `心跳已 ${Math.round(heartbeatAgeMs / 1000)} 秒未更新`;
      recommendation = "检查后台 Worker、任务日志和进程资源；不要直接重复提交相同训练。";
    } else if (job.stagnation && !job.stagnation.resolvedAt) {
      state = "running";
      health = "running-needs-diagnosis";
      needsDiagnosis = true;
      reason = `心跳正常，但实质进度已 ${Math.round((progressAgeMs || 0) / 60_000)} 分钟未变化`;
      recommendation = `先拆解${job.stagnation.category || "任务"}阻塞并查看当前阶段，不要重复提交相同签名或立即重启。`;
    } else if (progressAgeMs !== null && progressAgeMs > progressStaleAfterMs) {
      state = "running";
      health = "running-no-recent-progress";
      reason = `心跳正常，但实际进度已 ${Math.round(progressAgeMs / 60_000)} 分钟未变化`;
      recommendation = "任务仍在运行；先观察 Worker 是否持续占用 CPU，只有心跳也停止才判定为卡顿。";
    } else {
      state = "running";
      health = "healthy-running";
      recommendation = "任务正在运行，等待下一阶段或折级检查点。";
    }
  } else if (status === "queued") {
    const hasBlocker = activeBlockers.length > 0;
    if (!hasBlocker && (queueAgeMs === null || queueAgeMs > queueStaleAfterMs)) {
      state = "stalled";
      health = "stalled-queue-no-capacity";
      isStalled = true;
      reason = "任务长时间排队，但没有发现正在占用同类资源的任务";
      recommendation = "检查任务调度器和后台资源容量；必要时取消重复任务后重新调度。";
    } else {
      state = "queued";
      health = hasBlocker ? "queued-resource-wait" : "queued";
      reason = hasBlocker ? `等待 ${activeBlockers.length} 个重型任务释放资源` : "等待后台资源";
      recommendation = "无需重复提交；任务会在当前重型任务完成后自动推进。";
    }
  } else if (status === "complete") {
    state = "complete";
    health = "completed";
    recommendation = "任务已完成，可查看结果和验收结论。";
  } else if (status === "failed") {
    state = "failed";
    health = "failed";
    reason = job.error || job.failureCategory || "任务失败";
    recommendation = "先按失败类别修复或恢复检查点，不要无改变地重复相同参数。";
  } else if (status === "cancelled") {
    state = "cancelled";
    health = "cancelled";
    reason = job.error || "任务已取消";
    recommendation = "如需继续，请从已有检查点创建可恢复的新尝试。";
  }

  return {
    state,
    health,
    isStalled,
    heartbeatAt: heartbeatAtMs === null ? null : new Date(heartbeatAtMs).toISOString(),
    heartbeatAgeMs,
    progressAt: progressAtMs === null ? null : new Date(progressAtMs).toISOString(),
    progressAgeMs,
    queueAgeMs,
    hasFreshHeartbeat: heartbeatAgeMs !== null && heartbeatAgeMs <= staleAfterMs,
    hasRecentProgress: progressAgeMs !== null && progressAgeMs <= progressStaleAfterMs,
    needsDiagnosis,
    stagnation: job.stagnation || null,
    reason,
    recommendation,
    checkpoint,
  };
}

function buildTaskDiagnostics(jobs = [], options = {}) {
  const now = Number(options.now ?? Date.now());
  const staleAfterMs = Math.max(10_000, Number(options.staleAfterMs || DEFAULT_STALE_AFTER_MS));
  const queueStaleAfterMs = Math.max(staleAfterMs, Number(options.queueStaleAfterMs || DEFAULT_QUEUE_STALE_AFTER_MS));
  const progressStaleAfterMs = Math.max(staleAfterMs, Number(options.progressStaleAfterMs || DEFAULT_PROGRESS_STALE_AFTER_MS));
  const running = jobs.filter((job) => job.status === "running");
  // The job manager has a shared heavy-worker lane for both data enrichment
  // and research. Treating only research jobs as blockers makes a normal PIT
  // or history queue look stalled even while the shared lane is healthy.
  const blockers = running.filter((job) => RESOURCE_BLOCKING_TYPES.has(job.type));
  const rows = jobs.map((job) => {
    const diagnostic = classifyTaskHealth(job, { now, staleAfterMs, queueStaleAfterMs, progressStaleAfterMs, activeBlockers: blockers.filter((item) => item.id !== job.id) });
    return {
      id: job.id,
      type: job.type,
      market: job.market || null,
      status: job.status,
      progress: numberOrNull(job.progress),
      phase: diagnostic.checkpoint.phase || job.detail?.phase || null,
      detail: job.detail || null,
      attempt: job.attempt ?? null,
      maxAttempts: job.maxAttempts ?? null,
      createdAt: job.createdAt || null,
      startedAt: job.startedAt || null,
      updatedAt: job.updatedAt || null,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      failureCategory: job.failureCategory || null,
      ...diagnostic,
    };
  });
  const count = (predicate) => rows.filter(predicate).length;
  const sortRank = (row) => row.state === "stalled" ? 0 : row.state === "running" ? 1 : row.state === "queued" ? 2 : 3;
  rows.sort((left, right) => sortRank(left) - sortRank(right)
    || (right.progressAgeMs || 0) - (left.progressAgeMs || 0)
    || String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  return {
    schema: "task-diagnostics.v1",
    checkedAt: new Date(now).toISOString(),
    policy: {
      staleAfterMs,
      queueStaleAfterMs,
      progressStaleAfterMs,
      note: "心跳用于判断任务是否仍活着，实质进度用于判断是否停滞；长时间没有新检查点不等于进程已卡死，只有超过停滞阈值才进入诊断。",
    },
    summary: {
      total: rows.length,
      running: count((row) => row.state === "running"),
      diagnosisPending: count((row) => row.needsDiagnosis === true),
      stalled: count((row) => row.state === "stalled"),
      queued: count((row) => row.state === "queued"),
      complete: count((row) => row.state === "complete"),
      failed: count((row) => row.state === "failed"),
      cancelled: count((row) => row.state === "cancelled"),
    },
    runtime: options.runtime || null,
    jobs: rows,
  };
}

export { buildTaskDiagnostics, checkpointSummary, classifyTaskHealth };
