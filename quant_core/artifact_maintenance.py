from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Any


def _referenced_artifacts(models_root: Path) -> set[Path]:
    preserved: set[Path] = set()
    registry_root = models_root / "registry"
    for index_path in registry_root.glob("*/index.json"):
        try:
            index = json.loads(index_path.read_text("utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        filenames = {
            str(value.get("filename"))
            for key in ("champion", "frozenBaseline", "bestChallenger", "latestRun")
            for value in [index.get(key)]
            if isinstance(value, dict) and value.get("filename")
        }
        for filename in filenames:
            version_path = index_path.parent / filename
            try:
                document = json.loads(version_path.read_text("utf-8"))
            except (OSError, ValueError, TypeError):
                continue

            def visit(value: Any) -> None:
                if isinstance(value, dict):
                    for child in value.values():
                        visit(child)
                elif isinstance(value, list):
                    for child in value:
                        visit(child)
                elif isinstance(value, str) and value.endswith((".jsonl.gz", ".json.gz")):
                    candidate = Path(value).expanduser()
                    if candidate.is_absolute():
                        preserved.add(candidate.resolve())

            visit(document)
    return preserved


def _remove(path: Path, dry_run: bool) -> int:
    try:
        size = sum(item.stat().st_size for item in path.rglob("*") if item.is_file()) if path.is_dir() else path.stat().st_size
    except OSError:
        size = 0
    if not dry_run:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    return size


def cleanup_training_artifacts(payload: dict[str, Any]) -> dict[str, Any]:
    project_root = Path(str(payload.get("project_root") or payload.get("projectRoot") or Path(__file__).resolve().parents[1])).expanduser().resolve()
    models_root = project_root / ".cache" / "models"
    oof_root = models_root / "oof"
    dry_run = bool(payload.get("dry_run", payload.get("dryRun", False)))
    keep_datasets = max(2, min(8, int(payload.get("keep_datasets", payload.get("keepDatasets", 3)) or 3)))
    keep_checkpoints = max(3, min(12, int(payload.get("keep_checkpoints", payload.get("keepCheckpoints", 6)) or 6)))
    keep_oof = max(6, min(30, int(payload.get("keep_oof", payload.get("keepOof", 12)) or 12)))
    preserved = _referenced_artifacts(models_root)
    removed: list[str] = []
    freed = 0

    def prune(paths: list[Path], keep: int) -> None:
        nonlocal freed
        ordered = sorted(paths, key=lambda path: path.stat().st_mtime, reverse=True)
        for stale in ordered[keep:]:
            if stale.resolve() in preserved:
                continue
            freed += _remove(stale, dry_run)
            removed.append(str(stale))

    for market_dir in ([path for path in oof_root.iterdir() if path.is_dir()] if oof_root.exists() else []):
        dataset_groups: dict[str, list[Path]] = {}
        for path in (market_dir / "datasets").glob("*.json.gz"):
            horizon = re.search(r"-(\d+)d-", path.name)
            dataset_groups.setdefault(horizon.group(1) if horizon else "other", []).append(path)
        for paths in dataset_groups.values():
            prune(paths, keep_datasets)

        checkpoint_groups: dict[str, list[Path]] = {}
        for path in (market_dir / "checkpoints").glob("*"):
            if not path.is_dir():
                continue
            horizon = re.search(r"-(\d+)d-", path.name)
            checkpoint_groups.setdefault(horizon.group(1) if horizon else "other", []).append(path)
        for paths in checkpoint_groups.values():
            prune(paths, keep_checkpoints)

        oof_groups: dict[str, list[Path]] = {}
        for path in market_dir.glob("*.jsonl.gz"):
            horizon = re.search(r"-(\d+)d-", path.name)
            oof_groups.setdefault(horizon.group(1) if horizon else "other", []).append(path)
        for paths in oof_groups.values():
            prune(paths, keep_oof)

        cutoff = time.time() - 60 * 60
        for temporary in market_dir.rglob("*.tmp"):
            if temporary.stat().st_mtime < cutoff:
                freed += _remove(temporary, dry_run)
                removed.append(str(temporary))

    return {
        "available": True,
        "dryRun": dry_run,
        "removed": len(removed),
        "freedBytes": freed,
        "freedGiB": round(freed / 1024**3, 4),
        "preservedReferences": len(preserved),
        "policy": {
            "datasetsPerMarketHorizon": keep_datasets,
            "checkpointSetsPerMarketHorizon": keep_checkpoints,
            "oofArtifactsPerMarketHorizon": keep_oof,
        },
        "paths": removed[:200],
    }
