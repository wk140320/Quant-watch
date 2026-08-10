# P0-P2 completion and evidence boundary

Updated: 2026-08-04 (Australia/Sydney)

## Outcome

The P0, P1, and P2 implementation paths are complete. This means the system can now build, register, compare, reject, and report models without allowing failed research artifacts to affect live confidence or Paper Agent entries. It does not mean that a production Champion has been proven.

The current ASX five-day Challenger remains in Research/Shadow because it failed deterministic production gates. US and CN also remain without an approved Champion. The correct live behavior is therefore No Trade or conservative legacy display with zero learned-model execution weight.

## P0: freeze, isolate, and reject

- Model versions are immutable and separated into latest run, strongest Challenger, frozen baseline, and explicitly approved Champion.
- A newer but worse training run cannot replace the strongest Challenger or Champion.
- Strict OOF failure, missing Champion, stale data, and missing model evidence force No Trade for Paper Agent entries.
- Local model heads, model-zoo predictions, factor scores, and external AI overlays cannot bypass the production gate.
- Rules and manually configured weights are retained only as transparent Research/Shadow features. They are not described as learned probabilities.
- Duplicate market/symbol/bar decisions are rejected, and market switches cannot reuse another market's model gate.

## P1: point-in-time data and reproducible inputs

- OHLCV is stored under `market/exchange/interval/symbol`, with adjusted OHLC values derived consistently from adjusted close.
- The local data lake currently contains about 2.02 million OHLCV rows: ASX 540,357; US 428,485; CN 1,054,734.
- PIT data is stored in separate fundamentals, corporate-actions, news, social, and universe-history layers with `available_at` timestamps.
- Feature matrices, label inputs, PIT coverage, universe version, corporate-action version, and adjustment policy are included in the data-version hash.
- Current-universe snapshots are explicitly marked as historically unverified and cannot backfill past index membership.
- The partition audit identifies a dataset by market, exchange, and symbol. Multiple valid real sources for the same identity are permitted and preserved.
- Cross-market or unverifiable partitions are quarantined. Valid multi-source partitions previously quarantined by the old source-sensitive rule are recovered automatically.
- Actual historical PIT coverage is reported honestly. Current ASX historical-universe and verified corporate-action coverage are still insufficient, so event features remain disabled in production training.

## P2: five-day market Challenger

The completed ASX five-day run used:

- 200 stocks.
- 456,969 training rows.
- 116,710 strict OOF rows.
- 198 final test dates.
- Five purged walk-forward folds.

Selected test evidence:

| Metric | Result | Gate |
| --- | ---: | --- |
| Accuracy | 59.28% | Diagnostic only |
| Balanced accuracy | 57.30% | Primary direction evidence |
| F1 | 47.80% | Failed to show balanced class quality |
| Brier Skill Score | -0.0012 | Failed; must be greater than zero |
| ECE | 7.74% | Failed; must be at most 5% |
| Calibration slope | 1.313 | Failed; required range 0.8-1.2 |
| Positive folds | 2/5 | Failed; required at least 4/5 |
| Top 10% direction accuracy | 79.48% | Research evidence only |

The attractive Top-10% slice is not sufficient to promote the model because calibration and fold stability failed. It remains a Challenger and has no authority to increase live confidence.

## Dual-level factor research

Factor research now has two independent scopes.

### Market scope

The ASX cross-sectional run used 178 stocks, 403,257 panel rows, and 2,466 dates. It used a purged date split, five walk-forward folds, transaction costs, correlation clustering, residualization, and strict OOS admission.

The combined model had positive Rank IC and four positive folds, but its direction hit rate did not beat the simple momentum benchmark. It therefore admitted zero factors for live weighting.

### Stock scope

BHP, CBA, CPU, CAR, and MIN were each evaluated with about 2,515 five-day samples from complete local history. Each stock has its own immutable factor artifact and can never borrow another stock's evidence.

All five currently admit zero factors for live weighting. CBA reached 56.89% direction accuracy but failed the MAE-improvement gate; weaker stocks failed additional direction, IC, stability, or net-cost gates.

At inference time the system can display both market and stock evidence. A stock-specific score is blended with market context only after both evidence objects are available, but the resulting live weight remains zero until an approved market Champion and strict factor gates both exist.

## Remaining external evidence blockers

These are data acquisition and observation requirements, not unfinished gate code:

- Verified historical index membership, delistings, and corporate actions.
- Sufficient point-in-time fundamentals, filings, news, and social history.
- At least four positive OOF folds with Brier Skill above zero and ECE at or below 5%.
- US and CN market-level training runs at the same standard.
- Shadow/Paper observation sufficient for Agent promotion.

Until those conditions are met, the stable and honest result is Research/Shadow plus No Trade, not a higher displayed confidence.
