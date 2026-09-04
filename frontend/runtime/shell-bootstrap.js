(function installQuantShell(globalScope) {
  "use strict";

  const VALID_PAGES = new Set(["home", "dashboard", "features", "factors", "regime", "strategy", "simulation", "sources"]);
  const PAGE_LABELS = {
    home: "主页",
    dashboard: "监控台",
    features: "特征分析",
    factors: "因子实验室",
    regime: "市场状态",
    strategy: "策略 / Agent",
    simulation: "模拟持仓",
    sources: "数据中心",
  };
  const MARKET_ORDER = ["ASX", "US", "CN"];
  const marketDomain = globalScope.QuantMarket || {};
  const marketConfig = marketDomain.MARKET_CONFIG || {};
  const storage = globalScope.QuantStorage || {};
  let appLoaded = false;
  let appPromise = null;
  let clockTimer = null;
  let shellTaskCenterTimer = null;
  let shellTaskFilter = "running";
  let shellTaskPayload = { jobs: [], summary: {} };
  let pendingMarket = null;
  let marketCommitPromise = null;

  function storageGet(key) {
    return typeof storage.getItem === "function" ? storage.getItem(key) : null;
  }

  function storageSet(key, value) {
    return typeof storage.setItem === "function" ? storage.setItem(key, value) : false;
  }

  function readJson(key, fallback) {
    return typeof storage.readJson === "function"
      ? storage.readJson(key, fallback, { maxChars: 80_000 })
      : fallback;
  }

  function safeMarket(value) {
    return marketConfig[value] ? value : "ASX";
  }

  function currentMarket() {
    return safeMarket(storageGet("selectedMarket") || "ASX");
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = String(value == null ? "" : value);
  }

  function formatSnapshotTime(value) {
    if (!value) return "暂无";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "暂无";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }

  function zonedClock(config, now = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-AU", {
      timeZone: config.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour || 0);
    const minute = Number(parts.minute || 0);
    const second = Number(parts.second || 0);
    const weekday = String(parts.weekday || "");
    const weekdayOpen = !["Sat", "Sun"].includes(weekday);
    const minuteOfDay = hour * 60 + minute;
    const isTrading = weekdayOpen && minuteOfDay >= config.open && minuteOfDay < config.close;
    const inCloseWindow = weekdayOpen && minuteOfDay >= config.close && minuteOfDay <= config.refreshClose;
    return {
      clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
      session: isTrading ? "交易进行中" : inCloseWindow ? "收盘刷新窗口" : "当前休市",
      tone: isTrading ? "open" : inCloseWindow ? "window" : "closed",
    };
  }

  function snapshotTimeForMarket(market) {
    return storageGet(`analysisSnapshotTime:${market}`) || (market === "ASX" ? storageGet("analysisSnapshotTime") : null);
  }

  function watchCountForMarket(market) {
    const byMarket = readJson("watchlistsByMarket", {});
    const rows = Array.isArray(byMarket[market]) ? byMarket[market] : marketConfig[market]?.defaultSymbols || [];
    return new Set(rows.map((item) => String(item?.symbol || item || "").trim()).filter(Boolean)).size;
  }

  function summaryForMarket(market) {
    const summary = readJson(`homeSummary:${market}`, {});
    return summary && typeof summary === "object" ? summary : {};
  }

  const SHELL_TASK_LABELS = {
    backtest: "严格 OOF 训练",
    "history-backfill": "历史行情补齐",
    "pit-enrichment": "PIT 事件补齐",
    "corporate-action-backfill": "公司行动补齐",
    "factor-lab": "因子评估",
    "factor-evolution": "Alpha 因子进化",
    "factor-research": "因子研究",
    training: "分钟模型训练",
    "agent-replay": "Agent 历史重放",
    "learning-evaluation": "学习效果评估",
    "model-report": "模型训练报告",
    "training-supervisor": "训练门禁",
    news: "新闻缓存刷新",
    reddit: "Reddit 社媒缓存",
  };

  function shellEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function shellTaskStatusLabel(status = "") {
    return ({ queued: "排队中", running: "运行中", paused: "已暂停", complete: "已完成", failed: "失败", cancelled: "已取消", deferred: "已延期" }[status] || status || "未知");
  }

  function shellTaskLifecycleLabel(job = {}) {
    if (job.supervisorReview?.status === "accepted") return "已验收·通过";
    if (job.supervisorReview?.status === "rejected") return "已验收·未通过";
    if (job.supervisorState === "rework_scheduled") return "待返工";
    if (job.status === "complete" && job.detail?.phase === "supervisor-review-ready") return "待验收";
    return shellTaskStatusLabel(job.status);
  }

  function shellTaskTimestamp(value, market = currentMarket()) {
    if (!value) return "暂无";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "暂无";
    const timezone = marketConfig[market]?.timezone || "Australia/Sydney";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  }

  function shellTaskProgress(job = {}) {
    return Math.max(0, Math.min(100, Number(job.progress || 0) * 100));
  }

  function shellTaskJobsForFilter(payload = shellTaskPayload) {
    const allJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    const filter = ["running", "queued", "paused", "complete", "recent24h"].includes(shellTaskFilter) ? shellTaskFilter : "running";
    return allJobs
      .filter((job) => filter === "recent24h"
        ? Date.parse(job.updatedAt || job.createdAt || "") >= Date.now() - 24 * 60 * 60 * 1000
        : filter === "complete"
          ? ["complete", "failed", "cancelled", "deferred"].includes(job.status)
          : job.status === filter)
      .sort((left, right) => filter === "queued" || filter === "paused"
        ? Number(left.queuePosition ?? 9999) - Number(right.queuePosition ?? 9999)
        : String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))
      .slice(0, filter === "recent24h" ? 500 : 8);
  }

  function renderShellTaskCenter(payload = shellTaskPayload, error = "") {
    shellTaskPayload = payload && typeof payload === "object" ? payload : { jobs: [], summary: {} };
    const summary = shellTaskPayload.summary || {};
    setText("homeTaskActiveCount", Number(summary.running || 0));
    setText("homeTaskQueuedCount", Number(summary.queued || 0));
    setText("homeTaskPausedCount", Number(summary.paused || 0));
    setText("homeTaskCompleteCount", Number(summary.recent24h ?? summary.completed ?? summary.complete ?? 0));
    document.querySelectorAll("[data-task-filter]").forEach((button) => {
      const active = button.dataset.taskFilter === shellTaskFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const panel = document.getElementById("homeTaskCenter");
    if (!panel) return;
    panel.classList.toggle("is-task-history", shellTaskFilter === "recent24h");
    const jobs = shellTaskJobsForFilter(shellTaskPayload);
    if (!jobs.length) {
      const filterLabel = shellTaskFilter === "running" ? "运行中的任务" : shellTaskFilter === "queued" ? "排队任务" : shellTaskFilter === "paused" ? "已暂停任务" : shellTaskFilter === "recent24h" ? "最近24小时任务" : "最近完成的任务";
      panel.innerHTML = error
        ? `<div class="home-task-empty home-task-error"><strong>任务中心暂时无法连接</strong><small>${shellEscape(error)}。系统会自动重试。</small></div>`
        : `<p class="muted home-task-empty">当前没有${filterLabel}。任务中心已完成读取，后台产生新任务后会自动显示。</p>`;
      return;
    }
    const warning = error ? `<small class="home-task-cache-note">当前显示最近一次本地记录 · ${shellEscape(error)}</small>` : "";
    const historyMeta = shellTaskFilter === "recent24h"
      ? `<div class="home-task-history-meta"><strong>最近24小时共 ${jobs.length} 条</strong><span>可滚动查看全部任务，点击任意任务查看执行阶段与训练结果审计。</span></div>`
      : "";
    panel.innerHTML = `${warning}${historyMeta}${jobs.map((job) => {
      const pct = shellTaskProgress(job);
      const status = job.status;
      const phase = job.detail?.phase || job.detail?.stage || job.detail?.message || job.error || (status === "queued" ? "等待后台资源" : "等待阶段更新");
      const result = job.resultSummary?.productionEligible === true ? "生产门控已满足"
        : status === "complete" && job.resultSummary?.available === false ? "已完成，但证据不足"
          : status === "failed" ? (job.failureCategory ? `失败分类：${job.failureCategory}` : "任务失败")
            : job.supervisorReview?.status === "accepted" ? `监工验收通过${job.supervisorReview.score != null ? ` · 得分 ${job.supervisorReview.score}` : ""}`
              : job.supervisorReview?.status === "rejected" ? `监工验收未通过${job.supervisorReview.score != null ? ` · 得分 ${job.supervisorReview.score}` : ""}`
            : status === "complete" && job.detail?.phase === "supervisor-review-ready" ? "训练产物已生成，等待确定性验收"
              : "结果待验收";
      const tone = status === "failed" ? "danger" : status === "complete" ? "good" : "active";
      const market = job.market || currentMarket();
      const createdAt = shellTaskTimestamp(job.createdAt, market);
      const startedAt = shellTaskTimestamp(job.startedAt, market);
      const updatedAt = shellTaskTimestamp(job.updatedAt || job.heartbeatAt, market);
      const durationStart = Date.parse(job.startedAt || job.createdAt || "");
      const durationEnd = Date.parse(job.updatedAt || job.heartbeatAt || "");
      const duration = Number.isFinite(durationStart) && Number.isFinite(durationEnd) && durationEnd >= durationStart
        ? `耗时 ${Math.max(1, Math.round((durationEnd - durationStart) / 60000))} 分钟`
        : "耗时暂无";
      const canStart = ["queued", "paused"].includes(status);
      const canPause = ["queued", "running"].includes(status);
      const canCancel = ["queued", "running", "paused"].includes(status);
      const canRestart = ["failed", "cancelled", "deferred"].includes(status);
      const action = (name, label) => `<button class="task-action${name === "start" || name === "resume" || name === "restart" ? " primary" : name === "cancel" ? " danger" : ""}" type="button" data-task-action="${name}" data-task-id="${shellEscape(job.id)}">${label}</button>`;
      const draggable = ["queued", "paused"].includes(status);
      return `<article class="home-task-row ${tone}" data-task-row data-task-id="${shellEscape(job.id)}" draggable="${draggable ? "true" : "false"}">
        <div class="home-task-main"><strong>${shellEscape(SHELL_TASK_LABELS[job.type] || job.type || "后台任务")}</strong><span>${shellEscape(market)} · ${shellEscape(shellTaskLifecycleLabel(job))}</span></div>
        <div class="home-task-progress"><div><i style="width:${pct.toFixed(1)}%"></i></div><strong>${status === "complete" ? "100%" : `${pct.toFixed(1)}%`}</strong></div>
        <div class="home-task-detail"><span>${shellEscape(phase)}</span><small>${shellEscape(result)}${updatedAt !== "暂无" ? ` · 最近更新 ${shellEscape(updatedAt)}` : ""}</small></div>
        <div class="home-task-time" aria-label="任务时间"><span>创建 ${shellEscape(createdAt)}</span><span>开始 ${shellEscape(startedAt)}</span><span>${shellEscape(duration)}</span></div>
        <div class="home-task-actions" aria-label="任务操作">${canStart ? action(status === "paused" ? "resume" : "start", status === "paused" ? "恢复" : "开始") : ""}${canPause ? action("pause", "暂停") : ""}${canCancel ? action("cancel", "取消") : ""}${canRestart ? action("restart", "重新启动") : ""}</div>
      </article>`;
    }).join("")}`;
  }

  async function loadShellTaskCenter() {
    if (appLoaded) return;
    const market = currentMarket();
    const cacheKey = `taskCenterSnapshot:${market}`;
    const cached = readJson(cacheKey, null);
    const controller = new AbortController();
    const timeout = globalScope.setTimeout(() => controller.abort(), 2800);
    try {
      // The homepage is the operations view. Read the shared queue across all
      // markets so switching the selected market cannot hide a live job.
      const recent = shellTaskFilter === "recent24h";
      const response = await globalScope.fetch(`/api/task-center?limit=${recent ? 120 : 80}${recent ? "&recentHours=24&includeSupervisor=false" : ""}&fast=true`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
      shellTaskPayload = payload;
      storageSet(cacheKey, JSON.stringify({
        jobs: Array.isArray(payload.jobs) ? payload.jobs.slice(0, recent ? 120 : 80) : [],
        summary: payload.summary || {},
        updatedAt: payload.updatedAt || new Date().toISOString(),
      }));
      renderShellTaskCenter(payload);
    } catch (error) {
      const cachedPayload = cached && typeof cached === "object" ? cached : { jobs: [], summary: {} };
      const timedOut = error?.name === "AbortError";
      renderShellTaskCenter(cachedPayload, timedOut ? "后台响应超过 2.8 秒" : "后台服务暂时不可用");
    } finally {
      globalScope.clearTimeout(timeout);
    }
  }

  async function runShellTaskAction(id, action, payload = {}) {
    if (!id || !action || appLoaded) return;
    try {
      const response = await globalScope.fetch(`/api/task-center/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`任务操作失败：${response.status}`);
      await loadShellTaskCenter();
    } catch (error) {
      renderShellTaskCenter(shellTaskPayload, error?.message || String(error));
    }
  }

  function shellTaskSubtaskRows(items = [], tone = "") {
    if (!Array.isArray(items) || !items.length) return `<p class="task-detail-empty">暂无记录</p>`;
    return items.map((item) => `<div class="task-subtask ${tone}"><span>${shellEscape(item.label || item.id || "阶段")}</span><small>${shellEscape(item.status || "pending")}</small></div>`).join("");
  }

  function shellTaskFlowMarkup(subtasks = {}) {
    const all = Array.isArray(subtasks.all) && subtasks.all.length
      ? subtasks.all
      : [
        ...(Array.isArray(subtasks.completed) ? subtasks.completed.map((item) => ({ ...item, status: "complete" })) : []),
        ...(Array.isArray(subtasks.current) ? subtasks.current.map((item) => ({ ...item, status: "running" })) : []),
        ...(Array.isArray(subtasks.pending) ? subtasks.pending : []),
      ];
    if (!all.length) return `<div class="task-flow-empty">暂无可展示的子任务流程</div>`;
    const labelFor = (status) => status === "complete" ? "已完成" : status === "running" ? "进行中" : "未开始";
    return `<div class="task-flow" role="list" aria-label="任务执行流程">${all.map((item, index) => {
      const status = item.status === "complete" ? "complete" : item.status === "running" ? "running" : "pending";
      const connector = index < all.length - 1 ? `<span class="task-flow-line ${status === "complete" ? "is-active" : ""}" aria-hidden="true"></span>` : "";
      return `<div class="task-flow-step ${status}" role="listitem"><span class="task-flow-dot" aria-hidden="true"></span><strong>${shellEscape(item.label || item.id || "阶段")}</strong><small>${labelFor(status)}</small></div>${connector}`;
    }).join("")}</div>`;
  }

  function shellTaskTrainingAuditMarkup(job = {}) {
    const result = job.result && typeof job.result === "object" ? job.result : {};
    const horizons = Array.isArray(result.horizons) ? result.horizons : [];
    if (!horizons.length) return "";
    const metric = (value, digits = 2, suffix = "") => Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}${suffix}` : "—";
    return `<section class="task-training-audit"><div class="task-detail-flow-title"><span>训练结果审计</span><small>${shellEscape(result.framework || "严格样本外训练")}</small></div><div class="task-training-audit-grid">${horizons.map((item) => {
      const m = item.directionMetrics || item.metrics || {};
      const r = item.rankingMetrics || item.ranking || {};
      return `<article><strong>${shellEscape(`${item.horizon || "—"}日模型`)}</strong><span>状态 ${item.productionEvidencePassed === true ? "可晋级" : "未晋级"}</span><small>样本 ${shellEscape(metric(m.samples, 0))} · 独立测试日 ${shellEscape(metric(m.testDates, 0))}</small><small>BA ${shellEscape(metric(m.balancedAccuracyPct, 2, "%"))} · 做多排名 Top10 ${shellEscape(metric(r.top10DirectionHitRatePct, 2, "%"))}</small><small>Brier ${shellEscape(metric(m.brierSkillScore, 4))} · ECE ${shellEscape(metric(m.ecePct, 2, "%"))}</small></article>`;
    }).join("")}</div></section>`;
  }

  async function openShellTaskDetail(id) {
    if (!id || appLoaded) return;
    const modal = document.createElement("div");
    modal.className = "task-detail-modal";
    modal.innerHTML = `<div class="task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="shellTaskDetailTitle">
      <div class="task-detail-head"><div><p>TASK DETAIL</p><h2 id="shellTaskDetailTitle">正在读取任务详情</h2></div><button type="button" class="task-detail-close" aria-label="关闭">×</button></div>
      <div class="task-detail-body"><div class="task-detail-loading">读取当前阶段与检查点…</div></div>
    </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector(".task-detail-close")?.addEventListener("click", close);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    try {
      const response = await globalScope.fetch(`/api/task-center/${encodeURIComponent(id)}`, { cache: "no-store" });
      const job = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(job.error || `请求失败：${response.status}`);
      const subtasks = job.subtasks || {};
      const title = `${SHELL_TASK_LABELS[job.type] || job.type || "后台任务"} · ${job.market || "GLOBAL"}`;
      modal.querySelector("#shellTaskDetailTitle").textContent = title;
      const pct = shellTaskProgress(job);
      const status = shellTaskLifecycleLabel(job);
      const timezoneMarket = job.market || currentMarket();
      modal.querySelector(".task-detail-body").innerHTML = `<div class="task-detail-summary">
        <span><b>状态</b>${shellEscape(status)}</span>
        <span><b>进度</b>${job.progress == null ? "等待阶段" : `${pct.toFixed(1)}%`}</span>
        <span><b>当前阶段</b>${shellEscape(job.detail?.phase || job.detail?.stage || "暂无")}</span>
        <span><b>更新时间</b>${shellEscape(shellTaskTimestamp(job.updatedAt || job.heartbeatAt, timezoneMarket))}</span>
      </div>
      <div class="task-detail-flow-title"><span>执行流程</span><small>从左到右查看已完成、进行中与未开始阶段</small></div>
      ${shellTaskFlowMarkup(subtasks)}
      ${shellTaskTrainingAuditMarkup(job)}
      <div class="task-detail-columns">
        <section><h3>当前执行</h3>${shellTaskSubtaskRows(subtasks.current, "current")}</section>
        <section><h3>已完成</h3>${shellTaskSubtaskRows(subtasks.completed, "complete")}</section>
        <section><h3>未完成</h3>${shellTaskSubtaskRows(subtasks.pending, "pending")}</section>
      </div>
      ${job.error ? `<div class="task-detail-error">${shellEscape(job.error)}</div>` : ""}
      <details class="task-detail-raw"><summary>查看检查点与审计记录</summary><pre>${shellEscape(JSON.stringify({ checkpoints: job.checkpoints || {}, history: job.history || [] }, null, 2))}</pre></details>`;
    } catch (error) {
      modal.querySelector(".task-detail-body").innerHTML = `<div class="task-detail-error">读取失败：${shellEscape(error?.message || String(error))}</div>`;
    }
  }

  function updateShellMarket() {
    const market = currentMarket();
    const config = marketConfig[market] || marketConfig.ASX;
    const clock = zonedClock(config);
    const summary = summaryForMarket(market);
    const hasSummary = Object.prototype.hasOwnProperty.call(summary, "readyCount");
    const snapshotTime = snapshotTimeForMarket(market);
    const watchCount = watchCountForMarket(market);
    const marketButton = document.getElementById("marketCycleButton");
    if (marketButton) {
      marketButton.textContent = market;
      marketButton.setAttribute("aria-label", `当前${config.label}，点击切换市场`);
      marketButton.title = `当前${config.label}，点击切换 ASX / US / CN`;
    }
    document.querySelectorAll("[data-market-select]").forEach((button) => {
      const active = button.dataset.marketSelect === market;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "true" : "false");
    });
    setText("brandMarketTitle", `${config.label} ${config.code}`);
    setText("brandSubtitle", "真实数据工作区");
    setText("clockLabel", config.clockLabel);
    setText("sydneyClock", clock.clock);
    setText("marketSession", clock.session);
    setText("snapshotTime", `本地快照：${formatSnapshotTime(snapshotTime)}`);
    setText("homeMarketCode", `${config.code} / ${config.currency}`);
    setText("homeMarketClock", `${clock.clock} · ${config.clockLabel}`);
    setText("homeSessionState", clock.session);
    setText("homeReadyCount", hasSummary ? Number(summary.readyCount || 0) : "—");
    setText("homeWatchCount", watchCount);
    setText("homeBuyCount", hasSummary ? Number(summary.buyCount || 0) : "—");
    setText("homeRiskCount", hasSummary ? Number(summary.riskCount || 0) : "—");
    setText("homeEvidenceState", summary.evidenceState || "本地快照优先");
    setText("homeSnapshotState", snapshotTime ? `快照 ${formatSnapshotTime(snapshotTime)}` : "等待快照");
    const sessionNode = document.getElementById("homeSessionState");
    if (sessionNode) sessionNode.dataset.tone = clock.tone;
    const symbolInput = document.getElementById("symbolInput");
    if (symbolInput) symbolInput.placeholder = config.symbolPlaceholder;
    return { market, config };
  }

  function flushPendingMarket() {
    if (!appLoaded || typeof globalScope.switchMarket !== "function" || marketCommitPromise || !pendingMarket) {
      return marketCommitPromise || Promise.resolve(false);
    }
    marketCommitPromise = (async () => {
      while (pendingMarket) {
        const next = pendingMarket;
        pendingMarket = null;
        await globalScope.switchMarket(next);
      }
      return true;
    })().catch((error) => {
      console.error("Direct market switch failed", error);
      return false;
    }).finally(() => {
      marketCommitPromise = null;
      if (pendingMarket) flushPendingMarket();
    });
    return marketCommitPromise;
  }

  function requestMarketSwitch(value) {
    const next = safeMarket(value);
    storageSet("selectedMarket", next);
    pendingMarket = next;
    updateShellMarket();
    loadShellTaskCenter();
    flushPendingMarket();
    return next;
  }

  function updatePageChrome(page) {
    const next = VALID_PAGES.has(page) ? page : "home";
    const market = currentMarket();
    const config = marketConfig[market] || marketConfig.ASX;
    document.documentElement.dataset.activeWorkspace = next;
    document.querySelectorAll("[data-quant-page]").forEach((section) => {
      section.hidden = section.dataset.quantPage !== next;
    });
    document.querySelectorAll("[data-page-target]").forEach((button) => {
      const active = button.dataset.pageTarget === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
      if (active) requestAnimationFrame(() => {
        const rail = button.closest("#workspaceRail");
        if (!rail) return;
        const itemRect = button.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const clipped = itemRect.left < railRect.left + 8 || itemRect.right > railRect.right - 8;
        if (clipped) button.scrollIntoView?.({ block: "nearest", inline: "center" });
      });
    });
    setText("marketTitle", next === "dashboard" ? config.title : `${config.label} · ${PAGE_LABELS[next] || PAGE_LABELS.home}`);
    document.title = next === "home" ? "Global Quant Watch" : `${config.label} · ${PAGE_LABELS[next]} · Global Quant Watch`;
    try {
      const url = new URL(globalScope.location.href);
      url.searchParams.set("page", next);
      globalScope.history.replaceState({ ...(globalScope.history.state || {}), page: next }, "", url);
    } catch (error) {
      console.warn("Unable to persist workspace URL", error);
    }
  }

  function startShellClock() {
    clearInterval(clockTimer);
    updateShellMarket();
    clockTimer = globalScope.setInterval(updateShellMarket, 1000);
  }

  function showHome() {
    storageSet("activeQuantPage", "home");
    storageSet("homeExperienceIntroduced:v1", "true");
    updatePageChrome("home");
    startShellClock();
    globalScope.QuantHomeMotion?.refresh();
  }

  function loadScript(id, src) {
    const existing = document.getElementById(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.async = false;
      script.addEventListener("load", () => resolve(script), { once: true });
      script.addEventListener("error", () => {
        script.remove();
        reject(new Error(`Unable to load ${src}`));
      }, { once: true });
      document.body.appendChild(script);
    });
  }

  function loadFullApp(page) {
    const target = VALID_PAGES.has(page) && page !== "home" ? page : "dashboard";
    if (appLoaded) return Promise.resolve(true);
    if (appPromise) return appPromise;
    storageSet("activeQuantPage", target);
    globalScope.clearInterval(shellTaskCenterTimer);
    shellTaskCenterTimer = null;
    storageSet("homeExperienceIntroduced:v1", "true");
    globalScope.__quantRequestedWorkspace = target;
    clearInterval(clockTimer);
    updatePageChrome(target);
    document.querySelectorAll("[data-quant-page]").forEach((section) => {
      section.hidden = true;
    });
    setText("status", `正在打开${PAGE_LABELS[target]}...`);
    document.documentElement.dataset.appState = "loading";
    const task = globalScope.QuantUI?.beginTask?.("加载完整工作台");
    // Keep the requested workspace visible while the full controller script is
    // loading. Hiding every section here made a slow script download look like
    // a frozen page and also left navigation with no visible feedback.
    const targetSection = document.querySelector(`[data-quant-page="${target}"]`);
    if (targetSection) {
      document.querySelectorAll("[data-quant-page]").forEach((section) => {
        section.hidden = section !== targetSection;
      });
      targetSection.setAttribute("aria-busy", "true");
    }
    appPromise = (async () => {
      await Promise.all([
        loadScript("quant-chart-math", "/frontend/charts/math.js?v=20260714-workspace-fast-1"),
        loadScript("quant-http-runtime", "/frontend/runtime/http.js?v=20260717-stable-load-2"),
      ]);
      await loadScript("quant-full-app", "/app.js?v=20260818-task-history-4");
      appLoaded = true;
      globalScope.__quantAppLoaded = true;
      document.documentElement.dataset.appState = "ready";
      targetSection?.removeAttribute("aria-busy");
      await flushPendingMarket();
      return true;
    })().catch((error) => {
      console.error("Full workspace load failed", error);
      appPromise = null;
      document.documentElement.dataset.appState = "error";
      targetSection?.removeAttribute("aria-busy");
      showHome();
      setText("homeEvidenceState", "工作台加载失败");
      return false;
    }).finally(() => task?.finish?.());
    return appPromise;
  }

  function bindShellNavigation() {
    document.querySelectorAll("[data-page-target]").forEach((button) => {
      button.addEventListener("click", (event) => {
        if (appLoaded) return;
        event.preventDefault();
        const target = button.dataset.pageTarget || "home";
        if (target === "home") showHome();
        else loadFullApp(target);
      });
    });
    document.querySelectorAll("[data-home-target]").forEach((button) => {
      button.addEventListener("click", (event) => {
        if (appLoaded) return;
        event.preventDefault();
        loadFullApp(button.dataset.homeTarget || "dashboard");
      });
    });
    document.getElementById("homeOpenDashboard")?.addEventListener("click", (event) => {
      if (appLoaded) return;
      event.preventDefault();
      loadFullApp("dashboard");
    });
    document.getElementById("homeOpenStrategy")?.addEventListener("click", (event) => {
      if (appLoaded) return;
      event.preventDefault();
      loadFullApp("strategy");
    });
    document.getElementById("marketCycleButton")?.addEventListener("click", (event) => {
      event.preventDefault();
      const market = currentMarket();
      const index = Math.max(0, MARKET_ORDER.indexOf(market));
      requestMarketSwitch(MARKET_ORDER[(index + 1) % MARKET_ORDER.length]);
    });
    document.getElementById("homeBrandButton")?.addEventListener("click", (event) => {
      if (appLoaded) return;
      event.preventDefault();
      showHome();
    });
    document.querySelectorAll("[data-task-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        shellTaskFilter = button.dataset.taskFilter || "running";
        renderShellTaskCenter(shellTaskPayload);
        if (shellTaskFilter === "recent24h") void loadShellTaskCenter();
      });
    });
    document.getElementById("homeTaskCenter")?.addEventListener("click", (event) => {
      const action = event.target.closest("[data-task-action]");
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        void runShellTaskAction(action.dataset.taskId, action.dataset.taskAction);
        return;
      }
      const row = event.target.closest("[data-task-row]");
      if (row) {
        event.preventDefault();
        void openShellTaskDetail(row.dataset.taskId);
      }
    });
    document.getElementById("homeTaskCenter")?.addEventListener("dragstart", (event) => {
      const row = event.target.closest("[data-task-row][draggable=\"true\"]");
      if (!row) return;
      event.dataTransfer?.setData("text/plain", row.dataset.taskId || "");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
      }
      row.classList.add("is-dragging");
    });
    document.getElementById("homeTaskCenter")?.addEventListener("dragend", (event) => {
      event.target.closest("[data-task-row]")?.classList.remove("is-dragging");
      document.querySelectorAll("#homeTaskCenter .task-drop-target").forEach((node) => node.classList.remove("task-drop-target"));
    });
    document.getElementById("homeTaskCenter")?.addEventListener("dragover", (event) => {
      const target = event.target.closest("[data-task-row][draggable=\"true\"]");
      if (!target) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      document.querySelectorAll("#homeTaskCenter .task-drop-target").forEach((node) => node.classList.remove("task-drop-target"));
      target.classList.add("task-drop-target");
    });
    document.getElementById("homeTaskCenter")?.addEventListener("drop", (event) => {
      event.preventDefault();
      const target = event.target.closest("[data-task-row][draggable=\"true\"]");
      const draggedId = event.dataTransfer?.getData("text/plain");
      if (!target || !draggedId || target.dataset.taskId === draggedId) return;
      const rows = [...document.querySelectorAll('#homeTaskCenter [data-task-row][draggable="true"]')];
      const position = rows.findIndex((row) => row.dataset.taskId === target.dataset.taskId);
      if (position >= 0) void runShellTaskAction(draggedId, "move", { position });
      document.querySelectorAll("#homeTaskCenter .task-drop-target").forEach((node) => node.classList.remove("task-drop-target"));
    });
    const marketMenuButton = document.getElementById("marketMenuButton");
    const marketMenu = document.getElementById("marketMenu");
    if (marketMenu && marketMenu.parentElement !== document.body) {
      marketMenu.dataset.portaled = "true";
      document.body.appendChild(marketMenu);
    }
    const positionMarketMenu = () => {
      if (!marketMenu || !marketMenuButton || marketMenu.hidden) return;
      const triggerRect = marketMenuButton.getBoundingClientRect();
      const switcherRect = document.querySelector(".market-switcher")?.getBoundingClientRect() || triggerRect;
      const menuWidth = marketMenu.offsetWidth || 176;
      const viewportPadding = 12;
      const alignRight = globalScope.innerWidth <= 680;
      const preferredLeft = alignRight ? triggerRect.right - menuWidth : switcherRect.left;
      const left = Math.min(
        Math.max(viewportPadding, preferredLeft),
        Math.max(viewportPadding, globalScope.innerWidth - menuWidth - viewportPadding),
      );
      marketMenu.style.top = `${Math.round(triggerRect.bottom + 9)}px`;
      marketMenu.style.left = `${Math.round(left)}px`;
      marketMenu.style.right = "auto";
    };
    const setMarketMenuOpen = (opening, { focusFirst = false } = {}) => {
      if (!marketMenu || !marketMenuButton) return;
      marketMenu.hidden = !opening;
      marketMenu.dataset.open = opening ? "true" : "false";
      marketMenuButton.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) {
        positionMarketMenu();
        globalScope.requestAnimationFrame?.(positionMarketMenu);
      }
      if (opening && focusFirst) marketMenu.querySelector("[data-market-select]")?.focus();
    };
    marketMenuButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const opening = marketMenu?.hidden !== false;
      setMarketMenuOpen(opening);
    });
    marketMenuButton?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      setMarketMenuOpen(true, { focusFirst: true });
    });
    marketMenu?.querySelectorAll("[data-market-select]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const next = safeMarket(button.dataset.marketSelect);
        setMarketMenuOpen(false);
        requestMarketSwitch(next);
      });
    });
    document.addEventListener("click", (event) => {
      if (!marketMenu || marketMenu.hidden) return;
      if (marketMenu.contains(event.target) || marketMenuButton?.contains(event.target)) return;
      setMarketMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !marketMenu || marketMenu.hidden) return;
      setMarketMenuOpen(false);
      marketMenuButton?.focus();
    });
    globalScope.addEventListener("resize", positionMarketMenu, { passive: true });
    globalScope.addEventListener("scroll", positionMarketMenu, { passive: true });
  }

  function initialPage() {
    const params = new URLSearchParams(globalScope.location.search || "");
    const requested = params.get("page");
    if (params.has("safe") || storageGet("quantWatchBootPending") === "true") return "dashboard";
    if (requested && VALID_PAGES.has(requested)) return requested;
    const stored = storageGet("activeQuantPage") || "home";
    const saved = stored === "research" ? "features" : stored;
    if (storageGet("homeExperienceIntroduced:v1") !== "true") return "home";
    return VALID_PAGES.has(saved) ? saved : "home";
  }

  function bootShell() {
    if (!marketConfig.ASX) {
      setText("status", "市场配置加载失败");
      return;
    }
    bindShellNavigation();
    const page = initialPage();
    if (page === "home") {
      showHome();
      loadShellTaskCenter();
      shellTaskCenterTimer = globalScope.setInterval(() => loadShellTaskCenter(), 6000);
    }
    else loadFullApp(page);
  }

  globalScope.QuantShell = Object.freeze({ loadFullApp, showHome, updateShellMarket, requestMarketSwitch });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootShell, { once: true });
  else bootShell();
}(typeof window !== "undefined" ? window : globalThis));
