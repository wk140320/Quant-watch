(function installQuantHttp(globalScope) {
  "use strict";

  function localBackendOfflineMessage(url) {
    return `本地后端未连接：${url || "API"}。请确认 8787 服务正在运行，然后刷新页面。`;
  }

  function normalizeApiErrorMessage(message, url, options) {
    const settings = options || {};
    const text = String(message || "读取失败");
    if (settings.network) return localBackendOfflineMessage(url);
    if (/quota has been exceeded|quota exceeded|The quota has been exceeded/i.test(text)) {
      return "外部数据源额度已用尽；已优先保留本地真实快照/缓存，稍后或更换数据源后再刷新。";
    }
    if (/Load failed|Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(text)) {
      return `真实数据源请求失败：${text}`;
    }
    return text;
  }

  async function requestJson(url, options) {
    const settings = options || {};
    const method = String(settings.method || "GET").toUpperCase();
    const showProgress = settings.progress === true || (settings.progress !== false && method !== "GET");
    const uiTask = showProgress ? globalScope.QuantUI?.beginTask(`${method} ${url}`) : null;
    let response;
    try {
      response = await globalScope.fetch(url, settings);
    } catch (error) {
      throw new Error(normalizeApiErrorMessage(error?.message || error, url, { network: true }));
    } finally {
      uiTask?.finish();
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(normalizeApiErrorMessage(payload.error || `请求失败：${response.status}`, url));
    }
    return payload;
  }

  globalScope.QuantHttp = Object.freeze({
    localBackendOfflineMessage,
    normalizeApiErrorMessage,
    requestJson,
  });
}(typeof window !== "undefined" ? window : globalThis));
