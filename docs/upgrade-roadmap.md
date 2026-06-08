# Quant Watch Upgrade Roadmap

This roadmap translates the requirements in `量化项目升级内容.docx` into verifiable implementation work. Secrets from the document are intentionally excluded.

## Guardrails

- Preserve the existing real-data-only dashboard, prediction samples, snapshots, model memory, and market-separated portfolios.
- New research and trading-domain logic is implemented in Python first. The existing Node service remains as the compatibility and provider adapter during migration.
- Never fabricate market, tick, L2, portfolio, or broker data.
- Distinguish real tick/order-flow data from candle-derived proxies in the API and UI.
- Live order execution remains disabled until broker authentication, permissions, risk limits, audit logs, and explicit user confirmation are complete.
- Each data task may consume at most one quota-limited provider plus one free support provider.

## Requirement Matrix

| Phase | Requirement | Acceptance evidence | Status |
| --- | --- | --- | --- |
| 1 | Python quant core added without deleting current models/data | Python worker health endpoint, local Python client, and unit tests | Complete |
| 1 | Multi-page workspace for dashboard, features, factors, regime, strategy, simulation, trading | Web workspace with top navigation and dark trading-console style plus Python CLI/Tk client entry points; final in-app browser visual audit is blocked by current browser policy | Implemented; visual audit pending |
| 1 | Feature analysis page with OHLCV log, VWAP, volume profile, active buy/sell analysis, anomaly segments, structure analysis, feature formulas, and ATAS adapter status | `/api/features` returns source-labelled real-data features, Bollinger/Fibonacci/FVG/ICT/Wyckoff/order-flow proxy structure, and optional external feature-adapter status | Complete |
| 1 | Provider quota planning | `/api/provider-budget` and market adapter enforce one limited-source cap | Complete |
| 1 | IBKR trading page reserved without enabling orders | Local readiness check reports `order_execution_enabled=false` | Complete |
| 2 | Factor lab with AI/manual selection, factor scoring, structure factors, formulas, positive/negative correlations, price/prediction/VWAP correlations, rolling IC/Rank IC, labels | Factor lab output, heatmap/table visualizations, and persisted factor configuration | Implemented |
| 2 | Finer-grained walk-forward backtests and anti-overfitting controls | Purged/embargoed validation, chronological train/validation/test, 3-batch gradient accumulation, early stopping, best-checkpoint rollback | Complete for the local factor-learning pipeline |
| 3 | Regime page with feature/factor/regime fusion, market/sector state, news impact, leaders/laggards, search/detail | Three-market regime dashboard, Feature + Factor + Regime strip, and evidence-linked scoring | Implemented from the successfully analysed real-data pool; coverage depends on configured providers |
| 3 | Strategy page with editable AI strategy and timestamped change log | Persistent strategy revisions and review view | Implemented |
| 4 | Multiple independent agents per market with shared transferable learning | Archived simulation runs, market-isolated ledgers, and SQLite aggregate event archives | Implemented; transfer remains validation-gated and aggregate-only |
| 4 | Risk engine covering exposure, reserve cash, stops, drawdown and hedging | Python risk policy, UI assessment, and unit tests | Complete; hedge advice remains analytical rather than broker-executed |
| 5 | Broker integration for IBKR paper trading, then guarded manual/automated trading | Local readiness, idempotent paper-intent audit trail, and explicit live-trading gate | Audit-only paper intent complete; broker order transmission intentionally disabled |
| 5 | Real tick/L2 adapters according to market availability and permissions | Source capability/permission checks; no candle proxy labelled as L2; local store can persist authorised tick/L1/L2 rows | Optional Alpaca US Trades and local storage framework complete; ASX/A-share tick and all true L2 require licensed feeds |

## Market Data Strategy

- US: optional real trades from Alpaca IEX or an authorised broker feed; use free historical/support sources where appropriate. Provider trades are not labelled L2.
- China A-shares: use free/support sources for candles and announcements; treat tick feeds as unstable unless a licensed or broker feed is available.
- ASX: use real candles, announcements, news, and macro data until licensed tick/L2 access is configured.
- Market data remains isolated by market. Strategy learning may transfer only through explicit aggregated features and validation statistics.
- Optional adapters now include Alpaca IEX US bars/trades and Tushare China A-share daily bars.
- Optional news/macro adapters now include Marketaux and cached official FRED observations.
- Optional local market-data storage now supports authorised tick rows, L1 quotes, and L2 depth rows with explicit availability flags.

## Verification

- `node --check server.mjs` and `node --check app.js`
- `SERVER_DISABLE_LISTEN=true node --test tests/test_server.mjs`: 9/9 passed
- `python3 -m unittest discover -s tests -v`: 12/12 passed
- `git diff --check` and `sh -n start-local.sh`
- Local API smoke checks confirmed `/api/health`, `/api/trades`, `/api/provider-budget`, `/api/control-plane`, and `/api/risk-assessment` behavior on the running service.

The current in-app browser policy rejected opening the local target. API-level smoke checks can be run through `python3 quant_client.py health` or direct local HTTP calls after restarting the service with `./start-local.sh`.
