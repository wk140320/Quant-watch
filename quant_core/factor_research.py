"""Point-in-time factor cards and conservative factor-pool admission.

The module evaluates factors on a date-grouped panel.  It never uses labels to
construct a factor; labels are consumed only after the signal date for OOS
evaluation.  A factor without enough independent dates remains watchlisted.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import defaultdict
from typing import Any, Iterable


FACTOR_CARD_SCHEMA = "factor-card-v2-pit-panel"

FACTOR_DEFINITIONS: dict[str, dict[str, Any]] = {
    "1日反转": {"formula": "-(close[t] / close[t-1] - 1)", "hypothesis": "短期过度反应可能在下一窗口均值回归", "inputs": ["close"], "lookback": 1},
    "5日动量": {"formula": "close[t] / close[t-5] - 1", "hypothesis": "短期趋势延续与资金分批调整可能形成延续", "inputs": ["close"], "lookback": 5},
    "20日动量": {"formula": "close[t] / close[t-20] - 1", "hypothesis": "中短期相对强势可能携带趋势信息", "inputs": ["close"], "lookback": 20},
    "12减1月动量": {"formula": "close[t-21] / close[t-252] - 1", "hypothesis": "剔除最近一个月后的中期动量减少短期反转干扰", "inputs": ["close"], "lookback": 252},
    "行业动量": {"formula": "rank_pct(mean(return_20d) within sector, date)", "hypothesis": "行业相对强弱比绝对价格尺度更可迁移", "inputs": ["close", "sector"], "lookback": 20},
    "Amihud非流动性": {"formula": "mean(abs(return_1d) / dollar_volume_1d, 20d)", "hypothesis": "低流动性资产对冲击更敏感并带来执行惩罚", "inputs": ["close", "volume"], "lookback": 20},
    "成交额冲击": {"formula": "zscore(dollar_volume_1d, 20d)", "hypothesis": "异常成交额可能标记信息到达或流动性冲击", "inputs": ["close", "volume"], "lookback": 20},
    "下行波动": {"formula": "-std(min(return_1d, 0), 20d)", "hypothesis": "下行风险应降低风险调整后的持有吸引力", "inputs": ["close"], "lookback": 20},
    "特质波动": {"formula": "std(return_1d - beta * market_return_1d, 20d)", "hypothesis": "不可分散波动需要更高风险补偿或触发弃权", "inputs": ["close", "market_return"], "lookback": 20},
    "市场Beta状态": {"formula": "rolling_beta(close_return, market_return, 60d)", "hypothesis": "市场暴露状态影响个股信号的有效性", "inputs": ["close", "market_return"], "lookback": 60},
    "毛盈利能力": {"formula": "gross_profit / assets", "hypothesis": "经营质量可能提供跨行业的慢变量信息", "inputs": ["gross_profit", "assets"], "lookback": 0},
    "投资与资产增长": {"formula": "-(assets[t] / assets[t-4q] - 1)", "hypothesis": "过快扩张可能对应较低的未来风险调整收益", "inputs": ["assets"], "lookback": 4},
    "现金流质量": {"formula": "operating_cash_flow / max(abs(net_income), epsilon)", "hypothesis": "现金实现质量用于区分会计利润与现金流", "inputs": ["operating_cash_flow", "net_income"], "lookback": 0},
    "价值": {"formula": "-rank_pct(price / fundamental_value, date)", "hypothesis": "相对估值需在同日横截面和可见财务版本下比较", "inputs": ["price", "fundamental_value"], "lookback": 0},
    "盈余超预期漂移": {"formula": "rank_pct(actual_eps - consensus_eps, date)", "hypothesis": "可见的业绩意外可能在后续窗口渐进反映", "inputs": ["actual_eps", "consensus_eps"], "lookback": 0},
    "金融文本语调": {"formula": "pit_text_sentiment(event_text, available_at <= signal_time)", "hypothesis": "文本语调只能在首次公开时间后作为事件特征", "inputs": ["event_text", "available_at"], "lookback": 0},
    "事件新颖度": {"formula": "1 - duplicate_event_count_rolling_60d / max(event_count_rolling_60d, 1)", "hypothesis": "首次出现且非重复的事件可能比转载更有信息量", "inputs": ["event_id", "event_time", "available_at"], "lookback": 60},
    "情绪乘套利约束": {"formula": "text_sentiment * (1 - arbitrage_constraint_score)", "hypothesis": "情绪信号需要经可交易性和套利约束过滤", "inputs": ["event_text", "arbitrage_constraint_score", "available_at"], "lookback": 0},
    "动量崩溃状态": {"formula": "-abs(momentum_20d) * downside_volatility_20d", "hypothesis": "趋势拥挤与下行波动同时升高时降低动量暴露", "inputs": ["close", "volume"], "lookback": 20},
}


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _hash(value: Any, length: int = 24) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:length]


def _pearson(left: list[float], right: list[float]) -> float:
    pairs = [(a, b) for a, b in zip(left, right) if math.isfinite(a) and math.isfinite(b)]
    if len(pairs) < 3:
        return 0.0
    ax = sum(a for a, _ in pairs) / len(pairs)
    bx = sum(b for _, b in pairs) / len(pairs)
    numerator = sum((a - ax) * (b - bx) for a, b in pairs)
    denominator = math.sqrt(sum((a - ax) ** 2 for a, _ in pairs) * sum((b - bx) ** 2 for _, b in pairs))
    return numerator / denominator if denominator else 0.0


def _rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0] * len(values)
    for position, index in enumerate(order):
        ranks[index] = position + 1
    return ranks


def _spearman(left: list[float], right: list[float]) -> float:
    pairs = [(a, b) for a, b in zip(left, right) if math.isfinite(a) and math.isfinite(b)]
    return _pearson(_rank([a for a, _ in pairs]), _rank([b for _, b in pairs])) if len(pairs) >= 3 else 0.0


def _normal_two_sided_p(value: float) -> float:
    """A dependency-free normal approximation for research diagnostics."""
    return max(0.0, min(1.0, math.erfc(abs(value) / math.sqrt(2.0))))


def _fdr_qvalues(pvalues: list[float]) -> list[float]:
    ordered = sorted(enumerate(pvalues), key=lambda item: item[1])
    output = [1.0] * len(pvalues)
    running = 1.0
    for rank, (index, value) in reversed(list(enumerate(ordered, start=1))):
        running = min(running, value * len(pvalues) / max(1, rank))
        output[index] = running
    return output


def factor_card(name: str, *, source_version: str = "unbound", feature_schema: str = "factor-panel-v2") -> dict[str, Any]:
    definition = FACTOR_DEFINITIONS.get(name)
    if not definition:
        raise ValueError(f"unknown_factor:{name}")
    canonical = re.sub(r"\s+", "", definition["formula"].lower())
    return {
        "schema": FACTOR_CARD_SCHEMA,
        "name": name,
        "formula": definition["formula"],
        "formulaHash": _hash(canonical, 32),
        "economicHypothesis": definition["hypothesis"],
        "inputs": list(definition["inputs"]),
        "lookback": int(definition["lookback"]),
        "pointInTimeRule": "all inputs must have available_at <= signal_time; future labels are evaluation-only",
        "normalization": "cross-sectional rank or train-window standardization; no raw price scale",
        "direction": "learned on inner OOF only",
        "coverage": {"observedRows": 0, "eligibleRows": 0, "eligibleDates": 0},
        "failureConditions": ["PIT timestamp missing", "insufficient date breadth", "unstable sign", "redundant conditional signal", "PSI above 0.40"],
        "sourceVersion": source_version,
        "featureSchema": feature_schema,
    }


def _psi(reference: list[float], current: list[float], bins: int = 10) -> float | None:
    if len(reference) < 20 or len(current) < 20:
        return None
    ordered = sorted(reference)
    edges = [ordered[min(len(ordered) - 1, int(len(ordered) * i / bins))] for i in range(bins + 1)]
    def counts(values: list[float]) -> list[float]:
        output = [0] * bins
        for value in values:
            index = next((i for i in range(bins) if value <= edges[i + 1]), bins - 1)
            output[index] += 1
        return [(count + 0.5) / (len(values) + bins * 0.5) for count in output]
    left, right = counts(reference), counts(current)
    return sum((a - b) * math.log(a / b) for a, b in zip(left, right))


def evaluate_factor(rows: Iterable[dict[str, Any]], name: str, *, value_key: str | None = None, label_key: str = "label", min_breadth: int = 10) -> dict[str, Any]:
    """Evaluate one factor only after its signal-date panel has been formed."""
    field = value_key or name
    grouped: dict[str, list[tuple[float, float]]] = defaultdict(list)
    raw_count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("pitEligible") is False or row.get("futureLeakage") is True:
            continue
        value = row.get(field)
        if value is None and isinstance(row.get("factors"), dict):
            value = row["factors"].get(field)
        x, y = _number(value), _number(row.get(label_key))
        if x is None or y is None:
            continue
        raw_count += 1
        grouped[str(row.get("date") or row.get("signalDate") or "")[:10]].append((x, y))
    daily: list[dict[str, Any]] = []
    for day, pairs in sorted(grouped.items()):
        if not day or len(pairs) < min_breadth:
            continue
        values, labels = zip(*pairs)
        daily.append({
            "date": day,
            "symbols": len(pairs),
            "ic": _pearson(list(values), list(labels)),
            "rankIc": _spearman(list(values), list(labels)),
            "topDecileDirection": sum(1 for value, label in sorted(pairs, key=lambda pair: pair[0], reverse=True)[:max(1, len(pairs) // 10)] if label > 0) / max(1, len(pairs) // 10),
            "topDecileMeanLabel": sum(label for value, label in sorted(pairs, key=lambda pair: pair[0], reverse=True)[:max(1, len(pairs) // 10)]) / max(1, len(pairs) // 10),
        })
    folds: list[dict[str, Any]] = []
    if daily:
        for fold in range(min(5, len(daily))):
            subset = daily[fold::5]
            folds.append({"fold": fold, "dates": len(subset), "meanRankIc": sum(item["rankIc"] for item in subset) / max(1, len(subset)), "positive": bool(subset) and sum(item["rankIc"] > 0 for item in subset) / len(subset) >= 0.5})
    rank_ics = [item["rankIc"] for item in daily]
    return {
        "schema": "factor-evidence-v2",
        "name": name,
        "rawEligibleRows": raw_count,
        "eligibleRows": sum(item["symbols"] for item in daily),
        "eligibleDates": len(daily),
        "daily": daily[-240:],
        "meanIc": sum(item["ic"] for item in daily) / max(1, len(daily)),
        "meanRankIc": sum(rank_ics) / max(1, len(rank_ics)),
        "positiveDateShare": sum(item > 0 for item in rank_ics) / max(1, len(rank_ics)),
        "folds": folds,
        "positiveFolds": sum(item["positive"] for item in folds),
        "status": "evidence_ready" if len(daily) >= 120 else "insufficient_dates",
    }


def factor_pool_audit(rows: list[dict[str, Any]], names: Iterable[str], *, min_dates: int = 120, max_correlation: float = 0.65) -> dict[str, Any]:
    names = list(dict.fromkeys(str(name) for name in names))
    evidence = {name: evaluate_factor(rows, name) for name in names}
    complete_rows = [
        row for row in rows
        if isinstance(row, dict)
        and row.get("pitEligible") is not False
        and row.get("futureLeakage") is not True
        and all(_number((row.get("factors") or {}).get(name)) is not None for name in names)
    ]
    series: dict[str, list[float]] = {name: [_number((row.get("factors") or {}).get(name)) for row in complete_rows] for name in names}
    redundancy: list[dict[str, Any]] = []
    for index, left in enumerate(names):
        for right in names[index + 1:]:
            correlation = _pearson(series[left], series[right])
            if abs(correlation) >= max_correlation:
                redundancy.append({"left": left, "right": right, "correlation": correlation, "decision": "keep_more_stable_then_quarantine_duplicate"})
    raw_pvalues = []
    for name in names:
        ic = _number(evidence[name].get("meanRankIc")) or 0.0
        dates = max(1, int(evidence[name].get("eligibleDates") or 0))
        dispersion = math.sqrt(sum((_number(day.get("rankIc")) or 0.0 - ic) ** 2 for day in evidence[name].get("daily") or []) / max(1, dates - 1))
        t_stat = ic / max(1e-9, dispersion / math.sqrt(dates)) if dispersion else 0.0
        raw_pvalues.append(_normal_two_sided_p(t_stat))
    fdr_qvalues = _fdr_qvalues(raw_pvalues)
    for name, item in evidence.items():
        overlaps = [row for row in redundancy if name in {row["left"], row["right"]}]
        item["maxRedundancy"] = max((abs(row["correlation"]) for row in overlaps), default=0.0)
        midpoint = max(20, len(series[name]) // 2)
        item["completePanelRows"] = len(complete_rows)
        item["psi"] = _psi(series[name][:midpoint], series[name][midpoint:]) if len(series[name]) >= 40 else None
        item["fdrPValue"] = raw_pvalues[names.index(name)] if name in names else None
        item["fdrQValue"] = fdr_qvalues[names.index(name)] if name in names else None
        item["vifProxy"] = 1.0 / max(1e-6, 1.0 - item["maxRedundancy"] ** 2)
        positive_days = [day for day in item.get("daily") or [] if (_number(day.get("rankIc")) or 0.0) > 0]
        item["deflatedSharpeProxy"] = (item.get("meanRankIc") or 0.0) * math.sqrt(max(1, item.get("eligibleDates") or 0)) - math.sqrt(max(1, len(names))) * 0.10
        item["pboProxy"] = 1.0 - (len(positive_days) / max(1, item.get("eligibleDates") or 0))
        item["admission"] = "admit" if (
            item["eligibleDates"] >= min_dates
            and item["positiveFolds"] >= 4
            and item["meanRankIc"] > 0
            and item["maxRedundancy"] < max_correlation
            and (item["psi"] is None or item["psi"] <= 0.40)
            and item["vifProxy"] <= 5.0
            and (_number(item.get("fdrQValue"), 1.0) <= 0.10)
            and (_number(item.get("deflatedSharpeProxy"), -1.0) > 0.0)
            and (_number(item.get("pboProxy"), 1.0) < 0.50)
        ) else "watchlist"
    return {
        "schema": "factor-pool-audit-v2",
        "factorCount": len(names),
        "evaluated": evidence,
        "redundancy": redundancy,
        "admitted": [name for name, item in evidence.items() if item["admission"] == "admit"],
        "rejectedOrWatchlist": [name for name, item in evidence.items() if item["admission"] != "admit"],
        "controls": ["formula_hash", "Pearson/Spearman", "VIF proxy", "cluster", "residualization required for production", "PSI", "FDR", "Deflated Sharpe", "PBO"],
        "completePanelRows": len(complete_rows),
        "missingValuePolicy": "rows missing any candidate factor are excluded from redundancy statistics; no neutral zero is imputed",
    }


__all__ = ["FACTOR_CARD_SCHEMA", "FACTOR_DEFINITIONS", "factor_card", "evaluate_factor", "factor_pool_audit"]
