const state = {
  status: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function formatTime(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatMinutes(ms) {
  const minutes = Math.round(Number(ms || 0) / 60000);
  return `${minutes || 0} 分钟`;
}

function tag(text, tone = "") {
  return `<span class="tag ${tone}">${escapeHtml(text)}</span>`;
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

function currentConfig() {
  return state.status?.config || null;
}

function setBusy(busy) {
  state.busy = busy;
  ["toggleBackend", "runOnce", "saveSchedule", "refreshStatus"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = busy;
  });
}

function renderSummary(status) {
  const config = status.config || {};
  const enabled = config.enabled !== false;
  const running = Boolean(status.state?.running);
  $("enabledState").textContent = enabled ? "已开启" : "已关闭";
  $("enabledHint").textContent = enabled ? "交易时段自动监控、训练和提醒" : "不会抓行情、不会训练、不会推送";
  $("runningState").textContent = running ? "运行中" : "空闲";
  $("lastRunAt").textContent = `上次运行：${formatTime(status.runtime?.lastRunAt || status.state?.lastRunAt)}`;
  $("dueJobs").textContent = String(status.dueJobs || 0);

  const push = status.push || {};
  const mobileConfigured = push.mobileWebhookConfigured || push.barkConfigured || push.pushPlusConfigured || push.serverChanConfigured;
  $("pushState").textContent = mobileConfigured ? "已配置" : "未配置";
  $("pushHint").textContent = mobileConfigured ? "触发信号会推送到手机" : "只保留本机通知和本地日志";

  const toggle = $("toggleBackend");
  toggle.textContent = enabled ? "关闭后台" : "开启后台";
  toggle.classList.toggle("good", !enabled);
  toggle.classList.toggle("danger", enabled);
  $("statusText").textContent = `${status.version || "local"} · ${enabled ? "后台监控已启用" : "后台监控已暂停"} · ${running ? "当前正在处理任务" : "当前空闲"}`;
}

function renderControls(status) {
  const config = status.config || {};
  $("holdingMinutes").value = Math.round(Number(config.refresh?.holdingMs || 300000) / 60000);
  $("watchMinutes").value = Math.round(Number(config.refresh?.watchMs || 900000) / 60000);
  $("trainingMinutes").value = Math.round(Number(config.refresh?.trainingMs || 300000) / 60000);
  $("trainingSymbols").value = Number(config.training?.symbolLimit || 3);
}

function renderSessions(status) {
  const sessions = status.sessions || {};
  $("sessionList").innerHTML = Object.entries(sessions).map(([market, session]) => `
    <div class="row">
      <div class="row-top">
        <strong>${escapeHtml(market)}</strong>
        ${tag(session.open ? "交易中" : session.weekend ? "周末" : "休市", session.open ? "good" : "warn")}
      </div>
      <div class="muted-line">${escapeHtml(session.localTime || "--")} · ${escapeHtml(session.timeZone || "")}</div>
    </div>
  `).join("") || `<div class="muted-line">暂无市场时段信息。</div>`;
}

function renderBudget(status) {
  const used = status.budget?.used || {};
  const limits = status.budgetLimits || {};
  const rows = [
    ["marketCalls", "行情调用"],
    ["factorCalls", "因子调用"],
    ["trainingCalls", "分钟训练"],
    ["aiCalls", "AI复核"],
    ["notifications", "提醒推送"],
  ];
  $("budgetList").innerHTML = rows.map(([key, label]) => {
    const current = Number(used[key] || 0);
    const limit = Number(limits[key] || 0);
    const pct = limit > 0 ? Math.round(current / limit * 100) : 0;
    const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "good";
    return `
      <div class="row">
        <div class="row-top">
          <strong>${label}</strong>
          ${tag(`${current}/${limit}`, tone)}
        </div>
        <div class="muted-line">今日预算使用 ${pct}%${key === "marketCalls" ? ` · 训练预留 ${Number(limits.trainingMarketReserve || 0)} 次` : ""}</div>
      </div>
    `;
  }).join("");
}

function renderModels(status) {
  const models = status.intradayModels || {};
  $("modelList").innerHTML = Object.entries(models).map(([market, model]) => `
    <div class="row">
      <div class="row-top">
        <strong>${escapeHtml(market)}</strong>
        ${tag(model.available ? "ready" : "pending", model.available ? "good" : "warn")}
      </div>
      <div class="muted-line">样本 ${Number(model.sampleCount || 0)} · 更新 ${formatTime(model.updatedAt)}</div>
      <div class="muted-line">${model.test ? `测试方向命中 ${Number(model.test.directionalAccuracy || 0).toFixed(0)}% · MAE ${Number(model.test.mae || 0).toFixed(3)}` : escapeHtml(model.reason || "等待训练")}</div>
    </div>
  `).join("") || `<div class="muted-line">暂无分钟模型。</div>`;
}

function renderPools(status) {
  const markets = status.config?.markets || {};
  $("poolList").innerHTML = Object.entries(markets).map(([market, config]) => `
    <div class="row">
      <div class="row-top">
        <strong>${escapeHtml(market)}</strong>
        ${tag(`持仓 ${Number(config.portfolio?.length || 0)}`)}
      </div>
      <div class="muted-line">监控 ${Number(config.watchlist?.length || 0)} 只 · 持仓刷新 ${formatMinutes(status.config?.refresh?.holdingMs)} · 监控刷新 ${formatMinutes(status.config?.refresh?.watchMs)}</div>
    </div>
  `).join("") || `<div class="muted-line">暂无监控池。打开主控制台保存自选或持仓后会同步到后台。</div>`;
}

function renderResults(status) {
  const results = status.runtime?.lastResults || status.state?.lastAnalyses || [];
  $("resultList").innerHTML = results.length ? results.slice(0, 30).map((row) => {
    const action = row.action || (row.error ? "ERROR" : "WAIT");
    const tone = row.error ? "danger" : /BUY/.test(action) ? "good" : /SELL|AVOID|ERROR/.test(action) ? "danger" : "warn";
    return `
      <div class="result-row">
        <div class="result-top">
          <strong>${escapeHtml(row.symbol || "--")} · ${escapeHtml(row.market || "")}</strong>
          ${tag(action, tone)}
        </div>
        <div class="muted-line">${row.error ? escapeHtml(row.error) : `置信 ${Math.round(Number(row.confidence || 0))}% · 预估 ${Number(row.projectedFinalReturn || 0).toFixed(2)}% · 价格 ${Number(row.price || 0).toFixed(3)}`}</div>
        <div class="muted-line">${escapeHtml(row.source || row.tier || "backend")} · ${formatTime(row.updatedAt)}</div>
      </div>
    `;
  }).join("") : `<div class="muted-line">暂无后台运行结果。交易时段或手动运行后会显示。</div>`;
}

function render(status) {
  state.status = status;
  renderSummary(status);
  renderControls(status);
  renderSessions(status);
  renderBudget(status);
  renderModels(status);
  renderPools(status);
  renderResults(status);
}

async function refreshStatus() {
  try {
    const status = await fetchJson("/api/backend-monitor/status");
    render(status);
  } catch (error) {
    $("statusText").textContent = `读取失败：${error.message}`;
  }
}

async function saveConfig(nextConfig) {
  const saved = await fetchJson("/api/backend-monitor/config", {
    method: "POST",
    body: JSON.stringify(nextConfig),
  });
  await refreshStatus();
  return saved;
}

async function toggleBackend() {
  const config = currentConfig();
  if (!config) return;
  setBusy(true);
  try {
    const next = JSON.parse(JSON.stringify(config));
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
  const config = currentConfig();
  if (!config) return;
  setBusy(true);
  try {
    const next = JSON.parse(JSON.stringify(config));
    next.source = "monitor-app";
    next.refresh = {
      ...(next.refresh || {}),
      holdingMs: Math.max(1, Number($("holdingMinutes").value || 5)) * 60000,
      watchMs: Math.max(1, Number($("watchMinutes").value || 15)) * 60000,
      trainingMs: Math.max(1, Number($("trainingMinutes").value || 5)) * 60000,
    };
    next.training = {
      ...(next.training || {}),
      enabled: true,
      symbolLimit: Math.max(1, Math.min(5, Number($("trainingSymbols").value || 3))),
      interval: next.training?.interval || "5m",
      range: next.training?.range || "5d",
    };
    await saveConfig(next);
    $("saveHint").textContent = "频率已保存。";
  } catch (error) {
    $("saveHint").textContent = `保存失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function runOnce() {
  setBusy(true);
  try {
    $("statusText").textContent = "正在触发后台运行一次...";
    await fetchJson("/api/backend-monitor/run", { method: "POST", body: "{}" });
    await refreshStatus();
  } catch (error) {
    $("statusText").textContent = `手动运行失败：${error.message}`;
  } finally {
    setBusy(false);
  }
}

$("refreshStatus").addEventListener("click", refreshStatus);
$("toggleBackend").addEventListener("click", toggleBackend);
$("saveSchedule").addEventListener("click", saveSchedule);
$("runOnce").addEventListener("click", runOnce);

refreshStatus();
setInterval(refreshStatus, 15000);
