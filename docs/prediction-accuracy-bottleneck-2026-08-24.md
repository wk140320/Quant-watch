# Prediction Accuracy Bottleneck Diagnosis

Date: 2026-08-24 (Australia/Sydney)

## Decision

The project is no longer blocked by raw OHLCV row count. The latest three-market runs each fitted more than 700,000 rows and evaluated 198 untouched meta-test dates, yet every market still abstained on the direction family and closed the long-trade gate. The remaining bottleneck is independent signal quality and training-task alignment, not a need to repeat the same fit.

No current result supports a Production promotion. The changes in this upgrade preserve that conclusion and remove two mechanisms that could hide or suppress useful evidence.

The training supervisor has also been reconciled against the immutable job artifacts. Its previous `33/100`, `0 rows` result was a transport defect: the fast SQLite task index intentionally omitted the full `productionTraining` payload, but the supervisor treated that compact row as the complete artifact. Completed jobs now hydrate the persisted JSON result before evaluation. The corrected supervisor evidence is ASX `56/100` with 703,491 rows, US `56/100` with 773,539 rows, and CN `59/100` with 712,455 rows. These higher scores correct the evidence display; they do not mean the models passed.

## Latest Strict Evidence

| Market | Symbols | Fitted rows | OOF rows | Meta-test dates | Direction BA | Direction BSS | Probability buckets | Top10 direction | Top10 lift vs universe return | Long gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ASX | 348 | 703,491 | 198,179 | 198 | 51.72% | -0.0147 | 2 | 46.22% | +0.4933 pp | Closed |
| US | 396 | 773,539 | 225,665 | 198 | 50.23% | +0.0004 | 2 | 50.08% | -0.0766 pp | Closed |
| CN | 396 | 712,455 | 233,810 | 198 | 51.45% | -0.0088 | 2 | 46.99% | +0.3005 pp | Closed |

These are Research/Partial candidates. Direction probabilities occupy only two effective buckets, so they do not yet provide enough probability resolution for a reliable confidence statement.

## Verified Root Causes

### 1. A linear gate suppressed all direction model families

Feature-profile selection used a small inner Logistic experiment. When Logistic failed the null comparison, the fold removed Ridge, ElasticNet, CatBoost direction and direction-ranker outputs together. This treated “linear signal not proven” as “no model family can have signal.” The latest OOF artifacts therefore contain no tree direction probabilities even though CatBoost completed without a native-library error.

This upgrade separates the responsibilities:

- the feature-profile gate now applies only to linear direction heads;
- path, ranking, return and event experts retain the shared feature panel;
- CatBoost/LightGBM direction outputs survive a linear null result;
- strict meta-train OOF selection still decides whether the tree expert is retained;
- the untouched meta-test and Production thresholds remain unchanged.

### 2. Ranking was forced to choose a least-bad candidate

The ranking selector always admitted the legacy path ranker. A model could therefore remain `AVAILABLE` even when it had no positive direction lift or cost-adjusted lift. This explains why the page could show a ranking model while long-only Top10 remained below 50%.

This upgrade adds:

- `universeDirectionRatePct` and `top10DirectionLiftPct`;
- a true `null/no-model` ranking outcome;
- a requirement for positive direction lift and cost-adjusted lift in at least three of four purged inner windows;
- preregistered rank-orientation candidates selected only on inner OOF data;
- a hard `rankingModelEligible` Production check.

### 3. More rows did not create more independent information

The current features are still dominated by related OHLCV transformations. Different algorithms see similar information and make correlated errors. Millions of overlapping stock-date rows do not equal millions of independent market regimes.

The next gain must come from distinct, point-in-time information and task-specific experts, not more MACD or momentum variants.

### 4. Data quality differs materially by market

| Market | PIT coverage | Historical universe | Company actions | Actionable fundamentals | Known-sector rows | Main gap |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| ASX | 67.56% | 60.60% | 82.43% | 2.00% | 2.11% | Fundamentals, industry identity, historical membership |
| US | 73.64% | 98.19% | 82.94% | 74.25% | 3.17% | Asset classification and industry identity |
| CN | 72.90% | 100.00% | 87.99% | 73.00% | 100.00% | Signal stability, label fit and execution semantics |

ASX and US cannot yet support trustworthy sector-residual specialists. CN has broader semantic coverage, but its current five-day signal remains weak, so simply adding more rows is unlikely to solve it.

### 5. Event and regime outputs currently add little independent skill

Existing OOF diagnostics show compressed event/regime probabilities and near-zero or negative Brier skill. Event coverage is not the same as event predictability. An event expert must abstain when there is no fresh, attributable event and must prove marginal OOF gain before entering an ensemble.

### 6. Task evidence was being truncated between training and supervision

The task centre uses a compact index so its page can load without parsing multi-megabyte OOF artifacts. The supervisor read that index first and did not hydrate the completed job, producing false zero-sample failures. The service now loads the immutable job artifact whenever a completed index row has no `result`, and the supervisor independently retries with `includeResult` before evaluating. A regression test covers this exact compact-index/full-artifact handoff.

## Next Training Contract

The next run must use a new training signature and may not reuse the old score as evidence of improvement. It should be evaluated in this order:

1. Confirm tree direction predictions are present in every eligible outer fold.
2. Compare Ridge, ElasticNet and tree direction heads separately on strict OOF.
3. Require the selected direction family to beat the training-date prior across the required windows.
4. Require the ranking head to have positive Top10 direction lift and positive cost-adjusted return lift in at least three of four inner windows.
5. Keep the long gate closed unless BA, Brier skill, probability resolution, Top10, EV and stability all pass together.
6. Do not promote solely because absolute Accuracy or one Top10 point estimate improves.

## Highest-Value Next Data Work

1. ASX: parse official annual, half-year, 4D/4E and 5B announcements into row-level PIT fundamentals; add historical sector and membership identity.
2. US: classify common stock, ADR, ETF, CEF, preferred, warrant and SPAC before training; rebuild GICS/SIC mappings.
3. CN: keep the broad industry map, but compare 5/10/20-day labels and market-residual tasks on the same frozen folds.
4. All markets: cluster duplicated news, preserve first-publication time and train sparse event experts that can abstain.
5. All markets: record every failed candidate and use conditional marginal OOF gain, rather than model count, as the admission rule.

## What Counts As Progress

A retrain is progress only if the candidate is comparable to the frozen baseline and improves out of sample. At minimum, report:

- Balanced Accuracy and MCC relative to the majority baseline;
- Brier Skill and probability resolution;
- Top10 direction lift relative to the same-date universe;
- Top10 cost-adjusted return lift and drawdown;
- positive rolling windows;
- independent dates and block-bootstrap confidence intervals;
- model-family availability and marginal contribution.

If the next strict run still produces no direction model, that is a valid result: the five-day task has not demonstrated usable signal. The correct response is to switch the label or horizon under a new lockbox, not to lower the gate.
