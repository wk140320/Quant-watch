(function installQuantUiRuntime() {
  "use strict";

  const root = document.documentElement;
  const activeTasks = new Map();
  let taskSequence = 0;
  let progressHideTimer = null;

  function ensureProgressRail() {
    let rail = document.getElementById("uiProgressRail");
    if (rail) return rail;
    rail = document.createElement("div");
    rail.id = "uiProgressRail";
    rail.className = "ui-progress-rail";
    rail.setAttribute("aria-hidden", "true");
    rail.innerHTML = '<i class="ui-progress-track"></i>';
    document.body.prepend(rail);
    return rail;
  }

  function syncTaskState() {
    ensureProgressRail();
    const active = activeTasks.size > 0;
    clearTimeout(progressHideTimer);
    if (active) {
      root.classList.add("ui-network-active");
      return;
    }
    progressHideTimer = setTimeout(() => root.classList.remove("ui-network-active"), 180);
  }

  function beginTask(label, options) {
    const settings = options || {};
    const id = `${Date.now()}:${++taskSequence}`;
    activeTasks.set(id, { label: String(label || "task"), startedAt: Date.now() });
    if (settings.button) setButtonBusy(settings.button, true);
    syncTaskState();
    let finished = false;
    return {
      id,
      finish() {
        if (finished) return;
        finished = true;
        activeTasks.delete(id);
        if (settings.button) setButtonBusy(settings.button, false);
        syncTaskState();
      },
    };
  }

  function setButtonBusy(button, busy) {
    if (!button) return;
    button.classList.toggle("is-busy", Boolean(busy));
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }

  function syncDisabledButton(button) {
    if (!(button instanceof HTMLButtonElement)) return;
    const isAction = /^(refresh|run|load|save|submit|send|check|confirm|toggle)/i.test(button.id || "");
    if (!isAction || button.classList.contains("range-btn")) return;
    setButtonBusy(button, button.disabled);
  }

  function observeBusyButtons() {
    document.querySelectorAll("button:disabled").forEach(syncDisabledButton);
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => syncDisabledButton(mutation.target));
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
  }

  function transitionPage(update, pageName) {
    root.classList.add("ui-page-switching");
    const applyUpdate = () => {
      update();
      const activeSections = document.querySelectorAll("[data-quant-page]:not([hidden])");
      activeSections.forEach((section) => {
        section.classList.remove("ui-page-enter");
      });
      requestAnimationFrame(() => activeSections.forEach((section) => section.classList.add("ui-page-enter")));
      root.dataset.activeWorkspace = String(pageName || "dashboard");
      const activeNav = document.querySelector('[data-page-target].active');
      activeNav?.scrollIntoView?.({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "center" });
    };
    const complete = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => root.classList.remove("ui-page-switching"));
      });
    };
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    try {
      applyUpdate();
    } finally {
      complete();
    }
  }

  function runFrameTasks(tasks, options) {
    const queue = Array.isArray(tasks) ? tasks.filter(Boolean).slice() : [];
    const budgetMs = Math.max(4, Number(options && options.budgetMs) || 8);
    return new Promise((resolve) => {
      function drain() {
        const startedAt = performance.now();
        while (queue.length && performance.now() - startedAt < budgetMs) {
          const task = queue.shift();
          try {
            task();
          } catch (error) {
            console.error("Deferred UI task failed", error);
          }
        }
        if (queue.length) requestAnimationFrame(drain);
        else resolve();
      }
      requestAnimationFrame(drain);
    });
  }

  function showSkeletons(container, count) {
    if (!container || container.children.length) return false;
    const total = Math.max(2, Math.min(8, Number(count) || 4));
    container.setAttribute("aria-busy", "true");
    container.innerHTML = Array.from({ length: total }, (_, index) => `
      <article class="stock-card ui-skeleton-card" aria-hidden="true" style="--skeleton-index:${index}">
        <span class="ui-skeleton-line wide"></span>
        <span class="ui-skeleton-line price"></span>
        <span class="ui-skeleton-grid"><i></i><i></i><i></i><i></i></span>
        <span class="ui-skeleton-line"></span>
      </article>
    `).join("");
    return true;
  }

  function clearBusy(container) {
    if (container) container.removeAttribute("aria-busy");
  }

  function setStatusTone(message) {
    const status = document.getElementById("status");
    if (!status) return;
    const text = String(message || "");
    const isBusy = /正在|读取|加载|分析|同步|刷新|恢复|排队|后台/.test(text)
      && !/完成|失败|不可用|已停止|已更新/.test(text);
    const isError = /失败|中断|错误|不可用|额度已用尽/.test(text);
    status.dataset.tone = isError ? "error" : isBusy ? "busy" : "ready";
    status.title = text;
  }

  function revealApp() {
    ensureProgressRail();
    observeBusyButtons();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.add("ui-ready"));
    });
  }

  window.QuantUI = Object.freeze({
    beginTask,
    clearBusy,
    runFrameTasks,
    setButtonBusy,
    setStatusTone,
    showSkeletons,
    transitionPage,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", revealApp, { once: true });
  } else {
    revealApp();
  }
}());
