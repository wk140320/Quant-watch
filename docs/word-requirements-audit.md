# Word Requirements Audit

This audit maps `量化项目升级内容.docx` to current implementation evidence. It is intentionally strict: where a requirement depends on broker permissions, licensed tick/L2 feeds, or blocked browser access, it is not claimed as fully complete.

## Evidence Snapshot

- Current service health: `/api/health` returns Python core capabilities including feature analysis, factor lab, real trade analysis, provider budget, risk assessment, paper-order audit, SQLite event store, local market-data store, IBKR readiness, redacted external AI provider status, and ATAS endpoint readiness.
- API smoke checks on the running service:
  - `/api/trades?market=ASX&symbol=BHP&windowMinutes=30` returns `available=false`, `true_tick=false`, `true_l2=false`, and a licensed-feed reason.
  - `/api/provider-budget?market=ASX` returns one limited provider plus free support policy.
  - `/api/control-plane?market=ASX` returns the SQLite control database and `order_execution_enabled=false`.
  - `/api/risk-assessment` returns portfolio concentration warnings from supplied real position inputs.
- Automated checks:
  - `node --check server.mjs`
  - `node --check app.js`
- `SERVER_DISABLE_LISTEN=true node --test tests/test_server.mjs`: 9/9 passed.
  - `python3 -m unittest discover -s tests -v`: 12/12 passed.
  - `git diff --check`
  - `sh -n start-local.sh`
- Browser visual verification is not completed because the in-app browser policy rejects opening the local target in this thread.

## Requirement Matrix

| Requirement from Word | Current evidence | Status |
| --- | --- | --- |
| Preserve previous data, models, snapshots, and generated results rather than rebuilding from zero | Existing `.cache/` snapshot/prediction files are still read by the web app; new Python control plane uses `.cache/quant-control-plane.sqlite3`; no migration deletes existing files | Implemented |
| Learn from Quant-dinger, Alpha2, RL-in-Finance minimal, simtradelab, ptrade | `docs/source-project-study.md` records the adopted patterns and avoids copying uncertain code/licences | Implemented as distilled architecture |
| Multi-page workspace for dashboard, feature analysis, factor analysis, regime, strategy, simulation, trading | `index.html`/`app.js` include page navigation and sections for all named pages; `quant_client.py gui` adds Python local tabs for core workflows | Implemented; browser visual audit pending |
| Local client primarily in Python, not only direct JS | `quant_core/` owns domain logic; `quant_client.py` provides Python CLI/Tk entry points for health, features, trades, factors, risk, and control-plane summary | Partially implemented; existing rich UI remains HTML/JS to preserve current app |
| Feature analysis page with price behavior/order flow, minute/order granularity, OHLCV, VWAP, trade count, notional, bucket price, active buy/sell proxies, volume profile, structure analysis, full data log, AI/ATAS feature extraction, and manual review | `/api/features` calls Python `analyze_features`; UI renders full-window data log, anomaly segments, Bollinger/Fibonacci/FVG/ICT/Wyckoff/order-flow proxy structure, formulas, ATAS adapter status, summary, volume profile, and quality notes; tests cover OHLCV proxy labeling and structure keys | Implemented for candle/minute features; true order-level active side requires provider support |
| Real trade/tick data and L2 distinction | `/api/trades` and `quant_core/trades.py` support provider-reported real US trades; `/api/market-data` and SQLite tables can persist authorised tick/L1/L2 rows; ASX/CN return unavailable instead of simulated trades; tests assert real trades never claim L2/aggressor side and local market rows persist | Implemented capability boundary; ASX/CN tick and all true L2 require licensed feeds |
| Factor analysis page with AI/manual factor selection, charts/tables/correlation, rolling IC/Rank IC, future return/VWAP labels, weights, formulas, positive/negative relation, price/prediction/VWAP correlation | Factor lab UI/API and Python factor analysis produce structure factors, formula metadata, correlations, heatmap cells, IC/Rank IC, VWAP labels, suggested weights; saved factor config changes decision signal in tests | Implemented |
| Refined backtesting and anti-overfitting | Python factor lab includes purged/embargoed validation, chronological train/validation/test split, 3-batch gradient accumulation, early stopping, and best-checkpoint rollback | Implemented for local factor-learning pipeline |
| Regime page with market/sector/news/political/technology impact, feature/factor/regime fusion, top/bottom 30, search/detail/K-line/news | Web app regime page computes breadth, sector state, Feature + Factor + Regime fusion strip, leader/laggard queues, news/political/war/central-bank/technology evidence from analysed real-data pool | Implemented subject to configured providers and analysed watchlist coverage |
| Strategy page with AI summary, manual revision, timestamped logs, and later review | Strategy revision UI persists timestamped revisions locally/server-side and appends events to SQLite | Implemented |
| Simulation with multiple independent agents, archived runs, market-isolated learning, controlled cross-market fusion | Existing agent memory is market-scoped; simulation archives and aggregate transfer queue are preserved; raw data/positions do not transfer | Implemented for paper simulation and aggregate learning |
| Trading page reserved for IBKR and later automated/manual trading | IBKR readiness endpoint checks local TWS/Gateway port; trading UI has paper-order audit intent and risk gate | Audit-only implemented; broker order transmission intentionally disabled |
| Risk management, portfolio sizing, reserve cash, stops, drawdown, hedging awareness | `quant_core/risk.py` assesses cash reserve, exposure, concentration, stop-loss, drawdown; API smoke returned concentration warning; tests cover blockers and sell quantity limits | Implemented; hedge execution remains analytical |
| Market isolation across ASX, US, CN with controlled strategy fusion | Market-specific state, snapshots, research config, prediction samples, agent memory, and event ledgers are separated; transfer is aggregate-only | Implemented |
| API quota policy: one reliable limited provider plus one free support provider; avoid double-consuming limited sources | `provider_budget.py`, `/api/provider-budget`, provider planning, and tests enforce limited-source classification and budget messaging | Implemented |
| Add A-share and US APIs including Tushare, Alpaca, Finnhub, Tiingo, Marketaux, FRED, etc. | Environment template and provider adapters include optional keys; Tushare daily and Alpaca bars/trades have parser tests; Marketaux/FRED are cached optional factors | Implemented where provider schemas are present; permissions still provider-dependent |
| News, macro, political, war, industry, upstream/downstream, competitor impacts | Server news/factor logic builds market/company/sector/macro queries and scores evidence; regime page surfaces global and sector signals | Implemented subject to provider availability and rate limits |
| OpenAI token exhaustion fallback to domestic AI models | External AI chain attempts OpenAI, then SiliconFlow, then Tencent Hunyuan when configured; health/test output is redacted | Implemented for text analysis and chat; image import remains OpenAI Vision-only |
| Quant-dinger-style dark UI, top page navigation, high-density chart controls, wheel/trackpad zoom | `styles.css`, `index.html`, and `app.js` implement dark trading palette, top workspace nav, chart overlay buttons, Bollinger/Fib/FVG overlays, wheel/trackpad X-axis zoom, and drag panning | Implemented in code; browser visual audit pending |
| Screenshot/CSV/manual holdings import and position-aware alerts | Existing web app includes portfolio import/add workflows and risk/alert logic; Python risk client accepts explicit positions | Implemented in web app; Python client supports explicit position input |
| Automatic refresh/off-hours real snapshot usage | Existing web app has refresh timers, Sydney clock, market-session logic, and persistent real snapshots | Implemented in web app; browser timer behavior still needs visual/runtime audit |
| Never use simulated data for market analysis | Market adapters, `/api/trades`, feature quality notes, and tests explicitly reject or label unavailable sources instead of returning simulated tick/L2 | Implemented |
| Live/paper broker execution | `order_execution_enabled=false` is returned by health, control plane, risk, order intents, and tests | Not enabled by design; requires explicit broker credentials, reconciliation, permissions, and user approval |

## Remaining External Dependencies

- Browser visual QA for the local app, because current in-app browser access to the local target is blocked by policy.
- Licensed ASX/CN tick or L2 feed if true order-book depth is required.
- Alpaca/Futu/IBKR/Polygon/Finnhub entitlements for richer US tick coverage beyond free or delayed plans.
- Explicit broker execution design and approval before any real or paper order transmission is connected.
