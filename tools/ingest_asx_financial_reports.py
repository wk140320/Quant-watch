#!/usr/bin/env python3
"""Ingest locally available, officially dated ASX reports into the PIT lake.

Manifest format: a JSON array or ``{"reports": [...]}``, where each item has
symbol, path/text_path, source_url, report_period_end, and published_at.  The
tool does not fetch URLs or invent dates; rejected items are written to the
receipt so missing metadata is visible.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from asx_report_ingest import ingest_asx_financial_report  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--root", default=None, help="data lake root")
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "asx-report-ingest.json")
    args = parser.parse_args()
    document = json.loads(args.manifest.read_text(encoding="utf-8"))
    reports = document.get("reports", []) if isinstance(document, dict) else document
    if not isinstance(reports, list):
        raise SystemExit("manifest must be a list or an object with a reports list")
    results = []
    for item in reports:
        if not isinstance(item, dict):
            results.append({"accepted": False, "reason": "manifest-item-not-object"})
            continue
        payload = dict(item)
        if not payload.get("document_path") and not payload.get("documentPath"):
            payload["document_path"] = item.get("path") or item.get("text_path")
        if args.root:
            payload["root"] = args.root
        try:
            results.append(ingest_asx_financial_report(payload))
        except Exception as exc:  # noqa: BLE001 - preserve per-document progress
            results.append({"accepted": False, "reason": "parser-error", "error": str(exc), "symbol": item.get("symbol")})
    summary = {
        "schema": "asx-financial-report-ingest-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "manifest": str(args.manifest.resolve()),
        "total": len(results),
        "accepted": sum(bool(row.get("accepted")) for row in results),
        "rejected": sum(not bool(row.get("accepted")) for row in results),
        "insertedDisclosures": sum(int(((row.get("saved") or {}).get("inserted") or 0)) for row in results if isinstance(row, dict)),
        "insertedFundamentals": sum(int(((row.get("savedFundamentals") or {}).get("inserted") or 0)) for row in results if isinstance(row, dict)),
        "policy": "Only official ASX URL, explicit publication time, report period, content hash, and labelled numeric values can enter strict PIT.",
        "results": results,
    }
    summary["inserted"] = summary["insertedDisclosures"] + summary["insertedFundamentals"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(json.dumps({"report": str(args.output.resolve()), **{key: summary[key] for key in ("total", "accepted", "rejected", "inserted")}}, ensure_ascii=False))
    return 0 if summary["rejected"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
