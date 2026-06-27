# Historical Prediction Calibration Formulas

This document records the current local backtest and prediction-calibration logic used by `quant_core/historical_backtest.py`.

## Sampling Parameters

Default server batch settings:

| Parameter | Default | Meaning |
| --- | ---: | --- |
| `range` | `5y` | Daily candle history fetched per symbol |
| `horizons` | `5`, strategy horizon, `30` | Short/mid/long prediction tasks |
| `min_train` | `120` | Minimum fully-known prior labels before a cut is allowed |
| `step` | `4` batch / `5` single | Base sparse walk-forward step |
| `step_schedule` | `2,3,5,4` batch | Multiple step sizes used to enlarge historical cuts |
| `max_step_offsets` | `2` | For each step, use up to two offsets, then dedupe |
| `max_predictions` | `1400` | Maximum unique cuts per symbol per horizon |
| `retrain_interval` | `60` | Rolling model retraining bucket size |
| `max_train_window` | `240` | Recent labeled rows used by ridge/logistic heads |
| `knn_window` | `260` | Recent labeled rows used by KNN analog head |
| `embargo` | `ceil(horizon / 2)`, min `2` | Extra gap between train labels and prediction cut |

Multi-step sampling deduplicates by `(symbol, horizon, candle index/date)`. Repeated cut dates are not counted twice.

## No Future Leakage Rule

For prediction cut `t` and horizon `H`:

```text
train_row.index + H <= t - embargo
```

Features for cut `t` use only candles `<= t`.

Labels for a train row can use `t+1 ... t+H`, but the row is admitted into training only after its whole future window ended before the prediction date plus embargo.

The prediction cut's future outcome is used only for evaluation.

## Feature Formulas

```text
pct_change_n = (close[t] - close[t-n]) / close[t-n] * 100
sma20 = mean(close[t-19:t])
sma50 = mean(close[t-49:t])
volume20 = mean(volume[t-19:t])
volumeRatioRaw = volume[t] / max(1, volume20)
volatility = sqrt(mean(daily_return[t-19:t]^2))
rsi14 = 100 - 100 / (1 + avg_gain_14 / avg_loss_14)
macdHist = EMA12(close[:t]) - EMA26(close[:t]) - EMA9(MACD[:t])
rangePositionRaw = (close[t] - min(close[t-20:t])) / (max(close[t-20:t]) - min(close[t-20:t]))
```

Normalized model inputs:

```text
change1 = clamp(change1Raw / 10, -2.5, 2.5)
change3 = clamp(change3Raw / 15, -2.5, 2.5)
change5 = clamp(change5Raw / 20, -2.5, 2.5)
change10 = clamp(change10Raw / 25, -2.5, 2.5)
change20 = clamp(change20Raw / 35, -2.5, 2.5)
volumeRatio = clamp((volumeRatioRaw - 1) / 3, -2.5, 2.5)
rsi = clamp((rsi14 - 50) / 50, -2, 2)
macdHist = clamp((macdHistRaw / close[t]) * 20, -2.5, 2.5)
smaGap = clamp((sma20 / sma50 - 1) * 8, -2.5, 2.5)
volatility = clamp(volatilityRaw / 5, 0, 3)
rangePosition = clamp((rangePositionRaw - 0.5) * 2, -1.5, 1.5)
```

Composite technical scores:

```text
trendScore =
  clamp(
    50
    + (12 if close[t] > sma20 else -9)
    + (11 if sma20 > sma50 else -10)
    + clamp(change20Raw * 0.62, -9, 9),
    0,
    100
  )

momentumScore =
  clamp(
    50
    + macdHistRaw / close[t] * 9200
    + (rsi14 - 50) * 0.55
    + clamp(change5Raw, -6, 6) * 0.35
    + clamp(change20Raw * 0.12, -3, 3),
    0,
    100
  )

riskScore = clamp(82 - volatilityRaw * 8, 0, 100)
```

## Label Formulas

```text
entry = close[t]
forwardReturn = (close[t+H] - entry) / entry * 100
maxUpside = (max(high[t+1:t+H]) - entry) / entry * 100
maxDrawdown = (min(low[t+1:t+H]) - entry) / entry * 100
hitTarget = maxUpside >= targetUpside
hitStop = maxDrawdown <= -stopLoss
targetWins = hitTarget and target touch occurs before stop touch when both occur
stopWins = hitStop and stop touch occurs before target touch when both occur
riskAdjustedReturn = targetUpside if targetWins else -stopLoss if stopWins else forwardReturn
```

## Prediction Heads

Rolling supervised heads:

```text
ridge_final_return = ridge_regression(features -> forwardReturn)
ridge_risk_adjusted = ridge_regression(features -> riskAdjustedReturn)
targetProbability = 0.62 * logistic(features -> targetWins) + 0.38 * knn_target_rate
stopProbability = 0.62 * logistic(features -> stopWins) + 0.38 * knn_stop_rate
knn_analog = mean(forwardReturn of nearest historical feature vectors)
```

Rule-derived return heads:

```text
trend_momentum =
  change20Raw * 0.12
  + change5Raw * 0.18
  + (trendScore - 50) * 0.035
  + (momentumScore - 50) * 0.03
  + macdHist * 1.6

mean_reversion =
  clamp((50 - rsi14) * 0.075, -4.5, 4.5)
  - change5Raw * 0.18
  + (0.25 if change20Raw > -8 else -0.45)

volume_breakout =
  max(0, volumeRatioRaw - 1) * 1.35 * (1 if change5Raw >= 0 else -0.55)
  + change20Raw * 0.08
  + macdHist * 1.2

risk_guard =
  ridge_final_return
  - stopProbability * stopLoss * 0.9
  + (riskScore - 50) * 0.025

target_probability =
  (targetProbability - 0.5) * targetUpside * 2.2
  - max(0, stopProbability - 0.36) * stopLoss * 1.25
```

## Weight Learning

The calibration layer learns non-negative ensemble weights over prediction heads.

```text
combinedPrediction = sum(weight_i * headPrediction_i)
objective = minimize mean((combinedPrediction - actualForwardReturn)^2)
constraints = weight_i >= 0, sum(weight_i) = 1, per-head cap ~= 0.48
split = time ordered train 58%, validation 21%, test 21%
penalty grid = [0, 0.006, 0.02, 0.06, 0.14, 0.32]
```

Activation gate:

```text
active if:
  test rows >= 8
  and (
    MSE improvement vs equal-weight >= 2%
    and direction lift >= -1 percentage point
    and test direction hit >= 50%
  )
  or direction lift >= 3 percentage points
```

If the gate fails, the learned weights are stored as research evidence only and do not become active decision evidence.
