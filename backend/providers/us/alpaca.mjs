function createAlpacaAdapter(options = {}) {
  const sanitizeCandleRows = options.sanitizeCandleRows || ((rows) => rows);
  const isIntradayInterval = options.isIntradayInterval || ((interval) => /m$/.test(String(interval || "")));

  function alpacaRows(payload, interval = "1d") {
    return sanitizeCandleRows((payload?.bars || []).map((row) => ({
      date: String(row.t || ""),
      open: Number(row.o),
      high: Number(row.h),
      low: Number(row.l),
      close: Number(row.c),
      adjClose: Number(row.c),
      volume: Number(row.v || 0),
      tradeCount: Number(row.n || 0),
      providerVwap: Number(row.vw || 0),
    })), { preserveTimestamp: isIntradayInterval(interval) });
  }

  function alpacaTradeRows(payload) {
    return (Array.isArray(payload?.trades) ? payload.trades : [])
      .map((row) => ({
        timestamp: String(row?.t || ""),
        price: Number(row?.p),
        size: Number(row?.s),
        exchange: String(row?.x || ""),
        conditions: Array.isArray(row?.c) ? row.c.map((item) => String(item)) : [],
        trade_id: String(row?.i ?? ""),
        tape: String(row?.z || ""),
        sequence: Number(row?.q || 0),
      }))
      .filter((row) => row.timestamp && Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.size) && row.size > 0)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
  }

  function alpacaQuoteRows(payload) {
    const rawRows = Array.isArray(payload?.quotes)
      ? payload.quotes
      : payload?.quote
        ? [payload.quote]
        : [];
    return rawRows
      .map((row) => ({
        timestamp: String(row?.t || ""),
        bid_price: Number(row?.bp || 0),
        bid_size: Number(row?.bs || 0),
        ask_price: Number(row?.ap || 0),
        ask_size: Number(row?.as || 0),
        bid_exchange: String(row?.bx || ""),
        ask_exchange: String(row?.ax || ""),
        conditions: Array.isArray(row?.c) ? row.c.map((item) => String(item)) : [],
        tape: String(row?.z || ""),
      }))
      .filter((row) => row.timestamp && ((Number.isFinite(row.bid_price) && row.bid_price > 0) || (Number.isFinite(row.ask_price) && row.ask_price > 0)))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  return { alpacaQuoteRows, alpacaRows, alpacaTradeRows };
}

export { createAlpacaAdapter };
