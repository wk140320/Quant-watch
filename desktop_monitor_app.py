#!/usr/bin/env python3
"""Local desktop controller for the Global Quant Watch backend monitor.

This intentionally uses only the Python standard library so it can run as a
small local app without Electron, browser UI, or extra package installs.
"""

from __future__ import annotations

import copy
import http.client
import json
import math
import os
import subprocess
import sys
import threading
import time
import traceback
import tkinter as tk
from datetime import datetime, timezone
from pathlib import Path
from tkinter import messagebox, ttk
from zoneinfo import ZoneInfo


PROJECT_ROOT = Path(__file__).resolve().parent
API_BASE = "http://127.0.0.1:8787"
BACKEND_MONITOR_DIR = PROJECT_ROOT / ".cache" / "backend-monitor"
CONFIG_PATH = BACKEND_MONITOR_DIR / "config.json"
RUNTIME_PATH = BACKEND_MONITOR_DIR / "runtime.json"
RUN_REQUEST_PATH = BACKEND_MONITOR_DIR / "manual-run-request.json"
APP_LOG_PATH = BACKEND_MONITOR_DIR / "desktop-app-runtime.log"
APP_VERSION = "desktop-model-ops-v2"
NODE_CANDIDATES = [
    Path("/Users/wukai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"),
    Path("/opt/homebrew/bin/node"),
    Path("/usr/local/bin/node"),
]
MARKET_TIMEZONES = {
    "ASX": "Australia/Sydney",
    "US": "America/New_York",
    "CN": "Asia/Shanghai",
}
MARKET_RANGES = {
    "ASX": [(600, 970)],
    "US": [(570, 960)],
    "CN": [(570, 690), (780, 900)],
}
DEFAULT_BUDGET_LIMITS = {
    "marketCalls": 520,
    "factorCalls": 120,
    "aiCalls": 30,
    "trainingCalls": 96,
    "notifications": 120,
    "trainingMarketReserve": 90,
}
COLORS = {
    "bg": "#090A09",
    "surface0": "#0D0F0D",
    "panel": "#111310",
    "panel2": "#181A16",
    "panel3": "#20221D",
    "border": "#292B26",
    "border2": "#3A3528",
    "text": "#F2F0E9",
    "muted": "#858881",
    "subtle": "#666A63",
    "accent": "#C6A35A",
    "accent2": "#728CA8",
    "gold": "#E1C77E",
    "danger": "#C76872",
    "good": "#5BAA91",
}


def compact_time(value: object) -> str:
    if not value:
        return "暂无"
    text = str(value)
    return text.replace("T", " ").replace("Z", "")[:19]


def json_request(path: str, payload: object | None = None, method: str | None = None, timeout: float = 8) -> dict:
    body = None
    headers = {"content-type": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        method = method or "POST"
        headers["content-length"] = str(len(body))
    connection = http.client.HTTPConnection("127.0.0.1", 8787, timeout=timeout)
    try:
        connection.request(method or "GET", path, body=body, headers={**headers, "connection": "close"})
        response = connection.getresponse()
        data = response.read().decode("utf-8")
        if response.status >= 400:
            raise RuntimeError(f"HTTP {response.status}: {data[:300]}")
    finally:
        connection.close()
    return json.loads(data or "{}")


def curl_json_request(path: str, payload: object | None = None, method: str | None = None, timeout: float = 8) -> dict:
    curl = "/usr/bin/curl"
    if not Path(curl).exists():
        raise RuntimeError("curl unavailable")
    command = [curl, "-sS", "--max-time", str(max(1, int(timeout))), "-H", "content-type: application/json"]
    if payload is not None:
        command.extend(["-X", method or "POST", "--data-binary", json.dumps(payload)])
    elif method:
        command.extend(["-X", method])
    command.append(f"{API_BASE}{path}")
    result = subprocess.run(command, cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=timeout + 2, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or f"curl exited {result.returncode}")[:500])
    return json.loads(result.stdout or "{}")


def backend_request(path: str, payload: object | None = None, method: str | None = None, timeout: float = 8) -> dict:
    try:
        data = json_request(path, payload=payload, method=method, timeout=timeout)
        data["_transport"] = "live"
        return data
    except Exception as first_error:  # noqa: BLE001
        log_message(f"direct HTTP failed for {path}; trying curl fallback: {type(first_error).__name__}: {first_error}")
        data = curl_json_request(path, payload=payload, method=method, timeout=timeout)
        data["_transport"] = "curl-live"
        return data


def read_json_file(path: Path, fallback: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return copy.deepcopy(fallback)


def write_json_file(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso_from_millis(value: object) -> str | None:
    if isinstance(value, (int, float)) and value > 1_000_000_000:
        return datetime.fromtimestamp(float(value) / 1000, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return value if isinstance(value, str) else None


def local_budget_date() -> str:
    return datetime.now(ZoneInfo("Australia/Sydney")).strftime("%Y-%m-%d")


def load_local_env() -> dict[str, str]:
    env = dict(os.environ)
    for path in [PROJECT_ROOT / ".env.local", PROJECT_ROOT / ".env"]:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, value = text.split("=", 1)
            env.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return env


def local_market_session(market: str) -> dict:
    zone = ZoneInfo(MARKET_TIMEZONES.get(market, "Australia/Sydney"))
    now = datetime.now(zone)
    minutes = now.hour * 60 + now.minute
    ranges = MARKET_RANGES.get(market, [])
    weekend = now.weekday() >= 5
    return {
        "market": market,
        "open": (not weekend) and any(start <= minutes <= end for start, end in ranges),
        "weekend": weekend,
        "localTime": now.strftime("%Y-%m-%d %H:%M"),
        "timeZone": MARKET_TIMEZONES.get(market, ""),
        "ranges": ranges,
    }


def local_due_jobs(config: dict, runtime: dict) -> int:
    now_ms = time.time() * 1000
    last_checks = runtime.get("lastSymbolChecks") if isinstance(runtime.get("lastSymbolChecks"), dict) else {}
    refresh = config.get("refresh") if isinstance(config.get("refresh"), dict) else {}
    holding_ms = float(refresh.get("holdingMs") or 300000)
    watch_ms = float(refresh.get("watchMs") or 900000)
    count = 0
    for market, market_config in (config.get("markets") or {}).items():
        for holding in market_config.get("portfolio") or []:
            symbol = holding.get("symbol")
            if symbol and now_ms - float(last_checks.get(f"{market}:{symbol}:holding") or 0) >= holding_ms:
                count += 1
        portfolio_symbols = {row.get("symbol") for row in market_config.get("portfolio") or []}
        for symbol in market_config.get("watchlist") or []:
            if symbol in portfolio_symbols:
                continue
            if now_ms - float(last_checks.get(f"{market}:{symbol}:watch") or 0) >= watch_ms:
                count += 1
    return count


def local_intraday_model_status(market: str) -> dict:
    path = BACKEND_MONITOR_DIR / f"intraday-model-{market.lower()}.json"
    model = read_json_file(path, None)
    if not isinstance(model, dict):
        return {"available": False, "sampleCount": 0, "updatedAt": None, "reason": "not trained yet"}
    return {
        "available": bool(model.get("available")),
        "sampleCount": model.get("sampleCount") or 0,
        "updatedAt": model.get("updatedAt"),
        "test": model.get("test") or {},
        "reason": model.get("reason") or "",
    }


MODEL_FAMILY_DEFINITIONS = {
    "calibration": {"name": "预测权重校准", "short": "权重校准", "stage": "OOF 与校准"},
    "factor": {"name": "因子研究模型", "short": "因子研究", "stage": "特征与因子"},
    "alpha": {"name": "Alpha 进化模型", "short": "Alpha 进化", "stage": "候选生成"},
    "intraday": {"name": "分钟学习模型", "short": "分钟学习", "stage": "分钟结构"},
    "adaptive": {"name": "误差驱动微调", "short": "动态微调", "stage": "预测反馈"},
    "agent": {"name": "Paper Agent 学习", "short": "Agent 学习", "stage": "纸面执行"},
}
MODEL_EVENT_FAMILIES = {
    "model-change-log-prediction-weight-calibration": "calibration",
    "model-change-log-cross-sectional-factor-research": "factor",
    "model-change-log-factor-research": "factor",
    "model-change-log-alpha-evolution": "alpha",
    "model-change-log-minute-learning": "intraday",
    "model-change-log-adaptive-micro-tuning": "adaptive",
}
_LOCAL_TRAJECTORY_CACHE: dict[str, tuple[tuple[float, int], dict]] = {}


def finite_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def mean_number(values: list[object]) -> float | None:
    numbers = [number for value in values if (number := finite_number(value)) is not None]
    return sum(numbers) / len(numbers) if numbers else None


def model_event_family(row: dict) -> str:
    event_type = str(row.get("event_type") or "")
    if event_type in MODEL_EVENT_FAMILIES:
        return MODEL_EVENT_FAMILIES[event_type]
    payload_type = str((row.get("payload") or {}).get("type") or "").lower()
    if "factor" in payload_type:
        return "factor"
    if "alpha" in payload_type:
        return "alpha"
    if "minute" in payload_type or "intraday" in payload_type:
        return "intraday"
    if "calibrat" in payload_type or "weight" in payload_type:
        return "calibration"
    if "tuning" in payload_type or "adjust" in payload_type:
        return "adaptive"
    return "agent"


def normalized_local_model_event(row: dict) -> dict:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    family = model_event_family(row)
    holdout = payload.get("holdout") if isinstance(payload.get("holdout"), dict) else {}
    test = payload.get("test") if isinstance(payload.get("test"), dict) else {}
    horizons = payload.get("horizonCalibrations") if isinstance(payload.get("horizonCalibrations"), list) else []
    latest_events = payload.get("latestEvents") if isinstance(payload.get("latestEvents"), list) else []
    latest = latest_events[0] if latest_events and isinstance(latest_events[0], dict) else {}
    after_strategies = ((payload.get("after") or {}).get("bestStrategies") or []) if isinstance(payload.get("after"), dict) else []
    direction = finite_number(test.get("directionalAccuracy") or test.get("directionHitRate") or holdout.get("direction_hit_rate_pct"))
    if direction is None and horizons:
        direction = mean_number([(item.get("test") or {}).get("directionHitRate") for item in horizons if isinstance(item, dict)])
    primary_label = "评估指标"
    primary_value: float | None = None
    primary_unit = ""
    if family == "calibration":
        primary_label, primary_value, primary_unit = "样本外方向命中", direction, "%"
    elif family == "factor":
        primary_label = "Holdout 方向命中" if direction is not None else "因子实时得分"
        primary_value = direction if direction is not None else finite_number(payload.get("liveScore"))
        primary_unit = "%" if direction is not None else ""
    elif family == "alpha":
        primary_label, primary_value = "候选适应度", finite_number(payload.get("topFitness"))
    elif family == "intraday":
        primary_label, primary_value, primary_unit = "测试方向命中", direction, "%"
    elif family == "adaptive":
        scale = finite_number(latest.get("adjustmentScale") or payload.get("avgAdjustmentScale"))
        primary_label, primary_value, primary_unit = "平均调整幅度", (scale * 100 if scale is not None else None), "%"
    else:
        primary_label = "策略综合分"
        primary_value = mean_number([item.get("score") for item in after_strategies if isinstance(item, dict)])

    changes = latest.get("changes") if isinstance(latest.get("changes"), list) else []
    reasons = latest.get("reasons") if isinstance(latest.get("reasons"), list) else []
    if not changes and payload.get("summary"):
        changes = [str(payload.get("summary"))]
    if not reasons and payload.get("framework"):
        reasons = [f"框架：{payload.get('framework')}"]
    guards = []
    overfit = payload.get("overfitGuard") if isinstance(payload.get("overfitGuard"), dict) else {}
    for check in overfit.get("checks") or []:
        if isinstance(check, dict):
            guards.append({"label": check.get("label") or "防过拟合检查", "pass": check.get("pass") is not False, "note": check.get("note") or ""})
    for guard in payload.get("guardrails") or []:
        guards.append({"label": str(guard), "pass": True, "note": ""})
    if payload.get("leakageControl"):
        guards.append({"label": "未来函数隔离", "pass": True, "note": str(payload.get("leakageControl"))})

    sample_count = finite_number(payload.get("sampleCount") or payload.get("sampleTotal") or holdout.get("samples") or (payload.get("details") or {}).get("sampleCount"))
    impact = "neutral"
    if direction is not None:
        impact = "improved" if direction >= 50 else "degraded"
    return {
        "id": row.get("entity_id") or payload.get("id") or f"{family}:{row.get('created_at')}",
        "family": family,
        "stage": MODEL_FAMILY_DEFINITIONS[family]["stage"],
        "createdAt": row.get("created_at") or payload.get("createdAt") or payload.get("updatedAt"),
        "title": payload.get("title") or MODEL_FAMILY_DEFINITIONS[family]["name"],
        "summary": payload.get("summary") or payload.get("reason") or "本次模型事件已写入本地审计日志。",
        "entity": payload.get("symbol") or row.get("entity_id") or "market",
        "framework": payload.get("framework") or payload.get("type") or "local-model",
        "impact": impact,
        "primaryLabel": primary_label,
        "primaryValue": primary_value,
        "primaryUnit": primary_unit,
        "sampleCount": int(sample_count or 0),
        "mae": finite_number(test.get("mae") or holdout.get("mae")),
        "rankIc": finite_number(holdout.get("rank_ic") or test.get("rankIc")),
        "changes": [str(item) for item in changes[:6]],
        "reasons": [str(item) for item in reasons[:6]],
        "guardrails": guards[:8],
        "formula": payload.get("scaleFormula") or payload.get("formula"),
    }


def local_model_trajectory_payload(market: str) -> dict:
    key = market.upper()
    path = PROJECT_ROOT / ".cache" / "records" / f"model-change-log-{key.lower()}.jsonl"
    try:
        stat = path.stat()
        signature = (stat.st_mtime, stat.st_size)
    except OSError:
        signature = (0.0, 0)
    cached = _LOCAL_TRAJECTORY_CACHE.get(key)
    if cached and cached[0] == signature:
        return copy.deepcopy(cached[1])

    rows = []
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    events = [normalized_local_model_event(row) for row in rows]
    events.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    deduped = []
    seen = set()
    for event in events:
        signature_key = (event.get("family"), event.get("id"), event.get("title"), event.get("entity"), event.get("primaryValue"))
        if signature_key in seen:
            continue
        seen.add(signature_key)
        deduped.append(event)
    intraday = local_intraday_model_status(key)
    families = []
    for family_id, definition in MODEL_FAMILY_DEFINITIONS.items():
        family_events = [event for event in deduped if event.get("family") == family_id]
        if not family_events and family_id != "intraday":
            continue
        latest = family_events[0] if family_events else None
        if family_id == "intraday":
            status = "已就绪" if intraday.get("available") else "采样中"
        elif family_id == "adaptive":
            status = "护栏微调"
        elif family_id == "agent":
            status = "Paper"
        else:
            status = "研究中"
        families.append({
            "id": family_id,
            **definition,
            "status": status,
            "eventCount": len(family_events),
            "sampleCount": (latest or {}).get("sampleCount") or (intraday.get("sampleCount") if family_id == "intraday" else 0),
            "primaryLabel": (latest or {}).get("primaryLabel") or "评估指标",
            "primaryValue": (latest or {}).get("primaryValue"),
            "primaryUnit": (latest or {}).get("primaryUnit") or "",
            "events": family_events[:80],
            "trajectory": list(reversed([
                {"at": event.get("createdAt"), "value": event.get("primaryValue"), "impact": event.get("impact"), "event": event}
                for event in family_events if event.get("primaryValue") is not None
            ][:48])),
        })
    now = datetime.now(timezone.utc).timestamp()
    changes_24h = 0
    for event in deduped:
        try:
            timestamp = datetime.fromisoformat(str(event.get("createdAt")).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            continue
        if now - timestamp <= 86400:
            changes_24h += 1
    payload = {
        "market": key,
        "families": families,
        "timeline": deduped[:180],
        "summary": {
            "modelCount": len(families),
            "eventCount": len(deduped),
            "changes24h": changes_24h,
            "lastChangeAt": deduped[0].get("createdAt") if deduped else intraday.get("updatedAt"),
            "guardrailCoveragePct": round(sum(1 for event in deduped if event.get("guardrails")) / len(deduped) * 100) if deduped else 0,
        },
    }
    _LOCAL_TRAJECTORY_CACHE[key] = (signature, payload)
    return copy.deepcopy(payload)


def local_status_payload() -> dict:
    config = read_json_file(CONFIG_PATH, {"enabled": False, "markets": {}, "refresh": {}, "training": {}})
    runtime = read_json_file(RUNTIME_PATH, {})
    if not isinstance(config, dict):
        config = {"enabled": False, "markets": {}, "refresh": {}, "training": {}}
    if not isinstance(runtime, dict):
        runtime = {}
    budget = read_json_file(BACKEND_MONITOR_DIR / f"budget-{local_budget_date()}.json", {"date": local_budget_date(), "used": {}})
    env = load_local_env()
    markets = sorted(set(["ASX", "US", "CN", *(config.get("markets") or {}).keys()]))
    return {
        "ok": True,
        "version": config.get("version") or APP_VERSION,
        "_transport": "local-cache",
        "state": {
            "enabled": bool(config.get("enabled", False)),
            "running": False,
            "startedAt": None,
            "lastTickAt": None,
            "lastRunAt": runtime.get("lastRunAt"),
            "lastTrainingAt": iso_from_millis(runtime.get("lastTrainingAt")),
            "lastError": runtime.get("lastError"),
            "lastAlerts": [],
            "lastAnalyses": runtime.get("lastResults") or [],
        },
        "config": config,
        "runtime": {
            "lastRunAt": runtime.get("lastRunAt"),
            "lastTrainingAt": iso_from_millis(runtime.get("lastTrainingAt")),
            "lastResults": runtime.get("lastResults") or [],
            "lastError": runtime.get("lastError"),
        },
        "sessions": {market: local_market_session(market) for market in markets},
        "dueJobs": local_due_jobs(config, runtime),
        "budget": budget if isinstance(budget, dict) else {"date": local_budget_date(), "used": {}},
        "budgetLimits": DEFAULT_BUDGET_LIMITS,
        "intradayModels": {market: local_intraday_model_status(market) for market in markets},
        "modelTrajectories": {market: local_model_trajectory_payload(market) for market in markets},
        "push": {
            "desktopConfigured": True,
            "mobileWebhookConfigured": bool(env.get("MOBILE_PUSH_WEBHOOK_URL")),
            "barkConfigured": bool(env.get("BARK_PUSH_URL")),
            "pushPlusConfigured": bool(env.get("PUSHPLUS_TOKEN")),
            "serverChanConfigured": bool(env.get("SERVERCHAN_SENDKEY")),
        },
    }


def node_binary() -> str:
    for candidate in NODE_CANDIDATES:
        if candidate.exists() and candidate.is_file():
            return str(candidate)
    return "node"


def log_message(message: str, exc: BaseException | None = None) -> None:
    APP_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with APP_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
        if exc is not None:
            handle.write("".join(traceback.format_exception(exc)))


class MonitorDesktopApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Global Quant Monitor · 模型运行中枢")
        self.geometry("1320x880")
        self.minsize(1080, 740)
        self.configure(bg=COLORS["bg"])
        self.status_payload: dict | None = None
        self.server_process: subprocess.Popen | None = None
        self.busy = False
        self.busy_since = 0.0

        self._build_style()
        self._build_ui()
        log_message("desktop app initialized")
        self.after(300, self.refresh_status)
        self.after(1000, self._busy_watchdog)
        self.after(15000, self._auto_refresh)

    def _build_style(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background=COLORS["bg"])
        style.configure("Panel.TFrame", background=COLORS["panel"], relief="flat")
        style.configure("TLabel", background=COLORS["bg"], foreground=COLORS["text"])
        style.configure("Muted.TLabel", background=COLORS["bg"], foreground=COLORS["muted"])
        style.configure("Panel.TLabel", background=COLORS["panel"], foreground=COLORS["text"])
        style.configure("MutedPanel.TLabel", background=COLORS["panel"], foreground=COLORS["muted"])
        style.configure("Title.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Helvetica Neue", 24, "bold"))
        style.configure("Metric.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Helvetica Neue", 20, "bold"))
        style.configure("TButton", padding=(13, 8), background="#242015", foreground=COLORS["text"], borderwidth=1, bordercolor=COLORS["border2"], focusthickness=0)
        style.map("TButton", background=[("active", "#2B2518"), ("disabled", "#151613")], foreground=[("disabled", COLORS["subtle"])])
        style.configure("Accent.TButton", background="#2B2518", foreground=COLORS["gold"], bordercolor="#5A4A2B")
        style.configure("Danger.TButton", background="#2B181A", foreground="#E5A1A8", bordercolor="#513036")
        style.configure("Good.TButton", background="#16251F", foreground="#8CC7B4", bordercolor="#2A4A3F")
        style.configure("TEntry", fieldbackground=COLORS["surface0"], foreground=COLORS["text"], insertcolor=COLORS["text"], bordercolor=COLORS["border"])
        style.configure("Model.TNotebook", background=COLORS["bg"], borderwidth=0, tabmargins=(0, 8, 0, 0))
        style.configure("Model.TNotebook.Tab", padding=(18, 9), background=COLORS["panel"], foreground=COLORS["muted"], borderwidth=0)
        style.map("Model.TNotebook.Tab", background=[("selected", COLORS["panel2"]), ("active", COLORS["panel2"])], foreground=[("selected", COLORS["gold"]), ("active", COLORS["text"])])

    def _build_ui(self) -> None:
        self.current_market = "ASX"
        self.current_family_id: str | None = None
        self.current_model_event_index = 0
        self.chart_hit_targets: list[tuple[float, float, dict]] = []
        self.hero_image = None

        root = tk.Frame(self, bg=COLORS["bg"], padx=20, pady=16)
        root.pack(fill="both", expand=True)

        topbar = tk.Frame(root, bg=COLORS["bg"])
        topbar.pack(fill="x", pady=(0, 10))
        brand = tk.Frame(topbar, bg=COLORS["bg"])
        brand.pack(side="left", fill="x", expand=True)
        tk.Label(brand, text="GQ", bg=COLORS["bg"], fg=COLORS["gold"], font=("Helvetica Neue", 10, "bold"), highlightbackground=COLORS["border2"], highlightthickness=1, padx=8, pady=8).pack(side="left", padx=(0, 9))
        brand_copy = tk.Frame(brand, bg=COLORS["bg"])
        brand_copy.pack(side="left")
        tk.Label(brand_copy, text="Global Quant Watch", bg=COLORS["bg"], fg=COLORS["text"], font=("Helvetica Neue", 14, "bold"), anchor="w").pack(fill="x")
        tk.Label(brand_copy, text="LOCAL MODEL OPERATIONS", bg=COLORS["bg"], fg=COLORS["muted"], font=("Helvetica Neue", 8), anchor="w").pack(fill="x")

        actions = tk.Frame(topbar, bg=COLORS["bg"])
        actions.pack(side="right")
        self.start_server_button = ttk.Button(actions, text="启动服务", command=self.start_server)
        self.start_server_button.pack(side="left", padx=3)
        self.refresh_button = ttk.Button(actions, text="刷新", command=self.refresh_status)
        self.refresh_button.pack(side="left", padx=3)
        self.run_button = ttk.Button(actions, text="立即运行", command=self.run_once, style="Accent.TButton")
        self.run_button.pack(side="left", padx=3)
        self.toggle_button = ttk.Button(actions, text="读取中", command=self.toggle_backend)
        self.toggle_button.pack(side="left", padx=3)

        hero = tk.Frame(root, bg=COLORS["surface0"], highlightbackground=COLORS["border"], highlightthickness=1)
        hero.pack(fill="x", pady=(0, 12))
        hero_copy = tk.Frame(hero, bg=COLORS["surface0"])
        hero_copy.pack(side="left", fill="both", expand=True, padx=28, pady=23)
        tk.Label(hero_copy, text="MODEL OPERATIONS CENTER", bg=COLORS["surface0"], fg=COLORS["accent"], font=("Helvetica Neue", 9, "bold"), anchor="w").pack(fill="x")
        tk.Label(hero_copy, text="模型运行中枢", bg=COLORS["surface0"], fg=COLORS["text"], font=("Helvetica Neue", 29, "bold"), anchor="w").pack(fill="x", pady=(6, 5))
        tk.Label(hero_copy, text="把数据、因子、样本外验证、权重校准与失败后微调串成可解释动线。", bg=COLORS["surface0"], fg=COLORS["muted"], font=("Helvetica Neue", 11), anchor="w").pack(fill="x")
        self.status_label = tk.Label(hero_copy, text="正在恢复本地状态...", bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica Neue", 10), anchor="w", padx=11, pady=7)
        self.status_label.pack(fill="x", pady=(16, 0))
        art_path = PROJECT_ROOT / "assets" / "images" / "quant-home-hero-v2.png"
        if art_path.exists():
            try:
                source = tk.PhotoImage(file=str(art_path))
                self.hero_image = source.subsample(5, 5)
                art = tk.Label(hero, image=self.hero_image, bg=COLORS["surface0"], borderwidth=0)
                art.pack(side="right", padx=(0, 1), pady=1)
            except tk.TclError as exc:
                log_message("desktop hero image unavailable", exc)

        metrics = tk.Frame(root, bg=COLORS["bg"])
        metrics.pack(fill="x", pady=(0, 10))
        self.metric_vars = {}
        metric_defs = [("enabled", "后台开关"), ("running", "运行状态"), ("due", "待运行任务"), ("push", "手机推送")]
        for index, (key, title) in enumerate(metric_defs):
            card = tk.Frame(metrics, bg=COLORS["panel"], highlightbackground=COLORS["border"], highlightthickness=1)
            card.pack(side="left", fill="x", expand=True, padx=(0 if index == 0 else 4, 0 if index == len(metric_defs) - 1 else 4))
            tk.Label(card, text=title, bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica Neue", 9), anchor="w").pack(fill="x", padx=14, pady=(11, 0))
            value = tk.StringVar(value="--")
            self.metric_vars[key] = value
            tk.Label(card, textvariable=value, bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica Neue", 18, "bold"), anchor="w").pack(fill="x", padx=14, pady=(4, 11))

        self.notebook = ttk.Notebook(root, style="Model.TNotebook")
        self.notebook.pack(fill="both", expand=True)
        self.model_tab = tk.Frame(self.notebook, bg=COLORS["surface0"])
        self.control_tab = tk.Frame(self.notebook, bg=COLORS["surface0"])
        self.system_tab = tk.Frame(self.notebook, bg=COLORS["surface0"])
        self.notebook.add(self.model_tab, text="模型动线")
        self.notebook.add(self.control_tab, text="运行控制")
        self.notebook.add(self.system_tab, text="系统与审计")
        self._build_model_tab()
        self._build_control_tab()
        self._build_system_tab()

    def _build_model_tab(self) -> None:
        toolbar = tk.Frame(self.model_tab, bg=COLORS["surface0"], padx=16, pady=12)
        toolbar.pack(fill="x")
        self.market_buttons: dict[str, tk.Button] = {}
        for market, label in [("ASX", "ASX"), ("US", "US"), ("CN", "A股")]:
            button = tk.Button(
                toolbar,
                text=label,
                command=lambda value=market: self.select_model_market(value),
                bg=COLORS["panel2"] if market == self.current_market else COLORS["panel"],
                fg=COLORS["gold"] if market == self.current_market else COLORS["muted"],
                activebackground=COLORS["panel2"],
                activeforeground=COLORS["gold"],
                relief="flat",
                borderwidth=0,
                padx=16,
                pady=7,
                font=("Helvetica Neue", 10, "bold"),
            )
            button.pack(side="left", padx=(0, 4))
            self.market_buttons[market] = button
        self.model_summary_var = tk.StringVar(value="正在读取模型注册表")
        tk.Label(toolbar, textvariable=self.model_summary_var, bg=COLORS["surface0"], fg=COLORS["muted"], font=("Helvetica Neue", 10), anchor="e").pack(side="right")

        self.pipeline_canvas = tk.Canvas(self.model_tab, height=96, bg=COLORS["surface0"], highlightthickness=0)
        self.pipeline_canvas.pack(fill="x", padx=16, pady=(0, 10))
        self.pipeline_canvas.bind("<Configure>", lambda _event: self.draw_model_pipeline())

        workspace = tk.PanedWindow(
            self.model_tab,
            orient="horizontal",
            bg=COLORS["border"],
            sashwidth=4,
            sashrelief="flat",
            borderwidth=0,
            showhandle=False,
        )
        workspace.pack(fill="both", expand=True)

        rail = tk.Frame(workspace, bg=COLORS["panel"], width=248)
        workspace.add(rail, minsize=220, width=248)
        rail_head = tk.Frame(rail, bg=COLORS["panel"])
        rail_head.pack(fill="x", padx=15, pady=(16, 8))
        tk.Label(rail_head, text="模型族", bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica Neue", 14, "bold"), anchor="w").pack(side="left")
        self.model_count_var = tk.StringVar(value="--")
        tk.Label(rail_head, textvariable=self.model_count_var, bg=COLORS["panel2"], fg=COLORS["muted"], font=("Helvetica Neue", 9), padx=7, pady=3).pack(side="right")
        self.model_list_frame = tk.Frame(rail, bg=COLORS["panel"])
        self.model_list_frame.pack(fill="both", expand=True, padx=9, pady=(0, 12))

        center = tk.Frame(workspace, bg=COLORS["surface0"])
        workspace.add(center, minsize=500, stretch="always")
        chart_head = tk.Frame(center, bg=COLORS["surface0"])
        chart_head.pack(fill="x", padx=18, pady=(16, 8))
        self.model_title_var = tk.StringVar(value="请选择模型")
        self.model_stage_var = tk.StringVar(value="MODEL TRAJECTORY")
        title_block = tk.Frame(chart_head, bg=COLORS["surface0"])
        title_block.pack(side="left", fill="x", expand=True)
        tk.Label(title_block, textvariable=self.model_stage_var, bg=COLORS["surface0"], fg=COLORS["accent"], font=("Helvetica Neue", 8, "bold"), anchor="w").pack(fill="x")
        tk.Label(title_block, textvariable=self.model_title_var, bg=COLORS["surface0"], fg=COLORS["text"], font=("Helvetica Neue", 17, "bold"), anchor="w").pack(fill="x", pady=(3, 0))
        self.model_metric_var = tk.StringVar(value="核心指标 --")
        tk.Label(chart_head, textvariable=self.model_metric_var, bg=COLORS["panel"], fg=COLORS["gold"], font=("Menlo", 10, "bold"), padx=10, pady=6).pack(side="right")

        self.trajectory_canvas = tk.Canvas(center, height=270, bg="#0B0D0B", highlightbackground=COLORS["border"], highlightthickness=1)
        self.trajectory_canvas.pack(fill="x", padx=18, pady=(4, 10))
        self.trajectory_canvas.bind("<Configure>", lambda _event: self.draw_model_trajectory())
        self.trajectory_canvas.bind("<Button-1>", self.on_trajectory_click)

        events_head = tk.Frame(center, bg=COLORS["surface0"])
        events_head.pack(fill="x", padx=18, pady=(0, 6))
        tk.Label(events_head, text="关键变更节点", bg=COLORS["surface0"], fg=COLORS["text"], font=("Helvetica Neue", 12, "bold"), anchor="w").pack(side="left")
        tk.Label(events_head, text="选择节点查看原因、证据与护栏", bg=COLORS["surface0"], fg=COLORS["muted"], font=("Helvetica Neue", 9), anchor="e").pack(side="right")
        self.event_listbox = tk.Listbox(
            center,
            height=7,
            bg=COLORS["panel"],
            fg=COLORS["text"],
            selectbackground="#2B2518",
            selectforeground=COLORS["gold"],
            relief="flat",
            highlightbackground=COLORS["border"],
            highlightthickness=1,
            activestyle="none",
            font=("Menlo", 10),
        )
        self.event_listbox.pack(fill="both", expand=True, padx=18, pady=(0, 16))
        self.event_listbox.bind("<<ListboxSelect>>", self.on_model_event_select)

        inspector = tk.Frame(workspace, bg=COLORS["panel"], width=342)
        workspace.add(inspector, minsize=300, width=342)
        inspector_head = tk.Frame(inspector, bg=COLORS["panel"])
        inspector_head.pack(fill="x", padx=15, pady=(16, 8))
        tk.Label(inspector_head, text="变更解释", bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica Neue", 14, "bold"), anchor="w").pack(side="left")
        self.event_impact_var = tk.StringVar(value="等待节点")
        tk.Label(inspector_head, textvariable=self.event_impact_var, bg=COLORS["panel2"], fg=COLORS["gold"], font=("Helvetica Neue", 9), padx=7, pady=3).pack(side="right")
        self.inspector_text = tk.Text(
            inspector,
            bg=COLORS["panel"],
            fg=COLORS["text"],
            insertbackground=COLORS["text"],
            relief="flat",
            wrap="word",
            font=("Helvetica Neue", 10),
            padx=15,
            pady=10,
            spacing1=2,
            spacing3=5,
            selectbackground="#3A3528",
        )
        self.inspector_text.pack(fill="both", expand=True)
        self.inspector_text.tag_configure("title", foreground=COLORS["text"], font=("Helvetica Neue", 14, "bold"), spacing3=8)
        self.inspector_text.tag_configure("section", foreground=COLORS["gold"], font=("Helvetica Neue", 10, "bold"), spacing1=9, spacing3=4)
        self.inspector_text.tag_configure("muted", foreground=COLORS["muted"], font=("Helvetica Neue", 9))
        self.inspector_text.tag_configure("good", foreground=COLORS["good"], font=("Helvetica Neue", 9, "bold"))
        self.inspector_text.tag_configure("danger", foreground=COLORS["danger"], font=("Helvetica Neue", 9, "bold"))
        self.inspector_text.configure(state="disabled")

    def _build_control_tab(self) -> None:
        schedule = tk.Frame(self.control_tab, bg=COLORS["panel"], highlightbackground=COLORS["border"], highlightthickness=1)
        schedule.pack(fill="x", padx=14, pady=14)
        schedule_header = tk.Frame(schedule, bg=COLORS["panel"])
        schedule_header.pack(fill="x", padx=16, pady=(14, 7))
        tk.Label(schedule_header, text="刷新与训练频率", bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica Neue", 15, "bold"), anchor="w").pack(side="left")
        tk.Label(schedule_header, text="报价 1/3 分钟 · 完整分析与分钟训练独立设置", bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica Neue", 9), anchor="e").pack(side="right")
        fields = tk.Frame(schedule, bg=COLORS["panel"])
        fields.pack(fill="x", padx=16, pady=(0, 14))
        self.holding_minutes = self._number_field(fields, "持仓分析分钟", 0)
        self.watch_minutes = self._number_field(fields, "监控分析分钟", 1)
        self.training_minutes = self._number_field(fields, "训练分钟", 2)
        self.training_symbols = self._number_field(fields, "训练股票数", 3)
        ttk.Button(fields, text="保存频率", command=self.save_schedule, style="Accent.TButton").grid(row=1, column=4, padx=(14, 0), sticky="ew")
        fields.grid_columnconfigure(4, weight=1)

        columns = tk.Frame(self.control_tab, bg=COLORS["surface0"])
        columns.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        left = tk.Frame(columns, bg=COLORS["surface0"])
        left.pack(side="left", fill="both", expand=True, padx=(0, 6))
        right = tk.Frame(columns, bg=COLORS["surface0"])
        right.pack(side="left", fill="both", expand=True, padx=(6, 0))
        self.sessions_text = self._text_panel(left, "市场时段")
        self.budget_text = self._text_panel(right, "预算与推送")

    def _build_system_tab(self) -> None:
        command_bar = tk.Frame(self.system_tab, bg=COLORS["surface0"], padx=14, pady=14)
        command_bar.pack(fill="x")
        tk.Label(command_bar, text="系统服务", bg=COLORS["surface0"], fg=COLORS["text"], font=("Helvetica Neue", 14, "bold"), anchor="w").pack(side="left")
        self.login_button = ttk.Button(command_bar, text="安装登录自启", command=self.install_login_agent)
        self.login_button.pack(side="right", padx=(6, 0))
        self.remove_login_button = ttk.Button(command_bar, text="取消登录自启", command=self.remove_login_agent)
        self.remove_login_button.pack(side="right")
        columns = tk.Frame(self.system_tab, bg=COLORS["surface0"])
        columns.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        left = tk.Frame(columns, bg=COLORS["surface0"])
        left.pack(side="left", fill="both", expand=True, padx=(0, 6))
        right = tk.Frame(columns, bg=COLORS["surface0"])
        right.pack(side="left", fill="both", expand=True, padx=(6, 0))
        self.models_text = self._text_panel(left, "分钟模型与本地注册表")
        self.pool_text = self._text_panel(right, "监控池与最近结果")

    def _number_field(self, parent: tk.Frame, title: str, column: int) -> tk.StringVar:
        frame = tk.Frame(parent, bg=COLORS["panel"])
        frame.grid(row=0, column=column, sticky="ew", padx=(0, 10))
        parent.grid_columnconfigure(column, weight=1)
        tk.Label(frame, text=title, bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica", 11), anchor="w").pack(fill="x")
        value = tk.StringVar(value="")
        entry = ttk.Entry(frame, textvariable=value)
        entry.pack(fill="x", pady=(4, 0))
        return value

    def _text_panel(self, parent: ttk.Frame, title: str) -> tk.Text:
        panel = tk.Frame(parent, bg=COLORS["panel"], highlightbackground=COLORS["border"], highlightthickness=1)
        panel.pack(fill="both", expand=True, pady=(0, 14))
        title_row = tk.Frame(panel, bg=COLORS["panel"])
        title_row.pack(fill="x", padx=14, pady=(12, 5))
        tk.Label(title_row, text=title, bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica Neue", 14, "bold"), anchor="w").pack(side="left")
        tk.Label(title_row, text="LOCAL / LIVE", bg=COLORS["panel"], fg=COLORS["subtle"], font=("Helvetica Neue", 8), anchor="e").pack(side="right")
        text = tk.Text(
            panel,
            height=10,
            bg=COLORS["surface0"],
            fg=COLORS["text"],
            insertbackground=COLORS["text"],
            relief="flat",
            wrap="word",
            font=("Menlo", 10),
            padx=10,
            pady=9,
            selectbackground="#3A3528",
        )
        text.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        text.configure(state="disabled")
        return text

    def select_model_market(self, market: str) -> None:
        self.current_market = market
        self.current_family_id = None
        self.current_model_event_index = 0
        for key, button in self.market_buttons.items():
            active = key == market
            button.configure(
                bg=COLORS["panel2"] if active else COLORS["panel"],
                fg=COLORS["gold"] if active else COLORS["muted"],
            )
        self.render_model_trajectory()

    def selected_model_payload(self) -> dict:
        payload = self.status_payload or {}
        trajectories = payload.get("modelTrajectories") if isinstance(payload.get("modelTrajectories"), dict) else {}
        return trajectories.get(self.current_market) if isinstance(trajectories.get(self.current_market), dict) else {"families": [], "summary": {}}

    def selected_model_family(self) -> dict | None:
        families = self.selected_model_payload().get("families") or []
        if not families:
            return None
        for family in families:
            if family.get("id") == self.current_family_id:
                return family
        return families[0]

    def render_model_trajectory(self) -> None:
        if not hasattr(self, "model_list_frame"):
            return
        payload = self.selected_model_payload()
        families = payload.get("families") or []
        if not any(family.get("id") == self.current_family_id for family in families):
            self.current_family_id = families[0].get("id") if families else None
            self.current_model_event_index = 0
        summary = payload.get("summary") or {}
        self.model_summary_var.set(
            f"{self.current_market} · {summary.get('modelCount', len(families))} 个模型族 · "
            f"24 小时 {summary.get('changes24h', 0)} 次变更 · 护栏 {summary.get('guardrailCoveragePct', 0)}%"
        )
        self.model_count_var.set(f"{len(families)} 个")
        for child in self.model_list_frame.winfo_children():
            child.destroy()
        for family in families:
            active = family.get("id") == self.current_family_id
            metric_value = family.get("primaryValue")
            metric_text = "--" if metric_value is None else f"{float(metric_value):.1f}{family.get('primaryUnit', '')}"
            button = tk.Button(
                self.model_list_frame,
                text=f"{family.get('short', family.get('name', '模型'))}\n{family.get('status', '研究中')}  ·  {metric_text}  ·  {family.get('eventCount', 0)} 次",
                command=lambda family_id=family.get("id"): self.select_model_family(family_id),
                justify="left",
                anchor="w",
                bg="#242015" if active else COLORS["panel"],
                fg=COLORS["gold"] if active else COLORS["text"],
                activebackground="#2B2518",
                activeforeground=COLORS["gold"],
                relief="flat",
                borderwidth=0,
                padx=12,
                pady=9,
                font=("Helvetica Neue", 10, "bold"),
            )
            button.pack(fill="x", pady=3)
        family = self.selected_model_family()
        if family:
            self.model_title_var.set(family.get("name") or family.get("short") or "模型")
            self.model_stage_var.set(str(family.get("stage") or "MODEL TRAJECTORY").upper())
            value = family.get("primaryValue")
            value_text = "--" if value is None else f"{float(value):.1f}{family.get('primaryUnit', '')}"
            self.model_metric_var.set(f"{family.get('primaryLabel', '核心指标')}  {value_text}")
        else:
            self.model_title_var.set("暂无模型轨迹")
            self.model_stage_var.set("WAITING FOR LOCAL EVIDENCE")
            self.model_metric_var.set("核心指标 --")
        self.draw_model_pipeline()
        self.draw_model_trajectory()
        self.render_model_event_list()

    def select_model_family(self, family_id: str | None) -> None:
        self.current_family_id = family_id
        self.current_model_event_index = 0
        self.render_model_trajectory()

    def draw_model_pipeline(self) -> None:
        if not hasattr(self, "pipeline_canvas"):
            return
        canvas = self.pipeline_canvas
        canvas.delete("all")
        width = max(620, canvas.winfo_width())
        height = max(84, canvas.winfo_height())
        stages = [
            ("数据", True),
            ("因子", any(family.get("id") == "factor" for family in (self.selected_model_payload().get("families") or []))),
            ("基础模型", any(family.get("id") in {"alpha", "intraday"} for family in (self.selected_model_payload().get("families") or []))),
            ("OOF", any(family.get("id") == "calibration" for family in (self.selected_model_payload().get("families") or []))),
            ("集成", any(family.get("id") in {"calibration", "agent"} for family in (self.selected_model_payload().get("families") or []))),
            ("校准", any(family.get("id") == "adaptive" for family in (self.selected_model_payload().get("families") or []))),
            ("拒绝交易", bool((self.status_payload or {}).get("config"))),
        ]
        left, right, y = 34, width - 34, 42
        step = (right - left) / max(1, len(stages) - 1)
        canvas.create_line(left, y, right, y, fill=COLORS["border2"], width=2)
        for index, (label, available) in enumerate(stages):
            x = left + index * step
            fill = COLORS["accent"] if available else COLORS["subtle"]
            canvas.create_oval(x - 7, y - 7, x + 7, y + 7, fill=fill, outline=COLORS["surface0"], width=2)
            canvas.create_text(x, y + 25, text=label, fill=COLORS["text"] if available else COLORS["muted"], font=("Helvetica Neue", 9), anchor="n")

    def draw_model_trajectory(self) -> None:
        if not hasattr(self, "trajectory_canvas"):
            return
        canvas = self.trajectory_canvas
        canvas.delete("all")
        family = self.selected_model_family()
        points = family.get("trajectory") if family else []
        points = [point for point in (points or []) if finite_number(point.get("value")) is not None]
        width = max(420, canvas.winfo_width())
        height = max(240, canvas.winfo_height())
        self.chart_hit_targets = []
        if not points:
            canvas.create_text(width / 2, height / 2 - 8, text="尚未形成可绘制的样本外轨迹", fill=COLORS["text"], font=("Helvetica Neue", 12, "bold"))
            canvas.create_text(width / 2, height / 2 + 15, text="事件仍会保留在下方本地审计列表", fill=COLORS["muted"], font=("Helvetica Neue", 9))
            return
        values = [float(point.get("value")) for point in points]
        minimum, maximum = min(values), max(values)
        spread = max(1.0, maximum - minimum)
        minimum -= spread * 0.16
        maximum += spread * 0.16
        margin_left, margin_right, margin_top, margin_bottom = 48, 20, 24, 36
        chart_width = width - margin_left - margin_right
        chart_height = height - margin_top - margin_bottom
        for index in range(5):
            y = margin_top + index / 4 * chart_height
            value = maximum - index / 4 * (maximum - minimum)
            canvas.create_line(margin_left, y, width - margin_right, y, fill="#242621", width=1)
            canvas.create_text(8, y, text=f"{value:.1f}", fill=COLORS["muted"], font=("Menlo", 8), anchor="w")
        coordinates = []
        for index, point in enumerate(points):
            x = margin_left + (chart_width / 2 if len(points) == 1 else index / (len(points) - 1) * chart_width)
            y = margin_top + (maximum - float(point.get("value"))) / (maximum - minimum) * chart_height
            coordinates.extend([x, y])
            self.chart_hit_targets.append((x, y, point.get("event") or {}))
        if len(coordinates) >= 4:
            canvas.create_line(*coordinates, fill=COLORS["accent"], width=2, smooth=True, splinesteps=18)
        for x, y, event in self.chart_hit_targets:
            impact = event.get("impact")
            fill = COLORS["good"] if impact == "improved" else COLORS["danger"] if impact == "degraded" else COLORS["accent"]
            canvas.create_oval(x - 4, y - 4, x + 4, y + 4, fill=fill, outline="#0B0D0B", width=2)
        for index in sorted({0, (len(points) - 1) // 2, len(points) - 1}):
            point = points[index]
            x = margin_left + (chart_width / 2 if len(points) == 1 else index / (len(points) - 1) * chart_width)
            canvas.create_text(x, height - 17, text=compact_time(point.get("at"))[5:16], fill=COLORS["muted"], font=("Menlo", 8), anchor="center")

    def render_model_event_list(self) -> None:
        family = self.selected_model_family()
        events = family.get("events") if family else []
        self.event_listbox.delete(0, tk.END)
        for event in events or []:
            marker = "+" if event.get("impact") == "improved" else "-" if event.get("impact") == "degraded" else "·"
            self.event_listbox.insert(tk.END, f" {marker}  {compact_time(event.get('createdAt'))[5:16]}  {event.get('title', '模型事件')}  ·  {event.get('entity', 'market')}")
        if events:
            self.current_model_event_index = min(self.current_model_event_index, len(events) - 1)
            self.event_listbox.selection_set(self.current_model_event_index)
            self.event_listbox.activate(self.current_model_event_index)
            self.render_model_event(events[self.current_model_event_index])
        else:
            self.render_model_event(None)

    def on_model_event_select(self, _event: tk.Event | None = None) -> None:
        selection = self.event_listbox.curselection()
        if not selection:
            return
        self.current_model_event_index = int(selection[0])
        family = self.selected_model_family()
        events = family.get("events") if family else []
        if 0 <= self.current_model_event_index < len(events):
            self.render_model_event(events[self.current_model_event_index])

    def on_trajectory_click(self, event: tk.Event) -> None:
        if not self.chart_hit_targets:
            return
        x, y, selected = min(self.chart_hit_targets, key=lambda point: math.hypot(point[0] - event.x, point[1] - event.y))
        if math.hypot(x - event.x, y - event.y) > 20:
            return
        family = self.selected_model_family()
        events = family.get("events") if family else []
        for index, item in enumerate(events):
            if item.get("id") == selected.get("id") and item.get("createdAt") == selected.get("createdAt"):
                self.current_model_event_index = index
                self.event_listbox.selection_clear(0, tk.END)
                self.event_listbox.selection_set(index)
                self.event_listbox.see(index)
                self.render_model_event(item)
                break

    def render_model_event(self, event: dict | None) -> None:
        text = self.inspector_text
        text.configure(state="normal")
        text.delete("1.0", tk.END)
        if not event:
            self.event_impact_var.set("等待节点")
            text.insert(tk.END, "选择一个模型变更节点后，这里会显示修改内容、触发原因、样本证据、公式和护栏结果。", "muted")
            text.configure(state="disabled")
            return
        impact = event.get("impact")
        self.event_impact_var.set("样本外改善" if impact == "improved" else "指标退化" if impact == "degraded" else "待验证")
        text.insert(tk.END, f"{event.get('title', '模型事件')}\n", "title")
        text.insert(tk.END, f"{event.get('summary', '')}\n", "muted")
        text.insert(tk.END, "\n证据摘要\n", "section")
        metric_value = event.get("primaryValue")
        metric_text = "--" if metric_value is None else f"{float(metric_value):.2f}{event.get('primaryUnit', '')}"
        text.insert(tk.END, f"核心指标  {event.get('primaryLabel', '评估指标')}  {metric_text}\n")
        text.insert(tk.END, f"样本数量  {event.get('sampleCount', 0)}\n")
        text.insert(tk.END, f"模型对象  {event.get('entity', 'market')}\n")
        text.insert(tk.END, f"发生时间  {compact_time(event.get('createdAt'))}\n")
        if event.get("changes"):
            text.insert(tk.END, "\n修改了什么\n", "section")
            for item in event.get("changes") or []:
                text.insert(tk.END, f"• {item}\n")
        if event.get("reasons"):
            text.insert(tk.END, "\n为什么修改\n", "section")
            for item in event.get("reasons") or []:
                text.insert(tk.END, f"• {item}\n")
        if event.get("formula"):
            text.insert(tk.END, "\n调整公式\n", "section")
            text.insert(tk.END, f"{event.get('formula')}\n", "muted")
        if event.get("guardrails"):
            text.insert(tk.END, "\n防过拟合与泄漏护栏\n", "section")
            for guard in event.get("guardrails") or []:
                tag = "good" if guard.get("pass") is not False else "danger"
                text.insert(tk.END, f"{'通过' if guard.get('pass') is not False else '未通过'}  {guard.get('label')}\n", tag)
                if guard.get("note"):
                    text.insert(tk.END, f"  {guard.get('note')}\n", "muted")
        text.configure(state="disabled")

    def set_busy(self, busy: bool) -> None:
        self.busy = busy
        self.busy_since = time.time() if busy else 0.0
        state = "disabled" if busy else "normal"
        for button in [self.start_server_button, self.refresh_button, self.toggle_button, self.run_button, self.login_button, self.remove_login_button]:
            button.configure(state=state)

    def install_login_agent(self) -> None:
        self.set_busy(True)
        self.status_label.configure(text="正在配置登录自动启动...")
        self.background(self._install_login_agent_worker)

    def _install_login_agent_worker(self) -> None:
        result = subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "tools" / "manage_launch_agent.py"), "install"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "登录自启安装失败")[:500])
        self.after(0, lambda: self.status_label.configure(text="登录自启已安装；后台会在 macOS 登录后自动运行。"))
        self.after(0, lambda: self.set_busy(False))

    def remove_login_agent(self) -> None:
        self.set_busy(True)
        self.status_label.configure(text="正在取消登录自动启动...")
        self.background(self._remove_login_agent_worker)

    def _remove_login_agent_worker(self) -> None:
        result = subprocess.run(
            [sys.executable, str(PROJECT_ROOT / "tools" / "manage_launch_agent.py"), "uninstall"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "取消登录自启失败")[:500])
        self.after(0, lambda: self.status_label.configure(text="登录自启已取消；当前已运行的后台可继续手动控制。"))
        self.after(0, lambda: self.set_busy(False))

    def background(self, target, *args) -> None:
        def runner() -> None:
            try:
                target(*args)
            except Exception as exc:  # noqa: BLE001
                log_message(f"background task failed: {getattr(target, '__name__', 'unknown')}", exc)
                self.after(0, lambda: self.show_error(str(exc)))
        threading.Thread(target=runner, daemon=True).start()

    def show_error(self, message: str) -> None:
        self.set_busy(False)
        self.status_label.configure(text=f"错误：{message}")

    def safe_render(self, payload: dict) -> None:
        try:
            self.render(payload)
        except Exception as exc:  # noqa: BLE001
            log_message("render failed", exc)
            self.show_error(str(exc))

    def status_with_fallback(self) -> dict:
        payload = local_status_payload()
        payload["_warning"] = "界面直接读取本地状态快照；后台服务每轮运行后更新。"
        return payload

    def start_server(self) -> None:
        self.status_label.configure(text="已请求启动本地服务；主界面继续读取本地快照。")
        payload = local_status_payload()
        payload["_warning"] = "已尝试启动本地服务；如果端口已占用，说明服务已经在运行。"
        self.safe_render(payload)
        self.background(self._start_server_worker)

    def _start_server_worker(self) -> None:
        log_message("spawning backend service without HTTP preflight")
        log_dir = PROJECT_ROOT / ".cache" / "backend-monitor"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = open(log_dir / "desktop-server.log", "a", encoding="utf-8")
        self.server_process = subprocess.Popen(
            [node_binary(), "server.mjs"],
            cwd=PROJECT_ROOT,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def refresh_status(self) -> None:
        if self.busy:
            return
        self.set_busy(True)
        try:
            log_message("refreshing backend monitor status")
            payload = self.status_with_fallback()
            self.safe_render(payload)
        except Exception as exc:  # noqa: BLE001
            log_message("synchronous status refresh failed", exc)
            self.show_error(str(exc))

    def _refresh_status_worker(self) -> None:
        log_message("refreshing backend monitor status")
        payload = self.status_with_fallback()
        self.after(0, lambda: self.safe_render(payload))

    def render(self, payload: dict) -> None:
        log_message("rendering backend monitor status")
        self.status_payload = payload
        self.set_busy(False)
        config = payload.get("config", {})
        monitor_state = payload.get("state", {})
        runtime = payload.get("runtime", {})
        enabled = config.get("enabled", True)
        running = bool(monitor_state.get("running"))
        push = payload.get("push", {})
        mobile_ready = any(push.get(key) for key in ["mobileWebhookConfigured", "barkConfigured", "pushPlusConfigured", "serverChanConfigured"])

        self.metric_vars["enabled"].set("已开启" if enabled else "已关闭")
        self.metric_vars["running"].set("运行中" if running else "空闲")
        self.metric_vars["due"].set(str(payload.get("dueJobs", 0)))
        self.metric_vars["push"].set("已配置" if mobile_ready else "未配置")

        self.toggle_button.configure(text="关闭后台" if enabled else "开启后台", style="Danger.TButton" if enabled else "Good.TButton")
        transport = payload.get("_transport") or "live"
        transport_label = "实时读取" if transport in {"live", "curl-live"} else "本地缓存"
        warning = f" · {payload.get('_warning')[:42]}" if payload.get("_warning") else ""
        self.status_label.configure(text=f"{transport_label} · {payload.get('version', 'local')} · 上次运行 {compact_time(runtime.get('lastRunAt') or monitor_state.get('lastRunAt'))}{warning}")

        refresh = config.get("refresh", {})
        training = config.get("training", {})
        self.holding_minutes.set(str(round(int(refresh.get("holdingMs", 120000)) / 60000)))
        self.watch_minutes.set(str(round(int(refresh.get("watchMs", 300000)) / 60000)))
        self.training_minutes.set(str(round(int(refresh.get("trainingMs", 120000)) / 60000)))
        self.training_symbols.set(str(training.get("symbolLimit", 3)))

        self._write(self.sessions_text, self.format_sessions(payload))
        self._write(self.budget_text, self.format_budget(payload))
        self._write(self.models_text, self.format_models(payload))
        self._write(self.pool_text, self.format_pools_and_results(payload))
        self.render_model_trajectory()
        log_message("render complete")

    def _write(self, widget: tk.Text, text: str) -> None:
        widget.configure(state="normal")
        widget.delete("1.0", tk.END)
        widget.insert("1.0", text)
        widget.configure(state="disabled")

    def format_sessions(self, payload: dict) -> str:
        rows = []
        for market, session in (payload.get("sessions") or {}).items():
            state = "交易中" if session.get("open") else "周末" if session.get("weekend") else "休市"
            rows.append(f"{market}: {state}\n  {session.get('localTime', '--')} · {session.get('timeZone', '')}")
        return "\n\n".join(rows) or "暂无市场时段信息。"

    def format_budget(self, payload: dict) -> str:
        used = (payload.get("budget") or {}).get("used") or {}
        limits = payload.get("budgetLimits") or {}
        names = [
            ("marketCalls", "行情调用"),
            ("factorCalls", "因子调用"),
            ("trainingCalls", "分钟训练"),
            ("aiCalls", "AI复核"),
            ("notifications", "提醒推送"),
        ]
        rows = [f"{label}: {used.get(key, 0)} / {limits.get(key, 0)}" for key, label in names]
        rows.append(f"训练行情预留: {limits.get('trainingMarketReserve', 0)}")
        push = payload.get("push") or {}
        rows.append("")
        rows.append("推送:")
        rows.append(f"  Bark: {'已配置' if push.get('barkConfigured') else '未配置'}")
        rows.append(f"  PushPlus: {'已配置' if push.get('pushPlusConfigured') else '未配置'}")
        rows.append(f"  Server酱: {'已配置' if push.get('serverChanConfigured') else '未配置'}")
        rows.append(f"  Webhook: {'已配置' if push.get('mobileWebhookConfigured') else '未配置'}")
        return "\n".join(rows)

    def format_models(self, payload: dict) -> str:
        rows = []
        for market, model in (payload.get("intradayModels") or {}).items():
            status = "ready" if model.get("available") else "pending"
            test = model.get("test") or {}
            rows.append(
                f"{market}: {status}\n"
                f"  样本: {model.get('sampleCount', 0)}\n"
                f"  更新: {compact_time(model.get('updatedAt'))}\n"
                f"  测试方向命中: {float(test.get('directionalAccuracy', 0) or 0):.0f}%\n"
                f"  {model.get('reason', '')}"
            )
        return "\n\n".join(rows) or "暂无分钟模型。"

    def format_pools_and_results(self, payload: dict) -> str:
        markets = ((payload.get("config") or {}).get("markets") or {})
        rows = ["监控池:"]
        for market, config in markets.items():
            rows.append(f"  {market}: 监控 {len(config.get('watchlist') or [])} · 持仓 {len(config.get('portfolio') or [])}")
        results = (payload.get("runtime") or {}).get("lastResults") or []
        rows.append("")
        rows.append("最近结果:")
        if not results:
            rows.append("  暂无后台运行结果。")
        for item in results[:12]:
            action = item.get("action") or ("ERROR" if item.get("error") else "WAIT")
            if item.get("error"):
                rows.append(f"  {item.get('market')} {item.get('symbol')} · {action}: {item.get('error')}")
            else:
                rows.append(
                    f"  {item.get('market')} {item.get('symbol')} · {action} · "
                    f"置信 {float(item.get('confidence') or 0):.0f}% · "
                    f"预估 {float(item.get('projectedFinalReturn') or 0):.2f}% · "
                    f"价格 {float(item.get('price') or 0):.3f}"
                )
        return "\n".join(rows)

    def toggle_backend(self) -> None:
        payload = self.status_payload
        if not payload:
            return
        config = copy.deepcopy(payload.get("config") or {})
        config["enabled"] = not bool(config.get("enabled", True))
        config["source"] = "desktop-app"
        self._save_config_local(config, "已切换后台开关；后台服务下一轮会读取。")

    def save_schedule(self) -> None:
        payload = self.status_payload
        if not payload:
            return
        try:
            holding = max(1, int(float(self.holding_minutes.get())))
            watch = max(1, int(float(self.watch_minutes.get())))
            training_minutes = max(1, int(float(self.training_minutes.get())))
            training_symbols = min(5, max(1, int(float(self.training_symbols.get()))))
        except ValueError:
            messagebox.showerror("输入错误", "请输入有效数字。")
            return
        config = copy.deepcopy(payload.get("config") or {})
        config["source"] = "desktop-app"
        config["refresh"] = {
            **(config.get("refresh") or {}),
            "holdingMs": holding * 60000,
            "watchMs": watch * 60000,
            "trainingMs": training_minutes * 60000,
        }
        config["training"] = {
            **(config.get("training") or {}),
            "enabled": True,
            "symbolLimit": training_symbols,
            "interval": (config.get("training") or {}).get("interval") or "5m",
            "range": (config.get("training") or {}).get("range") or "1mo",
        }
        self._save_config_local(config, "已保存刷新频率；后台服务下一轮会读取。")

    def _save_config_local(self, config: dict, message: str) -> None:
        config["updatedAt"] = iso_now()
        write_json_file(CONFIG_PATH, config)
        payload = local_status_payload()
        payload["_warning"] = message
        self.safe_render(payload)

    def _save_config_worker(self, config: dict) -> None:
        self._save_config_local(config, "已写入本地配置；后台服务下一轮会读取。")

    def run_once(self) -> None:
        self.status_label.configure(text="已写入即时运行请求，等待后端下一轮检查。")
        self._run_once_worker()

    def _run_once_worker(self) -> None:
        write_json_file(RUN_REQUEST_PATH, {"createdAt": iso_now(), "source": "desktop-app", "reason": "manual-desktop"})
        payload = local_status_payload()
        payload["_warning"] = "已写入本地即时运行请求；后端会在下一轮检查时执行。"
        self.safe_render(payload)

    def _busy_watchdog(self) -> None:
        if self.busy and self.busy_since and time.time() - self.busy_since > 15:
            log_message("busy watchdog released a stuck UI state")
            self.show_error("操作已解锁；主界面继续读取本地状态快照。")
        self.after(1000, self._busy_watchdog)

    def _auto_refresh(self) -> None:
        if not self.busy:
            self.refresh_status()
        self.after(15000, self._auto_refresh)


if __name__ == "__main__":
    app = MonitorDesktopApp()
    app.mainloop()
