from __future__ import annotations

import json
import sys
from pathlib import Path

# rqdata_provider historically runs inside worker.py as a script and imports
# sibling modules by their short names. Keep that import contract in the
# isolated helper without changing the production worker's module layout.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rqdata_provider import fetch_candles, status  # noqa: E402


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        operation = str(payload.get("operation") or "status")
        result = fetch_candles(payload) if operation in {"candles", "rqdata-candles"} else status(payload)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=True, default=str))
        return 0
    except Exception as exc:  # JSON is the helper's process boundary.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
