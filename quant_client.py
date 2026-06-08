#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


DEFAULT_BASE_URL = "http://127.0.0.1:8787"
MARKETS = ("ASX", "US", "CN")


class ClientError(RuntimeError):
    pass


@dataclass
class ApiClient:
    base_url: str = DEFAULT_BASE_URL
    timeout: float = 20.0

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    def request(self, method: str, path: str, query: dict[str, Any] | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        if query:
            clean_query = {key: value for key, value in query.items() if value is not None and value != ""}
            url = f"{url}?{urllib.parse.urlencode(clean_query)}"
        body = None
        headers = {"accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise ClientError(f"HTTP {exc.code}: {raw[:500]}") from exc
        except urllib.error.URLError as exc:
            raise ClientError(f"Cannot reach local quant service at {self.base_url}: {exc.reason}") from exc
        try:
            decoded = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise ClientError(f"Service returned non-JSON response: {raw[:500]}") from exc
        if isinstance(decoded, dict) and decoded.get("error"):
            raise ClientError(str(decoded["error"]))
        if not isinstance(decoded, dict):
            raise ClientError("Service returned an unexpected JSON payload.")
        return decoded


def safe_market(value: str) -> str:
    upper = (value or "ASX").upper()
    return upper if upper in MARKETS else "ASX"


def parse_position(text: str) -> dict[str, Any]:
    parts = [part.strip() for part in text.split(":")]
    if len(parts) < 4:
        raise argparse.ArgumentTypeError("Position format: SYMBOL:QTY:AVG_PRICE:CURRENT_PRICE[:SECTOR]")
    try:
        qty = float(parts[1])
        avg_price = float(parts[2])
        current_price = float(parts[3])
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Position qty, avg price, and current price must be numbers.") from exc
    if qty <= 0 or avg_price <= 0 or current_price <= 0:
        raise argparse.ArgumentTypeError("Position qty, avg price, and current price must be positive.")
    return {
        "symbol": parts[0].upper(),
        "qty": qty,
        "avgPrice": avg_price,
        "currentPrice": current_price,
        "sector": parts[4] if len(parts) > 4 else "",
    }


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def command_health(client: ApiClient, _args: argparse.Namespace) -> dict[str, Any]:
    return client.request("GET", "/api/health")


def command_features(client: ApiClient, args: argparse.Namespace) -> dict[str, Any]:
    return client.request("GET", "/api/features", {
        "market": safe_market(args.market),
        "symbol": args.symbol,
        "interval": args.interval,
        "range": args.range,
    })


def command_trades(client: ApiClient, args: argparse.Namespace) -> dict[str, Any]:
    return client.request("GET", "/api/trades", {
        "market": safe_market(args.market),
        "symbol": args.symbol,
        "windowMinutes": args.window_minutes,
    })


def command_factors(client: ApiClient, args: argparse.Namespace) -> dict[str, Any]:
    return client.request("GET", "/api/factor-lab", {
        "market": safe_market(args.market),
        "symbol": args.symbol,
        "horizonDays": args.horizon_days,
    })


def risk_payload(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "market": safe_market(args.market),
        "totalCapital": args.total_capital,
        "availableCash": args.available_cash,
        "positions": list(args.position or []),
        "policy": {
            "reserveCashPct": args.reserve_cash_pct,
            "maxPositionPct": args.max_position_pct,
            "maxSectorPct": args.max_sector_pct,
            "stopLossPct": args.stop_loss_pct,
        },
    }


def command_risk(client: ApiClient, args: argparse.Namespace) -> dict[str, Any]:
    return client.request("POST", "/api/risk-assessment", payload=risk_payload(args))


def command_control_plane(client: ApiClient, args: argparse.Namespace) -> dict[str, Any]:
    return client.request("GET", "/api/control-plane", {"market": safe_market(args.market)})


def command_market_data(client: ApiClient, args: argparse.Namespace) -> dict[str, Any]:
    return client.request("GET", "/api/market-data", {
        "market": safe_market(args.market),
        "symbol": args.symbol,
    })


def run_gui(client: ApiClient) -> int:
    try:
        import tkinter as tk
        from tkinter import ttk
    except Exception as exc:  # pragma: no cover - depends on local desktop build
        raise ClientError(f"Tkinter GUI is unavailable in this Python environment: {exc}") from exc

    root = tk.Tk()
    root.title("Global Quant Watch Python Client")
    root.geometry("980x720")

    notebook = ttk.Notebook(root)
    notebook.pack(fill="both", expand=True)

    def output_box(parent: ttk.Frame) -> tk.Text:
        text = tk.Text(parent, wrap="word", height=28)
        text.pack(fill="both", expand=True, padx=10, pady=10)
        return text

    def write(text: tk.Text, payload: dict[str, Any] | str) -> None:
        text.delete("1.0", tk.END)
        if isinstance(payload, str):
            text.insert(tk.END, payload)
        else:
            text.insert(tk.END, json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))

    def add_market_symbol_controls(parent: ttk.Frame, default_symbol: str = "BHP") -> tuple[tk.StringVar, tk.StringVar]:
        controls = ttk.Frame(parent)
        controls.pack(fill="x", padx=10, pady=(10, 0))
        market = tk.StringVar(value="ASX")
        symbol = tk.StringVar(value=default_symbol)
        ttk.Label(controls, text="Market").pack(side="left")
        ttk.Combobox(controls, textvariable=market, values=MARKETS, width=8, state="readonly").pack(side="left", padx=(4, 12))
        ttk.Label(controls, text="Symbol").pack(side="left")
        ttk.Entry(controls, textvariable=symbol, width=14).pack(side="left", padx=(4, 12))
        return market, symbol

    health_tab = ttk.Frame(notebook)
    notebook.add(health_tab, text="Dashboard")
    health_output = output_box(health_tab)
    ttk.Button(health_tab, text="Refresh Health", command=lambda: _gui_call(client, health_output, lambda: client.request("GET", "/api/health"), write)).pack(pady=(0, 10))

    feature_tab = ttk.Frame(notebook)
    notebook.add(feature_tab, text="Feature")
    feature_market, feature_symbol = add_market_symbol_controls(feature_tab)
    feature_controls = ttk.Frame(feature_tab)
    feature_controls.pack(fill="x", padx=10, pady=(6, 0))
    feature_interval = tk.StringVar(value="1d")
    feature_range = tk.StringVar(value="9mo")
    ttk.Label(feature_controls, text="Interval").pack(side="left")
    ttk.Combobox(feature_controls, textvariable=feature_interval, values=("1d", "60m", "15m", "5m"), width=8, state="readonly").pack(side="left", padx=(4, 12))
    ttk.Label(feature_controls, text="Range").pack(side="left")
    ttk.Combobox(feature_controls, textvariable=feature_range, values=("1mo", "3mo", "6mo", "9mo", "1y"), width=8, state="readonly").pack(side="left", padx=(4, 12))
    feature_output = output_box(feature_tab)
    ttk.Button(feature_tab, text="Run Feature Analysis", command=lambda: _gui_call(
        client,
        feature_output,
        lambda: client.request("GET", "/api/features", {"market": feature_market.get(), "symbol": feature_symbol.get(), "interval": feature_interval.get(), "range": feature_range.get()}),
        write,
    )).pack(pady=(0, 10))

    trade_tab = ttk.Frame(notebook)
    notebook.add(trade_tab, text="Trades")
    trade_market, trade_symbol = add_market_symbol_controls(trade_tab, default_symbol="AAPL")
    trade_controls = ttk.Frame(trade_tab)
    trade_controls.pack(fill="x", padx=10, pady=(6, 0))
    trade_window = tk.IntVar(value=30)
    ttk.Label(trade_controls, text="Window minutes").pack(side="left")
    ttk.Spinbox(trade_controls, from_=1, to=390, textvariable=trade_window, width=8).pack(side="left", padx=(4, 12))
    trade_output = output_box(trade_tab)
    ttk.Button(trade_tab, text="Read Real Trades", command=lambda: _gui_call(
        client,
        trade_output,
        lambda: client.request("GET", "/api/trades", {"market": trade_market.get(), "symbol": trade_symbol.get(), "windowMinutes": trade_window.get()}),
        write,
    )).pack(pady=(0, 10))

    factor_tab = ttk.Frame(notebook)
    notebook.add(factor_tab, text="Factor Lab")
    factor_market, factor_symbol = add_market_symbol_controls(factor_tab)
    factor_controls = ttk.Frame(factor_tab)
    factor_controls.pack(fill="x", padx=10, pady=(6, 0))
    factor_horizon = tk.IntVar(value=15)
    ttk.Label(factor_controls, text="Horizon days").pack(side="left")
    ttk.Spinbox(factor_controls, from_=1, to=60, textvariable=factor_horizon, width=8).pack(side="left", padx=(4, 12))
    factor_output = output_box(factor_tab)
    ttk.Button(factor_tab, text="Run Factor Lab", command=lambda: _gui_call(
        client,
        factor_output,
        lambda: client.request("GET", "/api/factor-lab", {"market": factor_market.get(), "symbol": factor_symbol.get(), "horizonDays": factor_horizon.get()}),
        write,
    )).pack(pady=(0, 10))

    risk_tab = ttk.Frame(notebook)
    notebook.add(risk_tab, text="Risk")
    risk_controls = ttk.Frame(risk_tab)
    risk_controls.pack(fill="x", padx=10, pady=10)
    risk_market = tk.StringVar(value="ASX")
    total_capital = tk.DoubleVar(value=10000)
    available_cash = tk.DoubleVar(value=5000)
    position_text = tk.StringVar(value="BHP:100:45:46:Materials")
    for label, variable, width in (
        ("Market", risk_market, 8),
        ("Total", total_capital, 10),
        ("Cash", available_cash, 10),
        ("Position", position_text, 34),
    ):
        ttk.Label(risk_controls, text=label).pack(side="left")
        if label == "Market":
            ttk.Combobox(risk_controls, textvariable=variable, values=MARKETS, width=width, state="readonly").pack(side="left", padx=(4, 12))
        else:
            ttk.Entry(risk_controls, textvariable=variable, width=width).pack(side="left", padx=(4, 12))
    risk_output = output_box(risk_tab)

    def gui_risk_payload() -> dict[str, Any]:
        return {
            "market": risk_market.get(),
            "totalCapital": total_capital.get(),
            "availableCash": available_cash.get(),
            "positions": [parse_position(position_text.get())],
            "policy": {"reserveCashPct": 15, "maxPositionPct": 30, "maxSectorPct": 50, "stopLossPct": 4},
        }

    ttk.Button(risk_tab, text="Assess Risk", command=lambda: _gui_call(client, risk_output, lambda: client.request("POST", "/api/risk-assessment", payload=gui_risk_payload()), write)).pack(pady=(0, 10))

    _gui_call(client, health_output, lambda: client.request("GET", "/api/health"), write)
    root.mainloop()
    return 0


def _gui_call(client: ApiClient, text: Any, callback: Any, write: Any) -> None:
    del client
    try:
        write(text, callback())
    except Exception as exc:
        write(text, f"Error: {exc}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Python local client for Global Quant Watch.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Local service URL, default: http://127.0.0.1:8787")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout seconds.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health", help="Show service and Python-core health.")

    features = subparsers.add_parser("features", help="Run bottom-level feature analysis.")
    features.add_argument("--market", default="ASX", choices=MARKETS)
    features.add_argument("--symbol", required=True)
    features.add_argument("--interval", default="1d", choices=("1d", "60m", "15m", "5m"))
    features.add_argument("--range", default="9mo", choices=("1mo", "3mo", "6mo", "9mo", "1y"))

    trades = subparsers.add_parser("trades", help="Read provider-reported real trades when authorised.")
    trades.add_argument("--market", default="US", choices=MARKETS)
    trades.add_argument("--symbol", required=True)
    trades.add_argument("--window-minutes", type=int, default=30)

    factors = subparsers.add_parser("factors", help="Run factor lab and walk-forward validation.")
    factors.add_argument("--market", default="ASX", choices=MARKETS)
    factors.add_argument("--symbol", required=True)
    factors.add_argument("--horizon-days", type=int, default=15)

    risk = subparsers.add_parser("risk", help="Run Python portfolio risk assessment.")
    risk.add_argument("--market", default="ASX", choices=MARKETS)
    risk.add_argument("--total-capital", type=float, required=True)
    risk.add_argument("--available-cash", type=float, required=True)
    risk.add_argument("--position", type=parse_position, action="append", help="SYMBOL:QTY:AVG_PRICE:CURRENT_PRICE[:SECTOR]")
    risk.add_argument("--reserve-cash-pct", type=float, default=15)
    risk.add_argument("--max-position-pct", type=float, default=30)
    risk.add_argument("--max-sector-pct", type=float, default=50)
    risk.add_argument("--stop-loss-pct", type=float, default=4)

    control = subparsers.add_parser("control-plane", help="Show persisted local audit/control-plane summary.")
    control.add_argument("--market", default="ASX", choices=MARKETS)

    market_data = subparsers.add_parser("market-data", help="Show local authorised tick/L1/L2 data summary.")
    market_data.add_argument("--market", default="US", choices=MARKETS)
    market_data.add_argument("--symbol", default="")

    subparsers.add_parser("gui", help="Open a Python Tk local client.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    client = ApiClient(args.base_url, args.timeout)
    try:
        if args.command == "gui":
            return run_gui(client)
        handlers = {
            "health": command_health,
            "features": command_features,
            "trades": command_trades,
            "factors": command_factors,
            "risk": command_risk,
            "control-plane": command_control_plane,
            "market-data": command_market_data,
        }
        print_json(handlers[args.command](client, args))
        return 0
    except ClientError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
