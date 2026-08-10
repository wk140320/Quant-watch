# Global Quant Watch

模型训练与生产门控详见 [市场级多任务预测、OOF 集成与生产门控](docs/production-model-training.md)。

A local, read-only multi-market quantitative research workspace for ASX, US stocks, and China A-shares.

It combines real market data providers, a Python quantitative core, technical indicators, macro/news signals, portfolio-aware risk rules, prediction learning, and paper-trading agents. The app does **not** place real trades.

## Important Disclaimer

This project is for research and personal analysis only. It is not financial advice, investment advice, or a trading system. Market data can be delayed, incomplete, rate-limited, or unavailable. Always verify signals with licensed market data and professional risk controls before making financial decisions.

## Features

- ASX, US, and China A-share watchlists with market isolation.
- Real-data-only market adapter flow. The app refuses simulated candles.
- Technical analysis including candles, volume, MACD, RSI, trend, momentum, and risk scores.
- News and macro signal aggregation from configured providers plus free fallbacks where available.
- Portfolio-aware alerts, stop-loss checks, position sizing, and cash reserve rules.
- Prediction sample tracking with hit-rate buckets, failure penalties, confidence calibration, and learning visibility.
- Versioned continuous learning with immutable 5-day OOF evidence, fixed-test and rolling progress curves, hard Champion/Challenger promotion gates, and explicit no-improvement records.
- A local Parquet + DuckDB data lake with Qlib-compatible OHLCV columns, canonical market keys, incremental deduplication, and cached feature/backtest reuse.
- Paper-trading agents that preserve strategy memory across reset cycles.
- Local snapshots for off-hours or provider outage fallback.
- Multi-page workspaces for monitoring, bottom-level feature analysis, factor experiments, market regime, strategy review, simulation, and account readiness.
- Python feature analysis for VWAP, notional, volume profile, liquidity, and explicitly labeled OHLCV order-flow proxies.
- Structure analysis for Bollinger Bands, Fibonacci retracement, Fair Value Gap, ICT liquidity-sweep proxies, Wyckoff phase proxies, absorption, and effort-versus-result.
- Optional real US trade analysis through Alpaca, with exchange distribution, tick VWAP, large-trade share, and explicit `true_tick`/`true_l2` capability labels.
- Quant-dinger-style dark trading workspace with top page navigation, high-density panels, chart overlay controls, Bollinger/Fib/FVG overlays, and wheel/trackpad X-axis zoom plus drag panning on time-series charts.
- Feature analysis now returns full-window data logs, anomaly segments, feature formulas, ATAS adapter status, volume profile, VWAP, liquidity, and order-flow proxy diagnostics.
- Factor lab now includes structure factors, formula metadata, positive/negative factor interpretation, price/prediction/VWAP correlations, heatmap-style correlation review, rolling IC/Rank IC, and manually persisted factor weights.
- Regime page fuses feature, factor, news, sector, and index state into a Feature + Factor + Regime risk-on/risk-off strip.
- Walk-forward factor lab with IC, Rank IC, stability, overlap checks, and suggested weights.
- Anti-overfitting controls with chronological train/validation/test splits, purged/embargoed walk-forward validation, 3-batch gradient accumulation, early stopping, and best-checkpoint rollback.
- Persisted per-market factor configuration and timestamped strategy revision history.
- Market breadth plus leader/laggard queues based only on successfully analysed real-data stocks.
- Python portfolio risk engine covering reserve cash, exposure, single-stock/sector concentration, stop-loss, drawdown, and paper-order validation.
- SQLite control plane for strategy/simulation/risk events and idempotent audit-only paper-order intents.
- SQLite local market-data store for authorised tick, L1 quote, and L2 depth rows. Empty stores remain explicitly unavailable and are not backfilled with simulated rows.
- Provider-budget policy that enforces at most one quota-limited market source per task plus free support sources.
- News aggregation that selects one configured quota-limited news provider per request and combines it with free/direct sources.
- Optional official FRED macro factor with a shared cache so it is not re-requested per stock.
- Optional Alpaca IEX US bars and Tushare China A-share daily bars, both governed by the limited-source budget.
- External AI fallback chain: OpenAI first, then SiliconFlow or Tencent Hunyuan when configured. Provider status is exposed without revealing keys.
- Persistent AI training supervisor: OpenAI, SiliconFlow, and Tencent Hunyuan review the same versioned OOF evidence independently; deterministic gates remain authoritative and failed cycles are automatically reworked with stricter or broader training plans.
- Optional ATAS feature adapter endpoint for external order-flow/feature extraction. Without `ATAS_FEATURE_ENDPOINT` or `ATAS_BASE_URL`, the app reports the adapter as reserved and sends no request.
- Local-only IBKR Paper/TWS readiness checks and audit-only paper-order intents. Broker order transmission and live trading are forcibly disabled.

## Requirements

- Node.js 20 or newer.
- Python 3.9 or newer.
- Optional API keys for richer market/news/AI coverage.

No npm dependencies are required.

## Quick Start

The most reliable start command, including environments where `node` is not on `PATH`:

```bash
./start-local.sh
```

Or use npm:

```bash
cp .env.example .env.local
npm start
```

Then open:

```text
http://127.0.0.1:8787
```

If `npm` is unavailable, run directly:

```bash
node server.mjs
```

Python local client entry points:

```bash
python3 quant_client.py health
python3 quant_client.py features --market ASX --symbol BHP
python3 quant_client.py trades --market US --symbol AAPL --window-minutes 30
python3 quant_client.py factors --market ASX --symbol BHP --horizon-days 15
python3 quant_client.py risk --market ASX --total-capital 10000 --available-cash 5000 --position BHP:100:45:46:Materials
python3 quant_client.py market-data --market US --symbol AAPL
python3 quant_client.py gui
```

## Configuration

Local secrets go in `.env.local`. This file is ignored by git.

Start from:

```bash
cp .env.example .env.local
```

Common optional keys:

```bash
EODHD_API_KEY=
EODHD_API_KEYS=
TWELVEDATA_API_KEY=
TWELVEDATA_API_KEYS=
ALPHAVANTAGE_API_KEY=
NEWSAPI_KEY=
NEWSDATA_API_KEY=
THENEWSAPI_KEY=
TIANAPI_KEY=
X_BEARER_TOKEN=
YOUTUBE_API_KEY=
OPENAI_API_KEY=
ENABLE_DOMESTIC_AI_ANALYSIS=false
SILICONFLOW_API_KEY=
HUNYUAN_API_KEY=
TUSHARE_TOKEN=
ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_TRADES_LIMIT=1000
ATAS_API_KEY=
ATAS_FEATURE_ENDPOINT=
FINNHUB_API_KEY=
TIINGO_API_KEY=
TIINGO_API_KEYS=
MARKETAUX_API_KEY=
FRED_API_KEY=
SIMFIN_API_KEY=
FMP_API_KEY=
OPENFIGI_API_KEY=
```

`EODHD_API_KEYS`, `TWELVEDATA_API_KEYS`, and `TIINGO_API_KEYS` accept comma-separated backup credentials. The singular key remains primary; backups are tried in order only after quota, authentication, or plan-permission failures. Keys are never round-robin consumed and are never returned to the browser.

OpenAI analysis is disabled by default. To enable it:

```bash
ENABLE_OPENAI_ANALYSIS=true
OPENAI_API_KEY=
```

## Data Behavior

- The app only uses real market data returned by providers or previously saved real snapshots.
- `.cache/` stores local snapshots and prediction samples. It is ignored by git because it may contain personal watchlists, portfolio data, and analysis history.
- If only one real provider is available, the app can degrade to that real source and reduce confidence.
- If no real provider or saved real snapshot is available, the app should report a provider failure rather than fabricate prices.
- US trades are available only when Alpaca credentials and entitlements permit them. ASX/A-share tick data and all true L2 data remain unavailable until a separately authorised feed is configured.
- Provider-reported trades are not treated as L2. If quotes or aggressor-side fields are absent, the app explicitly marks them unavailable.
- Authorised tick/L1/L2 rows can be recorded through the local market-data store, but candle proxies are never promoted to true order-book data.
- ATAS is treated as an optional external feature extractor, not as a market-data source. It receives real feature payloads only when an endpoint is configured.
- Paper Agents are backend-owned and persisted in SQLite. Browser refreshes only update the display; they do not advance the Paper ledger.
- Changing Paper Agent capital preserves positions, trades, and learning memory. Browser migration is non-destructive: an empty or poorer browser ledger cannot replace a richer backend ledger.
- Paper fills require an open market, a real provider source, a positive price, and a current completed bar timestamp. Live broker execution is always disabled.
- Historical US fundamentals combine SEC Company Facts with SimFin `asreported=true` statements. FMP contributes cached delisting and symbol-change events; OpenFIGI validates current identifiers but is deliberately excluded from historical-universe coverage.
- PIT enrichment is a background data-lake job. Provider failures are isolated per source, and current snapshots never receive a historical-availability flag unless the provider supplies a verifiable publication or effective timestamp.

## Model Training And Evidence

P0-P2 uses immutable model versions, point-in-time data versions, strict OOF gates, and separate market-level and stock-level factor evidence. See [P0-P2 completion and evidence boundary](docs/p0-p2-completion.md) for current sample sizes, metrics, and unresolved data-coverage blockers.

Local factor research can be reproduced without blocking the web server:

```bash
.venv/bin/python tools/run_factor_research.py --market ASX --scope market --limit 200 --min-rows 750 --horizons 5
.venv/bin/python tools/run_factor_research.py --market ASX --scope stock --symbols BHP,CBA,CPU,CAR,MIN --min-rows 260 --horizons 5
```

Research completion is not production approval. Failed OOF, calibration, stability, or cost gates keep the artifact in Research/Shadow with zero live execution weight.

## Background Runtime

The backend now separates lightweight quotes from full analysis. During trading sessions, holdings receive verified quote checks every 1 minute and other watchlist symbols every 3 minutes; full analysis runs every 2/5 minutes respectively. Minute-model training runs every 2 minutes on up to three priority symbols and keeps up to 50,000 deduplicated samples with a 70/30 persisted-history versus newly completed-bar target. The logical request envelope allocates 55% to quotes, 25% to full analysis, 15% to minute training, and 5% to manual/failover work. Manual refresh first updates strict real-price overlays, then recalculates the model in byte-bounded batches.

Open `GlobalQuantMonitor.app` to inspect model trajectories, start or pause the monitor, review the audit trail, and manually run the backend. The signed macOS container uses the same local `/monitor.html` workspace as the browser, so the visual system and model evidence stay in sync; when port `8787` is unavailable it attempts to start `server.mjs` with the bundled Codex Node runtime. The controller also exposes LaunchAgent status without copying API keys into the plist.

The model-operations workspace reads persisted local evidence rather than inventing a visual history. `GET /api/model-trajectories?market=ASX` normalizes calibration, factor research, alpha evolution, intraday learning, adaptive correction, and Paper Agent events into one explainable timeline with formulas, sample counts, reasons, guardrails, and improvement/degradation states.

The training supervisor persists each market cycle under `.cache/training-supervisor/`. A cycle moves through queued, training, reviewing, automatic rework, accepted, or needs-attention states. Acceptance requires both the deterministic point-in-time/OOF/calibration/cost gate and at least two independent AI approvals. Rework may expand the universe and history or tighten ensemble constraints, but it never lowers acceptance thresholds. An accepted cycle remains Shadow/Research evidence; it cannot place live orders or promote itself directly to production.

Continuous learning is evidence-driven rather than run-count-driven. Daily evaluation resolves matured labels without refitting; weekly Challenger training requires at least 100 newly resolved labels across five independent dates; monthly full training requires at least 1,000 resolved rows across 120 dates. Only the 5-day model can be promoted in the first stage. A Challenger must improve fixed-test direction accuracy by at least one percentage point, avoid regression in four of five folds, keep positive Brier Skill and ECE at or below 5%, and pass high-confidence signal checks. Failed or unchanged runs remain visible but never replace the Champion.

Paper Agent `generation_v1` is archived read-only as the historical loss baseline. `generation_v2` starts in Shadow mode with separate capital, OOF-only nightly replay, weekly parameter updates, six-position/12%-per-stock/25%-per-sector limits, at least 25% cash, and loss-streak circuit breakers. Observational or in-sample predictions cannot update its policy.

The local control plane exposes:

```text
GET  /api/workspace/bootstrap?market=ASX
GET  /api/paper-agents?market=ASX
POST /api/paper-agents/config
POST /api/paper-agents/reset
POST /api/paper-agents/migrate
GET  /api/paper-agents/events?market=ASX
GET  /api/runtime/stream
GET  /api/training-supervisor/status?market=ASX
GET  /api/training-supervisor/logs?market=ASX&provider=openai
POST /api/training-supervisor/run
POST /api/training-supervisor/review
POST /api/training-supervisor/config
POST /api/jobs/training|backtest|news|reddit|monitor
GET  /api/jobs/:id
GET  /api/learning-progress?market=ASX
GET  /api/training-runs/:id
GET  /api/agent-generations?market=ASX
```

GlobalQuantMonitor 的“后台控制”页包含人工监工操作台：可以暂停总调度、暂停单个市场、独立启停三位 AI、填写操作备注、要求返工或重新验收最近完整产物。所有人工动作写入 `.cache/training-supervisor/events.jsonl`；人工操作不能跳过 OOF、PIT、校准、漂移与成本后期望门槛，也不能直接批准生产部署。

News refresh windows and hourly Reddit cache warmup are scheduled by the backend while it is running. Long backtests and enrichment refreshes are asynchronous jobs, so the dashboard remains usable.

## Useful Commands

```bash
npm run check
npm run check:node
npm run check:python
npm run check:providers
```

`check:providers` reads `.env.local` and redacts provider responses before printing.

## Project Structure

```text
index.html                  Browser shell and versioned asset entry points
frontend/runtime/           UI scheduling, progress, loading, and transition runtime
frontend/domain/            Market configuration and cross-market symbol rules
frontend/charts/            Technical series and chart-coordinate mathematics
frontend/styles/            Design tokens and final high-density shell styling
frontend/vendor/lucide/     Vendored local icon runtime and licence
styles.css                  Legacy feature and chart styles during decomposition
app.js                      Frontend compatibility orchestrator
backend/http/               Static and HTTP transport modules
backend/config/             Local environment and secret-source loading
backend/providers/          Shared Provider HTTP, timeout, and redaction layer
server.mjs                  Node compatibility entry point and API orchestration
quant_client.py             Python local CLI/Tk client
quant_core/                 Features, factors, backtests, models, risk, and persistence
tests/                      Node and Python regression coverage
docs/architecture.md        Ownership boundaries and extraction order
docs/design-system.md       Colour, geometry, motion and page hierarchy contract
docs/upgrade-roadmap.md     Incremental requirements and acceptance roadmap
tools/check-providers.mjs   Provider smoke test helper
.env.example                Safe environment template
```

See [docs/architecture.md](docs/architecture.md) for runtime boundaries, performance rules, and the staged decomposition plan.

## Privacy And Secrets

Before publishing, make sure these are not committed:

- `.env.local`
- `.env`
- `.cache/`
- screenshots or CSVs containing holdings
- broker exports
- personal logs

The repository includes `.gitignore` rules for these paths.

## License

MIT
