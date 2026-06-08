# Source Project Distillation

This note records which ideas from the projects and data tools named in the upgrade document are being adopted. It intentionally does not copy unknown or unverified code.

## Verifiable References

- `Leezans/Reinforcement-Learning-in-Finance_minimal-implementatioin`: use the minimal-environment mindset, keep agent state explicit, separate training/evaluation, and archive paper runs.
- `Micro-sheep/efinance`, `shidenggui/easyquotation`, and `mootdx/mootdx`: treat China-market adapters as replaceable provider modules with explicit source labels and failure handling.
- yfinance: retain it only as a support/fallback concept; never treat an unofficial feed as licensed tick/L2 data.
- Alpaca market data: use authorised US bars/trades when credentials permit, with IEX coverage labelled explicitly.
- IBKR TWS/Gateway: reserve a local readiness and permission boundary before any paper-order integration.
- Tushare and FRED: cache shared data, respect quotas, and keep provider-specific schemas behind adapters.

## Names That Need Exact Project Links

The document names `Quant-dinger`, `Alpha2`, `simtradelab`, and `ptrade` without canonical repository URLs. Multiple unrelated projects use similar names. Until exact links and licences are supplied, the implementation adopts only the requirements described in the document:

- Multi-page quantitative workspace.
- Python-first domain core.
- Separate feature, factor, regime, strategy, simulation, and trading domains.
- Independent paper agents and archived runs.
- Licensed broker/data boundary for real tick and L2 data.

`pTrade`/`ptrade` must not be treated as a generic free L2 API. Real L2 data remains disabled until the user has a licensed feed and documented permission.

## Adopted Architecture

| Distilled idea | Current implementation |
| --- | --- |
| Thin UI, domain logic outside the browser | Existing UI preserved; new feature/factor/provider logic runs in `quant_core/`; `quant_client.py` provides a Python local CLI/Tk client for core workflows |
| Provider adapters with explicit provenance | Node adapters return source labels, validation status, warnings, and real snapshots |
| Avoid duplicate quota consumption | One limited market/news provider per task, plus free/direct support sources |
| Paper/live separation | Paper agents remain isolated; IBKR page performs readiness checks and audit-only paper intents, but never transmits broker orders |
| Time-series validation | Purged/embargoed walk-forward factor checkpoints, chronological test holdout, 3-batch gradient accumulation, early stopping, and best-checkpoint rollback |
| Market isolation | Watchlists, portfolios, snapshots, research configuration, and agent memory are separated by market |
| Controlled transfer | Simulation archives and aggregate research/strategy statistics may enter a validation queue; raw positions and raw market data do not transfer |
| Risk and audit control plane | Python portfolio-risk policy plus SQLite events and idempotent audit-only paper-order intents |
| Honest data capability labels | Candle-derived order-flow remains labelled as a proxy; optional Alpaca rows are labelled real Trades but never L2; missing aggressor side remains unavailable |

## Next Distillation Work

- Add exact repository links and licence notes for the unresolved project names.
- Evaluate a dedicated Python desktop shell after the domain core and API contracts stabilise.
- Add licensed ASX/A-share tick adapters and true L2 adapters only after documented entitlements are available.
- Connect the audited paper-order intent boundary to a broker only after explicit approval, credential setup, reconciliation, and failure-recovery testing.
