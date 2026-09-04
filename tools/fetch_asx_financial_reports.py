#!/usr/bin/env python3
"""Fetch public ASX report PDFs and ingest only auditable PIT facts.

The source index is already in the local lake.  This tool only follows ASX
announcement PDF links, rate-limits requests, and passes the document through
the strict report adapter.  It never uses a filename as a report date and it
never upgrades a document that lacks an explicit period in its body.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import duckdb  # type: ignore

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "quant_core"))

from asx_report_ingest import extract_document_text, ingest_asx_financial_report  # noqa: E402


ASX_HOSTS = {"asx.com.au", "www.asx.com.au", "announcements.asx.com.au"}
REPORT_TERMS = ("annual report", "half-year", "half year", "preliminary final", "appendix 4e", "appendix 4d", "financial statements", "financial results")
MAX_BYTES = 15 * 1024 * 1024
ACCESS_TERMS_MARKERS = (
    b"access to this site",
    b"announcementterms.do",
    b"agree and proceed",
)


def _is_official_url(value: object) -> bool:
    try:
        parsed = urlparse(str(value or ""))
    except ValueError:
        return False
    return parsed.scheme == "https" and parsed.hostname in ASX_HOSTS


def _record_title(record: dict) -> str:
    return str(record.get("title") or record.get("headline") or "").strip()


def _publication_time(record: dict) -> str:
    return str(
        record.get("published_at")
        or record.get("publishedAt")
        or record.get("available_at")
        or record.get("availableAt")
        or ""
    ).strip()


def _report_url(record: dict) -> str:
    return str(
        record.get("url")
        or record.get("link")
        or record.get("source_url")
        or record.get("sourceUrl")
        or ""
    ).strip()


def _previously_failed_urls(path: Path) -> set[str]:
    """Return URLs that failed in the previous receipt.

    ASX can return an HTML block page for a PDF endpoint.  Retrying the same
    URL on every scheduler tick only creates traffic without adding evidence,
    so the caller must opt in with ``--retry-failed`` before reattempting it.
    """
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return set()
    failed: set[str] = set()
    for row in previous.get("results", []) if isinstance(previous, dict) else []:
        if not isinstance(row, dict) or row.get("status") != "rejected":
            continue
        reason = str(row.get("reason") or "")
        if reason in {"response-is-not-pdf", "access-terms-interstitial"} or reason.startswith("download-error:"):
            url = str(row.get("source_url") or "").strip()
            if url:
                failed.add(url)
    return failed


def _previous_receipt(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _priority(title: str) -> int:
    lowered = title.lower()
    if "annual report" in lowered:
        return 0
    if "half-year" in lowered or "half year" in lowered:
        return 1
    if "preliminary final" in lowered or "financial statements" in lowered:
        return 2
    if "appendix 4e" in lowered or "appendix 4d" in lowered:
        return 3
    return 4


def _missing_symbols(root: Path, symbols: str | None) -> set[str]:
    if symbols:
        return {item.strip().upper().removesuffix(".AX") for item in symbols.split(",") if item.strip()}
    snapshot_path = root / "replenishment-snapshot-asx.json"
    try:
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    missing = ((snapshot.get("snapshot") or {}).get("pit") or {}).get("datasets", {}).get("fundamentals", {}).get("missingSymbols", [])
    return {str(item).upper().removesuffix(".AX") for item in missing if str(item).strip()}


def _candidates(root: Path, missing: set[str], limit: int, excluded_urls: set[str] | None = None) -> list[dict]:
    paths = [str(path) for path in (root / "news" / "market=ASX").glob("exchange=*/symbol=*/data.parquet")]
    if not paths:
        return []
    connection = duckdb.connect()
    try:
        rows = connection.execute("select symbol, payload_json from read_parquet(?, union_by_name=true)", [paths]).fetchall()
    finally:
        connection.close()
    best: dict[tuple[str, str], dict] = {}
    for symbol, payload_json in rows:
        canonical = str(symbol or "").upper().removesuffix(".AX")
        if missing and canonical not in missing:
            continue
        try:
            record = json.loads(payload_json or "{}")
        except json.JSONDecodeError:
            continue
        title = _record_title(record)
        url = _report_url(record)
        if excluded_urls and url in excluded_urls:
            continue
        if not title or not _is_official_url(url) or not any(term in title.lower() for term in REPORT_TERMS):
            continue
        if record.get("historicalAvailabilityVerified") is not True or not _publication_time(record):
            continue
        candidate = {
            "symbol": canonical,
            "title": title,
            "source_url": url,
            "published_at": _publication_time(record),
            "report_period_end": record.get("report_period_end") or record.get("reportPeriodEnd"),
        }
        key = (canonical, url)
        previous = best.get(key)
        if previous is None or (_priority(title), candidate["published_at"]) < (_priority(previous["title"]), previous["published_at"]):
            best[key] = candidate
    by_symbol: dict[str, list[dict]] = {}
    for candidate in best.values():
        by_symbol.setdefault(candidate["symbol"], []).append(candidate)
    selected = []
    for symbol in sorted(by_symbol):
        selected.append(sorted(by_symbol[symbol], key=lambda row: (_priority(row["title"]), row["published_at"]))[0])
        if len(selected) >= limit:
            break
    return selected


def _download(url: str, destination: Path) -> tuple[Path | None, str | None, dict]:
    request = Request(url, headers={"User-Agent": "SafeCapitAI-public-asx-report-ingest/1.0"})
    try:
        with urlopen(request, timeout=30) as response:  # nosec B310 - URL is allow-listed before this call
            body = response.read(MAX_BYTES + 1)
            content_type = str(response.headers.get("Content-Type") or "").lower()
            transport = {
                "httpStatus": int(getattr(response, "status", 0) or 0),
                "contentType": content_type,
                "contentLength": response.headers.get("Content-Length"),
                "finalUrl": str(response.geturl() or url),
                "bodyBytes": len(body),
                "bodyPrefixHex": body[:16].hex(),
                "pdfMagic": body.startswith(b"%PDF"),
            }
    except Exception as exc:  # noqa: BLE001 - preserve per-document fetch evidence
        return None, f"download-error:{type(exc).__name__}:{exc}", {
            "errorType": type(exc).__name__,
            "error": str(exc),
        }
    if len(body) > MAX_BYTES:
        return None, "download-too-large", transport
    body_probe = body[:65536].lower()
    if not body.startswith(b"%PDF") and (
        all(marker in body_probe for marker in ACCESS_TERMS_MARKERS[:2])
        or ACCESS_TERMS_MARKERS[2] in body_probe
    ):
        transport["accessTermsPage"] = True
        return None, "access-terms-interstitial", transport
    if not body.startswith(b"%PDF"):
        transport["accessTermsPage"] = False
        return None, "response-is-not-pdf", transport
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    return destination, None, transport


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(ROOT / ".cache" / "data-lake"))
    parser.add_argument("--symbols", default=None, help="comma-separated ASX codes; defaults to missing fundamental symbols")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--interval-seconds", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="explicitly retry URLs recorded as failed in the previous receipt",
    )
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "asx-report-fetch.json")
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    limit = max(1, min(100, int(args.limit)))
    previous_receipt = _previous_receipt(args.output)
    previous_failed = set() if args.retry_failed else _previously_failed_urls(args.output)
    candidates = _candidates(root, _missing_symbols(root, args.symbols), limit, previous_failed)
    archive = root.parent / "asx-report-archive"
    results = []
    for index, candidate in enumerate(candidates):
        digest = hashlib.sha256(candidate["source_url"].encode("utf-8")).hexdigest()[:24]
        path = archive / f"{candidate['symbol']}-{digest}.pdf"
        item = {**candidate, "path": str(path), "status": "planned"}
        if not args.dry_run:
            document, error, transport = _download(candidate["source_url"], path)
            item["transport"] = transport
            if error:
                item.update({"status": "rejected", "reason": error})
            else:
                text = extract_document_text(document)
                item["extractedCharacters"] = len(text)
                result = ingest_asx_financial_report({
                    "root": str(root),
                    "symbol": candidate["symbol"],
                    "document_path": str(document),
                    "source_url": candidate["source_url"],
                    "report_period_end": candidate["report_period_end"],
                    "published_at": candidate["published_at"],
                    "report_title": candidate["title"],
                })
                item.update({"status": "accepted" if result.get("accepted") else "rejected", "ingest": result})
            if index + 1 < len(candidates):
                time.sleep(max(0.0, float(args.interval_seconds)))
        results.append(item)
    prior_results = previous_receipt.get("results") if isinstance(previous_receipt.get("results"), list) else []
    cumulative_results = [*prior_results, *results]
    summary = {
        "schema": "asx-public-report-fetch-v1",
        "root": str(root),
        "output": str(args.output.resolve()),
        "candidateCount": len(candidates),
        "accepted": sum(row.get("status") == "accepted" for row in results),
        "rejected": sum(row.get("status") == "rejected" for row in results),
        "cumulativeCandidateCount": len(cumulative_results),
        "cumulativeAccepted": sum(row.get("status") == "accepted" for row in cumulative_results),
        "cumulativeRejected": sum(row.get("status") == "rejected" for row in cumulative_results),
        "dryRun": bool(args.dry_run),
        "retryFailed": bool(args.retry_failed),
        "skippedPreviouslyRejected": len(previous_failed),
        "policy": "Only allow-listed ASX PDFs with explicit publication time, body-stated period, content hash, and labelled facts enter strict PIT.",
        "results": cumulative_results,
        "lastBatchResults": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ("candidateCount", "accepted", "rejected", "dryRun", "output")}, ensure_ascii=False))
    return 0 if summary["rejected"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
