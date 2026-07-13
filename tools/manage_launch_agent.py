#!/usr/bin/env python3
"""Install or remove the local Global Quant Watch backend LaunchAgent."""

from __future__ import annotations

import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LABEL = "com.globalquantwatch.backend"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG_DIR = ROOT / ".cache" / "backend-monitor"
NODE_CANDIDATES = (
    Path("/Users/wukai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"),
    Path("/opt/homebrew/bin/node"),
    Path("/usr/local/bin/node"),
)


def node_binary() -> Path:
    for candidate in NODE_CANDIDATES:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError("Node.js executable was not found.")


def domain() -> str:
    return f"gui/{os.getuid()}"


def run_launchctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["/bin/launchctl", *args], capture_output=True, text=True, check=False)


def installed() -> bool:
    return PLIST_PATH.exists()


def install() -> dict:
    node = node_binary()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [str(node), str(ROOT / "server.mjs")],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 12,
        "ProcessType": "Background",
        "EnvironmentVariables": {
            "PATH": f"{node.parent}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
            "PORT": "8787",
            "HOST": "127.0.0.1",
        },
        "StandardOutPath": str(LOG_DIR / "launch-agent.stdout.log"),
        "StandardErrorPath": str(LOG_DIR / "launch-agent.stderr.log"),
    }
    with PLIST_PATH.open("wb") as handle:
        plistlib.dump(payload, handle, sort_keys=True)
    run_launchctl("bootout", domain(), str(PLIST_PATH))
    result = run_launchctl("bootstrap", domain(), str(PLIST_PATH))
    if result.returncode != 0 and "already bootstrapped" not in (result.stderr or "").lower():
        raise RuntimeError((result.stderr or result.stdout or "launchctl bootstrap failed").strip())
    run_launchctl("enable", f"{domain()}/{LABEL}")
    run_launchctl("kickstart", "-k", f"{domain()}/{LABEL}")
    return {"ok": True, "installed": True, "label": LABEL, "path": str(PLIST_PATH), "node": str(node)}


def uninstall() -> dict:
    if PLIST_PATH.exists():
        run_launchctl("bootout", domain(), str(PLIST_PATH))
        PLIST_PATH.unlink(missing_ok=True)
    return {"ok": True, "installed": False, "label": LABEL, "path": str(PLIST_PATH)}


def main() -> None:
    action = (sys.argv[1] if len(sys.argv) > 1 else "status").lower()
    if action == "install":
        result = install()
    elif action == "uninstall":
        result = uninstall()
    elif action == "status":
        result = {"ok": True, "installed": installed(), "label": LABEL, "path": str(PLIST_PATH)}
    else:
        raise SystemExit("Usage: manage_launch_agent.py [install|uninstall|status]")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
