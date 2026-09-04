"""Conservative ASX financial-report extraction for the local PIT lake.

The ASX announcement feed proves that a document was published, but it does
not by itself provide numeric financial facts.  This module accepts a locally
available official report and a publication timestamp from the official
announcement record, then extracts only clearly labelled statement lines.  A
report period may be read from an explicit period statement in the document
body, but is never inferred from a filename or from ingestion time.  Unverified
documents never become strict PIT.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    from data_lake import upsert_pit_batches
except ImportError:  # pragma: no cover - package import fallback
    from .data_lake import upsert_pit_batches


ASX_OFFICIAL_HOSTS = {"asx.com.au", "www.asx.com.au", "announcements.asx.com.au"}
REPORT_MARKERS = re.compile(
    r"annual report|half[- ]year|half[- ]yearly|financial statements?|"
    r"preliminary final|appendix 4e|appendix 4d|quarterly (?:activities|cash flow)",
    re.IGNORECASE,
)
NUMBER = re.compile(
    r"(?<![A-Za-z0-9.])\(?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?\)?(?![A-Za-z0-9.])"
)
METRIC_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("revenue", re.compile(
        r"(?:^|\b)(?:total\s+)?revenue(?!\s+losses?)(?:\s+from\s+ordinary\s+activities)?\b",
        re.I,
    )),
    ("net_income", re.compile(
        r"(?:^|\b)(?:net\s+)?(?:profit|loss)(?:\s*/\s*\(?\s*(?:profit|loss)\s*\)?)?\s+"
        r"(?:after\s+(?:income\s+)?tax|for\s+the\s+(?:year|period)(?:\s+ended)?(?:\s+after\s+tax)?)\b|"
        r"\bNPAT\b",
        re.I,
    )),
    ("gross_profit", re.compile(r"(?:^|\b)gross\s+profit\b", re.I)),
    ("ebitda", re.compile(r"(?:^|\b)EBITDA\b", re.I)),
    ("assets", re.compile(r"(?:^|\b)total\s+assets\b", re.I)),
    ("liabilities", re.compile(r"(?:^|\b)total\s+liabilities\b", re.I)),
    ("equity", re.compile(
        r"(?:^|\b)(?:total\s+)?(?:shareholders'?\s+)?equity\b(?![-\s]+(?:based|security|securities|instrument))",
        re.I,
    )),
    ("cash", re.compile(r"(?:^|\b)(?:cash\s+and\s+cash\s+equivalents|cash\s+and\s+equivalents)\b", re.I)),
    ("cfo", re.compile(r"net\s+cash\s+(?:provided\s+by|from)\s+operating\s+activities|operating\s+cash\s+flow", re.I)),
    ("capex", re.compile(
        r"payments?\s+for\s+(?:property,?\s*plant|plant)\s+and\s+equipment|"
        r"capital\s+expenditures?|\bcapex\b",
        re.I,
    )),
    ("eps", re.compile(
        r"(?:^|\b)(?:(?:(?:basic|diluted)\s+)?(?:earnings|loss)\s+per\s+share|"
        r"(?:basic|diluted)\s+EPS)\b",
        re.I,
    )),
)
AMOUNT_METRICS = {"revenue", "net_income", "gross_profit", "ebitda", "assets", "liabilities", "equity", "cash", "cfo", "capex"}
PERIOD_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?:year|period|six\s+months?|half[- ]year)\s+(?:ended|ending)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})", re.I),
    re.compile(r"(?:as\s+of|as\s+at)\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})", re.I),
    re.compile(r"(?:for\s+the\s+)?year\s+ended\s+(\d{1,2}[/-]\d{1,2}[/-]\d{4})", re.I),
    re.compile(r"(?:year|period)\s+ended\s+(\d{4}-\d{2}-\d{2})", re.I),
)
PERIOD_FORMATS = ("%d %B %Y", "%d %b %Y", "%B %d, %Y", "%b %d, %Y", "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d")
DOCUMENT_SYMBOL_PATTERN = re.compile(r"\bASX\s+code\s*[:\-]?\s*([A-Z0-9]{1,12})\b", re.I)


def _iso(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _official_asx_url(value: Any) -> bool:
    try:
        parsed = urlparse(str(value or "").strip())
    except ValueError:
        return False
    return parsed.scheme in {"https", "http"} and parsed.hostname in ASX_OFFICIAL_HOSTS


def _document_hash(path: Path | None, text: str, supplied: Any = None) -> str:
    if supplied:
        return str(supplied).strip().lower()
    if path is not None and path.is_file():
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _unit(text: str, metric: str | None = None) -> tuple[str, float]:
    if metric == "eps":
        return "reported", 1.0
    lowered = text.lower()
    if re.search(r"\bbillion\b|\bbn\b|\$\s*b\b", lowered):
        return "billion", 1_000_000_000.0
    if re.search(r"\bmillion\b|\bmillions\b|\bmn\b|\bmm\b|\$\s*m\b", lowered):
        return "million", 1_000_000.0
    if re.search(r"\bthousand\b|\bthousands\b|\b000s\b|\$\s*k\b|\$\s*['’]?000\b", lowered):
        return "thousand", 1_000.0
    return "reported", 1.0


def _numbers(line: str) -> list[float]:
    values: list[float] = []
    for token in NUMBER.findall(line):
        if token.endswith("%"):
            continue
        normalized = token.replace(",", "").replace(" ", "")
        negative = normalized.startswith("(") and normalized.endswith(")")
        normalized = normalized.strip("()")
        try:
            value = float(normalized)
        except ValueError:
            continue
        if negative:
            value = -value
        values.append(value)
    return values


def _drop_statement_note_reference(tail: str, values: list[float], metric: str) -> list[float]:
    """Remove a leading statement-note number from a row such as ``Cash 5 100 90``.

    PDF text extraction commonly places a note reference between the label and
    the two reported values.  Only drop it when the remaining row looks like
    two statement columns; otherwise keep every number and let the candidate
    fail closed rather than guessing.
    """
    if metric not in AMOUNT_METRICS | {"eps"} or len(values) < 3:
        return values
    first = re.match(r"\s*(?:\([^)]*\)\s*)?(\d{1,2})(?=\s|$)", tail)
    if not first or not 0 < values[0] < 100:
        return values
    remainder = tail[first.end():]
    if len(_numbers(remainder)) >= 2:
        return values[1:]
    return values


def _value_tail(line: str, match: re.Match[str]) -> str:
    """Keep only values after the label and remove an inline report date."""
    tail = line[match.end():]
    date_match = re.search(
        r"\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b",
        tail,
    )
    if date_match and re.search(r"\b(?:year|period|ended|ending|as\s+at)\b", tail, re.I):
        tail = tail[date_match.end():]
    return tail


def _extract_metrics(text: str) -> tuple[dict[str, Any], list[str]]:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    extracted: dict[str, Any] = {}
    warnings: list[str] = []
    for metric, pattern in METRIC_PATTERNS:
        candidates: list[tuple[tuple[int, int, int, int], str, list[float], str]] = []
        for index, line in enumerate(lines):
            match = pattern.search(line)
            if not match:
                continue
            # Narrative text often mentions EBITDA alongside dates and
            # thresholds; a statement row puts its values immediately after
            # the label.  Require that shape for this especially ambiguous
            # metric rather than turning prose into a financial fact.
            if metric == "ebitda" and not re.match(r"\s*(?:\([^)]*\)\s*)?(?:[$€£]?\s*[+-]?\(?\d)", line[match.end():]):
                continue
            # EPS is often repeated in narrative form with a year in
            # parentheses. Only use the labelled statement row.
            if metric == "eps" and re.search(r"\b(?:was|were|is|are|calculated|based)\b", line, re.I):
                continue
            if metric in {"revenue", "net_income"} and re.search(
                r"\b(?:was|were|almost|up\s+from|down|attributable|previous\s+year)\b",
                line,
                re.I,
            ):
                continue
            # A PDF can place explanatory prose before a valid label.  Keep
            # labels near the start of a normalized row and reject deep
            # in-sentence mentions that can capture unrelated dates.
            if match.start() > 24:
                continue
            tail = _value_tail(line, match)
            values = _numbers(tail)
            values = _drop_statement_note_reference(tail, values, metric)
            if not values:
                continue
            context = " ".join(lines[max(0, index - 2):index + 1])
            table_hint = int(bool(re.search(r"statement|consolidated|comparative|current year|prior year", context, re.I)))
            narrative_hint = int(bool(re.search(r"increase|decrease|grew|declined|guidance|outlook", line, re.I)))
            score = (int(len(values) == 2), table_hint, -narrative_hint, -abs(len(values) - 2))
            candidates.append((score, line, values, context))
        if not candidates:
            continue
        _, line, values, context = max(candidates, key=lambda item: item[0])
        unit_name, scale = _unit(context, metric)
        current = values[0] * scale
        comparative = values[1] * scale if len(values) > 1 else None
        item = {
            "current": current,
            "comparative": comparative,
            "unit": unit_name,
            "scale": scale,
            "sourceLine": line[:400],
            "confidence": 0.9 if len(values) == 2 else 0.76 if len(values) == 1 else 0.55,
        }
        extracted[metric] = item
        if len(values) > 2:
            warnings.append(f"{metric}:more-than-two-numeric-columns:first-two-used")
    for metric, _ in METRIC_PATTERNS:
        if any(pattern.search(line) for line in lines for name, pattern in METRIC_PATTERNS if name == metric) and metric not in extracted:
            warnings.append(f"{metric}:label-without-usable-number")
    return extracted, warnings


def _growth(item: dict[str, Any] | None) -> float | None:
    if not item or item.get("comparative") in (None, 0):
        return None
    return (float(item["current"]) - float(item["comparative"])) / abs(float(item["comparative"]))


def _extract_period_end(text: str) -> str | None:
    """Return a date only when the report body states an explicit period end."""
    for pattern in PERIOD_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        candidate = match.group(1).strip()
        for date_format in PERIOD_FORMATS:
            try:
                return datetime.strptime(candidate, date_format).replace(tzinfo=timezone.utc).isoformat()
            except ValueError:
                continue
    return None


def _extract_document_symbol(text: str) -> str | None:
    symbols = _extract_document_symbols(text)
    return symbols[0] if symbols else None


def _extract_document_symbols(text: str) -> list[str]:
    """Find issuer-code declarations without treating unrelated ASX mentions as identity."""
    symbols: list[str] = []
    listing_pattern = re.compile(
        r"\bshares\s*\(([A-Z0-9]{1,12})\)\s+are\s+quoted\s+on\s+the\s+Australian\s+Securities\s+Exchange",
        re.I,
    )
    symbols.extend(match.group(1).strip().upper() for match in listing_pattern.finditer(text))
    exchange_code_pattern = re.compile(
        r"\blisted\s+on\s+(?:the\s+)?Australian\s+Securities\s+Exchange(?:\s*\([^)]*\))?\s+under\s+the\s+code\s+([A-Z0-9]{1,12})\b",
        re.I,
    )
    symbols.extend(match.group(1).strip().upper() for match in exchange_code_pattern.finditer(text))
    trade_as_pattern = re.compile(
        r"\b(?:trade|traded)\s+on\s+the\s+(?:Australian\s+Securities\s+Exchange(?:\s*\([^)]*\))?|ASX)\s+as\s+([A-Z0-9]{1,12})\b",
        re.I,
    )
    symbols.extend(match.group(1).strip().upper() for match in trade_as_pattern.finditer(text))
    symbols.extend(match.group(1).strip().upper() for match in DOCUMENT_SYMBOL_PATTERN.finditer(text))
    return list(dict.fromkeys(symbols))


def parse_asx_financial_report(
    symbol: str,
    text: str,
    *,
    source_url: str,
    report_period_end: str | None,
    published_at: str,
    document_path: str | Path | None = None,
    document_sha256: str | None = None,
    report_title: str = "",
    ingestion_time: str | None = None,
) -> dict[str, Any]:
    """Parse one report and return a strict-PIT candidate or a rejection.

    The caller must provide the publication timestamp from the official ASX
    announcement record.  The report period may be supplied by the caller or
    extracted from an explicit period statement in the report body.  A report
    without that timestamp, official URL, hash, report-period end, or a labelled
    numeric field is rejected before lake insertion.
    """
    canonical_symbol = str(symbol or "").strip().upper().removesuffix(".AX")
    path = Path(document_path).expanduser() if document_path else None
    text = str(text or "")
    period = _iso(report_period_end) or _extract_period_end(text)
    published = _iso(published_at)
    ingested = _iso(ingestion_time) or datetime.now(timezone.utc).isoformat()
    digest = _document_hash(path, text, document_sha256)
    metrics, warnings = _extract_metrics(text)
    marker_ok = bool(REPORT_MARKERS.search(f"{report_title} {text[:4000]}"))
    document_symbols = _extract_document_symbols(text)
    document_symbol = document_symbols[0] if document_symbols else None
    period_dt = datetime.fromisoformat(period) if period else None
    published_dt = datetime.fromisoformat(published) if published else None
    required = {
        "symbol": bool(re.fullmatch(r"[A-Z0-9-]{1,12}", canonical_symbol)),
        "officialUrl": _official_asx_url(source_url),
        "periodEnd": period is not None,
        "publishedAt": published is not None,
        "documentHash": bool(re.fullmatch(r"[0-9a-f]{64}", digest or "")),
        "reportMarker": marker_ok,
        "numericField": bool(metrics),
        "periodBeforePublished": bool(period_dt and published_dt and period_dt <= published_dt),
        "symbolMatchesDocument": document_symbol is None or canonical_symbol in document_symbols,
    }
    if not all(required.values()):
        return {
            "accepted": False,
            "strictPit": False,
            "market": "ASX",
            "symbol": canonical_symbol,
            "required": required,
            "documentSymbol": document_symbol,
            "warnings": warnings,
            "reason": "asx-report-metadata-or-labelled-value-missing",
            "metrics": metrics,
        }

    if not _iso(report_period_end):
        warnings.append("periodEnd:extracted-from-explicit-report-body")

    values: dict[str, Any] = {
        "sourceQuality": 1.0,
        "earningsEvent": 1.0,
        "reportDocumentHash": digest,
        "reportPeriodEnd": period,
    }
    for name, item in metrics.items():
        canonical_name = {
            "net_income": "netIncome",
            "cash": "cashAndEquivalents",
            "cfo": "operatingCashFlow",
            "capex": "capitalExpenditure",
            "eps": "dilutedEps",
        }.get(name, name)
        # Keep the parser's raw metric names for backwards-compatible audit
        # consumers, while exposing canonical names to the feature layer.
        values[name] = item["current"]
        values[canonical_name] = item["current"]
        if name == "eps":
            values["eps"] = item["current"]
        if name == "net_income":
            values["profit"] = item["current"]
        values[f"{name}Comparative"] = item["comparative"]
        growth = _growth(item)
        if growth is not None and name in {"revenue", "net_income", "cfo", "gross_profit", "ebitda"}:
            values[f"{name}Growth"] = growth
    values["revenueGrowth"] = values.get("revenueGrowth")
    values["profitGrowth"] = values.get("net_incomeGrowth")
    values["operatingCashFlowGrowth"] = values.get("cfoGrowth")
    return {
        "accepted": True,
        "strictPit": True,
        "market": "ASX",
        "symbol": canonical_symbol,
        "documentSymbol": document_symbol,
        "source": "asx-official-report-pdf",
        "source_url": source_url,
        "id": f"asx-report:{canonical_symbol}:{period}:{digest[:24]}",
        "event_time": period,
        "observation_period_end": period,
        "reportDate": period,
        "filingDate": published,
        "published_at": published,
        "available_at": published,
        "first_seen_at": published,
        "ingested_at": ingested,
        "revision": f"asx-pdf-{digest[:16]}",
        "historicalAvailabilityVerified": True,
        "historicalAvailabilityUnverified": False,
        "historicalAvailabilityVerificationMethod": "asx-official-report-url-and-publication-time",
        "documentSha256": digest,
        "documentPath": str(path) if path else None,
        "reportTitle": report_title,
        "financialFactCount": len(metrics),
        "values": values,
        "extraction": metrics,
        "warnings": warnings,
    }


def ingest_asx_financial_report(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract one local report and atomically upsert both PIT layers.

    The disclosure layer keeps the report event.  The fundamentals layer keeps
    the same document-linked numeric facts.  They share the content hash but
    remain separate datasets so coverage cannot confuse an event with a fact.
    """
    path = Path(str(payload.get("document_path") or payload.get("documentPath") or "")).expanduser() if payload.get("document_path") or payload.get("documentPath") else None
    text = str(payload.get("text") or "")
    if not text and path and path.suffix.lower() in {".txt", ".text", ".csv"}:
        text = path.read_text(encoding="utf-8", errors="replace")
    if not text and path and path.suffix.lower() == ".pdf":
        text = extract_document_text(path)
    candidate = parse_asx_financial_report(
        str(payload.get("symbol") or ""),
        text,
        source_url=str(payload.get("source_url") or payload.get("sourceUrl") or ""),
        report_period_end=str(payload.get("report_period_end") or payload.get("reportPeriodEnd") or ""),
        published_at=str(payload.get("published_at") or payload.get("publishedAt") or ""),
        document_path=path,
        document_sha256=payload.get("document_sha256") or payload.get("documentSha256"),
        report_title=str(payload.get("report_title") or payload.get("reportTitle") or ""),
        ingestion_time=payload.get("ingestion_time") or payload.get("ingestionTime"),
    )
    if not candidate.get("accepted"):
        return candidate
    saved = upsert_pit_batches({
        "root": payload.get("root") or payload.get("project_root") or payload.get("projectRoot"),
        "batches": [{
            "dataset": "financial_disclosures",
            "market": "ASX",
            "symbol": candidate["symbol"],
            "source": candidate["source"],
            "records": [candidate],
        }],
    })
    saved_fundamentals = upsert_pit_batches({
        "root": payload.get("root") or payload.get("project_root") or payload.get("projectRoot"),
        "batches": [{
            "dataset": "fundamentals",
            "market": "ASX",
            "symbol": candidate["symbol"],
            "source": "asx-official-report-pit",
            "records": [candidate],
        }],
    })
    return {
        **candidate,
        "saved": saved,
        "savedFundamentals": saved_fundamentals,
        "savedDatasets": ["financial_disclosures", "fundamentals"],
    }


def extract_document_text(path: Path) -> str:
    """Extract PDF text using an installed parser, without downloading anything."""
    try:
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(str(path))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except ImportError:
        pass
    try:
        import pdfplumber  # type: ignore
        with pdfplumber.open(str(path)) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)
    except ImportError:
        pass
    try:
        result = subprocess.run(["pdftotext", "-layout", str(path), "-"], check=True, capture_output=True, text=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("ASX PDF extraction requires pypdf, pdfplumber, or pdftotext") from exc
    return result.stdout


__all__ = ["extract_document_text", "ingest_asx_financial_report", "parse_asx_financial_report"]
