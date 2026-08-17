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
    appPromise = (async () => {
      await Promise.all([
        loadScript("quant-chart-math", "/frontend/charts/math.js?v=20260714-workspace-fast-1"),
        loadScript("quant-http-runtime", "/frontend/runtime/http.js?v=20260717-stable-load-2"),
      ]);
      await loadScript("quant-full-app", "/app.js?v=20260812-exact-stage-one-v91");
      appLoaded = true;
      globalScope.__quantAppLoaded = true;
      document.documentElement.dataset.appState = "ready";
      await flushPendingMarket();
      return true;
    })().catch((error) => {
      console.error("Full workspace load failed", error);
      appPromise = null;
      document.documentElement.dataset.appState = "error";
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
    if (page === "home") showHome();
    else loadFullApp(page);
  }

  globalScope.QuantShell = Object.freeze({ loadFullApp, showHome, updateShellMarket, requestMarketSwitch });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootShell, { once: true });
  else bootShell();
}(typeof window !== "undefined" ? window : globalThis));
