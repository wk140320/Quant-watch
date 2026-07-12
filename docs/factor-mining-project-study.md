# Factor Mining Project Study

Date: 2026-07-02

Goal: improve forecast precision by upgrading the factor-analysis and factor-mining layer with machine-learning backtests, dynamic factor weighting, redundancy control, and large-sample point-in-time validation.

## Executive Takeaway

The strongest open projects do not treat factors as static handcrafted scores. They separate the pipeline into:

1. Point-in-time data and labels.
2. Factor generation or mining.
3. Factor validation by IC, Rank IC, grouped return, turnover, and drawdown.
4. Redundancy and complexity control.
5. Model-based factor combination.
6. Walk-forward backtesting with transaction costs.
7. Dynamic reweighting when factor performance decays.

For our project, the next precision upgrade should be a local factor-mining control plane:

```text
raw data -> candidate factors -> quality gates -> IC/RankIC/ML backtest
-> non-redundant factor library -> dynamic factor weights
-> prediction ensemble and buy/sell gate
```

The key rule remains: a factor is not allowed into the active factor library unless it proves sample-out usefulness and non-redundancy.

## Projects Reviewed

| Project | What It Is Good At | What We Should Borrow |
|---|---|---|
| Microsoft Qlib | Full quant ML workflow: dataset, feature pipeline, model zoo, backtest, analysis, online workflow | Use as the reference architecture for point-in-time data, LightGBM/LSTM/Transformer model layer, and rolling workflow |
| Alphalens / Alphalens Reloaded | Factor tear sheets: returns, IC, turnover, grouped analysis | Use its factor-evaluation grammar as our factor scorecard |
| AlphaGen | Reinforcement-learning formulaic alpha generation with IC/Rank IC and alpha-pool evaluation | Use the idea of mining factor sets, not isolated factors |
| RD-Agent(Q) | Agentic factor-model co-optimization on top of Qlib | Use alternating optimization: improve factors, then improve model, then re-evaluate factors |
| vectorbt | Large-scale vectorized backtesting and parameter sweeps | Use vectorized batch backtesting for many factors and factor combinations |
| AlphaForge / AlphaEvolve / QuantaAlpha papers | Dynamic factor generation, recombination, complexity/redundancy control, temporal factor weighting | Use evolutionary search with strict validation gates, not free-form factor creation |

## 1. Microsoft Qlib

Qlib is the most relevant reference architecture because it covers the full workflow: data, model training, backtesting, evaluation, and deployment. Its README describes it as an AI-oriented quant platform with supervised learning, market dynamics modeling, reinforcement learning, alpha seeking, risk modeling, portfolio optimization, and order execution. It also exposes model workflows through `qrun`, including LightGBM on Alpha158, and provides model prediction analysis such as cumulative return by groups, return distribution, IC, monthly IC, and autocorrelation.

Important design points:

- Treat datasets as first-class objects.
- Use standardized factor datasets such as Alpha158 and Alpha360.
- Run models through repeatable workflow configs.
- Evaluate both prediction signal quality and portfolio output.
- Support model zoo comparison: LightGBM, XGBoost, LSTM, Transformer, DoubleEnsemble, TRA, TCN, and others.

How to apply:

```text
factor candidates -> Qlib-like dataset handler
-> LightGBM baseline
-> sequence models only after enough samples
-> report IC, Rank IC, grouped return, turnover, cost-aware backtest
```

Our implementation should not blindly copy Qlib internals. The practical move is to build a Qlib-compatible local factor table and optional Qlib runner, so Qlib becomes a benchmark/double-check layer while our local model remains primary.

Sources:

- https://github.com/microsoft/qlib
- https://arxiv.org/abs/2009.11189

## 2. Alphalens / Alphalens Reloaded

Alphalens is focused on evaluating predictive stock factors. Its core output is not a trading bot but a factor tear sheet. It highlights:

- Returns analysis.
- Information Coefficient analysis.
- Turnover analysis.
- Grouped analysis.
- Quantile forward returns.

This is exactly the layer our factor lab needs before adding factors into the model. A factor should not become active just because the expression looks financially reasonable. It should pass:

```text
IC mean > threshold
Rank IC mean > threshold
IC information ratio stable
top quantile return > bottom quantile return
turnover not too high
sector-neutral performance not collapsing
cost-adjusted performance still positive
```

How to apply:

- Add factor tear-sheet metrics to every mined factor.
- Add quantile-bucket return charts.
- Add IC decay by horizon: 1d, 5d, 15d, 30d.
- Add factor turnover and stability penalty.
- Keep Alphalens as evaluation grammar, not as the only engine.

Sources:

- https://github.com/quantopian/alphalens
- https://github.com/stefan-jansen/alphalens-reloaded

## 3. AlphaGen

AlphaGen is directly relevant to automatic factor mining. The project states that it generates formulaic alpha factors using reinforcement learning. Its README also describes an adapter interface for calculating:

- single-factor IC.
- single-factor Rank IC.
- mutual IC between two alphas.
- pool IC / Rank IC for a weighted alpha set.

This is important because single good factors are often redundant. The actual target should be a factor set that improves the downstream model.

How to apply:

```text
candidate factor expression
-> compute IC / Rank IC
-> compute mutual correlation with existing factors
-> compute marginal contribution to factor pool
-> accept only if marginal contribution survives walk-forward
```

AlphaGen also warns that factor values can have drastically different scales and recommends normalization before combination. That matches our current "dimensionless, standardization, extreme-value, missing-value" gate.

Sources:

- https://github.com/ICT-FinD-Lab/alphagen
- https://arxiv.org/abs/2306.12964

## 4. RD-Agent(Q)

RD-Agent(Q) is useful less as a direct library and more as an architecture. Its README describes a data-centric multi-agent framework for coordinated factor-model co-optimization. It reports about 2x higher ARR than benchmark factor libraries while using over 70% fewer factors, which is a strong signal that "more factors" is not the goal.

The lesson:

```text
factor mining and model training should alternate
```

Bad workflow:

```text
mine many factors -> dump into model -> hope accuracy rises
```

Better workflow:

```text
mine candidate factors
-> train model
-> inspect failed cases
-> revise factor hypothesis
-> remove redundant factors
-> retrain and validate
```

How to apply:

- Add a factor-mining agent that proposes factor hypotheses.
- Add a factor-implementation step that turns hypotheses into executable formulas.
- Add a model-evaluation step that checks whether the factor improves prediction.
- Add an error-analysis loop: failed predictions generate new factor hypotheses.

Sources:

- https://github.com/microsoft/RD-Agent
- https://arxiv.org/abs/2505.15155

## 5. vectorbt

vectorbt is not primarily a factor-mining project, but it is highly relevant for speed. It uses vectorized backtesting to run thousands of configurations quickly and supports large parameter sweeps, custom indicators, portfolio analytics, signal tooling, label generation, and walk-forward optimization.

The lesson:

```text
factor mining needs fast batch evaluation
```

If every factor is evaluated one by one through slow UI refreshes, the system cannot gather enough evidence. We should use vectorized local arrays:

```text
N symbols x T dates x F factors
```

Then run:

- factor IC over all symbols and dates.
- quantile return spreads.
- turnover and cost.
- walk-forward splits.
- factor-combination grid or Bayesian search.

Sources:

- https://github.com/polakowo/vectorbt

## 6. AlphaForge, AlphaEvolve, QuantaAlpha

These papers are useful for the next generation of our factor miner.

AlphaForge proposes two stages:

```text
generate formulaic alpha factors
then dynamically combine factors based on temporal performance
```

AlphaEvolve emphasizes weakly correlated factors and pruning redundant alphas. QuantaAlpha emphasizes trajectory-level mutation and crossover, semantic consistency, complexity control, and redundancy constraints.

The common lesson:

```text
factor mining must optimize diversity + robustness, not just in-sample score
```

How to apply:

- Every factor has a hypothesis.
- Every factor has an executable expression.
- Every expression has complexity score.
- Every factor is checked for correlation / mutual IC against existing factors.
- Factor weights decay if recent OOS IC falls.
- Factor weights recover only after walk-forward evidence improves.

Sources:

- https://arxiv.org/abs/2406.18394
- https://arxiv.org/abs/2103.16196
- https://arxiv.org/abs/2602.07085

## Recommended Architecture For Our Project

### A. Factor Candidate Store

Each factor candidate should be stored as:

```json
{
  "id": "factor_id",
  "name": "factor_name",
  "hypothesis": "why it may predict return",
  "expression": "formula",
  "inputs": ["close", "volume", "buyPressure5"],
  "horizon": [1, 5, 15, 30],
  "market": ["ASX", "US", "CN"],
  "sector_scope": ["all", "technology", "banks"],
  "created_at": "...",
  "status": "candidate|active|rejected|decayed"
}
```

### B. Factor Quality Gate

Before backtesting:

```text
dimensionless: pass/fail
missing value rate: pass/fail
extreme value winsorization: pass/fail
standardization: pass/fail
future leakage audit: pass/fail
duplicate/correlation audit: pass/fail
```

### C. Factor ML Backtest

For each factor and factor set:

```text
labels:
  future_return_1d
  future_return_5d
  future_return_15d
  max_upside_15d
  max_drawdown_15d
  target_before_stop

models:
  ridge / elastic net baseline
  LightGBM baseline
  optional LSTM/Transformer after data volume is large
  factor-only model
  factor + technical model
  factor + news/social model
```

Split:

```text
rolling walk-forward
purged labels
embargo gap
market / sector / horizon buckets
```

### D. Dynamic Factor Weighting

For each active factor:

```text
base_score =
  IC_mean * 0.30
  + RankIC_mean * 0.25
  + quantile_spread * 0.20
  + model_gain * 0.15
  - turnover_cost_penalty * 0.10
  - redundancy_penalty
  - decay_penalty

active_weight = softmax(base_score / temperature)
```

But weights cannot be purely formulaic. They must be validated by:

```text
does factor improve out-of-sample model?
does factor improve target-before-stop probability?
does factor reduce drawdown or only increase churn?
does factor work outside one stock/one week?
```

### E. Factor Admission Rule

A new mined factor enters the active library only if:

```text
quality gate passed
IC/RankIC positive in at least 2 horizons or 2 market regimes
mutual correlation with active factors below threshold
walk-forward model gain positive
cost-adjusted factor portfolio not worse
no future-function risk
```

Suggested initial thresholds:

```text
abs(correlation with existing active factor) < 0.72
mutual IC redundancy < 0.65
min walk-forward windows >= 6
min symbols per market bucket >= 30 when available
factor turnover below configurable cap
```

## First Implementation Plan

1. Add local factor candidate registry.
2. Add factor tear-sheet metrics: IC, Rank IC, quantile returns, turnover, grouped analysis.
3. Add factor redundancy engine: Pearson/Spearman correlation, mutual IC, family tags.
4. Add ML backtest for factor sets: ridge and LightGBM first.
5. Add dynamic factor weight table and log every factor weight update.
6. Add UI page section: factor leaderboard, rejected factors, decayed factors, active weights.
7. Add evolutionary miner only after the evaluation layer is stable.

## Precision Priority

The biggest accuracy gain should come from:

1. Cleaner point-in-time data.
2. More historical slices.
3. Separate short/mid/long horizon factor models.
4. Non-redundant factor set selection.
5. Cost-aware walk-forward validation.
6. Dynamic factor decay handling.
7. Strict rejection of factors that only work in-sample.

The next coding step should be the factor candidate registry plus a factor tear-sheet engine. That gives every current and future factor a measurable pass/fail path before it can influence buy signals.
