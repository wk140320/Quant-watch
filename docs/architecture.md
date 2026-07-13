# Application Architecture

Global Quant Watch is a local-first application. The browser, Node service, and Python quantitative core have separate ownership boundaries even though the two compatibility entry points (`app.js` and `server.mjs`) still coordinate older features.

## Runtime Flow

```text
Browser workspace
  -> frontend/runtime       interaction scheduling, progress, transitions
  -> app.js                 market state and feature orchestration
  -> backend/http           bounded JSON transport and static-file policy
  -> backend/domain         market and symbol ownership contracts
  -> Node /api routes       provider policy, cache, snapshots, local analysis
  -> backend/services       isolated Python quant-core process client
  -> quant_core/worker.py   numerical features, backtests, risk, model training
  -> local record/cache     point-in-time data and reproducible model evidence
```

The persistent Paper Agent path is deliberately backend-owned:

```text
Backend monitor scheduler
  -> normalized real market result (source + completed bar timestamp)
  -> quant_core/paper_agents.py
  -> SQLite agent state + idempotent Paper events
  -> runtime SSE / local notifications
  -> browser read model
```

Paper Agent capital changes are cash adjustments, not ledger resets. Browser migrations merge per Agent and keep the richer ledger; a repeated migration marker may still restore a strictly richer Safari/local backup. Explicit resets require confirmation in the UI.

Credentialed market providers use primary-first failover pools. EODHD, Twelve Data, and Tiingo stay on the active key until a quota/auth/permission failure, then advance through configured backups without exposing credentials in API responses or source-control artifacts.

Market, news, social, and AI provider failures must terminate inside their own adapter or panel. They must not block market switching or hide the base interface.

## Directory Ownership

```text
frontend/runtime/           Browser-only scheduling and resilience helpers
frontend/domain/            Pure market and symbol ownership rules
frontend/charts/            Technical series and chart-coordinate mathematics
frontend/styles/            Design tokens and final application-shell styling
backend/config/             Environment loading and secret-source precedence
backend/domain/             Pure backend market, symbol, and universe contracts
backend/http/               HTTP transport and static-file concerns
backend/providers/          Provider request, timeout, redaction, and adapter foundations
backend/services/           Process and application-service adapters
quant_core/                 Python numerical and persistence domains
tests/                      Node and Python regression coverage
docs/                       Methodology, architecture, and requirements evidence
```

`styles.css`, `app.js`, and `server.mjs` remain compatibility entry points while domain code is extracted incrementally. New cross-cutting UI behavior belongs in `frontend/`; new transport behavior belongs in `backend/http/`; numerical model logic belongs in `quant_core/`.

## Extracted Contracts

- `backend/domain/markets.mjs` owns backend market metadata, symbol normalization, cross-market validation, and the training-universe seed lists.
- `frontend/runtime/storage.js` owns browser-storage exception isolation, JSON size guards, invalid-cache cleanup, and shared serialization helpers for both the lightweight shell and full workspace.
- `backend/http/json.mjs` owns JSON parsing, the two-megabyte default body limit, `400/413` request errors, and non-cacheable JSON responses.
- `backend/http/static-files.mjs` owns static path containment, content types, and immutable versioned assets.
- `backend/providers/http.mjs` owns provider timeouts, headers, curl fallback, and token redaction.
- `backend/providers/us/alpaca.mjs` owns Alpaca bar, trade, and quote normalization behind the shared candle sanitation contract.
- `backend/providers/cn/tushare.mjs` owns Tushare field mapping, lot-volume conversion, and amount normalization behind the same contract.
- `backend/services/python-quant.mjs` owns Python executable discovery, worker lifecycle, timeout, output limits, and protocol decoding.

API route handlers must consume these contracts instead of reimplementing request parsing, process spawning, or market-symbol rules inside `server.mjs`.

## Performance Rules

- Keep first paint independent of provider availability.
- Restore local snapshots before scheduling optional remote enrichments.
- Render critical watchlist content first and time-slice secondary panels across animation frames.
- Keep `/api/health` compact: cache inventories expose aggregate counts and timestamps while row-level diagnostics stay on dedicated status endpoints.
- Version immutable CSS and JavaScript assets; keep HTML uncached so version references update immediately.
- Use visible progress and skeleton states without delaying content that is already available.
- Respect reduced-motion preferences and never make animation a prerequisite for functionality.

## Stability Rules

- Every page and provider panel owns its error state.
- Market-switch tokens invalidate stale asynchronous work.
- Local real-data snapshots survive provider and process restarts.
- Static file resolution is constrained to the application root.
- Failed optional UI helpers must leave the base HTML visible and operable.
- Closed markets, stale bars, missing timestamps, and simulated sources cannot create Paper fills.
- Browser refreshes never advance the authoritative Paper Agent ledger.
- Malformed or oversized JSON requests fail locally with `400` or `413`; they must not enter provider or model execution paths.

## Next Extraction Boundaries

The next safe decomposition order is:

1. Move remaining Canvas renderers and interaction state to `frontend/charts/`.
2. Move market-specific adapters from `server.mjs` to `backend/providers/<market>/` behind one normalized candle contract.
3. Move snapshot, news, and prediction persistence to `backend/repositories/` without changing cache file formats.
4. Split `/api` routing by bounded domains after services and repositories have stable interfaces.
5. Keep `app.js` and `server.mjs` as compatibility composition roots until their extracted modules cover every existing public contract.

Each extraction must preserve the existing response schema and pass the browser smoke checks before the next domain moves.
