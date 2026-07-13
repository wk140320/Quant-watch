(function installQuantChartMath(globalScope) {
  "use strict";

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function ema(values, period) {
    if (!Array.isArray(values) || !values.length) return [];
    const alpha = 2 / (period + 1);
    const output = [];
    let previous = values[0];
    values.forEach((value, index) => {
      previous = index === 0 ? value : value * alpha + previous * (1 - alpha);
      output.push(previous);
    });
    return output;
  }

  function sma(values, period) {
    if (!Array.isArray(values)) return [];
    return values.map((_, index) => {
      const start = Math.max(0, index - period + 1);
      const slice = values.slice(start, index + 1);
      return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
    });
  }

  function rsi(values, period = 14) {
    if (!Array.isArray(values) || values.length <= period) return 50;
    let gains = 0;
    let losses = 0;
    for (let index = values.length - period; index < values.length; index += 1) {
      const change = values[index] - values[index - 1];
      if (change >= 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return 100;
    const relativeStrength = gains / losses;
    return 100 - 100 / (1 + relativeStrength);
  }

  function pctChange(current, previous) {
    if (!previous) return 0;
    return ((current - previous) / previous) * 100;
  }

  function chartBounds(values, padding = 0.06) {
    const finite = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
    if (!finite.length) return { min: -1, max: 1 };
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const spread = max - min || Math.abs(max) || 1;
    return { min: min - spread * padding, max: max + spread * padding };
  }

  function rangeCount(range) {
    return { "5D": 5, "1M": 24, "3M": 66, "6M": 132, "9M": 220, ALL: 100000 }[range] || 132;
  }

  function xFor(index, count, width, left = 48, right = 14) {
    return left + (count <= 1 ? 0 : (index / (count - 1)) * (width - left - right));
  }

  function yFor(value, min, max, height, top = 12, bottom = 20) {
    return top + (1 - (value - min) / (max - min || 1)) * (height - top - bottom);
  }

  function bollingerChartSeries(candles, period = 20, multiplier = 2) {
    const rows = Array.isArray(candles) ? candles : [];
    const closes = rows.map((row) => Number(row.close || 0));
    const middle = sma(closes, period);
    const upper = [];
    const lower = [];
    closes.forEach((close, index) => {
      const start = Math.max(0, index - period + 1);
      const slice = closes.slice(start, index + 1);
      const average = middle[index] || close;
      const variance = slice.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, slice.length);
      const sigma = Math.sqrt(variance);
      upper.push(average + multiplier * sigma);
      lower.push(average - multiplier * sigma);
    });
    return { middle, upper, lower };
  }

  function fibonacciChartLevels(candles, lookback = 60) {
    const rows = (Array.isArray(candles) ? candles : []).slice(-lookback);
    if (!rows.length) return [];
    let highIndex = 0;
    let lowIndex = 0;
    rows.forEach((row, index) => {
      if (row.high > rows[highIndex].high) highIndex = index;
      if (row.low < rows[lowIndex].low) lowIndex = index;
    });
    const high = rows[highIndex].high;
    const low = rows[lowIndex].low;
    const span = Math.max(high - low, high * 0.0001);
    const upswing = lowIndex < highIndex;
    return [0.236, 0.382, 0.5, 0.618, 0.786].map((ratio) => ({
      ratio,
      label: `${(ratio * 100).toFixed(1)}%`,
      price: upswing ? high - span * ratio : low + span * ratio,
      direction: upswing ? "upswing" : "downswing",
    }));
  }

  globalScope.QuantChartMath = Object.freeze({
    bollingerChartSeries,
    chartBounds,
    clamp,
    ema,
    fibonacciChartLevels,
    pctChange,
    rangeCount,
    rsi,
    sma,
    xFor,
    yFor,
  });
}(typeof window !== "undefined" ? window : globalThis));
