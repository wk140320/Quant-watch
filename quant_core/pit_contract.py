"""Point-in-time timestamp and coverage contracts.

The training pipeline must distinguish the observation period, public release,
effective date, and local ingestion time.  Providers often expose only a date
or use different field names, so this module normalizes the fields once and
records which values were inferred from compatible legacy fields.
"""

from __future__ import annotations

from datetime import datetime, time, timezone
from email.utils import parsedate_to_datetime
from typing import Any


PIT_TIMESTAMP_SCHEMA = "pit-four-timestamps-v1"


def parse_pit_timestamp(value: Any, *, date_only: str = "start") -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if len(text) == 10:
        try:
            parsed = datetime.fromisoformat(text)
            clock = time(23, 59, 59) if date_only == "end" else time(0, 0, 0)
            return parsed.replace(hour=clock.hour, minute=clock.minute, second=clock.second, tzinfo=timezone.utc)
        except ValueError:
            return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        # Some legacy RSS/news rows use RFC-2822 timestamps (for example,
        # ``Fri, 17 Jul 2026 07:00:00 GMT``).  Parsing that standard format
        # preserves the provider time instead of turning a valid row into a
        # missing-timestamp quarantine.
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError, OverflowError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)


def _first(raw: dict[str, Any], *names: str) -> Any:
    for name in names:
        value = raw.get(name)
        if value not in (None, ""):
            return value
    return None


def normalize_pit_timestamps(raw: dict[str, Any]) -> dict[str, Any]:
    """Return normalized PIT fields without inventing a more precise time.

    Date-only observation/effective values are treated as the beginning of the
    day.  Date-only published/ingested values are treated as end-of-day.  The
    result exposes fallback fields so coverage reports can distinguish exact
    provider timestamps from conservative legacy normalization.
    """
    observation_raw = _first(raw, "observation_period_end", "observationPeriodEnd", "event_time", "eventTime", "date")
    published_raw = _first(raw, "published_at", "publishedAt", "available_at", "availableAt", "first_seen_at", "firstSeenAt", "date")
    effective_raw = _first(raw, "effective_at", "effectiveAt", "effective_date", "effectiveDate", "event_time", "eventTime", "date")
    ingested_raw = _first(raw, "ingested_at", "ingestedAt", "available_at", "availableAt", "first_seen_at", "firstSeenAt", "date")
    observation = parse_pit_timestamp(observation_raw, date_only="start")
    published = parse_pit_timestamp(published_raw, date_only="end")
    effective = parse_pit_timestamp(effective_raw, date_only="start")
    ingested = parse_pit_timestamp(ingested_raw, date_only="end")
    order_valid = bool(
        observation and published and effective and ingested
        and published <= ingested
        and observation <= published
        and effective <= ingested
    )
    exact_fields = {
        "observation_period_end": raw.get("observation_period_end") not in (None, "") or raw.get("observationPeriodEnd") not in (None, ""),
        "published_at": raw.get("published_at") not in (None, "") or raw.get("publishedAt") not in (None, ""),
        "effective_at": raw.get("effective_at") not in (None, "") or raw.get("effectiveAt") not in (None, ""),
        "ingested_at": raw.get("ingested_at") not in (None, "") or raw.get("ingestedAt") not in (None, ""),
    }
    return {
        "schema": PIT_TIMESTAMP_SCHEMA,
        "observation_period_end": observation.isoformat() if observation else None,
        "published_at": published.isoformat() if published else None,
        "effective_at": effective.isoformat() if effective else None,
        "ingested_at": ingested.isoformat() if ingested else None,
        "complete": all(value is not None for value in (observation, published, effective, ingested)),
        "orderValid": order_valid,
        "exactFields": exact_fields,
        "fallbackFields": [name for name, exact in exact_fields.items() if not exact],
        "fallbackUsed": not all(exact_fields.values()),
    }


def fundamental_coverage_layers(candidates: Any, feature_names: list[str]) -> dict[str, Any]:
    """Compute row-level source-to-actionable coverage without zero placeholders.

    Coverage is a count of distinct candidate rows, not a boolean saying that
    at least one row in the whole dataset had a value.  The previous contract
    mixed those two meanings, which made a single verified statement look like
    full symbol coverage downstream.
    """
    aliases = {
        "fundamentalRevenueGrowth": ("revenueGrowth", "or_yoy", "tr_yoy", "revenue_yoy"),
        "fundamentalProfitGrowth": ("profitGrowth", "earningsGrowth", "netprofit_yoy", "dt_netprofit_yoy"),
        "fundamentalRoe": ("roe", "roe_waa", "roe_yearly", "roe_yoy"),
        "fundamentalRoa": ("roa", "roa2_yearly"),
        "fundamentalGrossMargin": ("grossMargin", "gross_margin", "grossprofit_margin"),
        "fundamentalNetMargin": ("netMargin", "profitMargin", "netprofit_margin"),
        "fundamentalDebtToAssets": ("debtToAssets", "debt_to_assets"),
        "fundamentalCurrentRatio": ("currentRatio", "current_ratio"),
        "fundamentalCashRatio": ("cashRatio", "cash_ratio"),
        "fundamentalOperatingCashFlowGrowth": ("operatingCashFlowGrowth", "ocf_yoy"),
        "fundamentalAssetGrowth": ("assetGrowth", "assets_yoy"),
        "fundamentalEquityGrowth": ("equityGrowth", "eqt_yoy"),
        "fundamentalEpsGrowth": ("epsGrowth", "eps_yoy", "dt_eps_yoy"),
    }
    rows = []
    for raw in candidates if isinstance(candidates, list) else []:
        if not isinstance(raw, dict):
            continue
        values = raw.get("values") if isinstance(raw.get("values"), dict) else raw
        def values_for(name: str) -> list[Any]:
            return [values.get(name), *(values.get(alias) for alias in aliases.get(name, ()))]
        has_feature = any(any(value is not None for value in values_for(name)) for name in feature_names)
        if has_feature or str(raw.get("dataset") or "").lower() in {"fundamentals", "financial_disclosures"}:
            rows.append((raw, values, normalize_pit_timestamps(raw)))
    def numeric(value: Any) -> float | None:
        try:
            parsed = float(value)
            return parsed if parsed == parsed and abs(parsed) != float("inf") else None
        except (TypeError, ValueError):
            return None
    def row_has_numeric(values: dict[str, Any], *, non_zero_only: bool = False) -> bool:
        numbers = [
            numeric(value)
            for name in feature_names
            for value in [values.get(name), *(values.get(alias) for alias in aliases.get(name, ()))]
        ]
        return any(
            value is not None and (not non_zero_only or abs(value) > 1e-12)
            for value in numbers
        )

    source = len(rows)
    verified = sum(
        1 for raw, _, _ in rows
        if raw.get("historicalAvailabilityVerified") is True
        and raw.get("historicalAvailabilityUnverified") is not True
    )
    temporal_valid = sum(
        1 for _, _, contract in rows
        if contract.get("complete") and contract.get("orderValid")
    )
    non_null = sum(1 for _, values, _ in rows if row_has_numeric(values))
    non_zero = sum(1 for _, values, _ in rows if row_has_numeric(values, non_zero_only=True))
    actionable = sum(
        1 for raw, values, contract in rows
        if row_has_numeric(values, non_zero_only=True)
        and (
            raw.get("actionable") is True
            or (
                raw.get("historicalAvailabilityVerified") is True
                and raw.get("historicalAvailabilityUnverified") is not True
                and contract.get("complete")
                and contract.get("orderValid")
            )
        )
    )
    return {
        "source": source,
        "verified": verified,
        "temporalValid": temporal_valid,
        "nonNull": non_null,
        "nonZero": non_zero,
        "actionable": actionable,
        "rowCount": len(rows),
    }


__all__ = ["PIT_TIMESTAMP_SCHEMA", "fundamental_coverage_layers", "normalize_pit_timestamps", "parse_pit_timestamp"]
