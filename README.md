# Global Quant Watch

A local, read-only multi-market equity analysis dashboard for ASX, US stocks, and China A-shares.

It combines real market data providers, technical indicators, macro/news signals, portfolio-aware risk rules, prediction learning, and paper-trading agents. The app does **not** place real trades.

## Important Disclaimer

This project is for research and personal analysis only. It is not financial advice, investment advice, or a trading system. Market data can be delayed, incomplete, rate-limited, or unavailable. Always verify signals with licensed market data and professional risk controls before making financial decisions.

## Features

- ASX, US, and China A-share watchlists with market isolation.
- Real-data-only market adapter flow. The app refuses simulated candles.
- Technical analysis including candles, volume, MACD, RSI, trend, momentum, and risk scores.
- News and macro signal aggregation from configured providers plus free fallbacks where available.
- Portfolio-aware alerts, stop-loss checks, position sizing, and cash reserve rules.
- Prediction sample tracking with hit-rate buckets, failure penalties, confidence calibration, and learning visibility.
- Paper-trading agents that preserve strategy memory across reset cycles.
- Local snapshots for off-hours or provider outage fallback.

## Requirements

- Node.js 20 or newer.
- Optional API keys for richer market/news/AI coverage.

No npm dependencies are required.

## Quick Start

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

## Configuration

Local secrets go in `.env.local`. This file is ignored by git.

Start from:

```bash
cp .env.example .env.local
```

Common optional keys:

```bash
EODHD_API_KEY=
TWELVEDATA_API_KEY=
ALPHAVANTAGE_API_KEY=
NEWSAPI_KEY=
NEWSDATA_API_KEY=
THENEWSAPI_KEY=
TIANAPI_KEY=
X_BEARER_TOKEN=
YOUTUBE_API_KEY=
OPENAI_API_KEY=
```

OpenAI analysis is disabled by default. To enable it:

```bash
ENABLE_OPENAI_ANALYSIS=true
OPENAI_API_KEY=your_key_here
```

## Data Behavior

- The app only uses real market data returned by providers or previously saved real snapshots.
- `.cache/` stores local snapshots and prediction samples. It is ignored by git because it may contain personal watchlists, portfolio data, and analysis history.
- If only one real provider is available, the app can degrade to that real source and reduce confidence.
- If no real provider or saved real snapshot is available, the app should report a provider failure rather than fabricate prices.

## Useful Commands

```bash
npm run check
npm run check:providers
```

`check:providers` reads `.env.local` and redacts provider responses before printing.

## Project Structure

```text
index.html                Browser UI
styles.css                App styling
app.js                    Frontend state, charts, alerts, UI rendering
server.mjs                Local HTTP server, providers, analysis, calibration
tools/check-providers.mjs Provider smoke test helper
.env.example              Safe environment template
```

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
