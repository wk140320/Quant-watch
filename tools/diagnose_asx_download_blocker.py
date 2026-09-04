#!/usr/bin/env python3
"""Write an evidence-backed diagnosis for repeated ASX report fetch failures."""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
FETCH_NAME = "asx-report-fetch-20260901.json"
ARCHIVE = ROOT / ".cache" / "asx-report-archive"


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def main() -> int:
    fetch_path = REPORTS / FETCH_NAME
    fetch = read_json(fetch_path)
    probe = read_json(REPORTS / "asx-response-probe-20260903.json")
    index_probe = read_json(REPORTS / "asx-announcement-index-probe-20260903.json")
    route_matrix = read_json(REPORTS / "asx-report-access-route-matrix-20260903.json")
    results = fetch.get("results") if isinstance(fetch.get("results"), list) else []
    reasons = Counter(str(row.get("reason") or "unknown") for row in results if isinstance(row, dict))
    official_pdf_count = 0
    if ARCHIVE.exists():
        official_pdf_count = sum(1 for path in ARCHIVE.glob("*.pdf") if path.is_file())

    diagnosis = {
        "schema": "asx-download-blocker-diagnosis-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceReceipt": str(fetch_path.resolve()),
        "observed": {
            "cumulativeAttempts": len(results),
            "cumulativeAccepted": int(fetch.get("cumulativeAccepted") or 0),
            "cumulativeRejected": int(fetch.get("cumulativeRejected") or 0),
            "lastBatchCandidates": int(fetch.get("candidateCount") or 0),
            "lastBatchAccepted": int(fetch.get("accepted") or 0),
            "lastBatchRejected": int(fetch.get("rejected") or 0),
            "rejectionReasons": dict(reasons),
            "localVerifiedPdfArchiveCount": official_pdf_count,
        },
        "strictPitImpact": {
            "newFinancialDisclosureRows": 0,
            "newFundamentalRows": 0,
            "coveredSymbolsChanged": False,
            "safeToStartResearchOof": False,
        },
        "primaryCause": {
            "category": "source_access_interstitial_plus_transport_instability",
            "finding": "The latest five Python fetches failed at DNS resolution, while an independent single GET probe reached the same ASX endpoint and received an HTML access-terms interstitial. Earlier attempts also included non-PDF responses.",
            "confidence": "high_for_mixed_failure_modes; not_evidence_that_ASX_is_permanently_unavailable",
            "notParserFailure": True,
            "notDataSynthesis": True,
        },
        "singleRequestProbe": {
            "evidence": str((REPORTS / "asx-response-probe-20260903.json").resolve()),
            "httpStatus": probe.get("response", {}).get("httpStatus"),
            "contentType": probe.get("response", {}).get("contentType"),
            "isPdf": probe.get("bodyClassification", {}).get("isPdf"),
            "isAccessTermsPage": probe.get("bodyClassification", {}).get("containsAccessTermsPage"),
        },
        "officialIndexProbe": {
            "evidence": str((REPORTS / "asx-announcement-index-probe-20260903.json").resolve()),
            "httpStatus": index_probe.get("response", {}).get("httpStatus"),
            "contentType": index_probe.get("response", {}).get("contentType"),
            "metadataIndexReachable": index_probe.get("conclusion", {}).get("metadataIndexReachable"),
            "pdfEndpointVerified": index_probe.get("conclusion", {}).get("pdfEndpointVerified"),
        },
        "routeMatrix": {
            "evidence": str((REPORTS / "asx-report-access-route-matrix-20260903.json").resolve()),
            "methodWasEntirelyWrong": route_matrix.get("decision", {}).get("methodWasEntirelyWrong"),
            "remainingExternalBlocker": route_matrix.get("decision", {}).get("remainingExternalBlocker"),
            "routesValidated": sum(
                1 for row in route_matrix.get("routes", [])
                if isinstance(row, dict) and str(row.get("status", "")).startswith("validated")
            ),
        },
        "secondaryChecks": {
            "localPdfAvailableForFallback": official_pdf_count > 0,
            "existingReceiptContainsAcceptedStrictPitFact": int(fetch.get("cumulativeAccepted") or 0) > 0,
            "trainingMayStart": False,
            "productionMayStart": False,
        },
        "actionTaken": [
            "Do not write HTML, 503, DNS-error, or unparsed content into strict PIT.",
            "Treat a reachable announcement index as metadata evidence only; require PDF magic bytes before archive or PIT ingestion.",
            "Do not run Gate03, formal OOF, Champion update, or longTradeGate activation.",
            "Do not retry the same URLs before the six-hour cooldown.",
        ],
        "nextAction": "After cooldown, select up to five previously untried official ASX HTTPS candidates. If no untried candidate exists, keep low-frequency retries only and wait for a new local official PDF or restored transport; do not claim the ASX strict-PIT precondition is met.",
    }
    target = REPORTS / "asx-download-blocker-diagnosis-20260903.json"
    temporary = REPORTS / f".{target.name}.tmp"
    temporary.write_text(json.dumps(diagnosis, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    print(json.dumps({
        "path": str(target.resolve()),
        "primaryCause": diagnosis["primaryCause"]["category"],
        "cumulativeAccepted": diagnosis["observed"]["cumulativeAccepted"],
        "cumulativeRejected": diagnosis["observed"]["cumulativeRejected"],
        "trainingMayStart": diagnosis["secondaryChecks"]["trainingMayStart"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
