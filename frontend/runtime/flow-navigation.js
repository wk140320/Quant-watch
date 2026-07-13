(function installFlowNavigation() {
  "use strict";

  function prefersReducedMotion() {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  }

  function centerActiveItem(rail) {
    const active = rail.querySelector("[data-page-target].active");
    active?.scrollIntoView?.({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }

  function installRail(rail) {
    if (!rail || rail.dataset.flowReady === "true") return;
    rail.dataset.flowReady = "true";
    let pointerId = null;
    let startX = 0;
    let startScrollLeft = 0;
    let moved = false;

    rail.addEventListener("wheel", (event) => {
      if (rail.scrollWidth <= rail.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      rail.scrollLeft += delta;
    }, { passive: false });

    rail.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = rail.scrollLeft;
      moved = false;
      rail.classList.add("is-dragging");
      rail.setPointerCapture?.(pointerId);
    });

    rail.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      const delta = event.clientX - startX;
      if (Math.abs(delta) > 5) moved = true;
      rail.scrollLeft = startScrollLeft - delta;
    });

    const finishDrag = (event) => {
      if (pointerId == null || (event.pointerId != null && event.pointerId !== pointerId)) return;
      rail.releasePointerCapture?.(pointerId);
      pointerId = null;
      rail.classList.remove("is-dragging");
      requestAnimationFrame(() => centerActiveItem(rail));
    };
    rail.addEventListener("pointerup", finishDrag);
    rail.addEventListener("pointercancel", finishDrag);
    rail.addEventListener("click", (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }, true);

    const observer = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => mutation.attributeName === "class")) return;
      requestAnimationFrame(() => centerActiveItem(rail));
    });
    rail.querySelectorAll("[data-page-target]").forEach((item) => {
      observer.observe(item, { attributes: true, attributeFilter: ["class"] });
    });
    requestAnimationFrame(() => centerActiveItem(rail));
  }

  function boot() {
    installRail(document.getElementById("workspaceRail"));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  globalThis.QuantFlowNavigation = Object.freeze({ centerActiveItem });
}());
