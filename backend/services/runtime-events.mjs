function createRuntimeEventHub({ historyLimit = 240 } = {}) {
  const limit = Math.max(1, Number(historyLimit) || 240);
  const history = [];
  const clients = new Set();
  let nextId = 0;

  function matchesMarket(event, market) {
    if (!market) return true;
    const payloadMarket = event?.payload?.market || event?.payload?.job?.market || null;
    return !payloadMarket || String(payloadMarket).toUpperCase() === String(market).toUpperCase();
  }

  function writeEvent(client, event) {
    if (!matchesMarket(event, client.market)) return;
    try {
      client.response.write(`id: ${event.id}\n`);
      client.response.write(`event: ${event.type}\n`);
      client.response.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }

  function publish(type, payload = {}) {
    const event = {
      id: ++nextId,
      type: String(type || "runtime.event"),
      payload: payload && typeof payload === "object" ? payload : { value: payload },
      createdAt: new Date().toISOString(),
    };
    history.push(event);
    while (history.length > limit) history.shift();
    for (const client of clients) writeEvent(client, event);
    return event;
  }

  function summary({ recentLimit = 20 } = {}) {
    const count = Math.max(0, Number(recentLimit) || 0);
    return {
      clients: clients.size,
      lastEventId: nextId,
      recent: count ? history.slice(-count) : [],
    };
  }

  function subscribe(request, response, { since = 0, market = null } = {}) {
    const client = { request, response, market: market || null };
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    response.write(": connected\n\n");
    const sinceId = Number(since) || 0;
    for (const event of history) {
      if (event.id > sinceId) writeEvent(client, event);
    }
    clients.add(client);
    const heartbeat = setInterval(() => {
      try {
        response.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        clients.delete(client);
      }
    }, 25_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(client);
    };
    request.once("close", cleanup);
    request.once("aborted", cleanup);
    response.once("close", cleanup);
    return cleanup;
  }

  return { publish, summary, subscribe };
}

export { createRuntimeEventHub };
