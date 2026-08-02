# 市场级多任务预测、OOF 集成与生产门控

本文描述代码中已经实现的训练路径，以及仍需补齐的数据条件。它不是收益承诺；任何候选模型都只能先进入 Research/Shadow，不能因为单次回测表现好就自动进入 Production。

## 1. 最终训练链路

```text
point-in-time 市场面板
  -> 5d / 15d / 30d 独立标签与训练集
  -> Purged Walk-forward 基础模型 OOF 预测
  -> 残差相关性去重
  -> 非负、限权、向等权收缩的 Stacking
  -> Platt / Isotonic 概率校准
  -> Conformalized Quantile 收益区间
  -> EV、数据质量、漂移与拒绝交易闸门
  -> Research -> Shadow -> Paper Champion -> Production Champion
```

实现入口：

- `quant_core/production_training.py`：市场级数据集、模型、OOF、校准、生产证据。
- `quant_core/historical_backtest.py`：单票历史切片、基础特征与旧模型对照。
- `quant_core/worker.py`：`production-model-train` 与批量训练入口。
- `server.mjs`：异步作业、行情抓取额度、版本注册、日志和 OOF 路径。

## 2. 多任务目标

每个市场分别训练 5、15、30 日模型，不跨周期复用最终权重。

| 任务 | 标签/输出 | 作用 |
| --- | --- | --- |
| 横截面排序 | 同一交易日未来净收益 rank | 选出相对更值得买的股票 |
| 路径分类 | target-first / stop-first / timeout | 判断收益实现路径与先止损风险 |
| 收益分位数 | P10 / P50 / P90 | 给出收益范围，不只给点预测 |
| 事件专家 | 新闻、公告、财报、宏观 PIT 特征 | 提供与 OHLCV 不同的信息来源 |
| 市场状态 | 趋势、震荡、高波动、risk-off | 只控制权重/拒绝，不制造高置信信号 |

最终净期望：

```text
EV = P(target) * target_gross_return
   - P(stop) * stop_gross_loss
   + P(timeout) * timeout_expected_gross_return
   - fees
   - slippage
```

`P(target)`、`P(stop)`、`P(timeout)`由独立路径模型输出后归一化。相同 K 线内同时触达止盈和止损时标记为 `ambiguous`，不会伪装成成功或超时样本。

## 3. 标签与成交时点

信号由交易日 `t` 收盘数据生成，历史标签不能按 `t` 的收盘价成交。代码使用：

```text
entry(t) = next_session_vwap, if verifiable
         = next_session_open, otherwise
```

止盈和止损障碍随股票波动与周期调整：

```text
target_barrier = max(0.55 * strategy_target,
                     2.35 * ATR14_pct * sqrt(horizon / 15))

stop_barrier   = max(0.55 * strategy_stop,
                     1.65 * ATR14_pct * sqrt(horizon / 15))
```

上限用于避免极端 ATR 把标签推到几乎不可能触达的位置。交易费用按市场单独配置，并只扣一次。

## 4. 样本数量与真实含义

系统同时报告：

- `rawRows`：重叠的 `date x symbol x horizon` 训练行。
- `effectiveWeightedRows`：按数据质量权重计算的 Kish 有效样本量。
- `independentDateBlocks`：按预测周期切成的非重叠时间块。
- `positiveEventCount`、`stopEventCount`：真实路径事件数。
- `rawRowsPerHorizon`：5/15/30 日分别有多少样本，禁止用总和掩盖某个周期不足。

重叠窗口可以用于拟合，但不能把它们当成完全独立的测试证据。生产评估必须同时看非重叠区块、滚动窗口和事件数量。

### 第一阶段目标

| 市场 | 股票数 | 历史 | 每周期目标行数 | 成熟规模 |
| --- | ---: | ---: | ---: | ---: |
| US | 300 | 8–10 年 | 60 万 | 800 只、12 年、240 万 |
| ASX | 200 | 10 年 | 50 万 | 400 只、15 年、150 万 |
| CN | 500 | 8 年 | 100 万 | 1500 只、12 年、450 万 |

股票池必须包含当时可交易的历史股票、退市股、停牌股、历史成分变动和公司行动。当前数据提供方没有返回这些字段时，系统会把生产资格标记为失败，不会补造覆盖率。

`HISTORICAL_BACKTEST_TARGET_SYMBOLS_*` 是证据目标；`HISTORICAL_BACKTEST_FETCH_CAP` 是单次任务的接口预算上限。默认一次只增量抓取 80 只，并明确显示距离目标的缺口。

## 5. 数据来源和 PIT 要求

| 数据 | 主源要求 | 验证/备用 | 训练用途 |
| --- | --- | --- | --- |
| 日线 | 交易所或持牌综合行情 | 独立行情商 | 价格、量能、复权收益 |
| 分钟/Tick | 授权综合成交源 | 第二授权源 | 入场、滑点、障碍顺序 |
| 公司行动 | 交易所/持牌公司行动历史 | 行情商复权因子 | 拆股、分红、并购 |
| 财报公告 | SEC、ASX、沪深交易所 | Tushare/商业源 | 事件与基本面 |
| 宏观 | ALFRED/FRED vintage、央行、统计机构 | 第二官方源 | 状态模型 |
| 新闻 | 带历史首次发布时间的归档 | 第二新闻源 | 事件模型 |
| 社媒 | Reddit 官方只读接口 | 聚合源 | 辅助特征，不做主模型 |

每个外生特征必须保存 `available_at`。连接规则是：

```text
feature.available_at <= signal_market_close
effective_date <= signal_date
```

`futureFeatureRowsExcluded` 表示保护机制成功拦下的未来记录；`pointInTimeJoinViolationCount` 才表示实际泄漏。两者不能混为一谈。

## 6. 训练与样本权重

训练权重：

```text
training_weight = data_quality
                * liquidity
                * class_balance
                * bounded_recency
                * soft_label_confidence
```

正式评估权重：

```text
evaluation_weight = data_quality * liquidity
```

由未来路径计算的 `labelConfidence` 只能软化训练中的噪声标签，不能降低正式测试里“难预测样本”的权重，否则会虚增回测成绩。类别不平衡通过训练权重处理；校准和测试保留自然市场分布。

## 7. 基础模型与职责

- Logistic：目标/止损/超时的稳定概率基准。
- Ridge：收益与横截面 rank 的稳定线性基准。
- ElasticNet Logistic：验证稀疏、相关特征下是否有增益。
- CatBoost：安装后优先承担路径分类、排序和 Quantile。
- LightGBM：当前可用的独立树模型 Challenger 与 CatBoost 回退。
- 事件 Logistic/CatBoost：只读取 PIT 事件特征，事件历史不足时保持 unavailable。
- TCN/LSTM/Transformer：仍为零生产权重 Challenger；至少 25 万序列、250 个未触碰测试日并持续击败树模型后才可申请进入集成。

规则头（趋势、VWAP、量价等）应作为模型特征，而不是重复投票模型，避免相同 OHLCV 信息被多次计票。

## 8. 严格样本外 OOF

每个周期采用扩展窗口：

```text
train: earlier dates only
purge: horizon days
embargo: 5–10 additional trading days
test: later untouched block
roll forward
```

基础模型只在更早日期拟合。Meta Model 只能读取 OOF 表：

```text
date, symbol, market, horizon,
actual_target, actual_stop, actual_timeout, actual_return,
ridge_prediction, elastic_prediction, ranker_prediction,
path_safety_prediction, quantile_prediction, event_prediction,
target_probability, stop_probability, timeout_probability,
quantile_p10, quantile_p50, quantile_p90,
regime, data_quality, fold
```

完整 OOF 表以 `gzip-jsonl` 保存到 `.cache/models/oof/<market>/`；模型注册表只保存文件名、行数、schema 和 SHA-256，不把大文件塞进页面快照。

## 9. 受约束集成

1. 计算基础模型 OOF 残差相关性。
2. `abs(correlation) > 0.8` 时优先移除 Brier 较差的冗余模型。
3. Meta 权重非负、和为 1。
4. 单模型权重上限默认 35%。
5. 权重向等权先验收缩。
6. 移除任一模型后重新校准，必须证明有非负边际贡献。
7. 权重只按月或季度更新，不按每日涨跌追噪声。

外部开源模型只能作为 Challenger/Double Check；本地自主模型保持主体地位。真正重要的是误差来源不同，而不是模型名称数量多。

## 10. 概率与收益区间校准

- OOF 校准样本少于 5000：Platt Scaling。
- OOF 校准样本达到 5000：Isotonic Regression。
- P10/P90：Conformalized Quantile Regression，对 OOF 非一致性残差加宽区间。

生产证据同时检查：

- `ECE <= 5%`。
- 校准斜率在 `0.8–1.2`。
- `Brier Skill Score > 0`。
- 可靠性曲线大体单调。
- 每个已使用概率桶至少 30 个事件；成熟阶段提高到 50–100。
- Top 10% 信号净收益高于全体样本。
- Rank IC 与横截面 Top-K lift 为正。
- 共形区间覆盖率与名义覆盖率一致。

## 11. 漂移、拒绝交易与降级

每个滚动测试窗口计算特征 PSI。单窗口 `max PSI > 0.40` 会阻止生产证据通过。

以下情况拒绝新交易或自动降级：

- 概率低于策略阈值。
- Brier Skill `<= 0` 或 ECE `> 10%`。
- 收益区间过宽，EV 不为正。
- 最近两个滚动窗口净期望为负。
- Top-K 不再优于市场。
- 关键特征漂移、缺失或时间戳不可信。
- 行情源陈旧、降级或无法验证。

市场状态只能降低/切换权重，不得直接制造高置信买入信号。

## 12. 版本与部署

每次市场级训练保存：

```text
model_version
training_as_of
data_version
feature_schema_hash
universe_version
label_definition
fold_metrics
calibrator_version
deployment_status
```

本地注册路径：`.cache/models/registry/<market>/`。

部署顺序：

1. Research：可以训练和查看回测。
2. Shadow：每天生成信号，不参与页面最终结论。
3. Paper Champion：至少观察 2–3 个完整预测周期。
4. Production Champion：必须显式晋升，代码不允许自动晋升。

## 13. 当前诚实边界

- 代码已经实现市场级多任务数据集、下一交易日入场、ATR 障碍、OOF、受约束集成、概率/分位数校准、PSI、版本记录、OOF 落盘与生产拒绝闸门。
- 本机已具备 sklearn 与 LightGBM；CatBoost 未安装时会自动使用 LightGBM，不伪装成 CatBoost 结果。
- 现有缓存并不天然包含历史退市、历史指数成分、完整公司行动和多年 PIT 新闻。因此当前候选通常只能进入 Research/Shadow。
- 扩大样本不会自动提高准确率；必须先保证时间戳、复权、历史股票池和评估独立性。
- 页面上的高置信数字必须来自通过校准与拒绝闸门的模型；样本或数据不足时应显示拒绝，而不是强行给出买卖结论。

## 14. 2026-07-29 审计整改验收

本轮整改把“可运行”和“可用于生产预测”明确分开：

- 预测记录使用不可变 ID，并按市场、股票、信号时间、周期、标签、特征版本和模型版本去重；跨市场样本进入隔离区，不参与任何准确率。
- 最终方向、目标/止损路径和区间触达分别统计，不再把止损路径事件混入最终涨跌命中。
- 后台任务加入持久化心跳、启动对账、取消、单飞去重、队列上限和 `Retry-After`；Python 交互、因子、研究任务使用隔离工作池。
- 因子准入至少需要 5 个时间折、4 个正折、成本后增量收益和 100 分证据表；旧因子版本默认隔离，不能继续提供实盘权重。
- Paper Agent 的成交成本拆为佣金、半价差、波动滑点、平方根冲击、数据降级惩罚和容量上限；真实券商下单保持关闭。
- 全模型报告同时生成 JSON、HTML 和 Word，证据不足项显示 unavailable；报告硬门槛优先于 AI 监工意见。

升级后本地验收：

- Node 测试 `88/88`，Python 测试 `46/46`。
- `/api/health` 25 并发请求全部在一次复测中成功，耗时约 220ms。
- 两项并发因子评估均完成，缓存命中路径耗时约 0.9–1.0 秒；这只证明任务调度和本地读取恢复，不代表因子预测有效。
- 当前 ASX 市场级训练仍只有 1,627 行、10 只股票、68 个日期，严格 OOF 不可用；US/CN 无市场级注册模型，因此生产就绪仍为 false。

参考：

- [CatBoost loss functions](https://catboost.ai/docs/en/concepts/loss-functions)
- [Qlib point-in-time database](https://qlib.readthedocs.io/en/stable/advanced/PIT.html)
- [scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [ALFRED vintage data](https://fred.stlouisfed.org/docs/api/fred/alfred.html)
