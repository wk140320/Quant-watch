(function installQuantIcons(globalScope) {
  "use strict";

  let scheduled = false;
  let loading = false;

  function loadRuntime() {
    if (globalScope.lucide?.createIcons || loading) return;
    loading = true;
    const script = document.createElement("script");
    script.src = "/frontend/vendor/lucide/lucide.min.js?v=1.8.0";
    script.async = true;
    script.addEventListener("load", renderIcons, { once: true });
    script.addEventListener("error", () => { loading = false; }, { once: true });
    document.head.appendChild(script);
  }

  function renderIcons() {
    scheduled = false;
    if (!globalScope.lucide?.createIcons) {
      loadRuntime();
      return;
    }
    try {
      globalScope.lucide.createIcons({
        attrs: {
          width: 15,
          height: 15,
          "stroke-width": 1.8,
          "aria-hidden": "true",
        },
      });
    } catch (error) {
      console.warn("Local Lucide icon rendering skipped", error);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(renderIcons);
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => [...mutation.addedNodes].some((node) => node.nodeType === 1 && (node.matches?.("[data-lucide]") || node.querySelector?.("[data-lucide]"))))) schedule();
  });

  const lazyStart = () => (globalScope.requestIdleCallback || globalScope.setTimeout)(schedule, { timeout: 1200 });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", lazyStart, { once: true });
  else lazyStart();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})(window);
