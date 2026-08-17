from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from data_lake import upsert_pit_batches


def _cn_code(symbol: str) -> str:
    code = "".join(character for character in str(symbol or "") if character.isdigit())[-6:]
    if len(code) != 6:
        raise ValueError(f"Invalid A-share symbol: {symbol}")
    return f"sh.{code}" if code.startswith(("5", "6", "9")) else f"sz.{code}"


def normalize_baostock_adjust_factors(
    symbol: str,
    fields: list[str],
    rows: list[list[str]],
    *,
    start_date: str,
    end_date: str,
) -> list[dict[str, Any]]:
    code = _cn_code(symbol).split(".", 1)[1]
    output: list[dict[str, Any]] = []
    for values in rows:
        row = dict(zip(fields, values))
        event_date = str(row.get("dividOperateDate") or row.get("diviDate") or row.get("date") or "")[:10]
        if len(event_date) != 10:
            continue
        output.append({
            "id": f"{code}:baostock-adjust:{event_date}",
            "event_time": event_date,
            "available_at": event_date,
            "first_seen_at": event_date,
            "revision": "historical-initial",
            "eventType": "adjustment-factor",
            "foreAdjustFactor": row.get("foreAdjustFactor"),
            "backAdjustFactor": row.get("backAdjustFactor"),
            "adjustFactor": row.get("adjustFactor"),
            "historicalAvailabilityVerified": True,
            "historicalAvailabilityVerificationMethod": "baostock-historical-adjust-factor-date",
        })
    # This is a data-completeness receipt, not a market event. It allows the
    # training audit to distinguish a verified no-action history from a source
    # that was never queried, without exposing the receipt as a model feature.
    output.append({
        "id": f"{code}:baostock-adjust-coverage:{start_date}:{end_date}",
        "event_time": start_date,
        "available_at": start_date,
        "first_seen_at": datetime.now(timezone.utc).isoformat(),
        "revision": "coverage-v1",
        "eventType": "coverage",
        "coverageStart": start_date,
        "coverageEnd": end_date,
        "historicalAvailabilityVerified": True,
        "historicalAvailabilityVerificationMethod": "baostock-historical-range-query",
    })
    return output


def backfill_baostock_corporate_actions(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import baostock as bs  # type: ignore
    except ImportError as exc:
        raise RuntimeError("baostock is required for A-share corporate-action PIT backfill") from exc

    symbols = list(dict.fromkeys(str(value) for value in payload.get("symbols") or [] if str(value).strip()))
    if not symbols:
        return {"available": False, "market": "CN", "checked": 0, "inserted": 0, "reason": "no-symbols"}
    start_date = str(payload.get("start_date") or payload.get("startDate") or "2000-01-01")[:10]
    end_date = str(payload.get("end_date") or payload.get("endDate") or date.today().isoformat())[:10]
    project_root = str(payload.get("project_root") or payload.get("projectRoot") or ".")
    state_path = Path(project_root) / ".cache" / "data-lake" / "baostock-corporate-action-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {"symbols": {}}
    state.setdefault("symbols", {})
    force = payload.get("force") is True
    refresh_days = max(1, int(payload.get("refresh_days") or payload.get("refreshDays") or 30))
    refresh_cutoff = datetime.now(timezone.utc) - timedelta(days=refresh_days)

    login = bs.login()
    if str(getattr(login, "error_code", "-1")) != "0":
        raise RuntimeError(f"BaoStock login failed: {getattr(login, 'error_msg', 'unknown error')}")
    batches: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    skipped = 0
    try:
        for symbol in symbols:
            code = _cn_code(symbol).split(".", 1)[1]
            last_checked = state["symbols"].get(code)
            if not force and last_checked:
                try:
                    if datetime.fromisoformat(str(last_checked).replace("Z", "+00:00")) >= refresh_cutoff:
                        skipped += 1
                        continue
                except ValueError:
                    pass
            provider_code = _cn_code(code)
            response = bs.query_adjust_factor(code=provider_code, start_date=start_date, end_date=end_date)
            if str(getattr(response, "error_code", "-1")) != "0":
                results.append({"symbol": code, "available": False, "error": getattr(response, "error_msg", "unknown error")})
                continue
            rows: list[list[str]] = []
            while response.next():
                rows.append(response.get_row_data())
            records = normalize_baostock_adjust_factors(
                code,
                list(response.fields),
                rows,
                start_date=start_date,
                end_date=end_date,
            )
            batches.append({
                "dataset": "corporate_actions",
                "market": "CN",
                "symbol": code,
                "source": "baostock-adjust-factor-pit",
                "records": records,
            })
            state["symbols"][code] = datetime.now(timezone.utc).isoformat()
            results.append({"symbol": code, "available": True, "events": max(0, len(records) - 1), "coverageReceipt": True})
    finally:
        bs.logout()

    inserted = 0
    saved_batches = 0
    batch_size = max(1, min(100, int(payload.get("batch_size") or payload.get("batchSize") or 40)))
    for offset in range(0, len(batches), batch_size):
        saved = upsert_pit_batches({"project_root": project_root, "batches": batches[offset:offset + batch_size]})
        inserted += int(saved.get("inserted") or 0)
        saved_batches += int(saved.get("batches") or 0)
    state["updatedAt"] = datetime.now(timezone.utc).isoformat()
    state["coverageStart"] = start_date
    state["coverageEnd"] = end_date
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "available": bool(batches or skipped),
        "market": "CN",
        "checked": len(results),
        "skippedFresh": skipped,
        "failed": sum(1 for row in results if not row.get("available")),
        "inserted": inserted,
        "batches": saved_batches,
        "coverageStart": start_date,
        "coverageEnd": end_date,
        "results": results,
    }
