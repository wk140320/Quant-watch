function createTushareAdapter(options = {}) {
  const sanitizeCandleRows = options.sanitizeCandleRows || ((rows) => rows);

  function tushareRows(payload) {
    const fields = payload?.data?.fields || [];
    const indexes = Object.fromEntries(fields.map((field, index) => [field, index]));
    return sanitizeCandleRows((payload?.data?.items || []).map((row) => ({
      date: String(row[indexes.trade_date] || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
      open: Number(row[indexes.open]),
      high: Number(row[indexes.high]),
      low: Number(row[indexes.low]),
      close: Number(row[indexes.close]),
      adjClose: Number(row[indexes.close]),
      volume: Number(row[indexes.vol] || 0) * 100,
      amount: Number(row[indexes.amount] || 0) * 1000,
    }))).sort((a, b) => a.date.localeCompare(b.date));
  }

  return { tushareRows };
}

export { createTushareAdapter };
