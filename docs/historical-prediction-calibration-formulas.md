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
gapRaw = (open[t] - close[t-1]) / close[t-1] * 100
bodyPositionRaw = (close[t] - open[t]) / max(high[t] - low[t], eps)
closeLocationRaw = ((close[t] - low[t]) / max(high[t] - low[t], eps) - 0.5) * 2
trueRangeRaw = (high[t] - low[t]) / low[t] * 100

buyPressureRaw =
  if buyVolume/sellVolume exists:
    (buyVolume[t] - sellVolume[t]) / max(buyVolume[t] + sellVolume[t], eps)
  else:
    closeLocationRaw * 0.55 + bodyPositionRaw * 0.45

buyPressure5Raw = volume_weighted_mean(buyPressureRaw[t-4:t])
buyPressure20Raw = volume_weighted_mean(buyPressureRaw[t-19:t])
pressureChangeRaw = buyPressure5Raw - buyPressure20Raw
volumeAccelRaw = mean(volume[t-4:t]) / mean(volume[t-19:t]) - 1
volumeTrendRaw = mean(volume[t-19:t]) / mean(volume[t-49:t]) - 1
rollingVWAP20 = sum(typicalPrice[i] * volume[i]) / sum(volume[i]), i=t-19..t
profileDistanceRaw = (close[t] - rollingVWAP20) / rollingVWAP20 * 100
profileSkewRaw = volume_weighted_skew(typicalPrice[t-19:t])
profilePocDistanceRaw = (close[t] - pointOfControl[t]) / pointOfControl[t] * 100 when price levels exist
profileImbalanceRaw = (buyVolumeAtLevels - sellVolumeAtLevels) / totalLevelVolume when price levels exist
liquidityShockRaw = abs(change1Raw) * max(0, volumeRatioRaw - 1)
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
gap = clamp(gapRaw / 10, -2, 2)
bodyPosition = clamp(bodyPositionRaw, -2, 2)
closeLocation = clamp(closeLocationRaw, -1.5, 1.5)
trueRange = clamp(trueRangeRaw / 10, 0, 3)
buyPressure = clamp(buyPressureRaw, -1.5, 1.5)
buyPressure5 = clamp(buyPressure5Raw, -1.5, 1.5)
pressureChange = clamp(pressureChangeRaw, -1.5, 1.5)
volumeAccel = clamp(volumeAccelRaw / 2, -2.5, 2.5)
volumeTrend = clamp(volumeTrendRaw / 2, -2.5, 2.5)
profileDistance = clamp(profileDistanceRaw / 8, -2.5, 2.5)
profileSkew = clamp(profileSkewRaw / 3, -2.5, 2.5)
profilePocDistance = clamp(profilePocDistanceRaw / 8, -2.5, 2.5)
profileImbalance = clamp(profileImbalanceRaw, -1.5, 1.5)
liquidityShock = clamp(liquidityShockRaw / 10, 0, 3)
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

trendQuality =
  clamp((trendScore - 50) * (1 - clamp(volatilityRaw / 18, 0, 0.75)) / 25, -2.5, 2.5)

factorQualityRaw =
  clamp(
    (trendScore - 50) * 0.18
    + (momentumScore - 50) * 0.16
    + (riskScore - 50) * 0.10
    + buyPressure5Raw * 8
    + clamp(profileDistanceRaw, -5, 5) * 0.45,
    -25,
    25
  )

factorQuality = clamp(factorQualityRaw / 25, -2.5, 2.5)
reversalPressure = clamp(-buyPressure5Raw when sign(change5Raw) != sign(buyPressure5Raw), -1.5, 1.5)
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
ambiguousBarrierOrder = one OHLC bar touched both target and stop, so intrabar order is unknowable
riskAdjustedReturn = targetUpside if targetWins else -stopLoss if stopWins else forwardReturn
```

When `ambiguousBarrierOrder=true`, neither `targetWins` nor `stopWins` is treated as a clean class label. The sample is retained for chronological continuity but receives a lower label-confidence weight. This removes an optimistic bias from daily bars where the high and low crossed both barriers on the same date.

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

orderflow_pressure =
  buyPressure5Raw * 4.2
  + pressureChange * 3.1
  + closeLocation * 0.7
  + volumeAccelRaw * 0.9

volume_profile =
  -profileDistanceRaw * 0.42
  + profileSkew * 0.55
  + profilePocDistance * 0.38
  + profileImbalance * 2.2

factor_quality =
  factorQualityRaw * 0.14
  + trendQuality * 1.3
  - liquidityShock * 0.25

liquidity_reversal =
  -change5Raw * 0.12
  + reversalPressure * 2.7
  + volumeAccelRaw * 0.8
  - trueRange * 0.35
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

## Adaptive Micro-tuning After Resolved Forecasts

When a live prediction becomes resolvable, the system records the forecast miss and computes a capped adjustment scale:

```text
forecastError = abs(predictedReturn - actualForwardReturn)
missSeverity =
  I(missed) + 0.6 * I(interimAdverse)
  + max(0, -actualForwardReturn) / 8
  + max(0, -maxDrawdown) / 12

adjustmentScale =
  clamp(0.02 + forecastError * 0.012 + missSeverity * 0.035, 0.02, 0.22)
```

The scale is not fixed: a small miss is logged as evidence, while a large miss can shrink future upside estimates and confidence more strongly. The cap prevents one bad trade from overfitting the whole model. Each adjustment is appended to the model change log with the affected symbol, horizon, error, scale, and transfer scopes.

## Explainability Surface

The dashboard now exposes a model parameter map under `预测学习与准确率 > 模型调整`.

It combines:

- Local linear/logistic model coefficients.
- LightGBM or tree-model feature importance when available.
- Historical walk-forward ensemble weights by horizon.
- The formula catalog above, plus the reason each feature is allowed into the model.

This view is diagnostic only. A high displayed weight means the feature is influential in the current local model evidence; it does not bypass the out-of-sample gate.

## Data Quality And Label Confidence

Historical calibration now uses quality-weighted learning. The goal is to keep chronological continuity while reducing the influence of questionable rows.

```text
candleQualityWeight = clamp(candleScore / 100, 0.12, 1.0)

candleScore penalties:
  non_positive_price
  ohlc_range_inconsistent
  zero_volume
  volume_spike
  extreme_return
  possible_split_or_provider_jump
  stale_close_low_volume
  large_calendar_gap
```

```text
labelConfidence =
  0.34
  + min(current/future candle weights) * 0.42
  + average future candle weight * 0.18
  - near_barrier_boundary penalty
  - both_target_and_stop_touched penalty
  - incomplete_future_window penalty

sampleWeight = min(candleQualityWeight, labelConfidence)
```

The following training and evaluation layers consume `sampleWeight`:

- rolling Ridge return heads
- rolling Logistic target/stop heads
- KNN historical analog averages
- prediction-head ensemble weight fitting
- calibration buckets and Brier summaries

This means a label can only become highly trusted when the data row itself is clean and the future label window is not ambiguous.

## Model Zoo Committee

The local Python layer now trains a challenger committee on resolved prediction samples. It is separate from the historical OHLCV method weights above: the historical layer asks "which prediction formula worked on old candles?", while the model zoo asks "which live prediction model family worked on our resolved prediction records?"

Candidate families:

```text
stored_ensemble = original live ensemble prediction saved at forecast time
technical_ridge = ridge(features: trend, momentum, RSI, volume, risk, gap)
factor_ridge = ridge(features: factor, news/social/macro/sector/liquidity/calibration)
orderflow_profile_ridge = ridge(features: buyPressure, pressureChange, volumeAccel, profileDistance)
wide_regularized_ridge = ridge(all stable technical + factor + agreement features)
target_stop_meta = logistic(P target-before-stop) and logistic(P stop-first), mapped to expected return
sequence_state_proxy = lightweight trend/pressure/volume state proxy until LSTM/Transformer has enough data
tree_boosting_return = optional LightGBM/sklearn gradient boosting challenger when importable
```

All candidates use the same purged time split:

```text
train -> validation -> test
weights are learned on validation only
test is untouched holdout
```

Model-zoo ensemble objective:

```text
zooPrediction = sum(weight_i * candidatePrediction_i)
objective = minimize mean((zooPrediction - actualForwardReturn)^2)
constraints = weight_i >= 0, sum(weight_i) = 1
```

Activation gate:

```text
active if:
  test window exists
  validation direction hit >= 48%
  and (
    test MSE improves vs equal weight >= 1%
    or test MSE improves vs stored ensemble >= 1%
    or direction lift vs equal/stored >= 3 percentage points
  )
  and test direction hit is not materially worse than equal/stored baselines
```

If the committee fails this gate, its weights and leaderboard are shown as research evidence only. It cannot increase live confidence.

External/open-source challengers are capped:

```text
self-built/local model share >= 88% inside model-zoo deployment weights
external/open-source challenger share <= 12%
single external challenger share <= 8%
```

This means LightGBM/sklearn, Qlib-style, or other project adapters can confirm or challenge the local forecast, but they do not become the primary predictor.

## Reject-Prediction Gate

The committee also computes per-row prediction dispersion:

```text
dispersion_t = weighted_std(candidatePrediction_i,t)
threshold = validation/test dispersion percentile around 72%
```

When live committee dispersion is above the learned threshold, the quality gate treats the setup as high disagreement:

```text
high dispersion -> lower confidence or block high-conviction buy
```

This is intentionally conservative. It improves precision by refusing ambiguous setups rather than forcing a forecast every time.

## Prediction Weight Stability Gate

Historical method weights now need to pass a rolling later-period stability gate before they can raise live confidence.

For each fold:

```text
fit_rows = prediction cuts before the fold validation segment
validation_rows = tail of fit history
test_rows = current later fold

weights = argmin weighted_mse(fit_rows, validation_rows)
mseImprovementPct = (mse(equalWeight) - mse(weights)) / mse(equalWeight) * 100
directionLiftPct = directionHit(weights) - directionHit(equalWeight)
```

Across folds:

```text
weightDrift = mean(sum(abs(weight_i,fold - avgWeight_i)))

stabilityScore =
  52
  + avgMseImprovementPct * 0.9
  + avgDirectionLiftPct * 1.7
  + (positiveMseFoldShare - 0.5) * 24
  + (positiveDirectionFoldShare - 0.5) * 20
  - weightDrift * 18
```

Deployment gate:

```text
stable =
  stabilityScore >= 52
  and avgMseImprovementPct >= -1.5
  and avgDirectionLiftPct >= -1.5
  and minDirectionHitRate >= 42
  and weightDrift <= 0.52
```

If this gate fails, the optimized weights remain visible as research evidence but are not used to increase high-conviction forecasts.

## Short-History Protection

New listings and recently renamed tickers cannot provide a reliable historical learning set. The app uses:

```text
minimumUsableCandles = 10
fullHistoryCandles = 35
```

Rules:

```text
candles < 10:
  reject analysis as insufficient real data

10 <= candles < 35:
  allow limited technical display
  disable historical analog/self-supervised backtest
  set marketValidation.shortHistory = true
  cap confidence <= 55
  block buyEligible
```

This is why a new stock such as SPCX can show price/volume/MACD but should not receive a high-confidence buy label until enough point-in-time history exists.

## Sample Coverage / OOD Gate

The historical learner now estimates whether the current feature vector is covered by prior point-in-time samples.

Distances are measured after feature normalization:

```text
distance(x_t, x_i) = sqrt(mean((standardize(x_t) - standardize(x_i))^2))
```

For the selected nearest-neighbor set:

```text
nearestDistance = min(distance)
avgNeighborDistance = mean(distance_topK)
p75NeighborDistance = percentile75(distance_topK)
sampleBonus = min(8, log10(trainSampleCount) * 3.5)

coverageScore =
  clamp(
    104
    - nearestDistance * 24
    - avgNeighborDistance * 31
    - p75NeighborDistance * 11
    + sampleBonus,
    0,
    100
  )

coverageWeight = clamp(0.22 + coverageScore / 100 * 0.78, 0.22, 1.0)
oodRisk = 1 - coverageScore / 100
```

Training/calibration use:

```text
effectiveSampleWeight = dataQualityWeight * labelConfidence * coverageWeight
```

Live high-conviction use:

```text
if coverageScore < 45:
  samplePower is reduced
  positive buy eligibility is blocked
  confidence cap is lowered
```

The goal is precision, not forced coverage. If the current setup is out-of-distribution, the model should say "I do not have enough comparable evidence" instead of inventing certainty.

## Regime-Bucket Calibration

Historical prediction cuts are also grouped by market state visible at the prediction date.

Bucket rules:

```text
if coverageScore < 40:
  low_coverage
elif riskScore < 48 or abs(change5) >= 8 or volumeRatio >= 3.2:
  volatile
elif rsi >= 72 or (change5 >= 6 and trendScore >= 60):
  overextended
elif trendScore >= 62 and momentumScore >= 56 and change20 >= 2:
  uptrend
elif trendScore <= 42 and change20 <= -2:
  downtrend
elif volumeRatio >= 1.35 and change5 >= 0 and momentumScore >= 52:
  volume_breakout
else:
  range
```

For each bucket:

```text
bucketTargetHitRate = weighted_mean(targetWins)
bucketStopRate = weighted_mean(stopWins)
bucketDirectionHitRate = weighted_mean(sign(predictedReturn) == sign(actualFinalReturn))
bucketAvgReturn = weighted_mean(actualFinalReturn)
bucketScore = (targetHitRate - 52) / 3.5 + avgReturn * 0.25 - stopRate * 0.04
```

The live/current bucket is evaluated separately:

```text
if matched bucket has enough effective samples and:
  targetHitRate < 50
  or stopRate > 48
  or avgReturn < 0:
    penalize historical backtest factor score
```

This avoids using a broad average when the current regime historically underperformed.

## Conformal Residual Calibration

For every point-in-time historical prediction:

```text
finalReturnError_t = abs(predictedFinalReturn_t - actualFinalReturn_t)
riskAdjustedError_t = abs(predictedReturn_t - actualRiskAdjustedReturn_t)
maxUpsideError_t = abs(predictedMaxUpside_t - max(0, actualMaxUpside_t))
targetProbabilityError_t = abs(targetProbability_t - targetWins_t)
```

Weighted empirical quantiles:

```text
P80 = weighted_quantile(finalReturnError, sampleWeight, 0.8)
P90 = weighted_quantile(finalReturnError, sampleWeight, 0.9)

interval80 = [prediction - P80, prediction + P80]
interval90 = [prediction - P90, prediction + P90]
```

Uncertainty score:

```text
uncertaintyScore =
  clamp(
    100
    - finalReturnAbsErrorP80 * 7.5
    - finalReturnAbsErrorP90 * 3.2
    - directionMissRate * 22,
    0,
    100
  )
```

Historical factor penalty:

```text
conformalPenalty =
  max(0, finalReturnAbsErrorP80 - 2.4) * 0.22
  + max(0, finalReturnAbsErrorP90 - 4.2) * 0.12
```

The model may still predict direction, but wide residual bands prevent a narrow high-confidence magnitude label.

## Path-Noise Label Quality

The label-quality layer measures whether a completed future window is a clean training label or a noisy path:

```text
pathVolatility = stdev(close-to-close returns inside future window)
pathChopRatio = sum(abs(dailyReturn)) / max(abs(forwardReturn), 0.35)
twoSidedExcursionRatio =
  min(maxUpside / targetUpside, abs(maxDrawdown) / stopLoss)
directionFlips = sign changes of cumulative return inside the horizon
```

Penalty flags:

```text
same_bar_barrier_order_unknown
final_return_inconclusive
high_path_chop
two_sided_excursion
frequent_direction_flips
high_path_volatility
```

These flags lower `labelConfidence` and increase `labelNoiseScore`. Ridge, logistic, KNN analogs, method-weight calibration, residual calibration, and reported historical metrics use the reduced `sampleWeight`.

Leakage rule: path-noise metrics are computed only for historical labels whose full future horizon is complete. They are never computed for the live prediction row.

## Weighted Wilson Reliability Interval

Backtest hit rates are point estimates. A 62% hit rate with a small or low-quality sample should not be treated the same as a 62% hit rate with many independent high-quality samples. The reliability gate computes weighted Wilson intervals:

```text
weights = sampleWeight
effectiveN = (sum(weights)^2) / sum(weights^2)
p = weighted_mean(binaryOutcome)
z = 1.64485  # two-sided 90% interval

denominator = 1 + z^2 / effectiveN
center = (p + z^2 / (2 * effectiveN)) / denominator
margin = z * sqrt((p * (1-p) + z^2/(4*effectiveN)) / effectiveN) / denominator

lowerBound = center - margin
upperBound = center + margin
```

Computed intervals:

```text
target.lowerBound = conservative lower bound for target-before-stop rate
stop.upperBound = conservative upper bound for stop-before-target rate
direction.lowerBound = conservative lower bound for direction hit rate
```

Reliability score:

```text
score = 100
  - max(0, 55 - targetLowerBound) * 1.25
  - max(0, 52 - directionLowerBound) * 0.8
  - max(0, stopUpperBound - 52) * 0.9
  - max(0, 14 - effectiveN) * 2.15
  - max(0, targetMargin - 16) * 0.75
```

High-confidence labels require not only strong observed hit rates, but also acceptable lower/upper statistical bounds.
