(function installHomeMotion(globalScope) {
  "use strict";

  const reducedMotion = globalScope.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  let hero = null;
  let pointerFrame = null;

  function setHeroPointer(event) {
    if (!hero || reducedMotion) return;
    const rect = hero.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2));
    const y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2));
    if (pointerFrame) cancelAnimationFrame(pointerFrame);
    pointerFrame = requestAnimationFrame(() => {
      hero.style.setProperty("--home-parallax-x", `${(-x * 9).toFixed(2)}px`);
      hero.style.setProperty("--home-parallax-y", `${(-y * 6).toFixed(2)}px`);
      hero.style.setProperty("--home-light-x", `${((x + 1) * 50).toFixed(1)}%`);
      hero.style.setProperty("--home-light-y", `${((y + 1) * 50).toFixed(1)}%`);
    });
  }

  function resetHeroPointer() {
    if (!hero) return;
    hero.style.setProperty("--home-parallax-x", "0px");
    hero.style.setProperty("--home-parallax-y", "0px");
  }

  function observeReveals() {
    const rows = document.querySelectorAll(".reveal-on-scroll");
    if (reducedMotion || !("IntersectionObserver" in globalScope)) {
      rows.forEach((row) => row.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.14 });
    rows.forEach((row) => observer.observe(row));
  }

  function refresh() {
    const nextHero = document.querySelector(".home-hero");
    if (hero !== nextHero) {
      hero?.removeEventListener("pointermove", setHeroPointer);
      hero?.removeEventListener("pointerleave", resetHeroPointer);
      hero = nextHero;
      hero?.addEventListener("pointermove", setHeroPointer, { passive: true });
      hero?.addEventListener("pointerleave", resetHeroPointer, { passive: true });
    }
    observeReveals();
  }

  globalScope.QuantHomeMotion = Object.freeze({ refresh });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh, { once: true });
  else refresh();
}(typeof window !== "undefined" ? window : globalThis));
