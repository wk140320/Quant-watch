#!/usr/bin/env python3
"""Build a source-level PIT gap inventory from the local data lake.

This is diagnostic evidence only. It never upgrades an unverified row. The
result tells the scheduler which gaps can be repaired locally and which need a
source with historical availability evidence.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import duckdb  # type: ignore


ROOT = Path(__file__).resolve().parents[1]
LAKE = ROOT / ".cache" / "data-lake"
DATASETS = (
    "corporate_actions", "financial_disclosures", "fundamentals", "macro",
    "news", "social", "universe",
)


def main() -> int:
    paths = [str(LAKE / dataset / "market=*" / "exchange=*" / "symbol=*" / "data.parquet") for dataset in DATASETS]
    path_list = ",".join(repr(path) for path in paths)
    connection = duckdb.connect()
    query = f"""
      select dataset, market, source, count(*) as row_count,
        sum(case when json_extract_string(payload_json, '$.historicalAvailabilityVerified') = 'true'
                 and coalesce(json_extract_string(payload_json, '$.historicalAvailabilityUnverified'), 'false') <> 'true'
                 then 1 else 0 end) as verified_count,
        sum(case when coalesce(json_extract_string(payload_json, '$.first_seen_at'), '') = '' then 1 else 0 end) as missing_first_seen,
        sum(case when coalesce(json_extract_string(payload_json, '$.ingested_at'), '') = '' then 1 else 0 end) as missing_ingested,
        sum(case when coalesce(json_extract_string(payload_json, '$.published_at'), json_extract_string(payload_json, '$.publishedAt'), '') <> '' then 1 else 0 end) as explicit_published,
        sum(case when coalesce(json_extract_string(payload_json, '$.historicalAvailabilityVerificationMethod'), '') not in ('', 'unverified') then 1 else 0 end) as verified_method_count
      from read_parquet([{path_list}], union_by_name=true)
      group by all order by dataset, market, row_count desc, source
    """
    rows = connection.execute(query).fetchall()
    connection.close()
    items = []
    for dataset, market, source, total, verified, missing_first, missing_ingested, published, method_count in rows:
        total = int(total or 0)
        verified = int(verified or 0)
        missing_first = int(missing_first or 0)
        missing_ingested = int(missing_ingested or 0)
        published = int(published or 0)
        method_count = int(method_count or 0)
        if verified == total:
            action = "accepted-source"
            reason = "全量记录已有可验证历史可用性证据"
        elif dataset == "social":
            action = "shadow-only"
            reason = "社媒抓取时间不能替代历史可见时间；需可回放的历史归档或官方历史时间"
        elif missing_first or missing_ingested:
            action = "adapter-repair"
            reason = "适配器需要保存真实 first_seen_at/ingested_at，不能使用抓取时间补成已验证"
        elif published and method_count:
            action = "evidence-review"
            reason = "存在发布时间和验证方法，需逐来源确认历史可回放条件后才能晋级"
        else:
            action = "archive-source-needed"
            reason = "当前记录缺少可证明的历史可见时间，需补充带发布/申报/生效归档的来源"
        items.append({
            "dataset": dataset,
            "market": market,
            "source": source,
            "rows": total,
            "verifiedRows": verified,
            "unverifiedRows": max(0, total - verified),
            "missingFirstSeen": missing_first,
            "missingIngested": missing_ingested,
            "explicitPublished": published,
            "verifiedMethodRows": method_count,
            "action": action,
            "reason": reason,
        })
    summary = {
        "schema": "pit-gap-inventory-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "root": str(LAKE),
        "policy": "unverified rows remain Shadow and never enter formal OOF",
        "items": items,
        "totals": {
            "rows": sum(item["rows"] for item in items),
            "verifiedRows": sum(item["verifiedRows"] for item in items),
            "unverifiedRows": sum(item["unverifiedRows"] for item in items),
            "localRepairSources": sum(item["action"] == "adapter-repair" for item in items),
            "archiveSourcesNeeded": sum(item["action"] == "archive-source-needed" for item in items),
            "shadowOnlySources": sum(item["action"] == "shadow-only" for item in items),
        },
    }
    output_dir = ROOT / "reports" / "pit-gap-2026-08-29"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "source-inventory.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"sources": len(items), **summary["totals"], "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
