function createRuntimeEventHub(options = {}) {
  const clients = new Set();
  const history = [];
  const historyLimit = Math.max(20, Number(options.historyLimit || 200));
  let sequence = 0;

  function publish(type, payload = {}) {
    const event = {
      id: ++sequence,
      type: String(type || "runtime"),
      createdAt: new Date().toISOString(),
      payload,
    };
    history.push(event);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    const body = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of [...clients]) {
      try {
        client.write(body);
      } catch {
        clients.delete(client);
      }
    }
    return event;
  }

  function subscribe(req, res, options = {}) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const since = Number(options.since || req.headers["last-event-id"] || 0);
    history.filter((event) => event.id > since).forEach((event) => {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on("close", close);
    req.on("error", close);
  }

  return {
    publish,
    subscribe,
    summary: (options = {}) => {
      const recentLimit = Math.max(0, Math.min(historyLimit, Number(options.recentLimit ?? 20)));
      return {
        clients: clients.size,
        lastEventId: sequence,
        recent: recentLimit > 0 ? history.slice(-recentLimit) : [],
      };
    },
  };
}

export { createRuntimeEventHub };
