#!/usr/bin/env python3
"""Local desktop controller for the Global Quant Watch backend monitor.

This intentionally uses only the Python standard library so it can run as a
small local app without Electron, browser UI, or extra package installs.
"""

from __future__ import annotations

import copy
import http.client
import json
import os
import subprocess
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
APP_VERSION = "desktop-local-v1"
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
    "bg": "#050A12",
    "panel": "#0A1420",
    "panel2": "#0E1A28",
    "panel3": "#111F2F",
    "border": "#1E3B53",
    "border2": "#27516E",
    "text": "#EAF6FF",
    "muted": "#8DA7BA",
    "subtle": "#577086",
    "accent": "#2DE2C5",
    "accent2": "#6EA8FE",
    "gold": "#F2C94C",
    "danger": "#F05D76",
    "good": "#45D483",
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
        self.title("Global Quant Watch 后台监控")
        self.geometry("1160x780")
        self.minsize(980, 690)
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
        style.configure("Title.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Helvetica", 24, "bold"))
        style.configure("Metric.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Helvetica", 20, "bold"))
        style.configure("TButton", padding=(13, 8), background="#13263A", foreground=COLORS["text"], borderwidth=0, focusthickness=0)
        style.map("TButton", background=[("active", "#193854"), ("disabled", "#0B1724")], foreground=[("disabled", COLORS["subtle"])])
        style.configure("Accent.TButton", background="#143C48", foreground="#D8FFF8")
        style.configure("Danger.TButton", background="#351620", foreground="#FFDCE3")
        style.configure("Good.TButton", background="#123522", foreground="#D8FFE5")
        style.configure("TEntry", fieldbackground="#07101A", foreground=COLORS["text"], insertcolor=COLORS["text"], bordercolor=COLORS["border"])

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=22)
        root.pack(fill="both", expand=True)

        header = tk.Frame(root, bg=COLORS["panel"], highlightbackground=COLORS["border2"], highlightthickness=1)
        header.pack(fill="x", pady=(0, 16))
        title_block = tk.Frame(header, bg=COLORS["panel"])
        title_block.pack(side="left", fill="both", expand=True, padx=18, pady=15)
        tk.Label(title_block, text="LOCAL DESKTOP DAEMON", bg=COLORS["panel"], fg=COLORS["accent"], font=("Helvetica", 10, "bold"), anchor="w").pack(fill="x")
        tk.Label(title_block, text="Global Quant Watch", bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica", 25, "bold"), anchor="w").pack(fill="x", pady=(2, 0))
        tk.Label(title_block, text="后端监控、分钟训练、预算和提醒的本地控制台", bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica", 12), anchor="w").pack(fill="x", pady=(2, 0))
        self.status_label = tk.Label(title_block, text="读取中...", bg="#07101A", fg=COLORS["muted"], font=("Helvetica", 11), anchor="w", padx=10, pady=5)
        self.status_label.pack(fill="x", pady=(10, 0))

        actions = tk.Frame(header, bg=COLORS["panel"])
        actions.pack(side="right", padx=14, pady=14)
        self.start_server_button = ttk.Button(actions, text="启动本地服务", command=self.start_server)
        self.start_server_button.pack(fill="x", pady=3)
        self.refresh_button = ttk.Button(actions, text="刷新", command=self.refresh_status)
        self.refresh_button.pack(fill="x", pady=3)
        self.toggle_button = ttk.Button(actions, text="读取中", command=self.toggle_backend)
        self.toggle_button.pack(fill="x", pady=3)
        self.run_button = ttk.Button(actions, text="立即运行一次", command=self.run_once, style="Accent.TButton")
        self.run_button.pack(fill="x", pady=3)

        metrics = ttk.Frame(root)
        metrics.pack(fill="x", pady=(0, 14))
        self.metric_vars: dict[str, tk.StringVar] = {}
        metric_defs = [
            ("enabled", "后台开关"),
            ("running", "运行状态"),
            ("due", "待运行任务"),
            ("push", "手机推送"),
        ]
        for key, title in metric_defs:
            card = tk.Frame(metrics, bg=COLORS["panel"], highlightbackground=COLORS["border"], highlightthickness=1)
            card.pack(side="left", fill="x", expand=True, padx=5)
            tk.Frame(card, bg=COLORS["accent"], height=2).pack(fill="x")
            tk.Label(card, text=title, bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica", 11), anchor="w").pack(fill="x", padx=14, pady=(12, 0))
            value = tk.StringVar(value="--")
            self.metric_vars[key] = value
            tk.Label(card, textvariable=value, bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica", 21, "bold"), anchor="w").pack(fill="x", padx=14, pady=(4, 13))

        schedule = tk.Frame(root, bg=COLORS["panel"], highlightbackground=COLORS["border"], highlightthickness=1)
        schedule.pack(fill="x", pady=(0, 14))
        schedule_header = tk.Frame(schedule, bg=COLORS["panel"])
        schedule_header.pack(fill="x", padx=14, pady=(12, 6))
        tk.Label(schedule_header, text="刷新频率", bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica", 15, "bold"), anchor="w").pack(side="left")
        tk.Label(schedule_header, text="持仓 5 分钟 / 监控 15 分钟 / 分钟训练可独立设置", bg=COLORS["panel"], fg=COLORS["muted"], font=("Helvetica", 11), anchor="e").pack(side="right")
        fields = tk.Frame(schedule, bg=COLORS["panel"])
        fields.pack(fill="x", padx=14, pady=(0, 12))
        self.holding_minutes = self._number_field(fields, "持仓股分钟", 0)
        self.watch_minutes = self._number_field(fields, "监控股分钟", 1)
        self.training_minutes = self._number_field(fields, "训练分钟", 2)
        self.training_symbols = self._number_field(fields, "训练股票数", 3)
        ttk.Button(fields, text="保存频率", command=self.save_schedule).grid(row=1, column=4, padx=(14, 0), sticky="ew")
        fields.grid_columnconfigure(4, weight=1)

        middle = ttk.Frame(root)
        middle.pack(fill="both", expand=True)

        left = ttk.Frame(middle)
        left.pack(side="left", fill="both", expand=True, padx=(0, 7))
        right = ttk.Frame(middle)
        right.pack(side="left", fill="both", expand=True, padx=(7, 0))

        self.sessions_text = self._text_panel(left, "市场时段")
        self.budget_text = self._text_panel(left, "预算与推送")
        self.models_text = self._text_panel(right, "分钟模型")
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
        tk.Label(title_row, text=title, bg=COLORS["panel"], fg=COLORS["text"], font=("Helvetica", 15, "bold"), anchor="w").pack(side="left")
        tk.Label(title_row, text="live/cache aware", bg=COLORS["panel"], fg=COLORS["subtle"], font=("Helvetica", 10), anchor="e").pack(side="right")
        text = tk.Text(
            panel,
            height=10,
            bg="#06101A",
            fg="#D8EDF8",
            insertbackground=COLORS["text"],
            relief="flat",
            wrap="word",
            font=("Menlo", 12),
            padx=10,
            pady=9,
            selectbackground="#1D4F63",
        )
        text.pack(fill="both", expand=True, padx=14, pady=(0, 14))
        text.configure(state="disabled")
        return text

    def set_busy(self, busy: bool) -> None:
        self.busy = busy
        self.busy_since = time.time() if busy else 0.0
        state = "disabled" if busy else "normal"
        for button in [self.start_server_button, self.refresh_button, self.toggle_button, self.run_button]:
            button.configure(state=state)

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
        self.holding_minutes.set(str(round(int(refresh.get("holdingMs", 300000)) / 60000)))
        self.watch_minutes.set(str(round(int(refresh.get("watchMs", 900000)) / 60000)))
        self.training_minutes.set(str(round(int(refresh.get("trainingMs", 300000)) / 60000)))
        self.training_symbols.set(str(training.get("symbolLimit", 3)))

        self._write(self.sessions_text, self.format_sessions(payload))
        self._write(self.budget_text, self.format_budget(payload))
        self._write(self.models_text, self.format_models(payload))
        self._write(self.pool_text, self.format_pools_and_results(payload))
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
            "range": (config.get("training") or {}).get("range") or "5d",
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
