from __future__ import annotations

import math
import random
from typing import Any

from features import _pearson, _spearman, clamp, mean, number, pct_change, sanitize_candles, stddev


def _sma(values: list[float], window: int) -> list[float]:
    rows: list[float] = []
    for index in range(len(values)):
        rows.append(mean(values[max(0, index - window + 1) : index + 1]))
    return rows


def _ema(values: list[float], window: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (window + 1)
    out: list[float] = []
    previous = values[0]
    for index, value in enumerate(values):
        previous = value if index == 0 else value * alpha + previous * (1 - alpha)
        out.append(previous)
    return out


def _std_series(values: list[float], window: int) -> list[float]:
    return [stddev(values[max(0, index - window + 1) : index + 1]) for index in range(len(values))]


def _zscore(values: list[float], window: int = 60) -> list[float]:
    out: list[float] = []
    for index, value in enumerate(values):
        sample = values[max(0, index - window + 1) : index + 1]
        center = mean(sample)
        scale = stddev(sample) or 1.0
        out.append(clamp((value - center) / scale, -6, 6))
    return out


def _safe_divide(left: list[float], right: list[float]) -> list[float]:
    return [
        number(a) / max(1e-9, abs(number(b)))
        for a, b in zip(left, right)
    ]


def _diff(values: list[float], lag: int = 1) -> list[float]:
    return [0.0 if index < lag else values[index] - values[index - lag] for index in range(len(values))]


def _clip(values: list[float], limit: float = 8.0) -> list[float]:
    return [clamp(number(value), -limit, limit) for value in values]


def _rank_pct(values: list[float], window: int = 60) -> list[float]:
    out: list[float] = []
    for index, value in enumerate(values):
        sample = values[max(0, index - window + 1) : index + 1]
        if len(sample) <= 1:
            out.append(0.5)
            continue
        out.append(sum(1 for item in sample if item <= value) / len(sample))
    return out


def _base_frame(rows: list[dict[str, Any]]) -> dict[str, list[float]]:
    closes = [row["close"] for row in rows]
    opens = [row["open"] for row in rows]
    highs = [row["high"] for row in rows]
    lows = [row["low"] for row in rows]
    volumes = [row["volume"] for row in rows]
    returns = [0.0] + [pct_change(closes[index - 1], closes[index]) for index in range(1, len(rows))]
    sma5 = _sma(closes, 5)
    sma20 = _sma(closes, 20)
    sma60 = _sma(closes, 60)
    volume20 = _sma(volumes, 20)
    volatility10 = _std_series(returns, 10)
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    macd = [fast - slow for fast, slow in zip(ema12, ema26)]
    signal = _ema(macd, 9)
    macd_hist = [value - sig for value, sig in zip(macd, signal)]
    true_range = [
        max(
            highs[index] - lows[index],
            abs(highs[index] - closes[index - 1]) if index else highs[index] - lows[index],
            abs(lows[index] - closes[index - 1]) if index else highs[index] - lows[index],
        )
        for index in range(len(rows))
    ]
    atr14 = _sma(true_range, 14)
    cumulative_notional = 0.0
    cumulative_volume = 0.0
    vwap: list[float] = []
    for row in rows:
        typical = (row["high"] + row["low"] + row["close"]) / 3
        cumulative_notional += typical * row["volume"]
        cumulative_volume += row["volume"]
        vwap.append(cumulative_notional / cumulative_volume if cumulative_volume else typical)
    high20 = [max(highs[max(0, index - 19) : index + 1]) for index in range(len(rows))]
    low20 = [min(lows[max(0, index - 19) : index + 1]) for index in range(len(rows))]
    candle_range = [max(high - low, close * 0.0001) for high, low, close in zip(highs, lows, closes)]
    close_location = [
        ((close - low) / spread - 0.5) * 2
        for close, low, spread in zip(closes, lows, candle_range)
    ]
    body_pressure = [
        (close - open_price) / spread
        for close, open_price, spread in zip(closes, opens, candle_range)
    ]
    return {
        "close": closes,
        "returns": returns,
        "momentum_5": [pct_change(closes[max(0, index - 5)], close) for index, close in enumerate(closes)],
        "momentum_20": [pct_change(closes[max(0, index - 20)], close) for index, close in enumerate(closes)],
        "trend_gap_20": [pct_change(avg, close) for avg, close in zip(sma20, closes)],
        "trend_gap_60": [pct_change(avg, close) for avg, close in zip(sma60, closes)],
        "vwap_gap": [pct_change(avg, close) for avg, close in zip(vwap, closes)],
        "volume_ratio_20": [volume / avg if avg else 0.0 for volume, avg in zip(volumes, volume20)],
        "volatility_10": volatility10,
        "range_position_20": [
            (close - low) / max(1e-9, high - low)
            for close, high, low in zip(closes, high20, low20)
        ],
        "macd_hist_pct": [value / max(close, 1e-9) * 100 for value, close in zip(macd_hist, closes)],
        "atr_pct_14": [value / max(close, 1e-9) * 100 for value, close in zip(atr14, closes)],
        "candle_body_pressure": body_pressure,
        "close_location": close_location,
        "overnight_gap": [0.0] + [pct_change(closes[index - 1], opens[index]) for index in range(1, len(rows))],
        "intraday_return": [pct_change(open_price, close) for open_price, close in zip(opens, closes)],
        "volume_price_impulse": [
            ret * (volume / avg if avg else 0.0)
            for ret, volume, avg in zip(returns, volumes, volume20)
        ],
    }


def _aligned_values(values: list[float], start_index: int, end_index: int) -> list[float]:
    return [number(values[index]) for index in range(start_index, end_index)]


def _candidate(name: str, expression: str, hypothesis: str, values: list[float], complexity: int, lineage: list[str]) -> dict[str, Any]:
    return {
        "name": name,
        "expression": expression,
        "hypothesis": hypothesis,
        "values": values,
        "complexity": complexity,
        "lineage": lineage,
    }


def _quality_gate(values: list[float], expression: str, complexity: int) -> dict[str, Any]:
    finite = [number(value) for value in values if math.isfinite(number(value))]
    missing_pct = max(0.0, (len(values) - len(finite)) / max(1, len(values)) * 100)
    unique_ratio = len({round(value, 8) for value in finite}) / max(1, len(finite))
    sigma = stddev(finite)
    outlier_pct = (
        sum(1 for value in finite if abs(value - mean(finite)) / max(sigma, 1e-9) > 8)
        / max(1, len(finite))
        * 100
    )
    expression_lower = expression.lower()
    checks = {
        "dimensionless": {"pass": any(token in expression_lower for token in ["rank", "zscore", "pct", "ratio", "gap", "pressure", "return", "vol"])},
        "richness": {"pass": unique_ratio >= 0.08 and sigma > 1e-9},
        "no_future_leakage": {"pass": not any(token in expression_lower for token in ["future", "label", "target", "shift(-", "lead("])},
        "missing_values": {"pass": missing_pct <= 2.0},
        "outliers": {"pass": outlier_pct <= 3.0},
        "standardization": {"pass": "zscore" in expression_lower or "rank" in expression_lower or complexity <= 5},
    }
    passed = sum(1 for row in checks.values() if row["pass"])
    return {"checks": checks, "passed": passed, "total": len(checks), "pass": passed == len(checks)}


def _rolling_ic(values: list[float], labels: list[float]) -> list[float]:
    if len(values) < 24:
        return []
    window = min(60, max(18, len(values) // 4))
    step = max(6, window // 3)
    return [
        _pearson(values[start : start + window], labels[start : start + window])
        for start in range(0, len(values) - window + 1, step)
    ]


def _evaluate_candidate(candidate: dict[str, Any], labels: list[float], accepted: list[dict[str, Any]]) -> dict[str, Any]:
    values = _clip(candidate["values"])
    count = len(values)
    train_end = max(6, int(count * 0.6))
    valid_end = max(train_end + 3, int(count * 0.8))
    full_ic = _pearson(values, labels)
    rank_ic = _spearman(values, labels)
    train_ic = _pearson(values[:train_end], labels[:train_end])
    valid_ic = _pearson(values[train_end:valid_end], labels[train_end:valid_end])
    test_ic = _pearson(values[valid_end:], labels[valid_end:])
    rolling = _rolling_ic(values, labels)
    stability = abs(mean(rolling)) / (stddev(rolling) + 0.05) if rolling else 0.0
    positive_window_share = sum(1 for value in rolling if value * full_ic >= 0) / len(rolling) if rolling else 0.0
    holdout_strength = (abs(valid_ic) + abs(test_ic)) / 2
    train_holdout_gap = max(0.0, abs(train_ic) - holdout_strength)
    sign_flip_penalty = 0.0
    if train_ic and valid_ic and train_ic * valid_ic < 0:
        sign_flip_penalty += 8.0
    if train_ic and test_ic and train_ic * test_ic < 0:
        sign_flip_penalty += 10.0
    if valid_ic and test_ic and valid_ic * test_ic < 0:
        sign_flip_penalty += 6.0
    overfit_penalty = min(24.0, train_holdout_gap * 55 + sign_flip_penalty + max(0.0, 0.55 - positive_window_share) * 10)
    max_overlap = 0.0
    for row in accepted[:12]:
        overlap = abs(_pearson(values, row.get("_values", [])))
        max_overlap = max(max_overlap, overlap)
    generalization_score = max(0.0, min(100.0, 100.0 - overfit_penalty - max_overlap * 10 - candidate["complexity"] * 0.9))
    quality = _quality_gate(values, candidate["expression"], candidate["complexity"])
    direction = 1 if full_ic >= 0 else -1
    fitness = (
        abs(valid_ic) * 42
        + abs(test_ic) * 34
        + abs(rank_ic) * 20
        + min(12, stability * 4.5)
        + positive_window_share * 8
        + quality["passed"] * 1.4
        - max_overlap * 12
        - candidate["complexity"] * 0.85
        - overfit_penalty
    )
    return {
        **candidate,
        "_values": values,
        "direction": direction,
        "ic": round(full_ic, 4),
        "rank_ic": round(rank_ic, 4),
        "train_ic": round(train_ic, 4),
        "validation_ic": round(valid_ic, 4),
        "test_ic": round(test_ic, 4),
        "fitness": round(fitness, 3),
        "generalization_score": round(generalization_score, 1),
        "overfit_penalty": round(overfit_penalty, 3),
        "overfit_flag": overfit_penalty >= 10 or generalization_score < 70,
        "stability": round(stability, 3),
        "positive_window_share_pct": round(positive_window_share * 100, 1),
        "max_overlap": round(max_overlap, 4),
        "quality_gate": quality,
    }


def _mutate(candidate: dict[str, Any], frame: dict[str, list[float]], rng: random.Random, suffix: int) -> dict[str, Any]:
    operation = rng.choice(["zscore", "rank", "delta", "smooth", "vol_adjust", "negate"])
    values = candidate["_values"]
    expression = candidate["expression"]
    hypothesis = candidate["hypothesis"]
    complexity = int(candidate["complexity"]) + 1
    if operation == "zscore":
        out = _zscore(values, rng.choice([20, 40, 60]))
        expression = f"zscore({expression})"
        hypothesis = f"Normalize the signal so cross-regime magnitude shifts do not dominate: {hypothesis}"
    elif operation == "rank":
        out = [value * 2 - 1 for value in _rank_pct(values, rng.choice([30, 60, 90]))]
        expression = f"ts_rank({expression})"
        hypothesis = f"Use only relative position inside the recent window to reduce scale drift: {hypothesis}"
    elif operation == "delta":
        out = _diff(values, rng.choice([1, 3, 5]))
        expression = f"delta({expression})"
        hypothesis = f"Focus on acceleration/change in the original signal: {hypothesis}"
    elif operation == "smooth":
        out = _sma(values, rng.choice([3, 5, 8]))
        expression = f"mean({expression})"
        hypothesis = f"Smooth noisy daily observations before scoring: {hypothesis}"
    elif operation == "vol_adjust":
        vol = _aligned_values(frame["atr_pct_14"], 30, 30 + len(values))
        out = _safe_divide(values, [max(0.25, item) for item in vol])
        expression = f"{expression} / atr_pct_14"
        hypothesis = f"Condition the signal by realized volatility so high-volatility regimes are not over-weighted: {hypothesis}"
    else:
        out = [-value for value in values]
        expression = f"-({expression})"
        hypothesis = f"Test the contrarian interpretation of the same market observation: {hypothesis}"
    return _candidate(
        f"evo_{suffix}_{operation}_{candidate['name'][:24]}",
        expression,
        hypothesis,
        out,
        complexity,
        [*candidate.get("lineage", []), f"mutation:{operation}"],
    )


def _crossover(left: dict[str, Any], right: dict[str, Any], rng: random.Random, suffix: int) -> dict[str, Any]:
    operation = rng.choice(["blend", "spread", "gated"])
    left_values = left["_values"]
    right_values = right["_values"]
    if operation == "blend":
        out = [(a + b) / 2 for a, b in zip(_zscore(left_values), _zscore(right_values))]
        expression = f"0.5*zscore({left['expression']}) + 0.5*zscore({right['expression']})"
        hypothesis = "Blend complementary validated signals to reduce single-factor brittleness."
    elif operation == "spread":
        out = [a - b for a, b in zip(_zscore(left_values), _zscore(right_values))]
        expression = f"zscore({left['expression']}) - zscore({right['expression']})"
        hypothesis = "Exploit disagreement between two validated factors as a regime-sensitive spread."
    else:
        out = [a if b >= 0 else -a for a, b in zip(_zscore(left_values), _zscore(right_values))]
        expression = f"zscore({left['expression']}) * sign(zscore({right['expression']}))"
        hypothesis = "Use one factor as the signal and the other as a direction gate."
    return _candidate(
        f"cross_{suffix}_{operation}_{left['name'][:10]}_{right['name'][:10]}",
        expression,
        hypothesis,
        out,
        int(left["complexity"]) + int(right["complexity"]) + 1,
        [*left.get("lineage", []), *right.get("lineage", []), f"crossover:{operation}"],
    )


def _gbm_forecast(rows: list[dict[str, Any]], horizon: int) -> dict[str, Any]:
    closes = [row["close"] for row in rows]
    log_returns = [math.log(closes[index] / closes[index - 1]) for index in range(1, len(closes)) if closes[index - 1] > 0]
    mu = mean(log_returns[-120:])
    sigma = stddev(log_returns[-120:])
    last = closes[-1]
    expected = last * math.exp(mu * horizon)
    z = 1.281551565545
    low = last * math.exp((mu - 0.5 * sigma * sigma) * horizon - z * sigma * math.sqrt(horizon))
    high = last * math.exp((mu - 0.5 * sigma * sigma) * horizon + z * sigma * math.sqrt(horizon))
    return {
        "model": "geometric_brownian_motion",
        "horizon_days": horizon,
        "annualized_drift_pct": round(mu * 252 * 100, 3),
        "annualized_volatility_pct": round(sigma * math.sqrt(252) * 100, 3),
        "expected_return_pct": round(pct_change(last, expected), 3),
        "p10_return_pct": round(pct_change(last, low), 3),
        "p90_return_pct": round(pct_change(last, high), 3),
        "note": "GBM is a baseline stochastic path model; it is not treated as a directional edge without factor confirmation.",
    }


def _regime_proxy(rows: list[dict[str, Any]]) -> dict[str, Any]:
    closes = [row["close"] for row in rows]
    returns = [0.0] + [pct_change(closes[index - 1], closes[index]) for index in range(1, len(closes))]
    rolling_return = _sma(returns, 10)
    rolling_vol = _std_series(returns, 20)
    vol_median = sorted(rolling_vol)[len(rolling_vol) // 2] if rolling_vol else 0.0
    states: list[str] = []
    for ret, vol in zip(rolling_return, rolling_vol):
        if vol > vol_median * 1.35 and ret < 0:
            states.append("risk_off_high_vol")
        elif ret > 0.12:
            states.append("risk_on_trend")
        elif ret < -0.12:
            states.append("bearish_drift")
        else:
            states.append("range_mean_reversion")
    labels = ["risk_on_trend", "range_mean_reversion", "bearish_drift", "risk_off_high_vol"]
    transitions = {left: {right: 0 for right in labels} for left in labels}
    for left, right in zip(states[:-1], states[1:]):
        transitions[left][right] += 1
    probabilities = {}
    for left, row in transitions.items():
        total = sum(row.values()) or 1
        probabilities[left] = {right: round(count / total, 3) for right, count in row.items()}
    current = states[-1] if states else "unknown"
    return {
        "model": "hmm_style_regime_proxy",
        "current_regime": current,
        "persistence_probability": probabilities.get(current, {}).get(current, 0),
        "transition_matrix": probabilities,
        "recent_state_path": states[-20:],
        "note": "This is a lightweight Gaussian/regime proxy inspired by HMM use; full HMM fitting can replace it when hmmlearn or Qlib adapters are installed.",
    }


def _volatility_models(rows: list[dict[str, Any]]) -> dict[str, Any]:
    closes = [row["close"] for row in rows]
    returns = [pct_change(closes[index - 1], closes[index]) / 100 for index in range(1, len(closes)) if closes[index - 1] > 0]
    ewma_var = 0.0
    decay = 0.94
    for ret in returns[-180:]:
        ewma_var = decay * ewma_var + (1 - decay) * ret * ret
    parkinson = [
        (math.log(row["high"] / row["low"]) ** 2) / (4 * math.log(2))
        for row in rows[-120:]
        if row["low"] > 0 and row["high"] > row["low"]
    ]
    vol = math.sqrt(ewma_var) * math.sqrt(252) * 100
    parkinson_vol = math.sqrt(mean(parkinson)) * math.sqrt(252) * 100 if parkinson else 0.0
    recent = [abs(item) for item in returns[-20:]]
    older = [abs(item) for item in returns[-80:-20]]
    return {
        "model": "ewma_plus_parkinson_volatility",
        "ewma_annual_vol_pct": round(vol, 3),
        "parkinson_annual_vol_pct": round(parkinson_vol, 3),
        "volatility_shock_ratio": round(mean(recent) / max(1e-9, mean(older)), 3) if older else 0.0,
        "risk_state": "vol_expansion" if older and mean(recent) > mean(older) * 1.35 else "normal",
    }


def _markowitz_single_asset(rows: list[dict[str, Any]], horizon: int) -> dict[str, Any]:
    closes = [row["close"] for row in rows]
    returns = [pct_change(closes[index - 1], closes[index]) / 100 for index in range(1, len(closes)) if closes[index - 1] > 0]
    expected = mean(returns[-80:]) * horizon
    variance = (stddev(returns[-80:]) ** 2) * horizon
    raw_weight = expected / max(variance, 1e-8)
    capped = clamp(raw_weight / 6, -0.25, 0.35)
    return {
        "model": "markowitz_single_asset_risk_budget",
        "expected_horizon_return_pct": round(expected * 100, 3),
        "horizon_variance": round(variance, 8),
        "suggested_active_weight_pct": round(capped * 100, 2),
        "note": "This is a single-asset risk-budget proxy; portfolio Markowitz needs a multi-symbol covariance matrix from the watchlist.",
    }


def _tradingview_style(rows: list[dict[str, Any]]) -> dict[str, Any]:
    frame = _base_frame(rows)
    closes = frame["close"]
    gains = [max(0.0, frame["returns"][index]) for index in range(len(rows))]
    losses = [max(0.0, -frame["returns"][index]) for index in range(len(rows))]
    avg_gain = _sma(gains, 14)
    avg_loss = _sma(losses, 14)
    rsi = [100 if loss == 0 else 100 - 100 / (1 + gain / loss) for gain, loss in zip(avg_gain, avg_loss)]
    return {
        "source": "tradingview_ta_style_local",
        "latest": {
            "rsi14": round(rsi[-1], 3),
            "macd_hist_pct": round(frame["macd_hist_pct"][-1], 4),
            "atr_pct_14": round(frame["atr_pct_14"][-1], 4),
            "vwap_gap_pct": round(frame["vwap_gap"][-1], 4),
            "close": round(closes[-1], 6),
        },
        "implemented_namespace": ["ta.sma", "ta.ema", "ta.macd", "ta.rsi", "ta.atr", "ta.vwap-style cumulative"],
    }


def analyze_alpha_evolution(
    candles: list[dict[str, Any]],
    horizon: int = 15,
    symbol: str = "",
    market: str = "ASX",
    generations: int = 4,
    population: int = 24,
) -> dict[str, Any]:
    rows = sanitize_candles(candles)
    horizon = max(1, min(60, int(horizon or 15)))
    if len(rows) < max(80, horizon + 45):
        raise ValueError("Alpha evolution requires at least 80 real candle rows.")
    start_index = 30
    end_index = len(rows) - horizon
    frame = _base_frame(rows)
    labels = [pct_change(rows[index]["close"], rows[index + horizon]["close"]) for index in range(start_index, end_index)]
    rng = random.Random(f"{market}:{symbol}:{horizon}:{len(rows)}")
    seed_specs = [
        ("mom_quality", "zscore(momentum_20) - zscore(volatility_10)", "Trend quality should work better when momentum is not just volatility expansion."),
        ("gap_reversal", "-zscore(overnight_gap)", "Large overnight gaps can mean-revert after auction-driven repricing."),
        ("liquidity_impulse", "zscore(volume_price_impulse)", "Volume-confirmed price impulse captures fresh attention/liquidity."),
        ("vwap_reclaim", "-zscore(vwap_gap) + zscore(close_location)", "Price reclaiming its volume-weighted cost area can indicate absorption."),
        ("macd_volume_gate", "zscore(macd_hist_pct) * zscore(volume_ratio_20)", "Momentum is more credible when volume is also abnormal."),
        ("range_breakout", "zscore(range_position_20) + zscore(atr_pct_14)", "High range position with expanding range can identify breakout pressure."),
        ("body_pressure", "zscore(candle_body_pressure) + zscore(close_location)", "Candle body and close location proxy intrabar order pressure."),
        ("trend_vwap_spread", "zscore(trend_gap_60) - zscore(vwap_gap)", "Longer trend strength relative to traded cost can identify structural drift."),
    ]
    expressions: dict[str, list[float]] = {
        "mom_quality": [a - b for a, b in zip(_zscore(frame["momentum_20"]), _zscore(frame["volatility_10"]))],
        "gap_reversal": [-value for value in _zscore(frame["overnight_gap"])],
        "liquidity_impulse": _zscore(frame["volume_price_impulse"]),
        "vwap_reclaim": [(-a + b) for a, b in zip(_zscore(frame["vwap_gap"]), _zscore(frame["close_location"]))],
        "macd_volume_gate": [a * b for a, b in zip(_zscore(frame["macd_hist_pct"]), _zscore(frame["volume_ratio_20"]))],
        "range_breakout": [a + b for a, b in zip(_zscore(frame["range_position_20"]), _zscore(frame["atr_pct_14"]))],
        "body_pressure": [a + b for a, b in zip(_zscore(frame["candle_body_pressure"]), _zscore(frame["close_location"]))],
        "trend_vwap_spread": [a - b for a, b in zip(_zscore(frame["trend_gap_60"]), _zscore(frame["vwap_gap"]))],
    }
    accepted: list[dict[str, Any]] = []
    pool: list[dict[str, Any]] = []
    for name, expression, hypothesis in seed_specs:
        values = _aligned_values(expressions[name], start_index, end_index)
        pool.append(_evaluate_candidate(_candidate(name, expression, hypothesis, values, 3, ["seed"]), labels, accepted))
    pool.sort(key=lambda row: row["fitness"], reverse=True)
    accepted = pool[: max(4, population // 3)]
    trajectory = [{
        "generation": 0,
        "best": pool[0]["name"],
        "best_fitness": pool[0]["fitness"],
        "pool_count": len(pool),
        "operation": "diversified_seed_initialization",
    }]
    for generation in range(1, max(1, generations) + 1):
        children: list[dict[str, Any]] = []
        parents = pool[: max(4, min(len(pool), population // 2))]
        for index, parent in enumerate(parents[: max(4, population // 3)]):
            children.append(_mutate(parent, frame, rng, generation * 100 + index))
        pairs = parents[:]
        rng.shuffle(pairs)
        for index in range(0, len(pairs) - 1, 2):
            children.append(_crossover(pairs[index], pairs[index + 1], rng, generation * 100 + index))
        evaluated = [_evaluate_candidate(child, labels, pool[:12]) for child in children]
        combined = {row["expression"]: row for row in [*pool, *evaluated]}
        pool = sorted(combined.values(), key=lambda row: row["fitness"], reverse=True)[:population]
        trajectory.append({
            "generation": generation,
            "best": pool[0]["name"],
            "best_fitness": pool[0]["fitness"],
            "pool_count": len(pool),
            "operation": "mutation+crossover+redundancy_filter",
        })
    best = []
    for row in pool[:10]:
        clean = {key: value for key, value in row.items() if key not in {"values", "_values"}}
        clean["latest_value"] = round(row["_values"][-1], 4)
        clean["lineage"] = row.get("lineage", [])[-8:]
        best.append(clean)
    return {
        "market": market,
        "symbol": symbol,
        "horizon_days": horizon,
        "row_count": len(rows),
        "sample_count": len(labels),
        "framework": "quantaalpha_inspired_local_evolution",
        "principles": [
            "trajectory-level mutation and crossover",
            "hypothesis-expression-code semantic consistency",
            "complexity and redundancy penalties",
            "walk-forward validation without future leakage",
            "TradingView-style TA primitives and Qlib-ready factor table",
        ],
        "trajectory": trajectory,
        "best_candidates": best,
        "advanced_models": {
            "gbm": _gbm_forecast(rows, horizon),
            "regime": _regime_proxy(rows),
            "volatility": _volatility_models(rows),
            "markowitz": _markowitz_single_asset(rows, horizon),
            "stat_arbitrage": {
                "model": "cointegration_pair_screen",
                "status": "requires_multi_symbol_panel",
                "note": "Cointegration/stat-arb needs synchronized candles for at least two symbols; the watchlist-level pair screen is the next integration point.",
            },
            "tradingview_style": _tradingview_style(rows),
        },
        "qlib_bridge": {
            "status": "factor_frame_ready",
            "models": ["LightGBM", "LSTM", "Transformer"],
            "requirements": [
                "fit scalers only on train windows",
                "purged/embargoed labels",
                "cross-sectional panels for production ranking",
                "no generated factor enters model if six-gate audit fails",
            ],
        },
    }
