(function installQuantStorage(globalScope) {
  "use strict";

  function browserStorage() {
    try {
      return globalScope.localStorage || null;
    } catch {
      return null;
    }
  }

  function createSafeStorage(target = browserStorage()) {
    function getItem(key) {
      try {
        return target?.getItem(String(key)) ?? null;
      } catch {
        return null;
      }
    }

    function setItem(key, value) {
      try {
        target?.setItem(String(key), String(value));
        return Boolean(target);
      } catch {
        return false;
      }
    }

    function removeItem(key) {
      try {
        target?.removeItem(String(key));
        return Boolean(target);
      } catch {
        return false;
      }
    }

    function readJson(key, fallback, options = {}) {
      const raw = getItem(key);
      if (!raw) return fallback;
      const maxChars = Math.max(1, Number(options.maxChars || 240_000));
      if (raw.length > maxChars) return fallback;
      try {
        const value = JSON.parse(raw);
        return value == null ? fallback : value;
      } catch {
        if (options.removeInvalid !== false) removeItem(key);
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        return setItem(key, JSON.stringify(value));
      } catch {
        return false;
      }
    }

    return { getItem, readJson, removeItem, setItem, writeJson };
  }

  globalScope.QuantStorage = {
    ...createSafeStorage(),
    createSafeStorage,
  };
})(typeof window !== "undefined" ? window : globalThis);
