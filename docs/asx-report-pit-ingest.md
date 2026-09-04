# ASX Report PIT Ingest

This adapter converts locally available, officially published ASX annual reports,
half-year reports, Appendix 4E/4D documents, and quarterly reports into strict
point-in-time financial disclosure records.

## What is accepted

Every manifest item must provide:

- an ASX-hosted `source_url`;
- an explicit `report_period_end`;
- an explicit `published_at` timestamp;
- a local `path` or `text_path` containing the document; and
- at least one labelled numeric fact such as revenue, profit, assets, liabilities,
  operating cash flow, or EPS.

The adapter computes a content SHA-256, stores `event_time`, `available_at`,
`first_seen_at`, revision, extraction method, and the raw numeric values. Rejected
items are recorded in the receipt and never enter strict PIT. URLs are not fetched
by this tool and dates are never inferred from filenames.

## Manifest example

```json
{
  "reports": [
    {
      "symbol": "BHP",
      "path": "/data/asx/BHP-annual-2025.pdf",
      "source_url": "https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
      "report_period_end": "2025-06-30",
      "published_at": "2025-08-01T08:00:00+10:00"
    }
  ]
}
```

Run it from the project root:

```text
.venv/bin/python tools/ingest_asx_financial_reports.py manifest.json --root /path/to/data-lake
```

The command writes `reports/asx-report-ingest.json`. A non-zero exit code means
at least one item was rejected; inspect the receipt before retrying. This is an
ETL input, not a claim that the full ASX universe has verified numeric coverage.
