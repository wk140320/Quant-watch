from __future__ import annotations

from typing import Any, Optional


LIMITED_MARKERS = ("eodhd", "twelvedata", "alphavantage", "tushare", "alpaca", "finnhub", "tiingo", "marketaux")
FREE_SUPPORT_MARKERS = ("stockanalysis", "yahoo", "nasdaq", "stooq", "satoshimacro", "eastmoney", "tencent", "asx-official", "gdelt", "baostock")
LICENSED_MARKERS = ("ibkr", "futu", "moomoo", "lseg", "market-source", "polygon", "massive")


def classify_provider(name: str) -> dict[str, Any]:
    value = str(name or "").lower()
    if any(marker in value for marker in LICENSED_MARKERS):
        tier = "licensed"
        quota_policy = "仅在用户已授权并具备行情权限时启用"
    elif any(marker in value for marker in LIMITED_MARKERS):
        tier = "limited"
        quota_policy = "按需调用，单任务调用数由市场预算控制"
    elif any(marker in value for marker in FREE_SUPPORT_MARKERS):
        tier = "free_support"
        quota_policy = "优先作为免费支撑源和故障回退"
    else:
        tier = "unknown"
        quota_policy = "未分类，启用前需要验证额度和授权"
    return {"name": name, "tier": tier, "quota_policy": quota_policy}


def provider_plan(market: str, candidates: list[str], configured: Optional[dict[str, bool]] = None) -> dict[str, Any]:
    rows = [classify_provider(name) for name in candidates]
    configured = configured or {}
    for row in rows:
        row["configured"] = bool(configured.get(row["name"], True))
    free = [row for row in rows if row["tier"] == "free_support" and row["configured"]]
    limited = [row for row in rows if row["tier"] == "limited" and row["configured"]]
    licensed = [row for row in rows if row["tier"] == "licensed" and row["configured"]]
    primary = limited[0] if limited else free[0] if free else licensed[0] if licensed else rows[0] if rows else None
    support = next((row for row in free if not primary or row["name"] != primary["name"]), None)
    if support is None:
        support = next((row for row in rows if not primary or row["name"] != primary["name"]), None)
    market_key = str(market or "").upper()
    limited_cap = 4 if market_key == "US" else 2 if market_key == "ASX" else 1
    return {
        "market": market,
        "policy": {
            "primary": primary,
            "support": support,
            "limited_source_cap_per_task": limited_cap,
            "cross_check": f"优先使用真实源；{market_key or 'GLOBAL'} 单任务最多尝试 {limited_cap} 个有限额源，免费源不计入额度。",
            "offline": "休市和外部源不可用时优先读取持久化真实快照。",
        },
        "providers": rows,
    }
