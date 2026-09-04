const MARKET_LABELS = Object.freeze({ ASX: "ASX", US: "US", CN: "A股" });
const FAMILY_ICONS = Object.freeze({
  calibration: "sliders-horizontal",
  factor: "flask-conical",
  alpha: "sparkles",
  intraday: "chart-candlestick",
  adaptive: "route",
  agent: "bot",
});

const state = {
  status: null,
  trajectoriesByMarket: {},
  market: "ASX",
  selectedFamily: null,
  selectedEventKey: null,
  eventFilter: "all",
  auditFamily: "all",
  view: "models",
  busy: false,
  chartHitTargets: [],
  refreshController: null,
  lastTrajectoryFetchAt: 0,
  statusDetailed: false,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactNumber(value) {
  const number = finiteNumber(value);
  if (number === null) return "--";
  return new Intl.NumberFormat("zh-CN", { notation: number >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
}

function formatMetric(value, unit = "", digits = 1) {
  const number = finiteNumber(value);
  if (number === null) return "--";
  return `${number.toFixed(digits)}${unit}`;
}

function formatTime(value, options = {}) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(options.full ? { year: "numeric", second: "2-digit" } : {}),
  });
}

function formatMinutes(milliseconds) {
  const minutes = Math.round(Number(milliseconds || 0) / 60000);
  return `${minutes || 0} 分钟`;
}

function eventKey(event) {
  return `${event?.family || "model"}|${event?.id || "event"}|${event?.createdAt || "time"}`;
}

function statusPill(text, tone = "") {
  return `<span class="status-pill ${escapeHtml(tone)}">${escapeHtml(text)}</span>`;
}

function refreshIcons() {
  if (!window.lucide?.createIcons) return;
  window.lucide.createIcons({ attrs: { "stroke-width": 1.7 } });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function currentTrajectory() {
  return state.trajectoriesByMarket[state.market] || null;
}

function currentFamily() {
  const trajectory = currentTrajectory();
  if (!trajectory?.families?.length) return null;
  return trajectory.families.find((family) => family.id === state.selectedFamily) || trajectory.families[0];
}

function currentEvent() {
  const family = currentFamily();
  if (!family?.events?.length) return null;
  return family.events.find((event) => eventKey(event) === state.selectedEventKey) || family.events[0];
}

function setBusy(busy) {
  state.busy = busy;
  ["toggleBackend", "runOnce", "saveSchedule", "refreshStatus", "runSupervisor", "reviewSupervisor", "refreshSupervisor", "supervisorMasterToggle", "supervisorMarketToggle"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = busy;
  });
  $("refreshStatus")?.classList.toggle("spinning", busy);
}

const SUPERVISOR_STATES = Object.freeze({
  idle: ["等待周期", ""],
  queued: ["已排队", "blue"],
  training: ["训练中", "blue"],
  evaluating: ["固定门禁核验中", "blue"],
  reviewing: ["固定门禁核验中", "blue"],
  rework_scheduled: ["自动返工", "gold"],
  accepted: ["本周期通过", "good"],
  completed_not_promoted: ["未通过门禁", "gold"],
  awaiting_optional_review: ["旧状态待迁移", "gold"],
  needs_attention: ["需要协助", "danger"],
});

const SUPERVISOR_GATE_GROUPS = Object.freeze([
  {
    label: "数据与隔离",
    ids: ["training_output", "dataset_rows", "symbol_breadth", "point_in_time", "sample_isolation", "horizon_models", "oof_depth", "event_support", "independent_dates", "leakage_controls"],
  },
  {
    label: "统计与泛化",
    ids: ["rolling_folds", "brier_skill", "direction_threshold_selection", "balanced_accuracy", "direction_mcc", "relative_majority_accuracy", "direction_threshold_coverage", "calibration_ece", "calibration_slope", "probability_bucket_support", "feature_drift", "monitoring_status"],
  },
  {
    label: "排序与收益",
    ids: ["top_k_lift", "top10_direction", "expected_value", "direction_accuracy", "production_data"],
  },
]);

const SUPERVISOR_EVENT_LABELS = Object.freeze({
  "cycle-started": "训练周期启动",
  "job-started": "后台训练启动",
  "gate-evaluation-started": "固定门禁开始核验",
  "gate-evaluation-complete": "固定门禁核验完成",
  "deterministic-review-complete": "历史固定门禁核验",
  accepted: "本周期通过",
  rework: "自动安排返工",
  "completed-not-promoted": "训练完成但未晋级",
  "unchanged-data": "数据未变化",
  queued: "等待训练资源",
  "legacy-ai-review-retired": "旧审核状态已迁移",
});

function renderTrainingSupervisor(status) {
  const supervisor = status?.trainingSupervisor || {};
  const cycle = supervisor.markets?.[state.market] || supervisor.market || {};
  const [stateLabel, stateTone] = SUPERVISOR_STATES[cycle.status] || [cycle.status || "未初始化", ""];
  const pill = $("supervisorStatePill");
  pill.textContent = stateLabel;
  pill.className = `status-pill ${stateTone}`;
  const evaluation = cycle.evaluation || {};
  const plan = cycle.currentPlan || {};
  const activeJob = supervisor.activeJobs?.[state.market] || null;
  const jobDetail = activeJob?.detail || {};
  const passed = (evaluation.checks || []).filter((check) => check.passed).length;
  const blockingFailed = (evaluation.checks || []).filter((check) => check.blocking && !check.passed).length;
  const masterToggle = $("supervisorMasterToggle");
  const marketToggle = $("supervisorMarketToggle");
  masterToggle.checked = supervisor.enabled !== false;
  marketToggle.checked = cycle.enabled !== false;
  masterToggle.disabled = state.busy;
  marketToggle.disabled = state.busy;
  $("supervisorMarketLabel").textContent = `${MARKET_LABELS[state.market] || state.market} 市场训练`;
  const controlState = $("supervisorControlState");
  controlState.textContent = supervisor.enabled === false ? "自动调度已暂停" : cycle.enabled === false ? "本市场已暂停" : "训练控制可用";
  controlState.className = `status-pill ${supervisor.enabled === false || cycle.enabled === false ? "gold" : "good"}`;
  $("supervisorOverview").innerHTML = `
    <div class="supervisor-ops-stat"><span>训练周期</span><strong>${escapeHtml(cycle.cycleId ? String(cycle.cycleId).slice(-18) : "等待首轮")}</strong><small>尝试 ${Number(cycle.attempt || 0)}/${Number(cycle.maxAttempts || supervisor.config?.maxAttempts || 0)}</small></div>
    <div class="supervisor-ops-stat"><span>${activeJob ? "后台作业进度" : "样本外硬门槛"}</span><strong>${activeJob ? `${Math.round(Number(activeJob.progress || 0) * 100)}%` : `${Number(evaluation.score || 0)} / 100`}</strong><small>${activeJob ? `${escapeHtml(jobDetail.phase || activeJob.status || "training")} · ${Number(jobDetail.completed || 0)}/${Number(jobDetail.total || plan.limit || 0)}${jobDetail.symbol ? ` · ${escapeHtml(jobDetail.symbol)}` : ""}` : `${passed}/${(evaluation.checks || []).length} 通过 · ${blockingFailed} 条阻塞 · 只接受 OOF 证据`}</small></div>
    <div class="supervisor-ops-stat"><span>下一动作</span><strong>${escapeHtml(cycle.status === "training" ? "后台训练进行中" : ["evaluating", "reviewing"].includes(cycle.status) ? "固定门槛核验" : cycle.status === "rework_scheduled" ? "自动启动返工" : cycle.status === "accepted" ? "等待下个周期" : "等待调度")}</strong><small>${activeJob ? `更新 ${escapeHtml(formatTime(activeJob.updatedAt, { full: true }))}` : `${escapeHtml(formatTime(cycle.nextActionAt || cycle.nextCycleAt, { full: true }))} · ${Number(plan.limit || 0)} 只 / ${escapeHtml(plan.range || "待定")} / ${Number(plan.foldCount || 0)} 折`}</small></div>
  `;
  const checks = Array.isArray(evaluation.checks) ? evaluation.checks : [];
  const checkMap = new Map(checks.map((check) => [check.id, check]));
  $("supervisorGateGroups").innerHTML = SUPERVISOR_GATE_GROUPS.map((group) => {
    const rows = group.ids.map((id) => checkMap.get(id)).filter(Boolean);
    const blockingRows = rows.filter((check) => check.blocking !== false);
    const failedRows = blockingRows.filter((check) => !check.passed);
    const verdict = !rows.length ? ["等待证据", ""] : failedRows.length ? [`${failedRows.length} 项阻塞`, "gold"] : ["通过", "good"];
    const detail = !rows.length
      ? "本轮训练完成后显示固定门槛结果。"
      : failedRows.length
        ? failedRows.map((check) => check.label || check.id).join("；")
        : `${rows.filter((check) => check.passed).length}/${rows.length} 项已有证据。`;
    return `
      <article class="supervisor-gate-row">
        <header><div><strong>${escapeHtml(group.label)}</strong><small>${rows.length} 项本地门槛</small></div>${statusPill(verdict[0], verdict[1])}</header>
        <p>${escapeHtml(detail)}</p>
      </article>
    `;
  }).join("");
  const logs = (supervisor.logs || []).filter((event) => !event.market || event.market === state.market);
  const operatorLogs = logs.filter((event) => event.type === "operator-action").slice(0, 8);
  $("supervisorOperatorLog").innerHTML = `
    <div class="supervisor-log-title"><strong>人工操作审计</strong><span>${operatorLogs.length} 条最近记录</span></div>
    <div class="supervisor-operator-rows">
      ${operatorLogs.length ? operatorLogs.map((event) => {
        const changes = (event.changes || []).map((change) => `${change.field}: ${change.from ? "开" : "关"} → ${change.to ? "开" : "关"}`).join("；");
        return `<article><div><strong>${escapeHtml(event.action || "manual-action")}</strong><time>${escapeHtml(formatTime(event.createdAt, { full: true }))}</time></div><p>${escapeHtml(event.operatorNote || changes || event.outcome || "人工操作")}</p><small>${escapeHtml(event.outcome || "recorded")}${changes && event.operatorNote ? ` · ${escapeHtml(changes)}` : ""}</small></article>`;
      }).join("") : `<p class="muted-line">尚无人工操作记录。</p>`}
    </div>
  `;
  const gateLogs = logs.filter((event) => event.type !== "operator-action" && event.type !== "reviewer-verdict").slice(0, 12);
  $("supervisorLogs").innerHTML = `
    <div class="supervisor-log-title"><strong>确定性门禁记录</strong><span>${gateLogs.length} 条最近记录</span></div>
    <div class="supervisor-log-grid deterministic-log-grid">
      <section><header><strong>本地训练证据</strong><small>不调用外部模型</small></header>${gateLogs.length ? gateLogs.map((event) => {
        const acceptedEvent = event.accepted === true || event.type === "accepted";
        const failedEvent = event.accepted === false || ["rework", "completed-not-promoted"].includes(event.type);
        const label = SUPERVISOR_EVENT_LABELS[event.type] || event.type || "状态更新";
        return `<article><div>${statusPill(label, acceptedEvent ? "good" : failedEvent ? "gold" : "blue")}<time>${escapeHtml(formatTime(event.createdAt))}</time></div><p>${escapeHtml(event.reason || event.error || event.evaluation?.failedChecks?.join("；") || "证据与状态已保存。")}</p></article>`;
      }).join("") : `<p class="muted-line">尚无门禁记录。</p>`}</section>
    </div>
  `;
  $("supervisorHint").textContent = cycle.lastError
    ? `最近阻塞：${cycle.lastError}`
    : "训练核验完全由本地固定门槛完成，不消耗外部 AI 额度。";
}

function renderStatusSummary(status) {
  if (!status) return;
  const config = status.config || {};
  const enabled = config.enabled !== false;
  const running = Boolean(status.state?.running);
  $("enabledState").textContent = enabled ? "已开启" : "已暂停";
  $("enabledHint").textContent = enabled ? (running ? "当前正在处理后台任务" : "交易时段自动恢复") : "行情、训练与提醒均停止";
  $("lastRunAt").textContent = `上次运行 ${formatTime(status.runtime?.lastRunAt || status.state?.lastRunAt)}`;
  $("headerStatusDot").classList.toggle("active", enabled);

  const toggle = $("toggleBackend");
  toggle.innerHTML = `<i data-lucide="power"></i><span>${enabled ? "关闭后台" : "开启后台"}</span>`;
  toggle.classList.toggle("good", !enabled);
  toggle.classList.toggle("danger", enabled);
  $("statusText").textContent = `${status.version || "local"} · ${enabled ? "后台已启用" : "后台已暂停"} · ${running ? "运行中" : "空闲"}`;
}

function renderTrajectorySummary(payload) {
  const summary = payload?.summary || {};
  const families = payload?.families || [];
  const ready = families.filter((family) => ["ready", "active", "guarded", "paper"].includes(family.status?.code)).length;
  $("heroSamples").textContent = compactNumber(summary.predictionSamples);
  $("heroGuardrail").textContent = `${Number(summary.guardrailCoveragePct || 0)}%`;
  $("heroUpdated").textContent = `最近更新 ${formatTime(summary.lastChangeAt)}`;
  $("modelFamilyCount").textContent = String(summary.modelCount || families.length || 0);
  $("modelReadyHint").textContent = `${ready} 个已有运行证据，其余保持研究态`;
  $("changes24h").textContent = String(summary.changes24h || 0);
  $("resolvedPredictions").textContent = compactNumber(summary.resolvedPredictions);
  const hitRate = finiteNumber(summary.hitRate);
  const brier = finiteNumber(summary.brierScore);
  $("calibrationHint").textContent = `${hitRate === null ? "命中待累计" : `方向命中 ${hitRate.toFixed(1)}%`} · ${brier === null ? "Brier 待累计" : `Brier ${brier.toFixed(3)}`}`;
}

function renderPipeline(payload) {
  const pipeline = payload?.pipeline || [];
  $("pipelineFlow").innerHTML = pipeline.length ? pipeline.map((stage) => `
    <article class="pipeline-node ${stage.available ? "ready" : "pending"}">
      <span class="pipeline-number">${Number(stage.order || 0)}</span>
      <strong>${escapeHtml(stage.name)}</strong>
      <p>${escapeHtml(stage.detail)}</p>
    </article>
  `).join("") : `<div class="muted-line">本市场尚未形成模型决策链证据。</div>`;
}

function familyProgress(family) {
  const value = finiteNumber(family?.primaryMetric?.value);
  if (value === null) return 8;
  if (family.id === "adaptive") return Math.min(100, Math.max(8, value / 22 * 100));
  return Math.min(100, Math.max(8, value));
}

function renderModelList(payload) {
  const families = payload?.families || [];
  if (!families.some((family) => family.id === state.selectedFamily)) {
    state.selectedFamily = families[0]?.id || null;
    state.selectedEventKey = null;
  }
  $("modelCountTag").textContent = `${families.length} 个模型族`;
  $("modelList").innerHTML = families.length ? families.map((family) => {
    const active = family.id === state.selectedFamily;
    const metric = family.primaryMetric || {};
    return `
      <button class="model-row ${active ? "active" : ""}" type="button" data-family="${escapeHtml(family.id)}" aria-pressed="${active}">
        <span class="model-row-icon"><i data-lucide="${FAMILY_ICONS[family.id] || "brain-circuit"}"></i></span>
        <span class="model-row-main">
          <span class="model-row-title"><strong>${escapeHtml(family.shortName || family.name)}</strong>${statusPill(family.status?.label || "研究中", family.status?.tone || "")}</span>
          <span class="model-row-meta"><span>${escapeHtml(metric.label || "轨迹事件")}</span><span>${metric.value === null || metric.value === undefined ? `${family.eventCount || 0} 次` : formatMetric(metric.value, metric.unit || "")}</span></span>
          <span class="mini-track"><i style="width:${familyProgress(family)}%"></i></span>
        </span>
      </button>
    `;
  }).join("") : `<div class="event-inspector-empty">暂无本市场模型事件。</div>`;
}

function renderSelectedFamily(payload) {
  const family = currentFamily();
  if (!family) {
    $("selectedModelName").textContent = "暂无模型轨迹";
    $("selectedModelDescription").textContent = "该市场尚未写入模型变更日志。";
    $("trajectoryEvents").innerHTML = "";
    $("eventInspector").className = "event-inspector-empty";
    $("eventInspector").textContent = "等待本地模型事件。";
    drawTrajectory([]);
    return;
  }
  const metric = family.primaryMetric || {};
  $("selectedModelIcon").innerHTML = `<i data-lucide="${FAMILY_ICONS[family.id] || "brain-circuit"}"></i>`;
  $("selectedModelStage").textContent = family.stage || "模型阶段";
  $("selectedModelName").textContent = family.name || family.shortName;
  $("selectedModelDescription").textContent = family.description || "";
  $("primaryMetricLabel").textContent = metric.label || "核心指标";
  $("primaryMetricValue").textContent = formatMetric(metric.value, metric.unit || "");
  $("selectedSampleCount").textContent = compactNumber(family.sampleCount || 0);
  $("selectedModelStatus").textContent = family.status?.label || "研究中";
  $("legendMetric").textContent = metric.label || "核心评估指标";
  drawTrajectory(family.trajectory || []);
  renderTrajectoryEvents(family);
  renderEventInspector(currentEvent());
  renderWeightEvidence(payload, family);
}

function filteredEvents(family) {
  const events = family?.events || [];
  if (state.eventFilter === "all") return events;
  return events.filter((event) => event.impact === state.eventFilter);
}

function renderTrajectoryEvents(family) {
  const events = filteredEvents(family);
  if (!events.some((event) => eventKey(event) === state.selectedEventKey)) {
    state.selectedEventKey = events[0] ? eventKey(events[0]) : null;
  }
  $("trajectoryEvents").innerHTML = events.length ? events.map((event) => {
    const key = eventKey(event);
    return `
      <button class="trajectory-event ${key === state.selectedEventKey ? "active" : ""}" type="button" data-event-key="${escapeHtml(key)}">
        <i class="event-state-dot ${escapeHtml(event.impact || "neutral")}"></i>
        <span><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.entity || "market")} · ${escapeHtml(event.framework || "local-model")}</small></span>
        <time>${escapeHtml(formatTime(event.createdAt))}</time>
      </button>
    `;
  }).join("") : `<div class="event-inspector-empty">当前筛选下没有变更节点。</div>`;
}

function metricRows(event) {
  const metrics = event?.metrics || {};
  const rows = [
    ["样本数", compactNumber(metrics.sampleCount)],
    [metrics.primaryMetric?.label || "核心指标", formatMetric(metrics.primaryMetric?.value, metrics.primaryMetric?.unit || "")],
    ["MAE", formatMetric(metrics.mae, "", 3)],
    ["Rank IC", formatMetric(metrics.rankIc, "", 3)],
  ];
  return rows.filter(([, value]) => value !== "--").slice(0, 4);
}

function listBlock(title, items = [], className = "") {
  if (!items.length) return "";
  return `<section class="explain-block ${className}"><h4>${escapeHtml(title)}</h4><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
}

function renderEventInspector(event) {
  const container = $("eventInspector");
  if (!event) {
    $("eventImpactTag").textContent = "等待节点";
    $("eventImpactTag").className = "status-pill";
    container.className = "event-inspector-empty";
    container.textContent = "选择一个模型变更节点后，这里会显示修改内容、触发原因、样本证据、公式和护栏结果。";
    return;
  }
  const impactLabels = { improved: "样本外改善", degraded: "指标退化", watch: "继续观察", neutral: "待验证" };
  $("eventImpactTag").textContent = impactLabels[event.impact] || "待验证";
  $("eventImpactTag").className = `status-pill ${event.impact || "neutral"}`;
  const rows = metricRows(event);
  container.className = "inspector-event";
  container.innerHTML = `
    <h3>${escapeHtml(event.title)}</h3>
    <p>${escapeHtml(event.summary || "本次事件没有附加摘要。")}</p>
    <div class="inspector-meta">
      ${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
      <div><span>发生时间</span><strong>${escapeHtml(formatTime(event.createdAt, { full: true }))}</strong></div>
      <div><span>对象 / 阶段</span><strong>${escapeHtml(event.entity || "market")} · ${escapeHtml(event.stage || "模型")}</strong></div>
    </div>
    ${listBlock("修改了什么", event.changes || [])}
    ${listBlock("为什么修改", event.reasons || [])}
    ${event.formula ? `<section class="explain-block"><h4>调整公式</h4><div class="formula-block">${escapeHtml(event.formula)}</div></section>` : ""}
    ${event.guardrails?.length ? `<section class="explain-block"><h4>防过拟合与泄漏护栏</h4><ul>${event.guardrails.map((guard) => `<li class="guardrail-row"><i data-lucide="${guard.pass === false ? "shield-x" : "shield-check"}"></i><span><strong>${escapeHtml(guard.label)}</strong>${guard.note ? `<br>${escapeHtml(guard.note)}` : ""}</span></li>`).join("")}</ul></section>` : ""}
  `;
  refreshIcons();
}

function renderWeightEvidence(payload, family) {
  const container = $("weightEvidence");
  if (family?.id !== "calibration" || !payload?.horizonWeights?.length) {
    container.innerHTML = "";
    return;
  }
  const horizon = payload.horizonWeights.find((row) => Number(row.horizonDays) === 15) || payload.horizonWeights[0];
  container.innerHTML = `
    <h3>${escapeHtml(horizon.label || "当前周期")} Top 权重</h3>
    <div class="muted-line">样本 ${compactNumber(horizon.sampleCount)} · 方向命中 ${formatMetric(horizon.directionHitRate, "%")} · 等权 ${formatMetric(horizon.equalWeightDirectionHitRate, "%")}</div>
    ${(horizon.weights || []).map((weight) => `
      <div class="weight-row">
        <div><span>${escapeHtml(weight.name)}</span><strong>${formatMetric(Number(weight.value || 0) * 100, "%")}</strong></div>
        <div class="weight-track"><i style="width:${Math.min(100, Number(weight.value || 0) * 300)}%"></i></div>
      </div>
    `).join("")}
  `;
}

function drawTrajectory(points = []) {
  const canvas = $("trajectoryChart");
  const empty = $("chartEmpty");
  const shell = canvas.parentElement;
  if (!canvas || !shell) return;
  const context = canvas.getContext("2d");
  const rectangle = shell.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rectangle.width));
  const height = Math.max(240, Math.floor(rectangle.height));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  state.chartHitTargets = [];

  const usable = points.filter((point) => finiteNumber(point.value) !== null && point.at);
  empty.hidden = usable.length > 0;
  if (!usable.length) return;

  const margin = { top: 28, right: 22, bottom: 38, left: 48 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const values = usable.map((point) => Number(point.value));
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  const spread = Math.max(1, maximum - minimum);
  minimum -= spread * 0.16;
  maximum += spread * 0.16;
  if (minimum === maximum) {
    minimum -= 1;
    maximum += 1;
  }
  const xFor = (index) => margin.left + (usable.length === 1 ? chartWidth / 2 : index / (usable.length - 1) * chartWidth);
  const yFor = (value) => margin.top + (maximum - value) / (maximum - minimum) * chartHeight;

  context.font = "9px Inter, system-ui, sans-serif";
  context.textBaseline = "middle";
  context.strokeStyle = "rgba(242, 240, 233, 0.065)";
  context.fillStyle = "#858881";
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = margin.top + index / 4 * chartHeight;
    const value = maximum - index / 4 * (maximum - minimum);
    context.beginPath();
    context.moveTo(margin.left, y);
    context.lineTo(width - margin.right, y);
    context.stroke();
    context.fillText(value.toFixed(Math.abs(maximum - minimum) < 5 ? 1 : 0), 6, y);
  }

  const area = context.createLinearGradient(0, margin.top, 0, height - margin.bottom);
  area.addColorStop(0, "rgba(198, 163, 90, 0.18)");
  area.addColorStop(1, "rgba(198, 163, 90, 0)");
  context.beginPath();
  usable.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.lineTo(xFor(usable.length - 1), height - margin.bottom);
  context.lineTo(xFor(0), height - margin.bottom);
  context.closePath();
  context.fillStyle = area;
  context.fill();

  context.beginPath();
  usable.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = "#c6a35a";
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  usable.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.value);
    const color = point.impact === "improved" ? "#5baa91" : point.impact === "degraded" ? "#c76872" : "#c6a35a";
    context.beginPath();
    context.arc(x, y, 3.4, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.strokeStyle = "#0b0d0b";
    context.lineWidth = 1.5;
    context.stroke();
    state.chartHitTargets.push({ x, y, point });
  });

  const labelIndexes = [...new Set([0, Math.floor((usable.length - 1) / 2), usable.length - 1])];
  context.fillStyle = "#858881";
  context.textBaseline = "top";
  labelIndexes.forEach((index) => {
    const text = formatTime(usable[index].at);
    const x = xFor(index);
    context.textAlign = index === 0 ? "left" : index === usable.length - 1 ? "right" : "center";
    context.fillText(text, x, height - margin.bottom + 12);
  });
}

function renderControls(status) {
  if (!status) return;
  const config = status.config || {};
  $("holdingMinutes").value = Math.round(Number(config.refresh?.holdingMs || 120000) / 60000);
  $("watchMinutes").value = Math.round(Number(config.refresh?.watchMs || 300000) / 60000);
  $("trainingMinutes").value = Math.round(Number(config.refresh?.trainingMs || 120000) / 60000);
  $("trainingSymbols").value = Number(config.training?.symbolLimit || 3);
  renderTrainingSupervisor(status);
  renderSessions(status);
  renderBudget(status);
  renderPools(status);
  renderResults(status);
}

function renderSessions(status) {
  const sessions = status.sessions || {};
  $("sessionList").innerHTML = Object.entries(sessions).map(([market, session]) => `
    <div class="data-row">
      <div class="data-row-top"><strong>${escapeHtml(MARKET_LABELS[market] || market)}</strong>${statusPill(session.open ? "交易中" : session.weekend ? "周末" : "休市", session.open ? "good" : "gold")}</div>
      <div class="muted-line">${escapeHtml(session.localTime || "--")} · ${escapeHtml(session.timeZone || "")}</div>
    </div>
  `).join("") || `<div class="muted-line">暂无市场时段信息。</div>`;
}

function renderBudget(status) {
  const used = status.budget?.used || {};
  const limits = status.budgetLimits || {};
  const rows = [["marketCalls", "行情调用"], ["factorCalls", "因子调用"], ["trainingCalls", "分钟训练"], ["aiCalls", "AI 复核"], ["notifications", "提醒推送"]];
  $("budgetList").innerHTML = rows.map(([key, label]) => {
    const current = Number(used[key] || 0);
    const limit = Number(limits[key] || 0);
    const percent = limit > 0 ? Math.min(100, Math.round(current / limit * 100)) : 0;
    const tone = percent >= 90 ? "danger" : percent >= 70 ? "warn" : "good";
    return `
      <div class="data-row">
        <div class="data-row-top"><strong>${label}</strong>${statusPill(`${current}/${limit}`, tone)}</div>
        <div class="budget-track"><i class="${tone}" style="width:${percent}%"></i></div>
        <div class="muted-line">今日使用 ${percent}%${key === "marketCalls" ? ` · 训练预留 ${Number(limits.trainingMarketReserve || 0)} 次` : ""}</div>
      </div>
    `;
  }).join("");
}

function renderPools(status) {
  const markets = status.config?.markets || {};
  $("poolList").innerHTML = Object.entries(markets).map(([market, config]) => `
    <div class="data-row">
      <div class="data-row-top"><strong>${escapeHtml(MARKET_LABELS[market] || market)}</strong>${statusPill(`持仓 ${Number(config.portfolio?.length || 0)}`, "blue")}</div>
      <div class="muted-line">监控 ${Number(config.watchlist?.length || 0)} 只 · 持仓 ${formatMinutes(status.config?.refresh?.holdingMs)} · 监控 ${formatMinutes(status.config?.refresh?.watchMs)}</div>
    </div>
  `).join("") || `<div class="muted-line">暂无监控池。</div>`;
}

function renderResults(status) {
  const results = status.runtime?.lastResults || status.state?.lastAnalyses || [];
  $("resultList").innerHTML = results.length ? results.slice(0, 30).map((row) => {
    const action = row.action || (row.error ? "ERROR" : "WAIT");
    const tone = row.error ? "danger" : /BUY/.test(action) ? "good" : /SELL|AVOID|ERROR/.test(action) ? "danger" : "gold";
    return `
      <div class="result-row">
        <div class="result-top"><strong>${escapeHtml(row.symbol || "--")} · ${escapeHtml(row.market || "")}</strong>${statusPill(action, tone)}</div>
        <div class="muted-line">${row.error ? escapeHtml(row.error) : `置信 ${Math.round(Number(row.confidence || 0))}% · 预估 ${Number(row.projectedFinalReturn || 0).toFixed(2)}% · 价格 ${Number(row.price || 0).toFixed(3)}`}</div>
        <div class="muted-line">${escapeHtml(row.source || row.tier || "backend")} · ${formatTime(row.updatedAt)}</div>
      </div>
    `;
  }).join("") : `<div class="muted-line">暂无后台运行结果。交易时段或手动运行后会显示。</div>`;
}

function renderAudit(payload) {
  const families = payload?.families || [];
  const select = $("auditFamily");
  select.innerHTML = `<option value="all">全部模型</option>${families.map((family) => `<option value="${escapeHtml(family.id)}">${escapeHtml(family.shortName || family.name)}</option>`).join("")}`;
  select.value = families.some((family) => family.id === state.auditFamily) ? state.auditFamily : "all";
  const timeline = (payload?.timeline || []).filter((event) => state.auditFamily === "all" || event.family === state.auditFamily);
  $("auditTimeline").innerHTML = timeline.length ? timeline.map((event) => `
    <article class="audit-row ${escapeHtml(event.impact || "neutral")}">
      <div class="audit-row-head"><div><span class="eyebrow">${escapeHtml(event.stage || "模型事件")}</span><h3>${escapeHtml(event.title)}</h3></div><time>${escapeHtml(formatTime(event.createdAt, { full: true }))}</time></div>
      <p>${escapeHtml(event.summary || event.changes?.[0] || "本次事件没有附加摘要。")} · ${escapeHtml(event.entity || "market")}</p>
    </article>
  `).join("") : `<div class="event-inspector-empty">暂无符合筛选条件的模型事件。</div>`;
}

function renderAll(options = {}) {
  renderStatusSummary(state.status);
  if (state.view === "control") renderControls(state.status);
  if (options.statusOnly) {
    refreshIcons();
    return;
  }
  const payload = currentTrajectory();
  renderTrajectorySummary(payload);
  renderPipeline(payload);
  renderModelList(payload);
  renderSelectedFamily(payload);
  if (state.view === "audit") renderAudit(payload);
  refreshIcons();
}

async function refreshStatus({ quiet = false, detailed = false, trajectory = null, fullTrajectory = false } = {}) {
  if (!quiet) setBusy(true);
  state.refreshController?.abort();
  const controller = new AbortController();
  state.refreshController = controller;
  const timeout = window.setTimeout(() => controller.abort(), detailed || fullTrajectory ? 8000 : 4500);
  const shouldLoadTrajectory = trajectory == null
    ? !quiet || Date.now() - state.lastTrajectoryFetchAt > 2 * 60 * 1000
    : trajectory;
  try {
    const statusUrl = detailed ? "/api/backend-monitor/status" : "/api/backend-monitor/status?compact=1";
    const requests = [fetchJson(statusUrl, { signal: controller.signal })];
    if (shouldLoadTrajectory) {
      const compact = fullTrajectory ? "" : "&compact=1";
      requests.push(fetchJson(`/api/model-trajectories?market=${encodeURIComponent(state.market)}&limit=${fullTrajectory ? 240 : 80}${compact}`, { signal: controller.signal }));
    }
    const [statusResult, trajectoryResult] = await Promise.allSettled(requests);
    if (statusResult.status === "fulfilled") state.status = statusResult.value;
    if (statusResult.status === "fulfilled") state.statusDetailed = detailed;
    if (trajectoryResult?.status === "fulfilled") {
      state.trajectoriesByMarket[state.market] = trajectoryResult.value;
      state.lastTrajectoryFetchAt = Date.now();
    }
    if (statusResult.status === "rejected" && (!trajectoryResult || trajectoryResult.status === "rejected")) {
      throw statusResult.reason || trajectoryResult?.reason || new Error("本地状态读取失败");
    }
    renderAll({ statusOnly: !shouldLoadTrajectory || trajectoryResult?.status !== "fulfilled" });
    if (trajectoryResult?.status === "rejected") {
      $("statusText").textContent = `后台状态可用；模型动线读取失败：${trajectoryResult.reason?.message || "未知错误"}`;
    }
  } catch (error) {
    if (error?.name !== "AbortError") $("statusText").textContent = `读取失败：${error.message}`;
    else if (state.refreshController === controller) $("statusText").textContent = "读取超时；已保留上次本地状态，可立即重试";
  } finally {
    window.clearTimeout(timeout);
    if (state.refreshController === controller) state.refreshController = null;
    if (!quiet) setBusy(false);
    refreshIcons();
  }
}

async function refreshInitialView() {
  if (currentTrajectory()) renderAll();
  await refreshStatus({ trajectory: false });
  window.setTimeout(() => {
    if (state.view === "models" && !currentTrajectory()) {
      refreshStatus({ quiet: true, trajectory: true });
    }
  }, 120);
}

async function saveConfig(nextConfig) {
  await fetchJson("/api/backend-monitor/config", { method: "POST", body: JSON.stringify(nextConfig) });
  await refreshStatus({ quiet: true });
}

async function toggleBackend() {
  const config = state.status?.config;
  if (!config) return;
  setBusy(true);
  try {
    const next = structuredClone(config);
    next.enabled = config.enabled === false;
    next.source = "monitor-app";
    await saveConfig(next);
  } catch (error) {
    $("statusText").textContent = `切换失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function saveSchedule() {
  const config = state.status?.config;
  if (!config) return;
  setBusy(true);
  try {
    const next = structuredClone(config);
    next.source = "monitor-app";
    next.refresh = {
      ...(next.refresh || {}),
      holdingMs: Math.max(1, Number($("holdingMinutes").value || 2)) * 60000,
      watchMs: Math.max(1, Number($("watchMinutes").value || 5)) * 60000,
      trainingMs: Math.max(1, Number($("trainingMinutes").value || 2)) * 60000,
    };
    next.training = {
      ...(next.training || {}),
      enabled: true,
      symbolLimit: Math.max(1, Math.min(5, Number($("trainingSymbols").value || 3))),
      interval: next.training?.interval || "5m",
      range: next.training?.range || "1mo",
    };
    await saveConfig(next);
    $("saveHint").textContent = "频率已保存，后台下一轮按新配置运行。";
  } catch (error) {
    $("saveHint").textContent = `保存失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function runOnce() {
  setBusy(true);
  try {
    $("statusText").textContent = "正在触发后台运行一次";
    await fetchJson("/api/backend-monitor/run", { method: "POST", body: "{}" });
    await refreshStatus({ quiet: true });
  } catch (error) {
    $("statusText").textContent = `手动运行失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function runSupervisor() {
  setBusy(true);
  try {
    $("supervisorHint").textContent = `${MARKET_LABELS[state.market] || state.market} 训练调度正在安排本轮任务`;
    const result = await fetchJson("/api/training-supervisor/run", {
      method: "POST",
      body: JSON.stringify({ market: state.market, reason: "manual-monitor-app", source: "GlobalQuantMonitor", operatorNote: $("supervisorOperatorNote").value.trim() }),
    });
    $("supervisorHint").textContent = result.reason === "already-running"
      ? "本市场训练已在运行；完成后会自动执行固定门禁核验。"
      : `训练周期已${result.queued ? "排队" : "启动"}；失败将自动返工。`;
    await refreshStatus({ quiet: true });
  } catch (error) {
    $("supervisorHint").textContent = `推动失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function reviewSupervisor() {
  setBusy(true);
  try {
    $("supervisorHint").textContent = "正在读取最近完整训练产物并重新执行固定门槛核验";
    const result = await fetchJson("/api/training-supervisor/review", {
      method: "POST",
      body: JSON.stringify({ market: state.market, source: "GlobalQuantMonitor", operatorNote: $("supervisorOperatorNote").value.trim() }),
    });
    $("supervisorHint").textContent = result.reason === "already-running"
      ? "当前训练或核验正在运行，本次重新核验请求已写入审计日志。"
      : result.reason === "no-complete-job"
        ? "当前市场没有可重新验收的完整训练产物。"
        : "最近训练产物已重新核验；结论与阻断项已写入本地证据日志。";
    await refreshStatus({ quiet: true });
  } catch (error) {
    $("supervisorHint").textContent = `重新核验失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function toggleSupervisorScope(scope, enabled) {
  setBusy(true);
  try {
    const payload = {
      market: state.market,
      source: "GlobalQuantMonitor",
      operatorNote: $("supervisorOperatorNote").value.trim(),
      ...(scope === "global" ? { enabled } : { marketEnabled: enabled }),
    };
    await fetchJson("/api/training-supervisor/config", { method: "POST", body: JSON.stringify(payload) });
    await refreshStatus({ quiet: true });
    $("supervisorHint").textContent = scope === "global"
      ? `自动训练总调度已${enabled ? "开启" : "暂停"}。`
      : `${MARKET_LABELS[state.market] || state.market} 市场训练已${enabled ? "开启" : "暂停"}。`;
  } catch (error) {
    $("supervisorHint").textContent = `训练范围切换失败：${error.message}`;
    await refreshStatus({ quiet: true });
  } finally {
    setBusy(false);
  }
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  if (view === "models") requestAnimationFrame(() => drawTrajectory(currentFamily()?.trajectory || []));
  if (view === "models" && !currentTrajectory()) refreshStatus({ quiet: true, trajectory: true });
  if (view === "control") {
    renderControls(state.status);
    if (!state.statusDetailed) refreshStatus({ detailed: true, trajectory: false });
  }
  if (view === "audit") {
    renderAudit(currentTrajectory());
    refreshStatus({ detailed: false, trajectory: true, fullTrajectory: true });
  }
  if (view !== "audit") $("auditTimeline").replaceChildren();
  refreshIcons();
}

function chartPointer(event) {
  const tooltip = $("chartTooltip");
  const canvas = $("trajectoryChart");
  if (!state.chartHitTargets.length) {
    tooltip.hidden = true;
    return;
  }
  const rectangle = canvas.getBoundingClientRect();
  const x = event.clientX - rectangle.left;
  const y = event.clientY - rectangle.top;
  const nearest = state.chartHitTargets.reduce((best, target) => {
    const distance = Math.hypot(target.x - x, target.y - y);
    return !best || distance < best.distance ? { target, distance } : best;
  }, null);
  if (!nearest || nearest.distance > 22) {
    tooltip.hidden = true;
    return;
  }
  const point = nearest.target.point;
  tooltip.innerHTML = `<strong>${escapeHtml(point.label)} ${formatMetric(point.value, point.unit || "")}</strong>${escapeHtml(formatTime(point.at, { full: true }))}`;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(rectangle.width - 178, Math.max(8, nearest.target.x + 12))}px`;
  tooltip.style.top = `${Math.max(8, nearest.target.y - 58)}px`;
}

$("refreshStatus").addEventListener("click", () => refreshStatus());
$("toggleBackend").addEventListener("click", toggleBackend);
$("saveSchedule").addEventListener("click", saveSchedule);
$("runOnce").addEventListener("click", runOnce);
$("runSupervisor").addEventListener("click", runSupervisor);
$("reviewSupervisor").addEventListener("click", reviewSupervisor);
$("refreshSupervisor").addEventListener("click", () => refreshStatus());
$("supervisorMasterToggle").addEventListener("change", (event) => toggleSupervisorScope("global", event.target.checked));
$("supervisorMarketToggle").addEventListener("change", (event) => toggleSupervisorScope("market", event.target.checked));
$("trajectoryChart").addEventListener("pointermove", chartPointer);
$("trajectoryChart").addEventListener("pointerleave", () => { $("chartTooltip").hidden = true; });

$("marketTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-market]");
  if (!button || button.dataset.market === state.market) return;
  state.market = button.dataset.market;
  state.selectedFamily = null;
  state.selectedEventKey = null;
  document.querySelectorAll("[data-market]").forEach((item) => item.classList.toggle("active", item.dataset.market === state.market));
  renderAll({ statusOnly: !currentTrajectory() });
  refreshInitialView();
});

document.querySelector(".view-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) switchView(button.dataset.view);
});

$("modelList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-family]");
  if (!button) return;
  state.selectedFamily = button.dataset.family;
  state.selectedEventKey = null;
  renderModelList(currentTrajectory());
  renderSelectedFamily(currentTrajectory());
  refreshIcons();
});

$("trajectoryEvents").addEventListener("click", (event) => {
  const button = event.target.closest("[data-event-key]");
  if (!button) return;
  state.selectedEventKey = button.dataset.eventKey;
  renderTrajectoryEvents(currentFamily());
  renderEventInspector(currentEvent());
});

document.querySelector(".event-filter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-event-filter]");
  if (!button) return;
  state.eventFilter = button.dataset.eventFilter;
  state.selectedEventKey = null;
  document.querySelectorAll("[data-event-filter]").forEach((item) => item.classList.toggle("active", item.dataset.eventFilter === state.eventFilter));
  renderTrajectoryEvents(currentFamily());
  renderEventInspector(currentEvent());
});

$("auditFamily").addEventListener("change", (event) => {
  state.auditFamily = event.target.value;
  renderAudit(currentTrajectory());
});

window.addEventListener("resize", () => {
  window.clearTimeout(window.__modelTrajectoryResizeTimer);
  window.__modelTrajectoryResizeTimer = window.setTimeout(() => {
    if (state.view === "models") drawTrajectory(currentFamily()?.trajectory || []);
  }, 100);
});

refreshIcons();
refreshInitialView();
window.setInterval(() => refreshStatus({ quiet: true, detailed: state.view === "control", trajectory: false }), 30000);
