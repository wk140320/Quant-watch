#!/usr/bin/env python3
"""Run market or stock factor research from the local point-in-time data lake."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from quant_core.data_lake import read_panel
from quant_core.features import analyze_cross_sectional_factors, analyze_factors


ROOT = PROJECT_ROOT
LAKE = ROOT / ".cache" / "data-lake"
OUTPUT = ROOT / ".cache" / "models" / "factor-research"


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(value: object) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:20]


def available_symbols(market: str) -> list[str]:
    files = (LAKE / "ohlcv" / f"market={market}").glob("exchange=*/interval=1d/symbol=*/data.parquet")
    available = {path.parent.name.split("=", 1)[-1] for path in files}
    universe_path = ROOT / ".cache" / f"universe-{market.lower()}.json"
    if not universe_path.exists():
        return sorted(available)
    universe = json.loads(universe_path.read_text("utf-8"))
    rows = universe.get("rows") or []
    symbols = []
    for row in rows:
        if str(row.get("type") or "").lower() not in {"", "common stock", "stock", "equity"}:
            continue
        symbol = str(row.get("code") or row.get("symbol") or "").upper().replace(".AX", "")
        if market == "CN" and symbol.startswith(("SH", "SZ")):
            symbol = symbol[2:]
        if symbol in available:
            symbols.append(symbol)
    return sorted(set(symbols))


def load_panel(market: str, symbols: list[str], min_rows: int, limit: int) -> list[dict]:
    result = read_panel({
        "root": str(LAKE),
        "market": market,
        "symbols": symbols,
        "interval": "1d",
        "min_rows": min_rows,
        "limit": 6_500,
    })
    return list(result.get("items") or [])[:limit]


def market_payload(market: str, result: dict, selected: int, eligible: int, min_rows: int) -> dict:
    horizon_results = result.get("horizon_results") or []
    payload = {
        "scope": "market",
        "market": market,
        "savedAt": stamp(),
        "framework": result.get("framework", "market-cross-sectional-factor-research"),
        "admissionPolicyVersion": 2,
        "available": bool(result.get("available")),
        "horizons": result.get("horizons") or [],
        "symbolCount": result.get("symbol_count", 0),
        "minSymbolsPerDate": result.get("min_symbols_per_date", 0),
        "aggregateWeights": (result.get("aggregate_weights") or [])[:40],
        "eligibleForLiveWeight": any(
            row.get("admitted_count", 0) > 0 and (row.get("ml_backtest") or {}).get("active") is True
            for row in horizon_results
        ),
        "horizonResults": [{
            "available": bool(row.get("available")),
            "horizonDays": row.get("horizon_days"),
            "rowCount": row.get("row_count"),
            "dateCount": row.get("date_count"),
            "symbolCount": row.get("symbol_count"),
            "admittedCount": row.get("admitted_count"),
            "weights": (row.get("weights") or [])[:20],
            "mlBacktest": row.get("ml_backtest"),
            "topFactors": (row.get("factors") or [])[:16],
            "highOverlap": (row.get("high_overlap") or [])[:16],
            "reason": row.get("reason", ""),
        } for row in horizon_results],
        "leakageControl": result.get("leakage_control"),
        "admissionPolicy": result.get("admission_policy") or [],
        "status": "research",
        "trainingUniverse": {
            "eligible": eligible,
            "selected": selected,
            "minRows": min_rows,
            "source": "local-parquet-data-lake",
        },
    }
    payload["dataVersion"] = digest({
        "market": market,
        "horizons": payload["horizons"],
        "symbolCount": payload["symbolCount"],
        "horizonResults": payload["horizonResults"],
    })
    return payload


def stock_payload(market: str, symbol: str, result: dict) -> dict | None:
    research = result.get("factor_research") or {}
    if not research.get("available"):
        return None
    live = research.get("live_signal") or {}
    checks = (research.get("ml_backtest") or {}).get("admission_checks") or {}
    payload = {
        "scope": "stock",
        "market": market,
        "symbol": symbol,
        "savedAt": stamp(),
        "framework": research.get("framework", "dynamic-factor-admission-and-ml-weighting"),
        "admissionPolicyVersion": 2,
        "horizonDays": research.get("horizon_days") or result.get("horizon_days"),
        "sampleCount": result.get("sample_count") or research.get("sample_count"),
        "candidateCount": research.get("candidate_count", 0),
        "admittedCount": research.get("admitted_count", 0),
        "researchCandidateCount": research.get("research_candidate_count", 0),
        "eligibleForLiveWeight": research.get("admitted_count", 0) > 0
        and (research.get("ml_backtest") or {}).get("active") is True
        and bool(checks) and all(checks.values()),
        "liveSignal": live,
        "weights": (research.get("weights") or [])[:40],
        "mlBacktest": research.get("ml_backtest"),
        "leakageControl": research.get("leakage_control"),
        "admissionRules": research.get("admission_rules") or [],
        "status": "research",
    }
    payload["dataVersion"] = digest({
        "market": market,
        "symbol": symbol,
        "horizon": payload["horizonDays"],
        "samples": payload["sampleCount"],
        "split": (payload.get("mlBacktest") or {}).get("split"),
    })
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--market", choices=["ASX", "US", "CN"], default="ASX")
    parser.add_argument("--scope", choices=["market", "stock", "both"], default="both")
    parser.add_argument("--symbols", default="")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--min-rows", type=int, default=750)
    parser.add_argument("--horizons", default="5")
    args = parser.parse_args()
    market = args.market
    horizons = [max(1, min(60, int(value))) for value in args.horizons.split(",") if value.strip()]
    candidates = available_symbols(market)
    panel = load_panel(market, candidates, args.min_rows, max(args.limit, len(candidates)))
    selected = panel[:max(1, args.limit)]
    requested = [value.strip().upper().replace(".AX", "") for value in args.symbols.split(",") if value.strip()]
    stock_items = selected if not requested else [row for row in panel if row.get("symbol") in set(requested)]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    summary: dict[str, object] = {"market": market, "scope": args.scope, "eligibleSymbols": len(panel)}
    if args.scope in {"market", "both"}:
        result = analyze_cross_sectional_factors(selected, market=market, horizons=horizons, min_symbols=min(30, max(6, len(selected) // 4)))
        payload = market_payload(market, result, len(selected), len(panel), args.min_rows)
        path = OUTPUT / f"cross-sectional-{market.lower()}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
        summary["marketEvidence"] = {
            "path": str(path), "symbols": payload["symbolCount"], "eligible": payload["eligibleForLiveWeight"],
            "horizons": [{"horizon": row["horizonDays"], "rows": row["rowCount"], "dates": row["dateCount"], "admitted": row["admittedCount"], "active": (row.get("mlBacktest") or {}).get("active")} for row in payload["horizonResults"]],
        }
    if args.scope in {"stock", "both"}:
        saved = []
        for item in stock_items:
            symbol = str(item.get("symbol") or "")
            result = analyze_factors(item.get("candles") or [], horizon=horizons[0], market=market, symbol=symbol)
            payload = stock_payload(market, symbol, result)
            if payload is None:
                continue
            path = OUTPUT / f"{market.lower()}-{symbol.lower()}.json"
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
            saved.append({"symbol": symbol, "samples": payload["sampleCount"], "admitted": payload["admittedCount"], "eligible": payload["eligibleForLiveWeight"]})
        summary["stockEvidence"] = saved
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
