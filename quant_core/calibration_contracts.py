"""Time-ordered probability calibration and abstention contracts.

The functions in this module are intentionally small and dependency-free. They
are used by research jobs before a candidate can enter the production gate.
Calibration never reads the final lockbox, and sparse buckets remain an
explicit failure rather than being smoothed into a passing result.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Iterable


CALIBRATION_CONTRACT_SCHEMA = "calibration-contract-v2-time-ordered"


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _clamp(value: Any, low: float = 0.001, high: float = 0.999) -> float:
    return max(low, min(high, _number(value, 0.5)))


def _logit(value: Any) -> float:
    probability = _clamp(value)
    return math.log(probability / (1.0 - probability))


def _sigmoid(value: float) -> float:
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-min(60.0, value)))
    exp_value = math.exp(max(-60.0, value))
    return exp_value / (1.0 + exp_value)


def chronological_calibration_split(
    rows: Iterable[dict[str, Any]],
    *,
    fit_pct: float = 0.55,
    calibration_pct: float = 0.20,
    selection_pct: float = 0.15,
    purge_days: int = 5,
    embargo_days: int = 5,
) -> dict[str, Any]:
    """Split rows by signal date into fit/calibration/selection/lockbox.

    The lockbox is only described by membership; callers must not pass its
    rows to any selection function. Purge and embargo rows are returned as an
    explicit excluded set, making accidental reuse observable.
    """
    materialized = [row for row in rows if isinstance(row, dict)]
    dates = sorted({str(row.get("date") or row.get("signalDate") or "")[:10] for row in materialized if row.get("date") or row.get("signalDate")})
    if not dates:
        return {"available": False, "reason": "no_signal_dates", "sets": {"fit": [], "calibration": [], "selection": [], "lockbox": [], "purged": []}}
    fit_end = max(1, min(len(dates) - 3, int(len(dates) * fit_pct)))
    calibration_end = max(fit_end + 1, min(len(dates) - 2, int(len(dates) * (fit_pct + calibration_pct))))
    selection_end = max(calibration_end + 1, min(len(dates) - 1, int(len(dates) * (fit_pct + calibration_pct + selection_pct))))
    fit_dates = dates[:fit_end]
    calibration_dates = dates[fit_end:calibration_end]
    selection_dates = dates[calibration_end:selection_end]
    lockbox_dates = dates[selection_end:]
    purge_start = max(0, fit_end - max(0, int(purge_days)))
    embargo_end = min(len(dates), calibration_end + max(0, int(embargo_days)))
    purged_dates = set(dates[purge_start:fit_end]) | set(dates[calibration_end:embargo_end])

    def take(selected: set[str]) -> list[dict[str, Any]]:
        return [row for row in materialized if str(row.get("date") or row.get("signalDate") or "")[:10] in selected]

    return {
        "available": len(dates) >= 12,
        "schema": CALIBRATION_CONTRACT_SCHEMA,
        "dateCount": len(dates),
        "fitDates": fit_dates,
        "calibrationDates": calibration_dates,
        "selectionDates": selection_dates,
        "lockboxDates": lockbox_dates,
        "purgedDates": sorted(purged_dates),
        "sets": {
            "fit": take(set(fit_dates)),
            "calibration": take(set(calibration_dates)),
            "selection": take(set(selection_dates)),
            "lockbox": take(set(lockbox_dates)),
            "purged": take(purged_dates),
        },
        "policy": "signal-date grouped; purge equals horizon and embargo follows every selection boundary; lockbox is never read by method selection",
    }


def _fit_platt(probabilities: list[float], actuals: list[float]) -> dict[str, Any]:
    if len(probabilities) < 20 or len(set(int(value >= 0.5) for value in actuals)) < 2:
        return {"method": "platt", "available": False, "reason": "insufficient_rows_or_single_class"}
    # Deterministic Newton updates for a two-parameter logistic calibration.
    scale, offset = 1.0, 0.0
    for _ in range(30):
        gradient_scale = gradient_offset = 0.0
        h11 = h12 = h22 = 1e-6
        for probability, actual in zip(probabilities, actuals):
            value = _sigmoid(scale * _logit(probability) + offset)
            error = value - _number(actual)
            feature = _logit(probability)
            weight = max(1e-6, value * (1.0 - value))
            gradient_scale += error * feature
            gradient_offset += error
            h11 += weight * feature * feature
            h12 += weight * feature
            h22 += weight
        determinant = h11 * h22 - h12 * h12
        if determinant <= 1e-12:
            break
        delta_scale = (h22 * gradient_scale - h12 * gradient_offset) / determinant
        delta_offset = (-h12 * gradient_scale + h11 * gradient_offset) / determinant
        scale = max(0.05, min(10.0, scale - delta_scale))
        offset = max(-8.0, min(8.0, offset - delta_offset))
        if abs(delta_scale) + abs(delta_offset) < 1e-7:
            break
    return {"method": "platt", "available": True, "scale": scale, "offset": offset}


def _fit_temperature(probabilities: list[float], actuals: list[float]) -> dict[str, Any]:
    if len(probabilities) < 20 or len(set(int(value >= 0.5) for value in actuals)) < 2:
        return {"method": "temperature", "available": False, "reason": "insufficient_rows_or_single_class"}
    best = (float("inf"), 1.0)
    for step in range(5, 401):
        temperature = step / 100.0
        loss = 0.0
        for probability, actual in zip(probabilities, actuals):
            calibrated = _sigmoid(_logit(probability) / temperature)
            calibrated = _clamp(calibrated)
            target = _number(actual)
            loss -= target * math.log(calibrated) + (1.0 - target) * math.log(1.0 - calibrated)
        if loss < best[0]:
            best = (loss, temperature)
    return {"method": "temperature", "available": True, "temperature": best[1], "logLoss": best[0] / len(probabilities)}


def _fit_isotonic(probabilities: list[float], actuals: list[float], *, min_rows: int = 500, min_dates: int = 120) -> dict[str, Any]:
    if len(probabilities) < min_rows or len(set(int(value >= 0.5) for value in actuals)) < 2:
        return {"method": "isotonic", "available": False, "reason": "minimum_rows_or_single_class"}
    ordered = sorted(zip(map(_clamp, probabilities), map(_number, actuals)), key=lambda item: item[0])
    blocks: list[dict[str, Any]] = []
    for probability, actual in ordered:
        blocks.append({"x": probability, "sum": actual, "count": 1})
        while len(blocks) >= 2 and blocks[-2]["sum"] / blocks[-2]["count"] > blocks[-1]["sum"] / blocks[-1]["count"]:
            right = blocks.pop()
            left = blocks.pop()
            blocks.append({"x": right["x"], "sum": left["sum"] + right["sum"], "count": left["count"] + right["count"]})
    thresholds, values = [], []
    for block in blocks:
        thresholds.append(block["x"])
        values.append(_clamp(block["sum"] / block["count"]))
    return {"method": "isotonic", "available": True, "xThresholds": thresholds, "yThresholds": values, "minDates": min_dates}


def apply_calibrator(calibrator: dict[str, Any] | None, probabilities: Iterable[float]) -> list[float]:
    model = calibrator or {"method": "identity"}
    method = str(model.get("method") or "identity")
    values = [_clamp(value) for value in probabilities]
    if method == "platt" and model.get("available") is not False:
        return [_clamp(_sigmoid(_number(model.get("scale"), 1.0) * _logit(value) + _number(model.get("offset")))) for value in values]
    if method == "temperature" and model.get("available") is not False:
        temperature = max(0.05, _number(model.get("temperature"), 1.0))
        return [_clamp(_sigmoid(_logit(value) / temperature)) for value in values]
    if method == "isotonic" and model.get("available") is not False:
        xs, ys = list(model.get("xThresholds") or []), list(model.get("yThresholds") or [])
        if xs and len(xs) == len(ys):
            output = []
            for value in values:
                index = 0
                while index + 1 < len(xs) and value > xs[index + 1]:
                    index += 1
                output.append(_clamp(ys[index]))
            return output
    return values


def _brier_decomposition(actuals: list[float], probabilities: list[float], bins: int = 10) -> dict[str, Any]:
    if not actuals:
        return {"available": False, "reliability": None, "resolution": None, "uncertainty": None, "bins": []}
    mean_actual = sum(actuals) / len(actuals)
    uncertainty = mean_actual * (1.0 - mean_actual)
    groups: dict[int, list[int]] = defaultdict(list)
    for index, probability in enumerate(probabilities):
        groups[min(bins - 1, max(0, int(_clamp(probability) * bins)))].append(index)
    reliability = 0.0
    resolution = 0.0
    result_bins = []
    for bucket, indexes in sorted(groups.items()):
        predicted = sum(probabilities[index] for index in indexes) / len(indexes)
        observed = sum(actuals[index] for index in indexes) / len(indexes)
        share = len(indexes) / len(actuals)
        reliability += share * (predicted - observed) ** 2
        resolution += share * (observed - mean_actual) ** 2
        result_bins.append({"bucket": bucket, "count": len(indexes), "predictedPct": predicted * 100.0, "observedPct": observed * 100.0})
    return {"available": True, "reliability": reliability, "resolution": resolution, "uncertainty": uncertainty, "bins": result_bins}


def calibration_diagnostics(
    rows: Iterable[dict[str, Any]],
    probabilities: Iterable[float],
    *,
    actual_key: str = "actualTarget",
    date_key: str = "date",
    min_bucket_events: int = 30,
    min_bucket_dates: int = 30,
) -> dict[str, Any]:
    materialized = [row for row in rows if isinstance(row, dict)]
    values = [_clamp(value) for value in probabilities]
    size = min(len(materialized), len(values))
    materialized, values = materialized[:size], values[:size]
    actuals = [_number(row.get(actual_key)) for row in materialized]
    decomposition = _brier_decomposition(actuals, values)
    bucket_dates = [len({str(materialized[index].get(date_key) or "")[:10] for index in indexes}) for indexes in [
        [index for index, probability in enumerate(values) if min(9, int(probability * 10)) == bucket]
        for bucket in range(10)
    ]]
    bucket_counts = [len(indexes) for indexes in [
        [index for index, probability in enumerate(values) if min(9, int(probability * 10)) == bucket]
        for bucket in range(10)
    ]]
    occupied = sum(1 for count in bucket_counts if count)
    min_count = min((count for count in bucket_counts if count), default=0)
    min_dates = min((count for count in bucket_dates if count), default=0)
    mean_probability = sum(values) / max(1, len(values))
    std = math.sqrt(sum((value - mean_probability) ** 2 for value in values) / max(1, len(values)))
    brier = sum((values[index] - actuals[index]) ** 2 for index in range(len(values))) / max(1, len(values))
    baseline = sum((sum(actuals) / max(1, len(actuals)) - actual) ** 2 for actual in actuals) / max(1, len(actuals))
    return {
        "schema": CALIBRATION_CONTRACT_SCHEMA,
        "available": bool(materialized),
        "samples": len(materialized),
        "independentDates": len({str(row.get(date_key) or "")[:10] for row in materialized}),
        "brier": brier if materialized else None,
        "baselineBrier": baseline if materialized else None,
        "brierSkill": (1.0 - brier / baseline) if baseline > 1e-12 else None,
        "brierDecomposition": decomposition,
        "occupiedBuckets": occupied,
        "probabilityStd": std,
        "probabilityBucketMinCount": min_count,
        "probabilityBucketMinIndependentDates": min_dates,
        "resolutionPassed": occupied >= 4 and std >= 0.03 and min_count >= min_bucket_events and min_dates >= min_bucket_dates,
        "bucketSupportContract": {"minEvents": min_bucket_events, "minIndependentDates": min_bucket_dates, "requiredOccupiedBuckets": 4},
    }


def choose_calibrator(
    fit_rows: Iterable[dict[str, Any]],
    calibration_rows: Iterable[dict[str, Any]],
    *,
    probability_key: str = "probability",
    actual_key: str = "actualTarget",
    date_key: str = "date",
) -> dict[str, Any]:
    fit = [row for row in fit_rows if isinstance(row, dict)]
    calibration = [row for row in calibration_rows if isinstance(row, dict)]
    fit_probabilities = [_clamp(row.get(probability_key)) for row in fit]
    fit_actuals = [_number(row.get(actual_key)) for row in fit]
    candidates = [{"method": "identity", "available": True}]
    for candidate in (_fit_platt(fit_probabilities, fit_actuals), _fit_temperature(fit_probabilities, fit_actuals)):
        if candidate.get("available") is not False:
            candidates.append(candidate)
    fit_dates = len({str(row.get(date_key) or "")[:10] for row in fit})
    if len(fit_probabilities) >= 500 and fit_dates >= 120:
        candidate = _fit_isotonic(fit_probabilities, fit_actuals, min_dates=fit_dates)
        if candidate.get("available") is not False:
            candidates.append(candidate)
    validation_probabilities = [_clamp(row.get(probability_key)) for row in calibration]
    validation_actuals = [_number(row.get(actual_key)) for row in calibration]
    scored = []
    for candidate in candidates:
        calibrated = apply_calibrator(candidate, validation_probabilities)
        loss = sum((calibrated[index] - validation_actuals[index]) ** 2 for index in range(len(calibrated))) / max(1, len(calibrated))
        scored.append({"method": candidate.get("method"), "brier": loss, "model": candidate})
    selected = min(scored, key=lambda row: (row["brier"], ["identity", "temperature", "platt", "isotonic"].index(str(row["method"])))) if scored else {"method": "identity", "brier": None, "model": {"method": "identity", "available": True}}
    return {
        "schema": CALIBRATION_CONTRACT_SCHEMA,
        "available": bool(fit and calibration),
        "selected": selected["model"],
        "selection": {"fitRows": len(fit), "calibrationRows": len(calibration), "fitDates": fit_dates, "candidateBrier": {row["method"]: row["brier"] for row in scored}, "usesLockbox": False},
        "candidates": [{"method": row["method"], "brier": row["brier"]} for row in scored],
        "reason": None if fit and calibration else "fit_and_calibration_windows_required",
    }


def adaptive_conformal_interval(
    shadow_rows: Iterable[dict[str, Any]],
    *,
    prediction_key: str = "prediction",
    actual_key: str = "actualReturn",
    date_key: str = "date",
    alpha: float = 0.20,
    window_dates: int = 120,
) -> dict[str, Any]:
    """Estimate a rolling absolute-residual radius from prior Shadow rows."""
    rows = sorted([row for row in shadow_rows if isinstance(row, dict)], key=lambda row: str(row.get(date_key) or ""))
    dates = sorted({str(row.get(date_key) or "")[:10] for row in rows})
    if len(dates) < max(20, window_dates // 2):
        return {"available": False, "method": "adaptive-conformal", "reason": "insufficient_shadow_dates", "coverageTargetPct": (1 - alpha) * 100.0}
    recent = set(dates[-window_dates:])
    residuals = sorted(abs(_number(row.get(actual_key)) - _number(row.get(prediction_key))) for row in rows if str(row.get(date_key) or "")[:10] in recent)
    index = min(len(residuals) - 1, max(0, math.ceil((len(residuals) + 1) * (1 - alpha)) - 1))
    radius = residuals[index]
    return {"available": True, "method": "adaptive-conformal", "alpha": alpha, "radius": radius, "windowDates": len(recent), "rows": len(residuals), "coverageTargetPct": (1 - alpha) * 100.0, "source": "prior-shadow-only"}


def no_trade_gate(
    *,
    probability: float,
    lower_probability: float | None = None,
    expected_value_pct: float | None = None,
    lower_return_pct: float | None = None,
    threshold: float = 0.57,
    min_lower_probability: float = 0.50,
    min_expected_value_pct: float = 0.0,
    min_lower_return_pct: float = 0.0,
    data_quality_ok: bool = True,
    model_evidence_ok: bool = True,
) -> dict[str, Any]:
    reasons: list[str] = []
    if _number(probability) < threshold:
        reasons.append("calibrated_probability_below_threshold")
    if lower_probability is None or _number(lower_probability) <= min_lower_probability:
        reasons.append("probability_interval_lower_bound_not_above_null")
    if expected_value_pct is None or _number(expected_value_pct) <= min_expected_value_pct:
        reasons.append("cost_adjusted_expected_value_not_positive")
    if lower_return_pct is None or _number(lower_return_pct) <= min_lower_return_pct:
        reasons.append("return_interval_lower_bound_not_positive")
    if not data_quality_ok:
        reasons.append("data_quality_failed")
    if not model_evidence_ok:
        reasons.append("strict_oof_evidence_missing")
    return {
        "schema": "no-trade-gate-v2",
        "trade": not reasons,
        "action": "BUY" if not reasons else "NO_TRADE",
        "reasons": reasons,
        "inputs": {"probability": probability, "lowerProbability": lower_probability, "expectedValuePct": expected_value_pct, "lowerReturnPct": lower_return_pct},
        "policy": "No Trade is a valid outcome; this gate may reject a signal but never raises its probability.",
    }


__all__ = [
    "CALIBRATION_CONTRACT_SCHEMA",
    "adaptive_conformal_interval",
    "apply_calibrator",
    "calibration_diagnostics",
    "choose_calibrator",
    "chronological_calibration_split",
    "no_trade_gate",
]
