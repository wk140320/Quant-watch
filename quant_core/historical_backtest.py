from __future__ import annotations

import math
from statistics import median
from typing import Any

from data_quality import assess_candle_quality, label_confidence_for_window


def number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def mean(values: list[float]) -> float:
    rows = [value for value in values if math.isfinite(value)]
    return sum(rows) / len(rows) if rows else 0.0


def sample_weight(row: dict[str, Any]) -> float:
    return clamp(number(row.get("sampleWeight"), 1.0), 0.05, 1.5)


def weighted_sample_mean(rows: list[dict[str, Any]], key: str) -> float:
    weights = [sample_weight(row) for row in rows]
    total = sum(weights)
    if total <= 1e-12:
        return mean([number(row.get(key)) for row in rows])
    return sum(number(row.get(key)) * weights[index] for index, row in enumerate(rows)) / total


def weighted_quantile(values: list[float], weights: list[float], q: float) -> float:
    pairs = sorted(
        (number(value, math.nan), max(0.0, number(weights[index], 0.0)))
        for index, value in enumerate(values)
        if math.isfinite(number(value, math.nan))
    )
    if not pairs:
        return 0.0
    total = sum(weight for _, weight in pairs)
    if total <= 1e-12:
        raw = [value for value, _ in pairs]
        return raw[min(len(raw) - 1, max(0, int((len(raw) - 1) * clamp(q, 0.0, 1.0))))]
    threshold = total * clamp(q, 0.0, 1.0)
    cumulative = 0.0
    for value, weight in pairs:
        cumulative += weight
        if cumulative >= threshold:
            return value
    return pairs[-1][0]


def pct_change(current: float, previous: float) -> float:
    return ((current - previous) / previous * 100.0) if previous else 0.0


def raw_sign(value: float) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def sanitize_candles(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in candles or []:
        close = number(row.get("close"), math.nan)
        if not math.isfinite(close) or close <= 0:
            continue
        open_value = number(row.get("open"), close)
        high = max(close, open_value, number(row.get("high"), close))
        low = min(close, open_value, number(row.get("low"), close))
        raw_date = str(row.get("date") or "")
        valid_iso_day = (
            len(raw_date) >= 10
            and raw_date[4:5] == "-"
            and raw_date[7:8] == "-"
            and raw_date[:4].isdigit()
            and raw_date[5:7].isdigit()
            and raw_date[8:10].isdigit()
            and 1 <= int(raw_date[5:7]) <= 12
            and 1 <= int(raw_date[8:10]) <= 31
            and (len(raw_date) == 10 or raw_date[10:11] in {"T", " "})
        )
        date = raw_date[:10] if valid_iso_day else raw_date
        rows.append({
            "date": date,
            "open": open_value,
            "high": high,
            "low": low,
            "close": close,
            "volume": max(0.0, number(row.get("volume"), 0.0)),
            "vwap": number(row.get("vwap", row.get("vw")), math.nan),
            "buyVolume": number(row.get("buyVolume", row.get("aggressiveBuyVolume", row.get("activeBuyVolume"))), math.nan),
            "sellVolume": number(row.get("sellVolume", row.get("aggressiveSellVolume", row.get("activeSellVolume"))), math.nan),
            "tradeCount": number(row.get("tradeCount", row.get("trades", row.get("count"))), math.nan),
            "buyTrades": number(row.get("buyTrades", row.get("buyCount", row.get("aggressiveBuyTrades"))), math.nan),
            "sellTrades": number(row.get("sellTrades", row.get("sellCount", row.get("aggressiveSellTrades"))), math.nan),
            "priceLevels": row.get("priceLevels") if isinstance(row.get("priceLevels"), list) else [],
        })
    rows = [row for row in rows if len(str(row["date"])) >= 8]
    rows.sort(key=lambda item: str(item["date"]))
    deduped: list[dict[str, float | str]] = []
    seen: set[str] = set()
    for row in rows:
        date = str(row["date"])
        if date in seen:
            deduped[-1] = row
            continue
        seen.add(date)
        deduped.append(row)
    return deduped


def weighted_mean(values: list[float], weights: list[float]) -> float:
    total = sum(max(0.0, weight) for weight in weights)
    if total <= 1e-12:
        return mean(values)
    return sum(number(value) * max(0.0, weights[index]) for index, value in enumerate(values)) / total


def sma(values: list[float], window: int, end: int) -> float:
    if end < 0:
        return values[0] if values else 0.0
    start = max(0, end - window + 1)
    return mean(values[start:end + 1])


def ema_series(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (period + 1)
    out = [values[0]]
    for value in values[1:]:
        out.append(value * alpha + out[-1] * (1 - alpha))
    return out


def rsi_at(closes: list[float], end: int, period: int = 14) -> float:
    if end <= 0:
        return 50.0
    start = max(1, end - period + 1)
    gains = []
    losses = []
    for index in range(start, end + 1):
        change = closes[index] - closes[index - 1]
        gains.append(max(0.0, change))
        losses.append(max(0.0, -change))
    avg_gain = mean(gains)
    avg_loss = mean(losses)
    if avg_loss <= 1e-9:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def macd_hist_at(closes: list[float], end: int) -> float:
    usable = closes[:end + 1]
    if len(usable) < 3:
        return 0.0
    ema12 = ema_series(usable, 12)
    ema26 = ema_series(usable, 26)
    macd = [ema12[index] - ema26[index] for index in range(len(usable))]
    signal = ema_series(macd, 9)
    return macd[-1] - signal[-1]


def rolling_vwap(rows: list[dict[str, Any]], end: int, window: int = 20) -> float:
    start = max(0, end - window + 1)
    prices = []
    weights = []
    for row in rows[start:end + 1]:
        volume = max(0.0, number(row.get("volume"), 0.0))
        explicit = number(row.get("vwap"), math.nan)
        typical = (number(row.get("high")) + number(row.get("low")) + number(row.get("close"))) / 3
        prices.append(explicit if math.isfinite(explicit) and explicit > 0 else typical)
        weights.append(volume)
    return weighted_mean(prices, weights)


def price_level_metrics(row: dict[str, Any], close: float) -> dict[str, float]:
    levels = row.get("priceLevels") if isinstance(row.get("priceLevels"), list) else []
    parsed = []
    for level in levels:
        if not isinstance(level, dict):
            continue
        price = number(level.get("price", level.get("p")), math.nan)
        volume = number(level.get("volume", level.get("v", level.get("size"))), math.nan)
        buy = number(level.get("buyVolume", level.get("bidVolume", level.get("buy"))), math.nan)
        sell = number(level.get("sellVolume", level.get("askVolume", level.get("sell"))), math.nan)
        if math.isfinite(price) and price > 0 and math.isfinite(volume) and volume > 0:
            parsed.append({"price": price, "volume": volume, "buy": buy, "sell": sell})
    if not parsed:
        return {"pocDistance": 0.0, "profileImbalance": 0.0, "levelCount": 0.0}
    poc = max(parsed, key=lambda item: item["volume"])
    buy_total = sum(item["buy"] for item in parsed if math.isfinite(item["buy"]) and item["buy"] > 0)
    sell_total = sum(item["sell"] for item in parsed if math.isfinite(item["sell"]) and item["sell"] > 0)
    imbalance = (buy_total - sell_total) / max(1e-9, buy_total + sell_total) if buy_total + sell_total > 0 else 0.0
    return {
        "pocDistance": pct_change(close, number(poc["price"], close)),
        "profileImbalance": clamp(imbalance, -1.0, 1.0),
        "levelCount": float(len(parsed)),
    }


def signed_flow_for_row(row: dict[str, Any]) -> float:
    buy = number(row.get("buyVolume"), math.nan)
    sell = number(row.get("sellVolume"), math.nan)
    if math.isfinite(buy) and math.isfinite(sell) and buy + sell > 0:
        return clamp((buy - sell) / (buy + sell), -1.0, 1.0)
    high = number(row.get("high"))
    low = number(row.get("low"))
    open_value = number(row.get("open"))
    close = number(row.get("close"))
    width = max(1e-9, high - low)
    close_location = ((close - low) / width - 0.5) * 2
    body_position = (close - open_value) / width
    return clamp(close_location * 0.55 + body_position * 0.45, -1.0, 1.0)


def feature_dict(rows: list[dict[str, Any]], end: int) -> dict[str, float]:
    closes = [number(row["close"]) for row in rows]
    opens = [number(row["open"]) for row in rows]
    highs = [number(row["high"]) for row in rows]
    lows = [number(row["low"]) for row in rows]
    volumes = [number(row["volume"]) for row in rows]
    close = closes[end]
    high = highs[end]
    low = lows[end]
    open_value = opens[end]
    sma20 = sma(closes, 20, end) or close
    sma50 = sma(closes, 50, end) or close
    volume20 = sma(volumes, 20, end) or 1.0
    volume5 = sma(volumes, 5, end) or volume20
    volume50 = sma(volumes, 50, end) or volume20
    returns = [pct_change(closes[index], closes[index - 1]) for index in range(max(1, end - 19), end + 1)]
    volatility = math.sqrt(mean([value * value for value in returns])) if returns else 0.0
    gap = pct_change(open_value, closes[end - 1]) if end >= 1 else 0.0
    change1 = pct_change(close, closes[end - 1]) if end >= 1 else 0.0
    change3 = pct_change(close, closes[end - 3]) if end >= 3 else 0.0
    change5 = pct_change(close, closes[end - 5]) if end >= 5 else 0.0
    change10 = pct_change(close, closes[end - 10]) if end >= 10 else 0.0
    change20 = pct_change(close, closes[end - 20]) if end >= 20 else 0.0
    rsi_value = rsi_at(closes, end)
    macd_hist = macd_hist_at(closes, end)
    volume_ratio = volumes[end] / max(1.0, volume20)
    volume_accel = volume5 / max(1.0, volume20) - 1
    volume_trend = volume20 / max(1.0, volume50) - 1
    range20 = closes[max(0, end - 20):end + 1]
    high20 = max(range20) if range20 else close
    low20 = min(range20) if range20 else close
    range_position = (close - low20) / max(1e-9, high20 - low20)
    true_range = pct_change(high, low) if low > 0 else 0.0
    intraday_width = max(1e-9, high - low)
    body_position = (close - open_value) / intraday_width
    close_location = ((close - low) / intraday_width - 0.5) * 2
    signed_flows = [signed_flow_for_row(row) for row in rows]
    buy_pressure = signed_flows[end]
    buy_pressure5 = weighted_mean(
        signed_flows[max(0, end - 4):end + 1],
        volumes[max(0, end - 4):end + 1],
    )
    buy_pressure20 = weighted_mean(
        signed_flows[max(0, end - 19):end + 1],
        volumes[max(0, end - 19):end + 1],
    )
    pressure_change = buy_pressure5 - buy_pressure20
    vwap20 = rolling_vwap(rows, end, 20) or close
    profile_distance = pct_change(close, vwap20)
    typical_prices = [(highs[index] + lows[index] + closes[index]) / 3 for index in range(max(0, end - 19), end + 1)]
    typical_volumes = volumes[max(0, end - 19):end + 1]
    tp_center = weighted_mean(typical_prices, typical_volumes)
    tp_sigma = math.sqrt(weighted_mean([(value - tp_center) ** 2 for value in typical_prices], typical_volumes)) or 1.0
    profile_skew = weighted_mean([((value - tp_center) / tp_sigma) ** 3 for value in typical_prices], typical_volumes)
    level_metrics = price_level_metrics(rows[end], close)
    liquidity_shock = abs(change1) * max(0.0, volume_ratio - 1)
    trend_quality = clamp((trend_score := clamp(50 + (12 if close > sma20 else -9) + (11 if sma20 > sma50 else -10) + clamp(change20 * 0.62, -9, 9), 0, 100)) - 50, -50, 50) * (1 - clamp(volatility / 18, 0, 0.75))
    reversal_pressure = -buy_pressure5 if raw_sign(change5) != raw_sign(buy_pressure5) else 0.0
    momentum_score = clamp(50 + (macd_hist / close) * 9200 + (rsi_value - 50) * 0.55 + clamp(change5, -6, 6) * 0.35 + clamp(change20 * 0.12, -3, 3), 0, 100)
    risk_score = clamp(82 - volatility * 8, 0, 100)
    factor_quality = clamp((trend_score - 50) * 0.18 + (momentum_score - 50) * 0.16 + (risk_score - 50) * 0.1 + buy_pressure5 * 8 + clamp(profile_distance, -5, 5) * 0.45, -25, 25)
    return {
        "bias": 1.0,
        "change1": clamp(change1 / 10, -2.5, 2.5),
        "change3": clamp(change3 / 15, -2.5, 2.5),
        "change5": clamp(change5 / 20, -2.5, 2.5),
        "change10": clamp(change10 / 25, -2.5, 2.5),
        "change20": clamp(change20 / 35, -2.5, 2.5),
        "volumeRatio": clamp((volume_ratio - 1) / 3, -2.5, 2.5),
        "rsi": clamp((rsi_value - 50) / 50, -2.0, 2.0),
        "macdHist": clamp((macd_hist / close) * 20, -2.5, 2.5),
        "smaGap": clamp((sma20 / max(1e-9, sma50) - 1) * 8, -2.5, 2.5),
        "volatility": clamp(volatility / 5, 0, 3.0),
        "rangePosition": clamp((range_position - 0.5) * 2, -1.5, 1.5),
        "gap": clamp(gap / 10, -2.0, 2.0),
        "bodyPosition": clamp(body_position, -2.0, 2.0),
        "closeLocation": clamp(close_location, -1.5, 1.5),
        "trueRange": clamp(true_range / 10, 0, 3.0),
        "buyPressure": clamp(buy_pressure, -1.5, 1.5),
        "buyPressure5": clamp(buy_pressure5, -1.5, 1.5),
        "pressureChange": clamp(pressure_change, -1.5, 1.5),
        "volumeAccel": clamp(volume_accel / 2, -2.5, 2.5),
        "volumeTrend": clamp(volume_trend / 2, -2.5, 2.5),
        "profileDistance": clamp(profile_distance / 8, -2.5, 2.5),
        "profileSkew": clamp(profile_skew / 3, -2.5, 2.5),
        "profilePocDistance": clamp(number(level_metrics.get("pocDistance")) / 8, -2.5, 2.5),
        "profileImbalance": clamp(number(level_metrics.get("profileImbalance")), -1.5, 1.5),
        "liquidityShock": clamp(liquidity_shock / 10, 0, 3.0),
        "trendQuality": clamp(trend_quality / 25, -2.5, 2.5),
        "factorQuality": clamp(factor_quality / 25, -2.5, 2.5),
        "reversalPressure": clamp(reversal_pressure, -1.5, 1.5),
        "trendScore": trend_score,
        "momentumScore": momentum_score,
        "riskScore": risk_score,
        "rawChange5": change5,
        "rawChange20": change20,
        "rawVolumeRatio": volume_ratio,
        "rawRsi": rsi_value,
        "rawBuyPressure5": buy_pressure5,
        "rawProfileDistance": profile_distance,
        "rawVolumeAccel": volume_accel,
        "rawFactorQuality": factor_quality,
    }


FEATURE_NAMES = [
    "bias",
    "change1",
    "change3",
    "change5",
    "change10",
    "change20",
    "volumeRatio",
    "rsi",
    "macdHist",
    "smaGap",
    "volatility",
    "rangePosition",
    "gap",
    "bodyPosition",
    "closeLocation",
    "trueRange",
    "buyPressure",
    "buyPressure5",
    "pressureChange",
    "volumeAccel",
    "volumeTrend",
    "profileDistance",
    "profileSkew",
    "profilePocDistance",
    "profileImbalance",
    "liquidityShock",
    "trendQuality",
    "factorQuality",
    "reversalPressure",
]


FORMULA_BOOK = {
    "features": {
        "pct_change_n": "(close[t] - close[t-n]) / close[t-n] * 100",
        "sma20": "mean(close[t-19:t])",
        "sma50": "mean(close[t-49:t])",
        "volume20": "mean(volume[t-19:t])",
        "volatility": "sqrt(mean(daily_return[t-19:t]^2))",
        "rsi14": "100 - 100 / (1 + avg_gain_14 / avg_loss_14)",
        "macdHist": "EMA12(close[:t]) - EMA26(close[:t]) - EMA9(MACD[:t])",
        "rangePosition": "(close[t] - min(close[t-20:t])) / (max(close[t-20:t]) - min(close[t-20:t]))",
        "trendScore": "clamp(50 + I(close>sma20)*12 - I(close<=sma20)*9 + I(sma20>sma50)*11 - I(sma20<=sma50)*10 + clamp(change20*0.62,-9,9),0,100)",
        "momentumScore": "clamp(50 + macdHist/close*9200 + (rsi14-50)*0.55 + clamp(change5,-6,6)*0.35 + clamp(change20*0.12,-3,3),0,100)",
        "riskScore": "clamp(82 - volatility*8,0,100)",
        "buyPressure": "real (buyVolume-sellVolume)/(buyVolume+sellVolume) when available; otherwise OHLCV proxy from close location and candle body",
        "buyPressure5": "volume-weighted mean(buyPressure[t-4:t])",
        "pressureChange": "buyPressure5 - volume-weighted mean(buyPressure[t-19:t])",
        "volumeAccel": "mean(volume[t-4:t]) / mean(volume[t-19:t]) - 1",
        "volumeTrend": "mean(volume[t-19:t]) / mean(volume[t-49:t]) - 1",
        "profileDistance": "(close[t] - rollingVWAP20) / rollingVWAP20 * 100",
        "profileSkew": "volume-weighted skew of 20-day typical prices around rollingVWAP-like center",
        "profilePocDistance": "if priceLevels exist: (close[t]-POC)/POC*100; otherwise 0",
        "profileImbalance": "if priceLevels include buy/sell volume: (buy-sell)/(buy+sell); otherwise 0",
        "factorQuality": "technical factor proxy from trend, momentum, risk, buyPressure5, and profileDistance",
    },
    "normalized_features": {
        "change1": "clamp(change1/10,-2.5,2.5)",
        "change3": "clamp(change3/15,-2.5,2.5)",
        "change5": "clamp(change5/20,-2.5,2.5)",
        "change10": "clamp(change10/25,-2.5,2.5)",
        "change20": "clamp(change20/35,-2.5,2.5)",
        "volumeRatio": "clamp((volume[t]/volume20 - 1)/3,-2.5,2.5)",
        "rsi": "clamp((rsi14-50)/50,-2,2)",
        "macdHist": "clamp((macd_hist/close)*20,-2.5,2.5)",
        "smaGap": "clamp((sma20/sma50 - 1)*8,-2.5,2.5)",
        "volatility": "clamp(volatility/5,0,3)",
        "rangePosition": "clamp((rangePosition-0.5)*2,-1.5,1.5)",
        "gap": "clamp(gap/10,-2,2)",
        "bodyPosition": "clamp((close-open)/(high-low),-2,2)",
        "closeLocation": "clamp(((close-low)/(high-low)-0.5)*2,-1.5,1.5)",
        "trueRange": "clamp((high-low)/low*100/10,0,3)",
        "buyPressure": "clamp(buyPressure,-1.5,1.5)",
        "buyPressure5": "clamp(buyPressure5,-1.5,1.5)",
        "pressureChange": "clamp(pressureChange,-1.5,1.5)",
        "volumeAccel": "clamp(volumeAccel/2,-2.5,2.5)",
        "volumeTrend": "clamp(volumeTrend/2,-2.5,2.5)",
        "profileDistance": "clamp(profileDistance/8,-2.5,2.5)",
        "profileSkew": "clamp(profileSkew/3,-2.5,2.5)",
        "profilePocDistance": "clamp(profilePocDistance/8,-2.5,2.5)",
        "profileImbalance": "clamp(profileImbalance,-1.5,1.5)",
        "liquidityShock": "clamp(abs(change1)*max(0,volumeRatio-1)/10,0,3)",
        "trendQuality": "clamp(((trendScore-50)*(1-volatilityPenalty))/25,-2.5,2.5)",
        "factorQuality": "clamp(factorQuality/25,-2.5,2.5)",
        "reversalPressure": "clamp(reversalPressure,-1.5,1.5)",
    },
    "labels": {
        "forwardReturn": "(close[t+horizon] - close[t]) / close[t] * 100",
        "maxUpside": "(max(high[t+1:t+horizon]) - close[t]) / close[t] * 100",
        "maxDrawdown": "(min(low[t+1:t+horizon]) - close[t]) / close[t] * 100",
        "targetWins": "maxUpside>=targetUpside and target touch occurs before stop touch when both occur",
        "stopWins": "maxDrawdown<=-stopLoss and stop touch occurs before target touch when both occur",
        "ambiguousBarrierOrder": "true when a single OHLC bar touches both target and stop, because daily bars cannot reveal the intrabar order",
        "riskAdjustedReturn": "targetUpside if targetWins else -stopLoss if stopWins else forwardReturn",
        "labelConfidence": "combines current/future candle quality, barrier-margin ambiguity, both-barrier touch risk, intrabar-order uncertainty, path chop, two-sided excursions, and future-window completeness",
        "labelNoiseScore": "0-100 path-label noise score; high values mean the future path was too choppy or order-ambiguous to trust as a strong training label",
        "sampleWeight": "min(dataQualityWeight,labelConfidence) used by Ridge/Logistic/KNN/ensemble calibration to avoid learning too strongly from suspicious rows",
    },
    "data_quality": {
        "candleScore": "100 minus penalties for bad OHLC ranges, zero volume, stale low-volume closes, large calendar gaps, extreme returns, and possible split/provider jumps",
        "qualityWeightedLearning": "training loss and calibration metrics are weighted by sampleWeight instead of treating all historical cuts equally",
        "labelReliability": "target/stop labels close to barrier boundaries or touching both barriers are down-weighted because the label is less stable",
        "sampleCoverage": "KNN nearest/average/p75 feature distance from prior fully-known samples; low coverage lowers sampleWeight and blocks buy signals",
    },
    "prediction_heads": {
        "ridge_final_return": "rolling ridge regression predicting forwardReturn",
        "ridge_risk_adjusted": "rolling ridge regression predicting riskAdjustedReturn",
        "knn_analog": "mean forwardReturn of nearest historical feature vectors",
        "trend_momentum": "change20*0.12 + change5*0.18 + (trendScore-50)*0.035 + (momentumScore-50)*0.03 + macdHist*1.6",
        "mean_reversion": "clamp((50-rsi14)*0.075,-4.5,4.5) - change5*0.18 + (0.25 if change20>-8 else -0.45)",
        "volume_breakout": "max(0,volumeRatio-1)*1.35*(1 if change5>=0 else -0.55) + change20*0.08 + macdHist*1.2",
        "risk_guard": "ridge_final_return - stopProbability*stopLoss*0.9 + (riskScore-50)*0.025",
        "target_probability": "(targetProbability-0.5)*targetUpside*2.2 - max(0,stopProbability-0.36)*stopLoss*1.25",
        "orderflow_pressure": "buyPressure5*4.2 + pressureChange*3.1 + closeLocation*0.7 + volumeAccel*0.9",
        "volume_profile": "-profileDistance*0.42 + profileSkew*0.55 + profilePocDistance*0.38 + profileImbalance*2.2",
        "factor_quality": "factorQualityRaw*0.14 + trendQuality*1.3 - liquidityShock*0.25",
        "liquidity_reversal": "-change5*0.12 + reversalPressure*2.7 + volumeAccel*0.8 - trueRange*0.35",
    },
    "weight_learning": {
        "objective": "minimize holdout MSE of weighted prediction vs actual forwardReturn with simplex weights",
        "constraint": "weights>=0, sum(weights)=1, per-head cap≈0.48",
        "split": "time ordered train 58%, validation 21%, test 21%",
        "activation_gate": "active only if test beats equal-weight enough without sacrificing direction hit rate",
        "stability_gate": "rolling later-period folds refit weights on prior cuts and require stable MSE/direction lift before live deployment",
    },
}


def vector_from_feature(feature: dict[str, float]) -> list[float]:
    return [number(feature.get(name)) for name in FEATURE_NAMES]


def outcome_window(rows: list[dict[str, float | str]], index: int, horizon: int, target_upside: float, stop_loss: float) -> dict[str, Any]:
    entry = number(rows[index]["close"])
    end = min(len(rows) - 1, index + horizon)
    if entry <= 0 or end <= index:
        return {"targetWins": False, "stopWins": False, "forwardReturn": 0.0, "maxUpside": 0.0, "maxDrawdown": 0.0}
    max_high = entry
    min_low = entry
    first_event = None
    first_event_day = None
    for offset in range(index + 1, end + 1):
        high_return = pct_change(number(rows[offset]["high"]), entry)
        low_return = pct_change(number(rows[offset]["low"]), entry)
        max_high = max(max_high, number(rows[offset]["high"]))
        min_low = min(min_low, number(rows[offset]["low"]))
        target_hit_on_bar = high_return >= target_upside
        stop_hit_on_bar = low_return <= -stop_loss
        if first_event is None and target_hit_on_bar and stop_hit_on_bar:
            first_event = "ambiguous"
            first_event_day = offset - index
        elif first_event is None and target_hit_on_bar:
            first_event = "target"
            first_event_day = offset - index
        elif first_event is None and stop_hit_on_bar:
            first_event = "stop"
            first_event_day = offset - index
    max_upside = pct_change(max_high, entry)
    max_drawdown = pct_change(min_low, entry)
    hit_target = max_upside >= target_upside
    hit_stop = max_drawdown <= -stop_loss
    forward_return = pct_change(number(rows[end]["close"]), entry)
    target_wins = hit_target and (not hit_stop or first_event == "target")
    stop_wins = hit_stop and (not hit_target or first_event == "stop")
    ambiguous_barrier_order = first_event == "ambiguous"
    return {
        "targetWins": target_wins,
        "stopWins": stop_wins,
        "hitTarget": hit_target,
        "hitStop": hit_stop,
        "firstBarrierEvent": first_event,
        "firstBarrierDay": first_event_day,
        "ambiguousBarrierOrder": ambiguous_barrier_order,
        "forwardReturn": forward_return,
        "maxUpside": max_upside,
        "maxDrawdown": max_drawdown,
        "riskAdjustedReturn": min(max_upside, target_upside) if target_wins else (-stop_loss if stop_wins else forward_return),
    }


def build_labeled_rows(
    rows: list[dict[str, float | str]],
    horizon: int,
    target_upside: float,
    stop_loss: float,
    quality_profile: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    labeled = []
    start = 55
    quality_rows = list((quality_profile or {}).get("rows") or [])
    if len(quality_rows) < len(rows):
        quality_rows = [
            *quality_rows,
            *[
                {"index": index, "score": 100.0, "sampleWeight": 1.0, "flags": []}
                for index in range(len(quality_rows), len(rows))
            ],
        ]
    for end in range(start, len(rows) - horizon):
        feature = feature_dict(rows, end)
        outcome = outcome_window(rows, end, horizon, target_upside, stop_loss)
        row_quality = quality_rows[end] if end < len(quality_rows) else {"score": 100.0, "sampleWeight": 1.0, "flags": []}
        label_quality = label_confidence_for_window(rows, quality_rows, end, horizon, outcome, target_upside, stop_loss)
        weight = clamp(
            min(number(row_quality.get("sampleWeight"), 1.0), number(label_quality.get("labelConfidence"), 1.0)),
            0.05,
            1.0,
        )
        labeled.append({
            "index": end,
            "date": rows[end]["date"],
            "x": vector_from_feature(feature),
            "feature": feature,
            "outcome": outcome,
            "sampleWeight": weight,
            "dataQualityScore": number(row_quality.get("score"), 100.0),
            "dataQualityFlags": list(row_quality.get("flags") or []),
            "labelConfidence": number(label_quality.get("labelConfidence"), 1.0),
            "labelNoiseScore": number(label_quality.get("labelNoiseScore"), 0.0),
            "labelPathMetrics": {
                "pathVolatility": number(label_quality.get("pathVolatility"), 0.0),
                "pathChopRatio": number(label_quality.get("pathChopRatio"), 0.0),
                "twoSidedExcursionRatio": number(label_quality.get("twoSidedExcursionRatio"), 0.0),
                "directionFlips": int(number(label_quality.get("directionFlips"), 0.0)),
            },
            "labelQualityFlags": list(label_quality.get("flags") or []),
            "y_return": clamp(number(outcome["riskAdjustedReturn"]), -24, 24),
            "y_final": clamp(number(outcome["forwardReturn"]), -24, 24),
            "y_max": clamp(max(0.0, number(outcome["maxUpside"])), 0, 32),
            "y_target": 1.0 if outcome["targetWins"] else 0.0,
            "y_stop": 1.0 if outcome["stopWins"] else 0.0,
        })
    return labeled


def fit_standardizer(samples: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    width = len(samples[0]["x"]) if samples else 0
    centers: list[float] = []
    scales: list[float] = []
    weights = [sample_weight(row) for row in samples]
    total_weight = sum(weights) or 1.0
    for index in range(width):
        values = [number(row["x"][index]) for row in samples]
        center = sum(values[row_index] * weights[row_index] for row_index in range(len(values))) / total_weight if values else 0.0
        variance = sum(((value - center) ** 2) * weights[row_index] for row_index, value in enumerate(values)) / total_weight if values else 0.0
        centers.append(center)
        scales.append(math.sqrt(variance) or 1.0)
    return centers, scales


def apply_standardizer(x: list[float], centers: list[float], scales: list[float]) -> list[float]:
    return [(number(value) - centers[index]) / max(1e-9, scales[index]) for index, value in enumerate(x)]


def dot(weights: list[float], x: list[float]) -> float:
    return sum(number(weights[index]) * number(value) for index, value in enumerate(x))


def fit_ridge(samples: list[dict[str, Any]], target_key: str, penalty: float = 0.08, epochs: int = 40) -> dict[str, Any]:
    centers, scales = fit_standardizer(samples)
    targets = [number(row[target_key]) for row in samples]
    weights_for_rows = [sample_weight(row) for row in samples]
    total_weight = sum(weights_for_rows) or 1.0
    weights = [0.0 for _ in centers]
    intercept = sum(targets[index] * weights_for_rows[index] for index in range(len(targets))) / total_weight if targets else 0.0
    step = 0.028 / max(1, len(weights))
    for _ in range(max(30, int(epochs))):
        grad_w = [2 * penalty * value for value in weights]
        grad_b = 0.0
        for row_index, (row, target) in enumerate(zip(samples, targets)):
            row_weight = weights_for_rows[row_index] / total_weight
            x = apply_standardizer(row["x"], centers, scales)
            error = intercept + dot(weights, x) - target
            grad_b += 2 * error * row_weight
            for index, value in enumerate(x):
                grad_w[index] += 2 * error * value * row_weight
        intercept -= step * grad_b
        weights = [weight - step * grad_w[index] for index, weight in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def fit_logistic(samples: list[dict[str, Any]], target_key: str, penalty: float = 0.08, epochs: int = 40) -> dict[str, Any]:
    centers, scales = fit_standardizer(samples)
    targets = [1.0 if number(row[target_key]) >= 0.5 else 0.0 for row in samples]
    weights_for_rows = [sample_weight(row) for row in samples]
    total_weight = sum(weights_for_rows) or 1.0
    base = clamp(sum(targets[index] * weights_for_rows[index] for index in range(len(targets))) / total_weight if targets else 0.5, 0.02, 0.98)
    intercept = math.log(base / (1 - base))
    weights = [0.0 for _ in centers]
    step = 0.045 / max(1, len(weights))
    for _ in range(max(30, int(epochs))):
        grad_w = [2 * penalty * value for value in weights]
        grad_b = 0.0
        for row_index, (row, target) in enumerate(zip(samples, targets)):
            row_weight = weights_for_rows[row_index] / total_weight
            x = apply_standardizer(row["x"], centers, scales)
            pred = 1 / (1 + math.exp(-clamp(intercept + dot(weights, x), -18, 18)))
            error = pred - target
            grad_b += error * row_weight
            for index, value in enumerate(x):
                grad_w[index] += error * value * row_weight
        intercept -= step * grad_b
        weights = [weight - step * grad_w[index] for index, weight in enumerate(weights)]
    return {"weights": weights, "intercept": intercept, "centers": centers, "scales": scales}


def predict_linear(model: dict[str, Any], x: list[float]) -> float:
    return number(model["intercept"]) + dot(model["weights"], apply_standardizer(x, model["centers"], model["scales"]))


def predict_logistic(model: dict[str, Any], x: list[float]) -> float:
    return 1 / (1 + math.exp(-clamp(predict_linear(model, x), -18, 18)))


def coverage_from_distances(distances: list[float], sample_count: int = 0) -> dict[str, float]:
    clean = sorted(value for value in distances if math.isfinite(value) and value >= 0)
    if not clean:
        return {
            "nearestDistance": 9.99,
            "avgNeighborDistance": 9.99,
            "p75NeighborDistance": 9.99,
            "coverageScore": 0.0,
            "coverageWeight": 0.2,
            "oodRisk": 1.0,
        }
    nearest = clean[0]
    avg_distance = mean(clean)
    p75_index = min(len(clean) - 1, max(0, int((len(clean) - 1) * 0.75)))
    p75_distance = clean[p75_index]
    sample_bonus = min(8.0, math.log10(max(1, sample_count)) * 3.5)
    score = clamp(104.0 - nearest * 24.0 - avg_distance * 31.0 - p75_distance * 11.0 + sample_bonus, 0.0, 100.0)
    weight = clamp(0.22 + score / 100.0 * 0.78, 0.22, 1.0)
    return {
        "nearestDistance": round(nearest, 5),
        "avgNeighborDistance": round(avg_distance, 5),
        "p75NeighborDistance": round(p75_distance, 5),
        "coverageScore": round(score, 5),
        "coverageWeight": round(weight, 5),
        "oodRisk": round(clamp(1.0 - score / 100.0, 0.0, 1.0), 5),
    }


def knn_prediction(train_rows: list[dict[str, Any]], x: list[float], k: int = 18) -> dict[str, float]:
    if not train_rows:
        return {
            "targetProb": 0.0,
            "stopProb": 0.0,
            "return": 0.0,
            "finalReturn": 0.0,
            "maxUpside": 0.0,
            "neighborCount": 0.0,
            "effectiveNeighborWeight": 0.0,
            **coverage_from_distances([], 0),
        }
    centers, scales = fit_standardizer(train_rows)
    target_x = apply_standardizer(x, centers, scales)
    ranked = []
    for row in train_rows:
        row_x = apply_standardizer(row["x"], centers, scales)
        distance = math.sqrt(mean([(row_x[index] - target_x[index]) ** 2 for index in range(len(target_x))]))
        ranked.append((distance, row))
    selected = sorted(ranked, key=lambda item: item[0])[:max(4, min(k, len(ranked)))]
    best = [row for _, row in selected]
    coverage = coverage_from_distances([distance for distance, _ in selected], len(train_rows))
    total_weight = sum(sample_weight(row) for row in best) or 1.0
    def neighbor_mean(key: str) -> float:
        return sum(number(row.get(key)) * sample_weight(row) for row in best) / total_weight
    return {
        "targetProb": neighbor_mean("y_target"),
        "stopProb": neighbor_mean("y_stop"),
        "return": neighbor_mean("y_return"),
        "finalReturn": neighbor_mean("y_final"),
        "maxUpside": neighbor_mean("y_max"),
        "neighborCount": float(len(best)),
        "effectiveNeighborWeight": total_weight,
        **coverage,
    }


def probability_bucket(value: float) -> str:
    pct = clamp(value, 0.0, 1.0) * 100
    if pct < 40:
        return "0-39"
    if pct < 50:
        return "40-49"
    if pct < 60:
        return "50-59"
    if pct < 70:
        return "60-69"
    if pct < 80:
        return "70-79"
    return "80-99"


def calibration_rows(predictions: list[dict[str, Any]], probability_key: str, actual_key: str) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, float]] = {}
    for row in predictions:
        bucket = probability_bucket(number(row.get(probability_key), 0.0))
        item = buckets.setdefault(bucket, {"count": 0.0, "weight": 0.0, "predicted": 0.0, "actual": 0.0})
        weight = sample_weight(row)
        item["count"] += 1
        item["weight"] += weight
        item["predicted"] += clamp(number(row.get(probability_key)), 0.0, 1.0) * weight
        item["actual"] += (1.0 if row.get(actual_key) else 0.0) * weight
    out = []
    for label in ["0-39", "40-49", "50-59", "60-69", "70-79", "80-99"]:
        item = buckets.get(label)
        if not item:
            continue
        count = max(1.0, item["count"])
        weight = max(1e-9, item.get("weight", count))
        out.append({
            "bucket": label,
            "count": int(item["count"]),
            "effectiveWeight": round(weight, 4),
            "avgPredicted": round(item["predicted"] / weight * 100, 2),
            "observedRate": round(item["actual"] / weight * 100, 2),
            "calibrationError": round((item["predicted"] - item["actual"]) / weight * 100, 2),
        })
    return out


def regime_bucket_from_feature(feature: dict[str, Any], coverage_score: float | None = None) -> dict[str, Any]:
    trend = number(feature.get("trendScore"), 50.0)
    momentum = number(feature.get("momentumScore"), 50.0)
    risk = number(feature.get("riskScore"), 50.0)
    change5 = number(feature.get("rawChange5"), 0.0)
    change20 = number(feature.get("rawChange20"), 0.0)
    volume_ratio = number(feature.get("rawVolumeRatio"), 1.0)
    rsi_value = number(feature.get("rawRsi"), 50.0)
    coverage = number(coverage_score, 100.0)

    if coverage < 40:
        bucket = "low_coverage"
        label = "低覆盖/分布外"
    elif risk < 48 or abs(change5) >= 8 or volume_ratio >= 3.2:
        bucket = "volatile"
        label = "高波动"
    elif rsi_value >= 72 or (change5 >= 6 and trend >= 60):
        bucket = "overextended"
        label = "短线过热"
    elif trend >= 62 and momentum >= 56 and change20 >= 2:
        bucket = "uptrend"
        label = "上升趋势"
    elif trend <= 42 and change20 <= -2:
        bucket = "downtrend"
        label = "下跌趋势"
    elif volume_ratio >= 1.35 and change5 >= 0 and momentum >= 52:
        bucket = "volume_breakout"
        label = "放量突破"
    else:
        bucket = "range"
        label = "震荡/均衡"

    return {
        "bucket": bucket,
        "label": label,
        "trendScore": round(trend, 3),
        "momentumScore": round(momentum, 3),
        "riskScore": round(risk, 3),
        "change5": round(change5, 5),
        "change20": round(change20, 5),
        "volumeRatio": round(volume_ratio, 5),
        "rsi": round(rsi_value, 5),
        "coverageScore": round(coverage, 5),
    }


def summarize_regime_calibration(predictions: list[dict[str, Any]], current_regime: dict[str, Any]) -> dict[str, Any]:
    labels = {
        "low_coverage": "低覆盖/分布外",
        "volatile": "高波动",
        "overextended": "短线过热",
        "uptrend": "上升趋势",
        "downtrend": "下跌趋势",
        "volume_breakout": "放量突破",
        "range": "震荡/均衡",
    }
    buckets = []
    for bucket, label in labels.items():
        rows = [row for row in predictions if row.get("regimeBucket") == bucket]
        if not rows:
            continue
        weights = [sample_weight(row) for row in rows]
        total = sum(weights) or 1.0
        weighted_rate = lambda values: sum(values[index] * weights[index] for index in range(len(values))) / total * 100
        weighted_field = lambda key: sum(number(row.get(key)) * weights[index] for index, row in enumerate(rows)) / total
        direction_hits = [
            1.0 if (
                (number(row.get("predictedReturn")) >= 0 and number(row.get("actualFinalReturn")) >= 0)
                or (number(row.get("predictedReturn")) < 0 and number(row.get("actualFinalReturn")) < 0)
            ) else 0.0
            for row in rows
        ]
        target_hits = [1.0 if row.get("targetWins") else 0.0 for row in rows]
        stop_hits = [1.0 if row.get("stopWins") else 0.0 for row in rows]
        buy_rows = [row for row in rows if row.get("buySignal")]
        bucket_score = (weighted_rate(target_hits) - 52) / 3.5 + weighted_field("actualFinalReturn") * 0.25 - weighted_rate(stop_hits) * 0.04
        buckets.append({
            "bucket": bucket,
            "label": label,
            "count": len(rows),
            "effectiveSamples": round(total, 4),
            "buySignals": len(buy_rows),
            "directionHitRate": round(weighted_rate(direction_hits), 4),
            "targetHitRate": round(weighted_rate(target_hits), 4),
            "stopRate": round(weighted_rate(stop_hits), 4),
            "avgReturn": round(weighted_field("actualFinalReturn"), 5),
            "avgRiskAdjustedReturn": round(weighted_field("actualRiskAdjustedReturn"), 5),
            "avgCoverageScore": round(weighted_field("coverageScore"), 5),
            "avgLabelConfidence": round(weighted_field("labelConfidence"), 5),
            "score": round(clamp(bucket_score, -12, 12), 5),
        })
    buckets.sort(key=lambda row: (row["bucket"] != current_regime.get("bucket"), -row["effectiveSamples"], row["bucket"]))
    matched = next((row for row in buckets if row.get("bucket") == current_regime.get("bucket")), None)
    return {
        "framework": "point-in-time-regime-bucket-calibration",
        "current": current_regime,
        "matchedBucket": matched,
        "buckets": buckets,
        "policy": "Historical prediction cuts are grouped by trend/volatility/volume/RSI/coverage visible at the prediction date; current-regime evidence can penalize confidence when the same regime was weak.",
    }


def conformal_error_summary(rows: list[dict[str, Any]], label: str, bucket: str = "overall") -> dict[str, Any]:
    if not rows:
        return {
            "bucket": bucket,
            "label": label,
            "samples": 0,
            "effectiveSamples": 0.0,
            "available": False,
        }
    weights = [sample_weight(row) for row in rows]
    total_weight = sum(weights) or 1.0
    final_errors = [abs(number(row.get("predictedFinalReturn")) - number(row.get("actualFinalReturn"))) for row in rows]
    risk_errors = [abs(number(row.get("predictedReturn")) - number(row.get("actualRiskAdjustedReturn"))) for row in rows]
    max_errors = [abs(number(row.get("predictedMaxUpside")) - max(0.0, number(row.get("actualMaxUpside")))) for row in rows]
    signed_final_errors = [number(row.get("predictedFinalReturn")) - number(row.get("actualFinalReturn")) for row in rows]
    target_prob_errors = [abs(number(row.get("targetProbability")) - (1.0 if row.get("targetWins") else 0.0)) for row in rows]
    direction_misses = [
        0.0 if (
            (number(row.get("predictedReturn")) >= 0 and number(row.get("actualFinalReturn")) >= 0)
            or (number(row.get("predictedReturn")) < 0 and number(row.get("actualFinalReturn")) < 0)
        ) else 1.0
        for row in rows
    ]
    weighted_mean_values = lambda values: sum(values[index] * weights[index] for index in range(len(values))) / total_weight
    final_p80 = weighted_quantile(final_errors, weights, 0.8)
    final_p90 = weighted_quantile(final_errors, weights, 0.9)
    max_p80 = weighted_quantile(max_errors, weights, 0.8)
    score = clamp(100 - final_p80 * 7.5 - final_p90 * 3.2 - weighted_mean_values(direction_misses) * 22, 0, 100)
    return {
        "bucket": bucket,
        "label": label,
        "samples": len(rows),
        "effectiveSamples": round(total_weight, 4),
        "available": len(rows) >= 8 and total_weight >= 5,
        "finalReturnAbsErrorP50": round(weighted_quantile(final_errors, weights, 0.5), 5),
        "finalReturnAbsErrorP80": round(final_p80, 5),
        "finalReturnAbsErrorP90": round(final_p90, 5),
        "riskAdjustedAbsErrorP80": round(weighted_quantile(risk_errors, weights, 0.8), 5),
        "maxUpsideAbsErrorP80": round(max_p80, 5),
        "targetProbabilityAbsErrorP80": round(weighted_quantile(target_prob_errors, weights, 0.8) * 100, 5),
        "directionMissRate": round(weighted_mean_values(direction_misses) * 100, 5),
        "meanSignedFinalError": round(weighted_mean_values(signed_final_errors), 5),
        "interval80": {
            "halfWidth": round(final_p80, 5),
            "fullWidth": round(final_p80 * 2, 5),
        },
        "interval90": {
            "halfWidth": round(final_p90, 5),
            "fullWidth": round(final_p90 * 2, 5),
        },
        "uncertaintyScore": round(score, 5),
        "policy": "Residual quantiles are computed on point-in-time historical predictions; wider residuals lower confidence and widen expected move labels.",
    }


def summarize_conformal_calibration(predictions: list[dict[str, Any]], current_regime: dict[str, Any]) -> dict[str, Any]:
    rows = [
        row for row in predictions
        if math.isfinite(number(row.get("predictedFinalReturn"), math.nan))
        and math.isfinite(number(row.get("actualFinalReturn"), math.nan))
    ]
    if not rows:
        return {
            "available": False,
            "framework": "conformal-residual-calibration",
            "reason": "No historical residual rows were available.",
        }
    current_bucket = str(current_regime.get("bucket") or "")
    current_rows = [row for row in rows if row.get("regimeBucket") == current_bucket]
    high_coverage_rows = [row for row in rows if number(row.get("coverageScore"), 0.0) >= 60]
    return {
        "available": True,
        "framework": "conformal-residual-calibration",
        "currentRegime": current_regime,
        "overall": conformal_error_summary(rows, "全部历史切片", "overall"),
        "currentRegimeSummary": conformal_error_summary(current_rows, current_regime.get("label") or current_bucket or "当前状态", current_bucket or "current"),
        "highCoverage": conformal_error_summary(high_coverage_rows, "高覆盖样本", "high_coverage"),
        "policy": "Use empirical residual quantiles to keep final-return/max-upside labels honest; high-confidence labels require narrow historical residual bands.",
    }


def summarize_predictions(predictions: list[dict[str, Any]], target_upside: float) -> dict[str, Any]:
    if not predictions:
        return {"samples": 0}
    buy_rows = [row for row in predictions if row["buySignal"]]
    trade_rows = buy_rows or predictions
    def weighted_rate(rows: list[dict[str, Any]], values: list[float]) -> float:
        weights = [sample_weight(row) for row in rows]
        total = sum(weights)
        if total <= 1e-12:
            return mean(values)
        return sum(values[index] * weights[index] for index in range(len(values))) / total
    def weighted_field(rows: list[dict[str, Any]], key: str) -> float:
        weights = [sample_weight(row) for row in rows]
        total = sum(weights)
        if total <= 1e-12:
            return mean([number(row.get(key)) for row in rows])
        return sum(number(row.get(key)) * weights[index] for index, row in enumerate(rows)) / total
    direction_hits = [
        (row["predictedReturn"] >= 0 and row["actualFinalReturn"] >= 0)
        or (row["predictedReturn"] < 0 and row["actualFinalReturn"] < 0)
        for row in predictions
    ]
    final_hits = [
        row["actualFinalReturn"] >= abs(row["predictedFinalReturn"]) * 0.82
        if row["predictedFinalReturn"] >= 0
        else row["actualFinalReturn"] <= -abs(row["predictedFinalReturn"]) * 0.82
        for row in predictions
        if abs(row["predictedFinalReturn"]) >= 0.25
    ]
    max_hits = [
        row["actualMaxUpside"] >= max(0.25, row["predictedMaxUpside"] * 0.82)
        for row in predictions
        if row["predictedMaxUpside"] >= 0.25
    ]
    brier_target_values = [(row["targetProbability"] - (1.0 if row["targetWins"] else 0.0)) ** 2 for row in predictions]
    brier_stop_values = [(row["stopProbability"] - (1.0 if row["stopWins"] else 0.0)) ** 2 for row in predictions]
    brier_target = weighted_rate(predictions, brier_target_values)
    brier_stop = weighted_rate(predictions, brier_stop_values)
    rejected = [row for row in predictions if not row["buySignal"]]
    high_confidence_rows = [row for row in trade_rows if number(row.get("labelConfidence"), 0.0) >= 0.78 and sample_weight(row) >= 0.72]
    return {
        "samples": len(predictions),
        "effectiveSamples": round(sum(sample_weight(row) for row in predictions), 4),
        "buySignals": len(buy_rows),
        "noTradeSignals": len(rejected),
        "avgSampleWeight": mean([sample_weight(row) for row in predictions]),
        "avgLabelConfidence": mean([number(row.get("labelConfidence"), 1.0) for row in predictions]),
        "avgLabelNoiseScore": mean([number(row.get("labelNoiseScore"), 0.0) for row in predictions]),
        "highNoiseSamplePct": mean([1.0 if number(row.get("labelNoiseScore"), 0.0) >= 55 else 0.0 for row in predictions]) * 100,
        "ambiguousBarrierPct": mean([1.0 if "same_bar_barrier_order_unknown" in (row.get("labelQualityFlags") or []) else 0.0 for row in predictions]) * 100,
        "avgCoverageScore": mean([number(row.get("coverageScore"), 100.0) for row in predictions]),
        "lowQualitySamplePct": mean([1.0 if sample_weight(row) < 0.55 else 0.0 for row in predictions]) * 100,
        "lowCoverageSamplePct": mean([1.0 if number(row.get("coverageScore"), 100.0) < 45 else 0.0 for row in predictions]) * 100,
        "directionHitRate": weighted_rate(predictions, [1.0 if item else 0.0 for item in direction_hits]) * 100,
        "targetHitRate": weighted_rate(trade_rows, [1.0 if row["targetWins"] else 0.0 for row in trade_rows]) * 100,
        "stopRate": weighted_rate(trade_rows, [1.0 if row["stopWins"] else 0.0 for row in trade_rows]) * 100,
        "finalReturnHitRate": mean([1.0 if item else 0.0 for item in final_hits]) * 100 if final_hits else None,
        "maxUpsideHitRate": mean([1.0 if item else 0.0 for item in max_hits]) * 100 if max_hits else None,
        "avgForwardReturn": weighted_field(trade_rows, "actualFinalReturn"),
        "avgRiskAdjustedReturn": weighted_field(trade_rows, "actualRiskAdjustedReturn"),
        "avgMaxUpside": weighted_field(trade_rows, "actualMaxUpside"),
        "avgMaxDrawdown": weighted_field(trade_rows, "actualMaxDrawdown"),
        "brierTarget": brier_target,
        "brierStop": brier_stop,
        "acceptedTargetRate": weighted_rate(buy_rows, [1.0 if row["targetWins"] else 0.0 for row in buy_rows]) * 100 if buy_rows else None,
        "highConfidenceTargetRate": weighted_rate(high_confidence_rows, [1.0 if row["targetWins"] else 0.0 for row in high_confidence_rows]) * 100 if high_confidence_rows else None,
        "highConfidenceSamples": len(high_confidence_rows),
        "rejectedStopRate": weighted_rate(rejected, [1.0 if row["stopWins"] else 0.0 for row in rejected]) * 100 if rejected else None,
        "targetUpside": target_upside,
        "calibration": {
            "target": calibration_rows(predictions, "targetProbability", "targetWins"),
            "stop": calibration_rows(predictions, "stopProbability", "stopWins"),
        },
    }


METHOD_LABELS = {
    "ridge_final_return": "Ridge final-return head",
    "ridge_risk_adjusted": "Ridge risk-adjusted return head",
    "knn_analog": "KNN historical analog head",
    "trend_momentum": "Trend/momentum technical head",
    "mean_reversion": "RSI mean-reversion head",
    "volume_breakout": "Volume breakout head",
    "risk_guard": "Stop-risk adjusted head",
    "target_probability": "Target-probability return head",
    "orderflow_pressure": "Buy/sell pressure and active flow head",
    "volume_profile": "Volume profile and POC distance head",
    "factor_quality": "Composite factor-quality head",
    "liquidity_reversal": "Liquidity shock and reversal head",
}


def horizon_bucket(horizon: int) -> str:
    days = int(horizon or 15)
    if days <= 7:
        return "short"
    if days <= 25:
        return "mid"
    return "long"


def horizon_label(horizon: int) -> str:
    bucket = horizon_bucket(horizon)
    return {"short": "短期", "mid": "中期", "long": "长期"}.get(bucket, "中期")


def method_predictions(
    feature: dict[str, float],
    analog: dict[str, float],
    *,
    model_return: float,
    model_final: float,
    target_prob: float,
    stop_prob: float,
    target_upside: float,
    stop_loss: float,
) -> dict[str, float]:
    """Return-only model heads for prediction calibration, not trade execution."""
    raw_change5 = number(feature.get("rawChange5"))
    raw_change20 = number(feature.get("rawChange20"))
    raw_rsi = number(feature.get("rawRsi"), 50.0)
    volume_ratio = number(feature.get("rawVolumeRatio"), 1.0)
    macd = number(feature.get("macdHist"))
    trend = number(feature.get("trendScore"), 50.0)
    momentum = number(feature.get("momentumScore"), 50.0)
    risk = number(feature.get("riskScore"), 50.0)
    buy_pressure5 = number(feature.get("rawBuyPressure5"), 0.0)
    pressure_change = number(feature.get("pressureChange"), 0.0)
    close_location = number(feature.get("closeLocation"), 0.0)
    volume_accel = number(feature.get("rawVolumeAccel"), 0.0)
    profile_distance = number(feature.get("rawProfileDistance"), 0.0)
    profile_skew = number(feature.get("profileSkew"), 0.0)
    profile_poc_distance = number(feature.get("profilePocDistance"), 0.0)
    profile_imbalance = number(feature.get("profileImbalance"), 0.0)
    factor_quality = number(feature.get("rawFactorQuality"), 0.0)
    trend_quality = number(feature.get("trendQuality"), 0.0)
    liquidity_shock = number(feature.get("liquidityShock"), 0.0)
    reversal_pressure = number(feature.get("reversalPressure"), 0.0)
    true_range = number(feature.get("trueRange"), 0.0)
    trend_head = (
        raw_change20 * 0.12
        + raw_change5 * 0.18
        + (trend - 50) * 0.035
        + (momentum - 50) * 0.03
        + macd * 1.6
    )
    mean_reversion_head = (
        clamp((50 - raw_rsi) * 0.075, -4.5, 4.5)
        - raw_change5 * 0.18
        + (0.25 if raw_change20 > -8 else -0.45)
    )
    volume_breakout_head = (
        max(0.0, volume_ratio - 1.0) * 1.35 * (1 if raw_change5 >= 0 else -0.55)
        + raw_change20 * 0.08
        + macd * 1.2
    )
    probability_head = (target_prob - 0.5) * target_upside * 2.2 - max(0.0, stop_prob - 0.36) * stop_loss * 1.25
    risk_guard_head = model_final - stop_prob * stop_loss * 0.9 + (risk - 50) * 0.025
    orderflow_head = buy_pressure5 * 4.2 + pressure_change * 3.1 + close_location * 0.7 + volume_accel * 0.9
    volume_profile_head = -profile_distance * 0.42 + profile_skew * 0.55 + profile_poc_distance * 0.38 + profile_imbalance * 2.2
    factor_quality_head = factor_quality * 0.14 + trend_quality * 1.3 - liquidity_shock * 0.25
    liquidity_reversal_head = -raw_change5 * 0.12 + reversal_pressure * 2.7 + volume_accel * 0.8 - true_range * 0.35
    return {
        "ridge_final_return": clamp(model_final, -18, 18),
        "ridge_risk_adjusted": clamp(model_return, -18, 18),
        "knn_analog": clamp(number(analog.get("finalReturn")), -18, 18),
        "trend_momentum": clamp(trend_head, -18, 18),
        "mean_reversion": clamp(mean_reversion_head, -18, 18),
        "volume_breakout": clamp(volume_breakout_head, -18, 18),
        "risk_guard": clamp(risk_guard_head, -18, 18),
        "target_probability": clamp(probability_head, -18, 18),
        "orderflow_pressure": clamp(orderflow_head, -18, 18),
        "volume_profile": clamp(volume_profile_head, -18, 18),
        "factor_quality": clamp(factor_quality_head, -18, 18),
        "liquidity_reversal": clamp(liquidity_reversal_head, -18, 18),
    }


def project_simplex(weights: list[float], cap: float = 0.48) -> list[float]:
    values = [max(0.0, number(value)) for value in weights]
    total = sum(values)
    if total <= 1e-12:
        values = [1.0 / max(1, len(values)) for _ in values]
    else:
        values = [value / total for value in values]
    cap = max(0.18, min(1.0, cap))
    for _ in range(4):
        overflow = sum(max(0.0, value - cap) for value in values)
        if overflow <= 1e-9:
            break
        values = [min(value, cap) for value in values]
        receivers = [index for index, value in enumerate(values) if value < cap - 1e-9]
        if not receivers:
            break
        add = overflow / len(receivers)
        for index in receivers:
            values[index] += add
    total = sum(values)
    return [value / total for value in values] if total > 0 else values


def combined_prediction(row: dict[str, Any], names: list[str], weights: list[float]) -> float:
    methods = row.get("methodPredictions") or {}
    return sum(number(methods.get(name)) * number(weights[index]) for index, name in enumerate(names))


def prediction_metrics(rows: list[dict[str, Any]], names: list[str], weights: list[float]) -> dict[str, Any]:
    if not rows:
        return {"samples": 0}
    errors: list[float] = []
    absolute_errors: list[float] = []
    direction_hits: list[float] = []
    target_hits: list[float] = []
    predicted: list[float] = []
    actuals: list[float] = []
    row_weights = [sample_weight(row) for row in rows]
    total_weight = sum(row_weights) or 1.0
    for row in rows:
        pred = combined_prediction(row, names, weights)
        actual = number(row.get("actualFinalReturn"))
        predicted.append(pred)
        actuals.append(actual)
        errors.append((pred - actual) ** 2)
        absolute_errors.append(abs(pred - actual))
        direction_hits.append(1.0 if (pred >= 0 and actual >= 0) or (pred < 0 and actual < 0) else 0.0)
        target_hits.append(1.0 if (pred >= 0 and actual >= max(0.25, pred * 0.72)) or (pred < 0 and actual <= pred * 0.72) else 0.0)
    pred_mean = sum(predicted[index] * row_weights[index] for index in range(len(rows))) / total_weight
    actual_mean = sum(actuals[index] * row_weights[index] for index in range(len(rows))) / total_weight
    covariance = sum((predicted[index] - pred_mean) * (actuals[index] - actual_mean) * row_weights[index] for index in range(len(rows))) / total_weight
    pred_var = sum(((value - pred_mean) ** 2) * row_weights[index] for index, value in enumerate(predicted)) / total_weight
    actual_var = sum(((value - actual_mean) ** 2) * row_weights[index] for index, value in enumerate(actuals)) / total_weight
    corr = covariance / math.sqrt(max(1e-9, pred_var * actual_var))
    return {
        "samples": len(rows),
        "effectiveSamples": total_weight,
        "mse": sum(errors[index] * row_weights[index] for index in range(len(rows))) / total_weight,
        "mae": sum(absolute_errors[index] * row_weights[index] for index in range(len(rows))) / total_weight,
        "directionHitRate": sum(direction_hits[index] * row_weights[index] for index in range(len(rows))) / total_weight * 100,
        "magnitudeHitRate": sum(target_hits[index] * row_weights[index] for index in range(len(rows))) / total_weight * 100,
        "avgPredictedReturn": pred_mean,
        "avgActualReturn": actual_mean,
        "correlation": clamp(corr, -1.0, 1.0),
    }


def fit_prediction_weights(rows: list[dict[str, Any]], names: list[str], penalty: float) -> list[float]:
    if not rows or not names:
        return []
    weights = [1.0 / len(names) for _ in names]
    prior = list(weights)
    row_weights = [sample_weight(row) for row in rows]
    total_weight = sum(row_weights) or 1.0
    lr = 0.0012 / max(1, len(names))
    for _ in range(420):
        gradients = [2 * penalty * (weights[index] - prior[index]) for index in range(len(names))]
        for row_index, row in enumerate(rows):
            methods = row.get("methodPredictions") or {}
            pred = combined_prediction(row, names, weights)
            err = pred - number(row.get("actualFinalReturn"))
            row_weight = row_weights[row_index] / total_weight
            for index, name in enumerate(names):
                gradients[index] += 2 * err * number(methods.get(name)) * row_weight
        weights = project_simplex([weights[index] - lr * gradients[index] for index in range(len(names))])
    return weights


def rounded_metric_dict(metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        key: round(value, 5) if isinstance(value, float) and math.isfinite(value) else value
        for key, value in metrics.items()
    }


def choose_prediction_weight_candidate(
    train_rows: list[dict[str, Any]],
    validation_rows: list[dict[str, Any]],
    names: list[str],
    penalties: list[float],
) -> dict[str, Any]:
    candidates = []
    for penalty in penalties:
        weights = fit_prediction_weights(train_rows, names, penalty)
        validation = prediction_metrics(validation_rows, names, weights)
        candidates.append({
            "penalty": penalty,
            "weights": weights,
            "validation": validation,
            "rankScore": number(validation.get("mse"), 999) - number(validation.get("directionHitRate"), 0) * 0.012,
        })
    return min(candidates, key=lambda item: number(item["rankScore"], 999))


def walk_forward_weight_stability(
    rows: list[dict[str, Any]],
    names: list[str],
    penalties: list[float],
) -> dict[str, Any]:
    """Check whether learned method weights survive multiple later periods.

    This is a second gate after the final holdout. It repeatedly fits weights
    only on earlier prediction cuts and tests on the next chronological fold,
    so a lucky single market phase cannot promote an overfit weight vector.
    """
    if len(rows) < 36 or not names:
        return {
            "available": False,
            "framework": "purged-walk-forward-weight-stability",
            "status": "collecting",
            "sampleCount": len(rows),
            "minSamples": 36,
            "reason": "Need more prediction cuts before multi-fold stability can be trusted.",
        }

    min_train = max(18, min(96, int(len(rows) * 0.42)))
    remaining = len(rows) - min_train
    fold_count = min(5, max(2, remaining // 8))
    fold_size = max(5, remaining // max(1, fold_count))
    equal_weights = [1.0 / len(names) for _ in names]
    folds: list[dict[str, Any]] = []
    start = min_train
    fold_index = 0
    while start < len(rows) - 3 and fold_index < 6:
        end = min(len(rows), start + fold_size)
        if end - start < 4:
            break
        train_pool = rows[:start]
        test_rows = rows[start:end]
        validation_size = max(4, min(18, len(train_pool) // 5))
        if len(train_pool) - validation_size >= 12:
            fit_rows = train_pool[:-validation_size]
            validation_rows = train_pool[-validation_size:]
        else:
            fit_rows = train_pool
            validation_rows = train_pool[-max(4, min(len(train_pool), validation_size)):]
        candidate = choose_prediction_weight_candidate(fit_rows, validation_rows, names, penalties)
        learned = prediction_metrics(test_rows, names, candidate["weights"])
        equal = prediction_metrics(test_rows, names, equal_weights)
        equal_mse = number(equal.get("mse"), 0.0)
        learned_mse = number(learned.get("mse"), 0.0)
        mse_improvement = (equal_mse - learned_mse) / equal_mse * 100 if equal_mse > 1e-9 else 0.0
        direction_lift = number(learned.get("directionHitRate")) - number(equal.get("directionHitRate"))
        folds.append({
            "fold": fold_index + 1,
            "trainSamples": len(train_pool),
            "testSamples": len(test_rows),
            "effectiveTestSamples": round(number(learned.get("effectiveSamples")), 5),
            "penalty": candidate["penalty"],
            "mseImprovementPct": round(mse_improvement, 5),
            "directionLiftPct": round(direction_lift, 5),
            "directionHitRate": round(number(learned.get("directionHitRate")), 5),
            "equalDirectionHitRate": round(number(equal.get("directionHitRate")), 5),
            "weights": {name: round(number(candidate["weights"][index]), 5) for index, name in enumerate(names)},
        })
        start = end
        fold_index += 1

    if len(folds) < 2:
        return {
            "available": False,
            "framework": "purged-walk-forward-weight-stability",
            "status": "collecting",
            "sampleCount": len(rows),
            "foldCount": len(folds),
            "reason": "Not enough later folds for stability validation.",
        }

    fold_weights = [max(1.0, number(row.get("effectiveTestSamples"), row.get("testSamples"))) for row in folds]
    total_fold_weight = sum(fold_weights) or 1.0
    avg_mse_improvement = sum(number(row.get("mseImprovementPct")) * fold_weights[index] for index, row in enumerate(folds)) / total_fold_weight
    avg_direction_lift = sum(number(row.get("directionLiftPct")) * fold_weights[index] for index, row in enumerate(folds)) / total_fold_weight
    min_direction = min(number(row.get("directionHitRate")) for row in folds)
    positive_mse_share = sum(1 for row in folds if number(row.get("mseImprovementPct")) > 0) / len(folds)
    positive_direction_share = sum(1 for row in folds if number(row.get("directionLiftPct")) >= -0.25) / len(folds)
    average_weights = {
        name: sum(number(row.get("weights", {}).get(name)) * fold_weights[index] for index, row in enumerate(folds)) / total_fold_weight
        for name in names
    }
    weight_drifts = [
        sum(abs(number(row.get("weights", {}).get(name)) - average_weights[name]) for name in names)
        for row in folds
    ]
    weight_drift = mean(weight_drifts)
    stability_score = clamp(
        52
        + avg_mse_improvement * 0.9
        + avg_direction_lift * 1.7
        + (positive_mse_share - 0.5) * 24
        + (positive_direction_share - 0.5) * 20
        - weight_drift * 18,
        0,
        100,
    )
    passed = (
        stability_score >= 52
        and avg_mse_improvement >= -1.5
        and avg_direction_lift >= -1.5
        and min_direction >= 42
        and (positive_mse_share >= 0.45 or positive_direction_share >= 0.5)
        and weight_drift <= 0.52
    )
    return {
        "available": True,
        "framework": "purged-walk-forward-weight-stability",
        "status": "pass" if passed else "unstable",
        "pass": passed,
        "sampleCount": len(rows),
        "foldCount": len(folds),
        "stabilityScore": round(stability_score, 4),
        "avgMseImprovementPct": round(avg_mse_improvement, 5),
        "avgDirectionLiftPct": round(avg_direction_lift, 5),
        "minDirectionHitRate": round(min_direction, 5),
        "positiveMseFoldPct": round(positive_mse_share * 100, 5),
        "positiveDirectionFoldPct": round(positive_direction_share * 100, 5),
        "weightDrift": round(weight_drift, 5),
        "averageWeights": {name: round(value, 5) for name, value in average_weights.items()},
        "folds": folds,
        "leakageControl": "Each fold trains on prediction cuts before the fold and tests only on later cuts; no fold can see its own future actual return.",
        "reason": "Learned weights are stable across rolling later periods." if passed else "Learned weights did not generalize consistently across rolling later periods.",
    }


def optimize_prediction_calibration(predictions: list[dict[str, Any]], horizon: int, target_upside: float) -> dict[str, Any]:
    rows = [
        row for row in predictions
        if isinstance(row.get("methodPredictions"), dict) and math.isfinite(number(row.get("actualFinalReturn"), math.nan))
    ]
    if len(rows) < 24:
        return {
            "available": False,
            "framework": "prediction-method-weight-calibration",
            "status": "collecting",
            "sampleCount": len(rows),
            "minSamples": 24,
            "horizonDays": horizon,
            "horizonBucket": horizon_bucket(horizon),
            "reason": "Not enough historical prediction cuts to fit method weights without overfitting.",
        }
    names = [name for name in METHOD_LABELS if all(name in (row.get("methodPredictions") or {}) for row in rows)]
    if not names:
        return {
            "available": False,
            "framework": "prediction-method-weight-calibration",
            "status": "no_methods",
            "sampleCount": len(rows),
            "horizonDays": horizon,
            "horizonBucket": horizon_bucket(horizon),
            "reason": "No common prediction method columns were available.",
        }
    train_end = max(12, int(len(rows) * 0.58))
    validation_end = max(train_end + 6, int(len(rows) * 0.79))
    validation_end = min(validation_end, len(rows) - 4)
    train_rows = rows[:train_end]
    validation_rows = rows[train_end:validation_end]
    test_rows = rows[validation_end:]
    if len(validation_rows) < 4 or len(test_rows) < 4:
        train_rows = rows[:max(12, int(len(rows) * 0.7))]
        validation_rows = rows[max(12, int(len(rows) * 0.7)):max(16, int(len(rows) * 0.85))]
        test_rows = rows[max(16, int(len(rows) * 0.85)):]
    equal_weights = [1.0 / len(names) for _ in names]
    penalties = [0.0, 0.006, 0.02, 0.06, 0.14, 0.32]
    best = choose_prediction_weight_candidate(train_rows, validation_rows, names, penalties)
    train_metrics = prediction_metrics(train_rows, names, best["weights"])
    validation_metrics = prediction_metrics(validation_rows, names, best["weights"])
    test_metrics = prediction_metrics(test_rows, names, best["weights"])
    equal_test = prediction_metrics(test_rows, names, equal_weights)
    momentum_weights = [0.0 for _ in names]
    if "trend_momentum" in names:
        momentum_weights[names.index("trend_momentum")] = 1.0
    else:
        momentum_weights = list(equal_weights)
    momentum_test = prediction_metrics(test_rows, names, momentum_weights)
    stability = walk_forward_weight_stability(rows, names, penalties)
    base_mse = number(equal_test.get("mse"), 0)
    learned_mse = number(test_metrics.get("mse"), 0)
    improvement_pct = (base_mse - learned_mse) / base_mse * 100 if base_mse > 1e-9 else 0.0
    direction_lift = number(test_metrics.get("directionHitRate")) - number(equal_test.get("directionHitRate"))
    active = len(test_rows) >= 8 and (
        (improvement_pct >= 2.0 and direction_lift >= -1.0 and number(test_metrics.get("directionHitRate")) >= 50)
        or direction_lift >= 3.0
    ) and bool(stability.get("pass"))
    deployment_blend = 0.0
    if active:
        stability_multiplier = clamp(number(stability.get("stabilityScore"), 52) / 100.0, 0.5, 1.0)
        deployment_blend = clamp(
            (0.35 + min(0.35, max(0.0, improvement_pct) / 100) + min(0.2, max(0.0, direction_lift) / 100)) * stability_multiplier,
            0.2,
            0.76,
        )
    weights_map = {name: round(number(best["weights"][index]), 5) for index, name in enumerate(names)}
    method_stats = []
    for name in names:
        single = [1.0 if item == name else 0.0 for item in names]
        metric = prediction_metrics(test_rows, names, single)
        method_stats.append({
            "name": name,
            "label": METHOD_LABELS.get(name, name),
            "testMse": round(number(metric.get("mse")), 5),
            "directionHitRate": round(number(metric.get("directionHitRate")), 3),
            "avgPredictedReturn": round(number(metric.get("avgPredictedReturn")), 5),
            "weight": weights_map.get(name, 0),
        })
    method_stats.sort(key=lambda item: (item["weight"], -item["testMse"]), reverse=True)
    stability_reason = stability.get("reason") if stability.get("available") else stability.get("reason", "Stability validation is still collecting.")
    reason = (
        f"Optimized weights passed holdout: test MSE improved {improvement_pct:.1f}% and direction lift {direction_lift:.1f}pct."
        if active else
        f"Holdout/stability gate not sufficient: MSE improvement {improvement_pct:.1f}%, direction lift {direction_lift:.1f}pct; {stability_reason} Keeping it as research evidence only."
    )
    return {
        "available": True,
        "framework": "prediction-method-weight-calibration",
        "status": "active" if active else "research_only",
        "active": active,
        "sampleCount": len(rows),
        "methodCount": len(names),
        "horizonDays": horizon,
        "horizonBucket": horizon_bucket(horizon),
        "horizonLabel": horizon_label(horizon),
        "targetUpside": target_upside,
        "target": "actual final return over the selected horizon",
        "optimizedWeights": weights_map,
        "deploymentBlend": round(deployment_blend, 4),
        "penalty": best["penalty"],
        "testImprovementPct": round(improvement_pct, 4),
        "directionLiftPct": round(direction_lift, 4),
        "train": rounded_metric_dict(train_metrics),
        "validation": rounded_metric_dict(validation_metrics),
        "test": rounded_metric_dict(test_metrics),
        "baselines": {
            "equalWeight": rounded_metric_dict(equal_test),
            "momentumOnly": rounded_metric_dict(momentum_test),
        },
        "stability": stability,
        "methodStats": method_stats,
        "split": {
            "trainSamples": len(train_rows),
            "validationSamples": len(validation_rows),
            "testSamples": len(test_rows),
            "mode": "time_ordered_walk_forward_holdout",
        },
        "leakageControl": "Each method prediction is generated from models trained only on labels whose full future horizon ended before the prediction date; weights are fitted on earlier cuts and reported on later holdout cuts.",
        "reason": reason,
    }


def aggregate_prediction_calibrations(results: list[dict[str, Any]], horizon: int | None = None) -> dict[str, Any] | None:
    rows = [
        row.get("predictionCalibration") for row in results
        if row.get("available") and row.get("predictionCalibration", {}).get("available")
    ]
    if horizon is not None:
        rows = [row for row in rows if int(row.get("horizonDays") or 0) == int(horizon)]
    if not rows:
        return None
    total_samples = sum(max(1, int(number(row.get("sampleCount")))) for row in rows)
    weights: dict[str, float] = {}
    for row in rows:
        sample_weight = max(1, int(number(row.get("sampleCount")))) / max(1, total_samples)
        quality = 1.0 + max(0.0, number(row.get("testImprovementPct"))) / 100 + max(0.0, number(row.get("directionLiftPct"))) / 100
        for name, value in (row.get("optimizedWeights") or {}).items():
            weights[name] = weights.get(name, 0.0) + number(value) * sample_weight * quality
    total_weight = sum(max(0.0, value) for value in weights.values()) or 1.0
    weights = {name: round(max(0.0, value) / total_weight, 5) for name, value in weights.items()}
    weighted = lambda key, section="test": (
        sum(number(row.get(section, {}).get(key)) * max(1, int(number(row.get("sampleCount")))) for row in rows)
        / max(1, total_samples)
    )
    active_count = sum(1 for row in rows if row.get("active"))
    stability_rows = [row.get("stability") or {} for row in rows if (row.get("stability") or {}).get("available")]
    stability_weight = sum(max(1, int(number(row.get("sampleCount")))) for row in rows if (row.get("stability") or {}).get("available")) or 1
    stability_weighted = lambda key: (
        sum(number((row.get("stability") or {}).get(key)) * max(1, int(number(row.get("sampleCount")))) for row in rows if (row.get("stability") or {}).get("available"))
        / stability_weight
    )
    stability_pass_count = sum(1 for row in stability_rows if row.get("pass"))
    return {
        "available": True,
        "framework": "prediction-method-weight-calibration-aggregate",
        "status": "active" if active_count else "research_only",
        "active": bool(active_count),
        "symbolCount": len(rows),
        "activeSymbolCount": active_count,
        "sampleCount": total_samples,
        "horizonDays": horizon or rows[0].get("horizonDays"),
        "horizonBucket": horizon_bucket(int(horizon or rows[0].get("horizonDays") or 15)),
        "horizonLabel": horizon_label(int(horizon or rows[0].get("horizonDays") or 15)),
        "optimizedWeights": weights,
        "test": {
            "mse": round(weighted("mse"), 5),
            "mae": round(weighted("mae"), 5),
            "directionHitRate": round(weighted("directionHitRate"), 4),
            "magnitudeHitRate": round(weighted("magnitudeHitRate"), 4),
            "correlation": round(weighted("correlation"), 5),
        },
        "baselines": {
            "equalWeightDirectionHitRate": round(
                sum(number(row.get("baselines", {}).get("equalWeight", {}).get("directionHitRate")) * max(1, int(number(row.get("sampleCount")))) for row in rows) / max(1, total_samples),
                4,
            ),
            "momentumOnlyDirectionHitRate": round(
                sum(number(row.get("baselines", {}).get("momentumOnly", {}).get("directionHitRate")) * max(1, int(number(row.get("sampleCount")))) for row in rows) / max(1, total_samples),
                4,
            ),
        },
        "stability": {
            "framework": "aggregate-purged-walk-forward-weight-stability",
            "available": bool(stability_rows),
            "symbolCount": len(stability_rows),
            "passCount": stability_pass_count,
            "passRatePct": round(stability_pass_count / len(stability_rows) * 100, 4) if stability_rows else 0.0,
            "avgStabilityScore": round(stability_weighted("stabilityScore"), 4) if stability_rows else None,
            "avgMseImprovementPct": round(stability_weighted("avgMseImprovementPct"), 5) if stability_rows else None,
            "avgDirectionLiftPct": round(stability_weighted("avgDirectionLiftPct"), 5) if stability_rows else None,
            "avgWeightDrift": round(stability_weighted("weightDrift"), 5) if stability_rows else None,
            "policy": "Learned prediction weights stay research-only unless rolling later-period folds are stable; this reduces overfit to one recent regime.",
        },
        "reason": "Aggregated across symbols by sample count and holdout quality; used as market-level prediction-weight evidence, not as a trade rule by itself.",
    }


def aggregate_regime_calibrations(results: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [row.get("regimeCalibration") or {} for row in results if row.get("available") and row.get("regimeCalibration")]
    if not rows:
        return {
            "available": False,
            "framework": "aggregate-point-in-time-regime-bucket-calibration",
            "reason": "No symbol-level regime calibration was available.",
        }
    bucket_map: dict[str, dict[str, Any]] = {}
    matched_rows = []
    for calibration in rows:
        matched = calibration.get("matchedBucket")
        if matched:
            matched_rows.append(matched)
        for bucket in calibration.get("buckets") or []:
            key = str(bucket.get("bucket") or "unknown")
            item = bucket_map.setdefault(key, {
                "bucket": key,
                "label": bucket.get("label") or key,
                "symbolBuckets": 0,
                "samples": 0.0,
                "targetHitRate": 0.0,
                "stopRate": 0.0,
                "directionHitRate": 0.0,
                "avgReturn": 0.0,
                "avgCoverageScore": 0.0,
            })
            weight = max(1e-9, number(bucket.get("effectiveSamples"), bucket.get("count", 0)))
            item["symbolBuckets"] += 1
            item["samples"] += weight
            for field in ["targetHitRate", "stopRate", "directionHitRate", "avgReturn", "avgCoverageScore"]:
                item[field] += number(bucket.get(field)) * weight
    buckets = []
    for item in bucket_map.values():
        samples = max(1e-9, number(item.get("samples")))
        buckets.append({
            "bucket": item["bucket"],
            "label": item["label"],
            "symbolBuckets": int(item["symbolBuckets"]),
            "effectiveSamples": round(samples, 4),
            "targetHitRate": round(number(item["targetHitRate"]) / samples, 4),
            "stopRate": round(number(item["stopRate"]) / samples, 4),
            "directionHitRate": round(number(item["directionHitRate"]) / samples, 4),
            "avgReturn": round(number(item["avgReturn"]) / samples, 5),
            "avgCoverageScore": round(number(item["avgCoverageScore"]) / samples, 5),
        })
    buckets.sort(key=lambda row: (-number(row.get("effectiveSamples")), row.get("bucket")))
    matched_weight = sum(max(1e-9, number(row.get("effectiveSamples"), row.get("count", 0))) for row in matched_rows) or 1.0
    matched_avg = lambda field: (
        sum(number(row.get(field)) * max(1e-9, number(row.get("effectiveSamples"), row.get("count", 0))) for row in matched_rows) / matched_weight
        if matched_rows else None
    )
    return {
        "available": True,
        "framework": "aggregate-point-in-time-regime-bucket-calibration",
        "symbolCount": len(rows),
        "matchedSymbolCount": len(matched_rows),
        "matchedCurrentRegime": {
            "effectiveSamples": round(matched_weight, 4) if matched_rows else 0,
            "targetHitRate": round(matched_avg("targetHitRate"), 4) if matched_rows else None,
            "stopRate": round(matched_avg("stopRate"), 4) if matched_rows else None,
            "directionHitRate": round(matched_avg("directionHitRate"), 4) if matched_rows else None,
            "avgReturn": round(matched_avg("avgReturn"), 5) if matched_rows else None,
            "avgCoverageScore": round(matched_avg("avgCoverageScore"), 5) if matched_rows else None,
        },
        "buckets": buckets,
        "policy": "Aggregates point-in-time regime buckets across symbols; matchedCurrentRegime summarizes each symbol's current regime evidence.",
    }


def aggregate_conformal_calibrations(results: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [row.get("conformalCalibration") or {} for row in results if row.get("available") and row.get("conformalCalibration")]
    rows = [row for row in rows if row.get("available")]
    if not rows:
        return {
            "available": False,
            "framework": "aggregate-conformal-residual-calibration",
            "reason": "No symbol-level conformal calibration was available.",
        }

    def aggregate_section(name: str) -> dict[str, Any]:
        sections = [row.get(name) or {} for row in rows if (row.get(name) or {}).get("samples")]
        total = sum(max(1e-9, number(section.get("effectiveSamples"), section.get("samples", 0))) for section in sections)
        if not sections or total <= 1e-12:
            return {"available": False, "samples": 0, "effectiveSamples": 0.0}
        weighted = lambda field: sum(number(section.get(field)) * max(1e-9, number(section.get("effectiveSamples"), section.get("samples", 0))) for section in sections) / total
        return {
            "available": True,
            "samples": sum(int(number(section.get("samples"))) for section in sections),
            "effectiveSamples": round(total, 4),
            "finalReturnAbsErrorP50": round(weighted("finalReturnAbsErrorP50"), 5),
            "finalReturnAbsErrorP80": round(weighted("finalReturnAbsErrorP80"), 5),
            "finalReturnAbsErrorP90": round(weighted("finalReturnAbsErrorP90"), 5),
            "maxUpsideAbsErrorP80": round(weighted("maxUpsideAbsErrorP80"), 5),
            "directionMissRate": round(weighted("directionMissRate"), 5),
            "uncertaintyScore": round(weighted("uncertaintyScore"), 5),
        }

    return {
        "available": True,
        "framework": "aggregate-conformal-residual-calibration",
        "symbolCount": len(rows),
        "overall": aggregate_section("overall"),
        "currentRegimeSummary": aggregate_section("currentRegimeSummary"),
        "highCoverage": aggregate_section("highCoverage"),
        "policy": "Aggregates empirical residual quantiles across symbol-level point-in-time predictions.",
    }


def compact_horizon_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "available": bool(result.get("available")),
        "market": result.get("market"),
        "symbol": result.get("symbol"),
        "horizonDays": result.get("horizonDays"),
        "candleCount": result.get("candleCount"),
        "dateRange": result.get("dateRange"),
        "dataDepth": result.get("dataDepth"),
        "metrics": result.get("metrics"),
        "predictionCalibration": result.get("predictionCalibration"),
        "regimeCalibration": result.get("regimeCalibration"),
        "conformalCalibration": result.get("conformalCalibration"),
        "values": result.get("values"),
        "reason": result.get("reason"),
    }


def parse_step_schedule(raw: Any, default_step: int) -> list[int]:
    if isinstance(raw, str):
        parts = [part.strip() for part in raw.split(",") if part.strip()]
    elif isinstance(raw, (list, tuple, set)):
        parts = list(raw)
    elif raw is None:
        parts = [default_step]
    else:
        parts = [raw]
    values: list[int] = []
    for part in parts:
        step_value = max(1, int(number(part, default_step)))
        if step_value not in values:
            values.append(step_value)
    return values or [max(1, int(default_step or 1))]


def candidate_indexes_from_step_schedule(
    *,
    start: int,
    stop: int,
    by_index: dict[int, dict[str, Any]],
    step_schedule: list[int],
    max_offsets_per_step: int,
    max_predictions: int,
) -> tuple[list[int], list[dict[str, Any]]]:
    seen: set[int] = set()
    source_counts: dict[str, int] = {}
    for step_value in step_schedule:
        step_value = max(1, int(step_value or 1))
        offsets = list(range(min(step_value, max(1, int(max_offsets_per_step or 1)))))
        if step_value > 2 and 0 not in offsets:
            offsets.insert(0, 0)
        for offset in offsets:
            count = 0
            first_index = start + offset
            for index in range(first_index, stop, step_value):
                if index in by_index:
                    seen.add(index)
                    count += 1
            source_counts[f"step{step_value}:offset{offset}"] = count
    candidate_indexes = sorted(seen)
    raw_count = len(candidate_indexes)
    downsample_stride = 1
    if max_predictions > 0 and len(candidate_indexes) > max_predictions:
        downsample_stride = math.ceil(len(candidate_indexes) / max_predictions)
        candidate_indexes = candidate_indexes[::downsample_stride]
    slice_plan = [
        {"source": source, "rawCuts": count}
        for source, count in sorted(source_counts.items(), key=lambda item: item[0])
    ]
    return candidate_indexes, [
        *slice_plan,
        {
            "source": "dedupe-and-cap",
            "rawUniqueCuts": raw_count,
            "finalCuts": len(candidate_indexes),
            "downsampleStride": downsample_stride,
            "maxPredictions": max_predictions,
        },
    ]


def run_historical_backtest(
    candles: list[dict[str, Any]],
    *,
    market: str = "ASX",
    symbol: str = "",
    horizon: int = 15,
    target_upside: float = 5.0,
    stop_loss: float = 4.0,
    min_train: int = 120,
    step: int = 1,
    step_schedule: list[int] | None = None,
    max_step_offsets: int = 1,
    max_predictions: int = 2000,
    retrain_interval: int = 60,
    max_train_window: int = 240,
    knn_window: int = 260,
) -> dict[str, Any]:
    rows = sanitize_candles(candles)
    data_quality = assess_candle_quality(rows)
    horizon = max(1, int(horizon or 15))
    target_upside = max(0.5, number(target_upside, 5.0))
    stop_loss = max(0.8, abs(number(stop_loss, 4.0)))
    step = max(1, int(step or 1))
    steps = parse_step_schedule(step_schedule, step)
    max_step_offsets = max(1, min(12, int(max_step_offsets or 1)))
    if len(rows) < min_train + horizon + 40:
        return {
            "available": False,
            "framework": "historical-walk-forward-backtest",
            "market": market,
            "symbol": symbol,
            "candleCount": len(rows),
            "dataQuality": data_quality,
            "minRequired": min_train + horizon + 40,
            "reason": "Not enough historical candles for point-in-time walk-forward backtest.",
        }

    labeled = build_labeled_rows(rows, horizon, target_upside, stop_loss, data_quality)
    by_index = {row["index"]: row for row in labeled}
    predictions: list[dict[str, Any]] = []
    model_cache: dict[int, dict[str, Any]] = {}
    candidate_indexes, slice_plan = candidate_indexes_from_step_schedule(
        start=max(70, min_train),
        stop=len(rows) - horizon,
        by_index=by_index,
        step_schedule=steps,
        max_offsets_per_step=max_step_offsets,
        max_predictions=max_predictions,
    )

    train_depths: list[int] = []
    embargo = max(2, math.ceil(horizon / 2))
    for position, index in enumerate(candidate_indexes):
        train_cutoff = index - horizon - embargo
        train_rows = [row for row in labeled if row["index"] <= train_cutoff]
        if len(train_rows) < min_train:
            continue
        train_depths.append(len(train_rows))
        model_train_rows = train_rows[-max(80, int(max_train_window or 520)):]
        knn_train_rows = train_rows[-max(60, int(knn_window or 360)):]
        cache_key = train_rows[-1]["index"] // max(1, retrain_interval)
        if cache_key not in model_cache:
            model_cache[cache_key] = {
                "return": fit_ridge(model_train_rows, "y_return", 0.1),
                "final": fit_ridge(model_train_rows, "y_final", 0.1),
                "max": fit_ridge(model_train_rows, "y_max", 0.1),
                "target": fit_logistic(model_train_rows, "y_target", 0.1),
                "stop": fit_logistic(model_train_rows, "y_stop", 0.1),
            }
        models = model_cache[cache_key]
        current = by_index[index]
        x = current["x"]
        analog = knn_prediction(knn_train_rows, x, 18)
        model_return = predict_linear(models["return"], x)
        model_final = predict_linear(models["final"], x)
        model_max = max(0.0, predict_linear(models["max"], x))
        target_prob = clamp(predict_logistic(models["target"], x) * 0.62 + analog["targetProb"] * 0.38, 0.0, 1.0)
        stop_prob = clamp(predict_logistic(models["stop"], x) * 0.62 + analog["stopProb"] * 0.38, 0.0, 1.0)
        predicted_return = clamp(model_return * 0.58 + analog["return"] * 0.42, -18, 18)
        predicted_final = clamp(model_final * 0.58 + analog["finalReturn"] * 0.42, -18, 18)
        predicted_max = clamp(model_max * 0.58 + analog["maxUpside"] * 0.42, 0, 24)
        coverage_score = number(analog.get("coverageScore"), 0.0)
        coverage_weight = clamp(number(analog.get("coverageWeight"), 1.0), 0.2, 1.0)
        regime_context = regime_bucket_from_feature(current["feature"], coverage_score)
        methods = method_predictions(
            current["feature"],
            analog,
            model_return=model_return,
            model_final=model_final,
            target_prob=target_prob,
            stop_prob=stop_prob,
            target_upside=target_upside,
            stop_loss=stop_loss,
        )
        buy_signal = (
            target_prob >= 0.56
            and stop_prob <= 0.46
            and predicted_max >= target_upside * 0.45
            and predicted_return > -0.15
            and coverage_score >= 45
        )
        outcome = current["outcome"]
        effective_sample_weight = clamp(sample_weight(current) * coverage_weight, 0.03, 1.0)
        predictions.append({
            "date": current["date"],
            "index": index,
            "trainSamples": len(train_rows),
            "sampleWeight": effective_sample_weight,
            "baseSampleWeight": sample_weight(current),
            "dataQualityScore": current.get("dataQualityScore"),
            "dataQualityFlags": current.get("dataQualityFlags", []),
            "labelConfidence": current.get("labelConfidence"),
            "labelNoiseScore": current.get("labelNoiseScore"),
            "labelPathMetrics": current.get("labelPathMetrics", {}),
            "labelQualityFlags": current.get("labelQualityFlags", []),
            "coverageScore": coverage_score,
            "coverageWeight": coverage_weight,
            "nearestDistance": analog.get("nearestDistance"),
            "avgNeighborDistance": analog.get("avgNeighborDistance"),
            "p75NeighborDistance": analog.get("p75NeighborDistance"),
            "oodRisk": analog.get("oodRisk"),
            "regimeBucket": regime_context["bucket"],
            "regimeLabel": regime_context["label"],
            "regimeContext": regime_context,
            "targetProbability": target_prob,
            "stopProbability": stop_prob,
            "predictedReturn": predicted_return,
            "predictedFinalReturn": predicted_final,
            "predictedMaxUpside": predicted_max,
            "methodPredictions": methods,
            "buySignal": buy_signal,
            "targetWins": bool(outcome["targetWins"]),
            "stopWins": bool(outcome["stopWins"]),
            "actualFinalReturn": number(outcome["forwardReturn"]),
            "actualMaxUpside": number(outcome["maxUpside"]),
            "actualMaxDrawdown": number(outcome["maxDrawdown"]),
            "actualRiskAdjustedReturn": number(outcome["riskAdjustedReturn"]),
        })

    summary = summarize_predictions(predictions, target_upside)
    latest_feature = feature_dict(rows, len(rows) - 1)
    current_regime = regime_bucket_from_feature(
        latest_feature,
        mean([number(row.get("coverageScore"), 100.0) for row in predictions[-8:]]) if predictions else 100.0,
    )
    regime_calibration = summarize_regime_calibration(predictions, current_regime)
    conformal_calibration = summarize_conformal_calibration(predictions, current_regime)
    prediction_calibration = optimize_prediction_calibration(predictions, horizon, target_upside)
    if not predictions:
        return {
            "available": False,
            "framework": "historical-walk-forward-backtest",
            "market": market,
            "symbol": symbol,
            "candleCount": len(rows),
            "dataQuality": data_quality,
            "reason": "Historical candles existed, but no cut had enough prior fully-known labels.",
        }
    buy_hold_direction = mean([
        1.0 if row["actualFinalReturn"] >= 0 else 0.0
        for row in predictions
    ]) * 100
    momentum_direction = mean([
        1.0 if (
            (by_index[row["index"]]["feature"]["rawChange20"] >= 0 and row["actualFinalReturn"] >= 0)
            or (by_index[row["index"]]["feature"]["rawChange20"] < 0 and row["actualFinalReturn"] < 0)
        ) else 0.0
        for row in predictions
    ]) * 100
    first = rows[0]
    last = rows[-1]
    return {
        "available": True,
        "framework": "historical-walk-forward-backtest",
        "market": market,
        "symbol": symbol,
        "source": "point-in-time-ohlcv-walk-forward",
        "candleCount": len(rows),
        "dateRange": {"start": first["date"], "end": last["date"]},
        "dataQuality": {
            **{key: value for key, value in data_quality.items() if key != "rows"},
            "recentRows": data_quality.get("rows", [])[-12:],
            "learningPolicy": "Rows are retained for chronology but Ridge/Logistic/KNN/weight calibration are down-weighted by sampleWeight=min(candleQuality,labelConfidence); labels with same-bar target/stop ambiguity, high path chop, or two-sided excursions receive lower weight.",
        },
        "horizonDays": horizon,
        "targetUpside": target_upside,
        "stopLoss": stop_loss,
        "embargoSamples": embargo,
        "minTrainSamples": min_train,
        "step": step,
        "stepSchedule": steps,
        "maxStepOffsets": max_step_offsets,
        "model": {
            "name": "rolling-ridge-logistic-plus-knn-analog",
            "featureCount": len(FEATURE_NAMES),
            "features": FEATURE_NAMES,
            "retrainInterval": retrain_interval,
            "maxTrainWindow": max_train_window,
            "knnWindow": knn_window,
            "leakageControl": "For each historical cut, labels are trained only when their full future window ended before the prediction date, plus embargo.",
            "predictionWeightCalibration": "Return-prediction method weights are trained on earlier prediction cuts and evaluated on later holdout cuts; inactive unless they beat simple baselines.",
            "formulas": FORMULA_BOOK,
        },
        "dataDepth": {
            "labelCount": len(labeled),
            "predictionCuts": len(predictions),
            "effectivePredictionCuts": round(sum(sample_weight(row) for row in predictions), 4),
            "candidateCuts": len(candidate_indexes),
            "trainSamplesMin": min(train_depths) if train_depths else 0,
            "trainSamplesMedian": median(train_depths) if train_depths else 0,
            "trainSamplesMax": max(train_depths) if train_depths else 0,
            "maxPredictions": max_predictions,
            "slicePlan": slice_plan,
            "leakageAudit": {
                "embargoSamples": embargo,
                "rule": "train_row.index + horizon <= prediction_index - embargo",
                "minimumTrainCutoffGap": horizon + embargo,
                "features": "All features use candles <= prediction index t.",
                "labels": "Outcome labels are used only for completed historical rows and never for the prediction cut model training.",
                "qualityWeights": "Data-quality and label-confidence weights use only candle rows up to t and completed historical outcome windows for already-known labels.",
            },
        },
        "metrics": {key: (round(value, 5) if isinstance(value, float) and math.isfinite(value) else value) for key, value in summary.items()},
        "benchmarks": [
            {"name": "random_direction", "directionHitRate": 50.0, "note": "Coin-flip baseline."},
            {"name": "buy_hold_direction", "directionHitRate": round(buy_hold_direction, 2), "note": "Always assumes non-negative horizon return."},
            {"name": "simple_20d_momentum_direction", "directionHitRate": round(momentum_direction, 2), "note": "Predicts next direction from prior 20-day return sign."},
        ],
        "predictionCalibration": prediction_calibration,
        "regimeCalibration": regime_calibration,
        "conformalCalibration": conformal_calibration,
        "recentPredictions": predictions[-30:],
        "values": {
            "samples": summary.get("buySignals") or summary.get("samples") or 0,
            "hitRate": summary.get("acceptedTargetRate") if summary.get("acceptedTargetRate") is not None else summary.get("targetHitRate"),
            "stopRate": summary.get("stopRate"),
            "avgReturn": summary.get("avgForwardReturn"),
            "directionHitRate": summary.get("directionHitRate"),
            "predictionWeightDirectionHitRate": prediction_calibration.get("test", {}).get("directionHitRate") if prediction_calibration else None,
            "predictionWeightMse": prediction_calibration.get("test", {}).get("mse") if prediction_calibration else None,
            "predictionWeightActive": bool(prediction_calibration.get("active")) if prediction_calibration else False,
            "brierTarget": summary.get("brierTarget"),
            "brierStop": summary.get("brierStop"),
            "avgCoverageScore": summary.get("avgCoverageScore"),
            "lowCoverageSamplePct": summary.get("lowCoverageSamplePct"),
            "avgLabelNoiseScore": summary.get("avgLabelNoiseScore"),
            "highNoiseSamplePct": summary.get("highNoiseSamplePct"),
            "ambiguousBarrierPct": summary.get("ambiguousBarrierPct"),
            "currentRegime": regime_calibration.get("current", {}).get("bucket"),
            "currentRegimeTargetHitRate": regime_calibration.get("matchedBucket", {}).get("targetHitRate") if regime_calibration.get("matchedBucket") else None,
            "currentRegimeStopRate": regime_calibration.get("matchedBucket", {}).get("stopRate") if regime_calibration.get("matchedBucket") else None,
            "currentRegimeAvgReturn": regime_calibration.get("matchedBucket", {}).get("avgReturn") if regime_calibration.get("matchedBucket") else None,
            "finalReturnP80Error": conformal_calibration.get("overall", {}).get("finalReturnAbsErrorP80"),
            "finalReturnP90Error": conformal_calibration.get("overall", {}).get("finalReturnAbsErrorP90"),
            "currentRegimeP80Error": conformal_calibration.get("currentRegimeSummary", {}).get("finalReturnAbsErrorP80"),
        },
        "thesis": [
            f"Historical walk-forward used {len(predictions)} point-in-time cuts from {len(rows)} real OHLCV candles.",
            f"Each cut trained on fully-known prior labels only; median training depth {median(train_depths) if train_depths else 0} samples, embargo {embargo} candles.",
            f"Data quality gate grade {data_quality.get('grade')} with average score {data_quality.get('avgScore')} and degraded-row share {data_quality.get('degradedRowPct')}%; weak labels are down-weighted rather than blindly trusted.",
            f"Label-noise gate average {summary.get('avgLabelNoiseScore'):.1f}/100 with high-noise share {summary.get('highNoiseSamplePct'):.1f}% and same-bar target/stop ambiguity {summary.get('ambiguousBarrierPct'):.1f}%.",
            f"Sample coverage gate average {summary.get('avgCoverageScore'):.1f}/100; low-coverage share {summary.get('lowCoverageSamplePct'):.1f}%, so out-of-distribution cuts cannot dominate confidence.",
            f"Current regime bucket {regime_calibration.get('current', {}).get('label')}; matched historical cuts {regime_calibration.get('matchedBucket', {}).get('count', 0)} with target-hit {number(regime_calibration.get('matchedBucket', {}).get('targetHitRate'), 0):.1f}% and stop-first {number(regime_calibration.get('matchedBucket', {}).get('stopRate'), 0):.1f}%.",
            f"Conformal residuals: final-return P80 error {number(conformal_calibration.get('overall', {}).get('finalReturnAbsErrorP80'), 0):.2f}%, P90 {number(conformal_calibration.get('overall', {}).get('finalReturnAbsErrorP90'), 0):.2f}%; labels are widened when historical residuals are wide.",
            f"Accepted buy-signal target hit {summary.get('acceptedTargetRate') if summary.get('acceptedTargetRate') is not None else summary.get('targetHitRate'):.1f}%, stop-first {summary.get('stopRate'):.1f}%, average forward return {summary.get('avgForwardReturn'):.2f}%.",
            f"Prediction-weight calibration ({horizon_label(horizon)}): {prediction_calibration.get('status', 'collecting')} with {prediction_calibration.get('sampleCount', 0)} historical cuts.",
        ],
    }


def batch_historical_backtest(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("items") or []
    results = []
    raw_horizons = payload.get("horizons") or payload.get("horizon_days") or payload.get("horizonDays") or 15
    if isinstance(raw_horizons, list):
        horizons = [max(1, int(number(value, 15))) for value in raw_horizons]
    else:
        horizons = [max(1, int(number(raw_horizons, 15)))]
    main_horizon = max(1, int(number(payload.get("horizon_days", payload.get("horizonDays")), horizons[0] or 15)))
    default_step = int(payload.get("step") or 1)
    step_schedule = parse_step_schedule(
        payload.get("step_schedule", payload.get("stepSchedule", payload.get("steps"))),
        default_step,
    )
    max_step_offsets = max(1, min(12, int(number(payload.get("max_step_offsets", payload.get("maxStepOffsets")), 1))))
    horizon_set = []
    for value in [main_horizon, *horizons]:
        if value not in horizon_set:
            horizon_set.append(value)
    all_horizon_results: dict[int, list[dict[str, Any]]] = {value: [] for value in horizon_set}
    for item in items:
        horizon_results = []
        for horizon in horizon_set:
            result = run_historical_backtest(
                item.get("candles") or [],
                market=str(item.get("market") or payload.get("market") or "ASX"),
                symbol=str(item.get("symbol") or ""),
                horizon=horizon,
                target_upside=number(payload.get("target_upside", payload.get("targetUpside")), 5.0),
                stop_loss=number(payload.get("stop_loss", payload.get("stopLoss")), 4.0),
                min_train=int(payload.get("min_train", payload.get("minTrain")) or 120),
                step=default_step,
                step_schedule=step_schedule,
                max_step_offsets=max_step_offsets,
                max_predictions=int(payload.get("max_predictions", payload.get("maxPredictions")) or 2000),
                retrain_interval=int(payload.get("retrain_interval", payload.get("retrainInterval")) or 60),
                max_train_window=int(payload.get("max_train_window", payload.get("maxTrainWindow")) or 240),
                knn_window=int(payload.get("knn_window", payload.get("knnWindow")) or 260),
            )
            all_horizon_results[horizon].append(result)
            horizon_results.append(result)
        main_result = next((row for row in horizon_results if int(row.get("horizonDays") or 0) == main_horizon), horizon_results[0])
        if len(horizon_results) > 1:
            main_result = {**main_result, "horizonResults": [compact_horizon_result(row) for row in horizon_results]}
        results.append(main_result)
    available = [row for row in results if row.get("available")]
    sample_total = sum(int(number(row.get("metrics", {}).get("samples"))) for row in available)
    buy_total = sum(int(number(row.get("metrics", {}).get("buySignals"))) for row in available)
    data_quality_rows = [row.get("dataQuality") or {} for row in available if row.get("dataQuality")]
    data_quality_weight = sum(max(1, int(number(row.get("candleCount")))) for row in available) or 1
    issue_counts: dict[str, int] = {}
    for quality in data_quality_rows:
        for name, count in (quality.get("issueCounts") or {}).items():
            issue_counts[name] = issue_counts.get(name, 0) + int(number(count))
    weighted = lambda key: (
        sum(number(row.get("metrics", {}).get(key)) * max(1, int(number(row.get("metrics", {}).get("samples")))) for row in available)
        / max(1, sum(max(1, int(number(row.get("metrics", {}).get("samples")))) for row in available))
    )
    weighted_quality = lambda key: (
        sum(number(row.get("dataQuality", {}).get(key)) * max(1, int(number(row.get("candleCount")))) for row in available)
        / data_quality_weight
    )
    horizon_calibrations = [
        row for row in (
            aggregate_prediction_calibrations(all_horizon_results.get(horizon, []), horizon)
            for horizon in horizon_set
        )
        if row
    ]
    main_prediction_calibration = next(
        (row for row in horizon_calibrations if int(row.get("horizonDays") or 0) == main_horizon),
        aggregate_prediction_calibrations(results, main_horizon),
    )
    regime_calibration = aggregate_regime_calibrations(available)
    conformal_calibration = aggregate_conformal_calibrations(available)
    return {
        "framework": "historical-walk-forward-backtest-batch",
        "market": str(payload.get("market") or "ASX"),
        "available": bool(available),
        "symbolCount": len(results),
        "availableCount": len(available),
        "sampleTotal": sample_total,
        "buySignalTotal": buy_total,
        "sampling": {
            "step": default_step,
            "stepSchedule": step_schedule,
            "maxStepOffsets": max_step_offsets,
            "dedupeKey": "symbol+horizon+historical candle index/date",
        },
        "metrics": {
            "directionHitRate": round(weighted("directionHitRate"), 4) if available else None,
            "targetHitRate": round(weighted("targetHitRate"), 4) if available else None,
            "stopRate": round(weighted("stopRate"), 4) if available else None,
            "avgForwardReturn": round(weighted("avgForwardReturn"), 4) if available else None,
            "brierTarget": round(weighted("brierTarget"), 5) if available else None,
            "effectiveSamples": round(weighted("effectiveSamples"), 4) if available else None,
            "avgLabelConfidence": round(weighted("avgLabelConfidence"), 5) if available else None,
            "avgLabelNoiseScore": round(weighted("avgLabelNoiseScore"), 5) if available else None,
            "highNoiseSamplePct": round(weighted("highNoiseSamplePct"), 4) if available else None,
            "ambiguousBarrierPct": round(weighted("ambiguousBarrierPct"), 4) if available else None,
            "lowQualitySamplePct": round(weighted("lowQualitySamplePct"), 4) if available else None,
            "avgCoverageScore": round(weighted("avgCoverageScore"), 4) if available else None,
            "lowCoverageSamplePct": round(weighted("lowCoverageSamplePct"), 4) if available else None,
        },
        "dataQuality": {
            "framework": "batch-point-in-time-candle-quality-gate",
            "symbolCount": len(data_quality_rows),
            "avgScore": round(weighted_quality("avgScore"), 4) if available else None,
            "highQualityPct": round(weighted_quality("highQualityPct"), 4) if available else None,
            "degradedRowPct": round(weighted_quality("degradedRowPct"), 4) if available else None,
            "avgSampleWeight": round(weighted_quality("avgSampleWeight"), 5) if available else None,
            "issueCounts": dict(sorted(issue_counts.items(), key=lambda item: (-item[1], item[0]))[:12]),
            "learningPolicy": "Batch metrics aggregate symbol-level data-quality, label-confidence, path-noise, and coverage weighted backtests.",
        },
        "predictionCalibration": main_prediction_calibration,
        "horizonCalibrations": horizon_calibrations,
        "regimeCalibration": regime_calibration,
        "conformalCalibration": conformal_calibration,
        "modelStorage": {
            "persistRecommended": True,
            "sampleRetention": "append-only local market cache; historical candles and learned weights are reusable because past OHLCV rows are point-in-time stable after adjustment policy is fixed",
        },
        "results": results,
    }
