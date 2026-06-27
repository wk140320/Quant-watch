# Quant Watch 模型、回测与交易决策方法说明

> 本文档说明当前系统如何生成涨跌预测、如何做回测验证、如何处理新闻与社媒、agent 如何训练与调仓，以及如何避免未来函数。系统只作为研究和风险提示工具，不构成投资建议，也不能替代你的独立判断。

## 1. 核心目标

系统预测的不是单一的“明天涨跌”，而是拆成三个不同任务：

1. **周期结束收益**：在用户设定周期结束时，例如 15 日后，收盘收益是否为正、预估是多少。
2. **周期内最高触达**：持仓周期内是否曾经触达目标涨幅，例如 15 日内是否到过 +5%。
3. **策略达标事件**：是否先触达目标涨幅，而不是先触发止损。

这三个任务必须分开，因为“最终涨 5%”“中途摸到 +5%”“先止损后反弹”是完全不同的交易结果。

## 2. 当前完整推理流程

一次股票分析大致经过下面的流程：

1. 读取真实行情 K 线、报价、成交量。
2. 计算技术面特征：MACD、RSI、均线、量比、波动率、5 日/20 日变化、风险分。
3. 读取新闻、公告、宏观、行业、上下游、竞品信息。
4. 读取社媒因子：目前 Reddit 作为 X / YouTube 不可用时的社媒底座。
5. 计算因子层：公告、空头、宏观、行业、相对强弱、流动性、社媒、市场环境、本地 walk-forward 校准。
6. 建立多模型 ensemble：技术面、历史相似、自监督回测、新闻社媒、因子、市场环境、策略达标、风险收益、开源策略蒸馏等。
7. 做保守校准：单源数据、共识不足、样本外不足、回测未达标都会压低置信和涨幅。
8. 做最终回测质量闸门：没有通过 walk-forward / OOS 验证的正向预测不能升级为买入信号。
9. 结合仓位、现金、持仓周期、止损、目标收益，输出观察/买入/减仓/卖出提示。

## 3. AI 部署架构

当前系统不是一个单一“大模型”直接给答案，而是三层协作：

| 层级 | 主要文件 | 职责 | 模型/方法 |
| --- | --- | --- | --- |
| 前端交互层 | `app.js` | 图表、持仓、策略输入、前端保守校准、agent 可视化 | 技术指标、客户端质量闸门、纸面 agent 展示 |
| Node 后端层 | `server.mjs` | 行情/新闻/社媒读取、缓存、预测记录、ensemble、API | 新闻规则模型、因子模型、历史相似、自监督校准、多模型集成 |
| Python quant core | `quant_core/worker.py` | 特征分析、因子实验、alpha 进化、Qlib readiness、风险/本地数据存储 | 因子工程、IC/Rank IC、进化因子、GBM/HMM proxy/波动率模型 |
| 本地记忆层 | `.cache/records/*.jsonl` 等 | 保存预测、结果、模型修改、缓存快照 | 自监督学习、后验评估、模型动态降权 |

运行链路：

```text
浏览器点击刷新/自动刷新
  -> Node API 获取真实行情、新闻、社媒、本地快照
  -> Node 调 Python quant core 做特征/因子/alpha evolution
  -> Node 计算 ensemble 和回测质量闸门
  -> 前端显示图表、预测、解释、agent 决策
  -> 预测写入本地 record，未来到期后反向评估
```

这里的“AI”更接近一个**分层量化推理系统**：

- LLM/API 负责文本解释、策略总结、部分自然语言分析。
- 可解释规则模型负责快速、稳定、可审计的实时打分。
- 自监督记录负责把旧预测和真实结果对上，纠正置信。
- 机器学习/深度学习模型作为下一阶段可接入的训练层，必须经过回测和样本外验证后才能参与买入信号。

## 4. 为什么要新增回测质量闸门

你指出的问题是对的：如果模型过度依赖当日或近几日涨跌，它会出现：

- 今天上涨，预测继续上涨。
- 明天下跌，马上改口预测下跌。
- 这不是稳定预测，而是追随最新价格噪音。

因此现在新增硬规则：

**正向预测必须通过回测质量闸门，否则不能给高置信买入。**

系统现在会检查两类证据：

1. **本地 walk-forward 回测**
   - 只用入场点之前的数据生成信号。
   - 向后看用户周期，例如 15 日，计算是否先达标或先止损。
   - 默认 ASX / US 至少需要 12 个可比样本。
   - 命中率必须大致超过 52%，且先止损率不能过高。

2. **样本外/OOS 自监督记录**
   - 使用历史预测记录和后验结果。
   - 分市场、分周期、分个股、分行为模式统计命中率。
   - 如果同类模式最近连续失败，会降低置信和预估涨幅。

如果这两类证据都不过关：

- 置信度封顶在 52-58 附近。
- 正向涨幅会被收缩。
- `buyEligible=false`。
- `qualityGate.backtestBlockedReason` 会记录原因。
- 前端 thesis 会显示“回测质量闸门 blocked”。

## 5. 技术面模型

技术面不再允许单纯因为当天或短线涨幅就强行看多。

当前技术特征包括：

- `SMA20 / SMA50`：中期趋势结构。
- `MACD histogram`：动量方向。
- `RSI`：过热/过冷。
- `volumeRatio`：成交参与度。
- `buyPressure / buyPressure5 / pressureChange`：主动买卖压力；有真实买卖量用真实值，缺失时用 K 线位置代理。
- `profileDistance / profileSkew / profilePocDistance / profileImbalance`：成交密集区、VWAP/POC 偏离和 volume profile 状态。
- `volumeAccel / volumeTrend`：短期量能相对中期/长期量能的加速度。
- `liquidityShock`：大波动叠加异常放量的事件冲击代理。
- `volatility`：20 日波动率。
- `change5d / change20d`：短中期价格变化。
- `riskScore`：波动率越高，风险分越低。

最新修改：

- 5 日涨幅只保留小权重。
- RSI 过高、5 日涨幅过大，会触发过热惩罚。
- 技术面 `projectedUpside` 改为由趋势、动量、量能、风险共同决定，而不是由短线涨幅直接推出。

简化公式：

```text
projectedUpside =
  (trendScore - 50) * 0.045
  + (momentumScore - 50) * 0.035
  + (volumeScore - 50) * 0.020
  + (riskScore - 50) * 0.015
  - overextensionPenalty
```

这能降低“今天涨所以明天继续涨”的惯性偏差。

### 5.1 技术指标如何折成分数

当前技术面模型是**确定性特征评分模型**，不是黑箱神经网络。它先把 K 线变成一组可解释指标，再把这些指标折算成 0-100 的趋势、动量、量能、风险分，最后得到技术面预估涨幅。

核心指标计算：

```text
EMA_t = price_t * alpha + EMA_{t-1} * (1 - alpha)
alpha = 2 / (period + 1)

MACD line = EMA12(close) - EMA26(close)
Signal line = EMA9(MACD line)
MACD histogram = MACD line - Signal line

RSI = 100 - 100 / (1 + avgGain / avgLoss)
volumeRatio = latestVolume / averageVolume20
volatility = sqrt(mean(dailyReturn^2 over last 20 bars))
```

当前折分方式：

```text
trendScore =
  50
  + close > SMA20 ? 12 : -9
  + SMA20 > SMA50 ? 11 : -10
  + clamp(change20d * 0.62, -9, 9)

momentumScore =
  50
  + MACD histogram * 92
  + (RSI - 50) * 0.55
  + clamp(change5d, -6, 6) * 0.35
  + clamp(change20d * 0.12, -3, 3)

volumeScore = 45 + (volumeRatio - 1) * 28
riskScore = 82 - volatility * 8

overextensionPenalty =
  max(0, change5d - 4) * 0.35
  + max(0, RSI - 72) * 0.12
```

所以 MACD 的作用不是“金叉就买、死叉就卖”，而是通过 `MACD histogram` 进入 `momentumScore`。RSI 也不是简单超买超卖，而是同时影响动量和过热惩罚。5 日涨幅只保留很低权重，并且超过 4% 后会被过热惩罚抵消。

当前技术面模型的不足也要明确：`MACD histogram` 仍然是价格尺度上的值，对不同价格水平股票的可比性不够好。下一步应该改成：

```text
normalizedMacd = MACD histogram / close
或
normalizedMacd = MACD histogram / ATR
```

这样才更符合“无量纲”要求，避免高价股和低价股的 MACD 数值不可比。

### 5.2 因子层如何折成总分

因子层分两类：

1. **实时因子层**：公告、空头、宏观、行业、社媒、订单流/期权、市场环境、相对强弱、流动性、walk-forward 校准。
2. **实验室自选因子**：用户在因子实验室里启用的动量、反转、波动率、量比、均线偏离、VWAP 偏离、区间位置等。

实验室因子当前折分：

```text
momentum_5       = clamp(change5d, -10, 10)
momentum_20      = clamp(change20d * 0.5, -10, 10)
reversal_5       = clamp(-change5d, -10, 10)
volatility_10    = clamp(4 - volatility * 2, -10, 10)
volume_ratio_20  = clamp((volumeRatio - 1) * 8, -10, 10)
trend_gap_20     = clamp((close - SMA20) / SMA20 * 100 * 0.7, -10, 10)
vwap_gap         = clamp(vwapDistancePct, -10, 10)
range_position   = clamp((rangePosition - 0.5) * 20, -10, 10)
```

总因子分：

```text
layerScore =
  sum(liveFactor.score * configuredWeight / averageConfiguredWeight)

researchScore =
  sum(researchFactorValue * normalizedUserWeight)

factorScore = clamp(layerScore + researchScore, -25, 25)
```

解释：

- `factorScore > 6`：因子层偏支持。
- `factorScore < -6`：因子层偏风险。
- 中间区域：混合或证据不足。

因子分不会单独决定买卖，它只进入 ensemble 和质量闸门。某个因子短期表现好，也不能绕过回测验证。

## 6. 历史相似与自监督模型

历史相似模型会寻找过去类似窗口：

- 类似趋势结构。
- 类似量能状态。
- 类似波动率。
- 类似 MACD / RSI。
- 类似行业或市场状态。

每个历史窗口都会生成标签：

- `forwardReturn`：周期结束收益。
- `maxUpside`：周期内最高上探。
- `maxDrawdown`：周期内最大回撤。
- `targetWins`：是否先达标。
- `stopWins`：是否先止损。

自监督模型会保存每次预测，然后等未来数据成熟后再评估：

- 预测方向是否正确。
- 是否触达目标涨幅。
- 是否先止损。
- 预测涨幅是否过度乐观。
- 同类行为模式是否连续失败。

这些记录写入本地 record 文件，不能只保留 3000 条上限式样本。历史样本越多，校准层越可靠。

### 6.1 回测数据如何折成分数

当前有两类回测分。

第一类是**本地 walk-forward 校准分**。它用于回答：“类似过去走势在同样周期里，先达到目标收益的概率够不够高？”

当前简化信号：

```text
signal = 20 日收益率 > 1.5%
```

每个历史入场点只使用入场点之前的数据。入场后向前看用户周期，例如 15 日，计算：

```text
targetWins = 是否先触达 +targetUpside
stopWins   = 是否先触发 -stopLoss
forwardReturn = 周期结束收益
maxUpside     = 周期内最高上探
maxDrawdown   = 周期内最大回撤
```

walk-forward 校准分：

```text
hitRate = hits / samples * 100
stopRate = stopFirst / samples * 100
avgReturn = mean(forwardReturn)

calibrationScore =
  clamp(
    (hitRate - 52) / 4
    + avgReturn * 0.18
    - stopRate * 0.035,
    -10,
    10
  )
```

含义：

- 命中率高于 52% 才开始明显加分。
- 平均收益越高，加分越多。
- 先止损率越高，扣分越多。
- 样本太少时，`available=false`，不会伪装成高置信证据。

第二类是**策略候选 replay 分**。它用于比较不同 agent 或不同策略参数，例如突破、趋势、新闻流、稳健配置。

每个候选策略会在最近约 220 根 K 线内回放：

```text
tradeReturn = exitReturn - estimatedRoundTripCost
winRate = wins / trades * 100

strategyScore =
  avgReturn * 3.4
  + (winRate - 50) * 0.18
  + min(12, trades * 0.35)
  + maxDrawdown * 0.45
```

注意 `maxDrawdown` 通常是负数，所以这一项会扣分。交易成本包含市场基础成本、低量能惩罚和数据源降级惩罚。

这些回测分不会直接变成“未来一定涨多少”。它们的主要作用是：

- 作为 `calibration` 因子进入因子层。
- 限制正向预测的置信上限。
- 决定买入信号是否允许通过。
- 训练 agent 的 aggressiveness 和 confidenceBias。
- 记录失败经验，避免同类信号重复高置信犯错。

## 7. 回测如何避免未来函数

当前回测原则：

1. 每个入场点只能使用当时已经出现的 K 线和因子。
2. 标签窗口从入场后的下一根 K 线开始计算。
3. 新闻、公告、社媒不能使用未来发布内容。
4. 训练窗口、验证窗口、上线窗口按时间顺序拆分，不能随机打乱。
5. 因子标准化只能用训练窗口均值和方差。
6. 极端值截断、缺失值处理都必须在训练窗口内拟合。
7. 对于 15 日标签，验证切分必须保留 label horizon 的间隔，避免样本泄漏。

系统文档里的“六项合格”标准继续保留：

- 无量纲。
- 丰富度。
- 无未来函数。
- 缺失值处理。
- 极端值处理。
- 标准化。

## 8. 新闻模型

新闻不是只看股票本身，而是按影响路径分类：

- 公司直接新闻。
- 财报/公告。
- 行业新闻。
- 上游新闻。
- 下游新闻。
- 竞品新闻。
- 宏观金融新闻。
- 政治与政策新闻。
- 地缘冲突。
- 利率、汇率、通胀。

新闻模型会提取：

- 相关度：公司/行业/上下游/宏观词命中。
- 方向：利好、利空、中性。
- 影响强度：宏观事件和政策事件权重更高。
- 时效：越新的新闻权重越高。
- 来源：官方、主流媒体、RSS、缓存源会分层处理。

新闻进入模型后不是直接“看到坏消息就卖”，而是进入 ensemble：

```text
newsScore -> 新闻社媒模型 -> 因子层 -> 多模型集成 -> 回测质量闸门 -> 最终动作
```

### 8.1 新闻文字如何折成分数

新闻模型当前是**事件词典 + 影响路径 + 行业传导**的可解释打分模型，不是直接让 LLM 随口判断利好利空。

第一步，确定影响路径 `channel`：

| 路径 | 权重 |
| --- | ---: |
| 公司/股票直接新闻 direct-stock/company | 1.00 |
| 政策/央行/宏观政策 policy/central-bank | 0.78 |
| 上游/供应链/行业 upstream/sector | 0.68 |
| 竞品/互补行业 peer/competitor | 0.56 |
| 全球宏观/政治人物/地缘 global/geopolitical | 0.48 |
| 未知市场新闻 | 0.40 |

第二步，识别新闻类别：

| 类别 | 基础分 |
| --- | ---: |
| 财报/公告 | 1.05 |
| 利率/宏观 | 0.90 |
| 政治/政策 | 0.86 |
| 国际局势 | 0.82 |
| 金融/信用 | 0.78 |
| 大宗/能源 | 0.76 |
| 科技/AI | 0.74 |
| 上下游/供应链 | 0.72 |
| 消费/社会 | 0.58 |
| 普通市场新闻 | 0.42 起 |

公司直接新闻会额外加权，宏观政策新闻也会小幅加权：

```text
impactWeight =
  clamp(channelWeight * categoryScore, 0.15, 1.35)
```

第三步，做方向评分。当前规则是关键词和事件词典：

```text
每命中一个利空事件词：itemScore -= 4
每命中一个利好事件词：itemScore += 4
```

利空词包括战争、制裁、关税、衰退、加息、违约、业绩预警、监管调查、亏损、暴跌、出口管制、增发摊薄、减持、问询函、退市风险等。

利好词包括降息、刺激、停火、上调评级、超预期、回购、分红增加、需求上升、价格上涨、获批、政策支持、补贴、业绩预增、订单、中标等。

第四步，加入行业传导修正：

```text
能源股 + 战争/制裁/油价上涨       -> 加分
材料股 + 中国刺激/铁矿铜价上涨    -> 加分
银行股 + 降息/按揭增长            -> 加分
银行股 + 房贷拖欠/高利率/衰退     -> 扣分
AI/半导体 + 数据中心/AI capex     -> 加分
AI/半导体 + 出口管制/反垄断调查   -> 扣分
白酒/消费 + 批价上涨/分红/节日    -> 加分
白酒/消费 + 反腐/库存高/需求弱    -> 扣分
```

单条新闻最终分：

```text
weightedNewsItemScore = itemScore * impactWeight
```

股票级新闻分：

```text
newsScore = clamp(sum(weightedNewsItemScore), -20, 20)

stance =
  newsScore > 4  -> supportive
  newsScore < -4 -> risk-off
  otherwise      -> mixed
```

所以一条“战争新闻”不会对所有股票同向扣分。它可能对航空、消费、成长股是风险，对能源、黄金、军工链条可能是利好。系统通过 `sectorContext` 做这种传导，但这部分仍然是规则知识图谱，后续应该升级为更完整的行业上下游图谱。

### 8.2 新闻分进入预测的方式

新闻分不会直接等于最终涨跌幅。它会进入几个层级：

```text
新闻原文
  -> 路径/类别/方向/行业传导
  -> newsScore
  -> 新闻社媒模型
  -> factorSignal
  -> ensemble
  -> backtestGate
  -> action
```

当前更保守的原则是：新闻可以提高关注度和解释强度，但除非历史回测证明同类新闻/同类价格结构有效，否则不能单独把买入置信推到高位。

## 9. Reddit 社媒模型

Reddit 作为当前社媒底座，用来补充 X / YouTube 暂不可用时的一手讨论信号。

后台逻辑：

1. 按市场维护社媒池，不在股票刷新时同步请求 Reddit。
2. 每个市场池使用 subreddit 和关键词抓取。
3. 关键词包括股票、公司、行业、竞品、上下游、宏观事件。
4. 每只股票从市场池里重新映射评分。
5. 缓存保存在 `.cache/social/reddit/<market>/<symbol>.json`。

单条帖子评分：

```text
impactScore =
  relevanceScore * 0.36
  + influenceScore * 0.28
  + validityScore * 0.18
  + truthScore * 0.16
  - manipulationRisk * 0.18
```

含义：

- `relevanceScore`：股票、行业、竞品、上下游、宏观关键词命中。
- `influenceScore`：帖子分数、评论数、upvote ratio、subreddit 订阅量近似。
- `validityScore`：是否有数字、链接、事实描述、公告/财报/监管词。
- `manipulationRisk`：是否像喊单、拉盘、内幕、必涨、all-in。
- `truthScore`：文本是否具备可验证信息结构，不代表事实已经被证明。
- `sentiment`：正负情绪。

股票级社媒分：

```text
socialScore = sentiment * impactScore * truthScore - manipulationPenalty
```

Top10 只展示最高影响/相关内容。低影响内容 12 小时过期，中等内容 24 小时，高影响内容 3 天。

## 10. 多模型 ensemble

当前 ensemble 包含：

- 策略达标模型。
- 技术面模型。
- 历史相似模型。
- 自监督回测模型。
- 新闻社媒模型。
- 因子模型。
- 市场环境模型。
- 风险收益模型。
- 基本面估值模型。
- Freqtrade/LEAN/Backtrader/Hummingbot/FinRL 思想蒸馏模型。
- Meta-label 样本外模型。

每个模型输出：

- `confidence`
- `projectedUpside`
- `weight`
- `available`
- `reason`

然后按表现、市场环境和模型一致度动态调权。

但现在新增规则：

**ensemble 只能提出候选，不能绕过回测质量闸门。**

### 10.1 各类模型到底是什么方法

当前系统里“模型”分成四类，成熟度不同：

| 模型层 | 当前方法 | 是否黑箱训练 | 主要用途 |
| --- | --- | --- | --- |
| 技术面模型 | 规则特征评分，MACD/RSI/均线/量能/波动率 | 否 | 给基础趋势、动量、风险分 |
| 新闻模型 | 事件词典、路径权重、行业传导规则 | 否 | 识别消息面利好利空和影响范围 |
| Reddit 社媒模型 | 相关度、影响力、有效性、真伪风险、操纵风险评分 | 否 | 补充市场讨论热度和风险提示 |
| 历史相似/自监督 | walk-forward 标签、历史预测后验评估 | 半监督/自监督 | 给置信校准和买入闸门 |
| agent replay | 纸面交易回放和策略分数 | 否，暂非深度 RL | 比较策略候选和调仓行为 |
| Qlib/LightGBM/LSTM/Transformer | 预留/接入中 | 是 | 后续做更严格的时序训练 |

目前真正参与稳定决策的是可解释模型和回测闸门。LightGBM、LSTM、Transformer 更适合在数据质量、样本量和 point-in-time 标签全部稳定后接入，否则它们很容易把噪声和未来函数学进去。

### 10.2 分数如何进入最终置信

每个子模型会被统一成类似结构：

```text
{
  confidence,
  projectedUpside,
  weight,
  available,
  reason
}
```

最终 ensemble 会看：

- 模型自身分数。
- 模型是否可用。
- 与其他模型是否一致。
- 数据源是否降级。
- 历史同类信号是否有效。
- 市场环境是否支持。
- 回测质量闸门是否通过。

因此最终置信不是单个 `newsScore`、`MACD` 或 `factorScore` 的线性放大。更准确地说：

```text
rawForecast = weightedAverage(modelProjectedUpside)
rawConfidence = weightedAverage(modelConfidence)

finalForecast =
  conservativeCalibration(rawForecast, dataQuality, consensus, history)

finalConfidence =
  min(rawConfidence, backtestGateConfidenceCap, dataQualityCap)
```

如果回测不通过，即使技术面和新闻都偏正，置信也会被封顶，买入资格会被关闭。

### 10.3 权重到底怎么来的

当前系统里的大部分权重不是神经网络训练出来的，而是三层来源：

1. **工程先验权重**：根据金融常识、特征稳定性、可解释性、数据可得性先给一个保守初值。
2. **历史表现调权**：模型有足够到期预测样本后，根据方向命中率、策略达标率、平均误差动态上调或下调。
3. **市场环境和一致度调权**：不同 regime 下调整模型权重；多数模型方向一致时小幅提高一致模型权重，分歧大时扣分。

这意味着旧版本的权重不是“AI 自己凭空学会的”，而是**人工设计初始权重 + 回测表现校准 + 市场状态调权**。当前版本已经新增 Python 本地学习层：用 `.cache/prediction-samples-*.json` 中的到期预测样本训练约束权重和信号模型，只有样本外验证优于旧系统时才替换或加入线上 ensemble。

当前 ensemble 的基础权重大致是：

| 模型 | 基础权重 | 权重来源解释 |
| --- | ---: | --- |
| 历史相似模型 | 0.22 | 过去相似窗口对短周期策略最直接，但样本少时不可用 |
| 技术面模型 | 0.20 | 实时、稳定、低成本，但容易被短期价格噪声误导 |
| 策略达标模型 | 0.18 | 直接对应“先达标还是先止损”，与交易目标最接近 |
| 自监督回测模型 | 0.18 | 用旧预测到期结果校准，但需要足够样本 |
| 因子模型 | 0.16 | 汇总公告、宏观、社媒、流动性、校准等多维因子 |
| 市场环境模型 | 0.10 | 控制 risk-on/risk-off 和大盘风险，不单独决定买卖 |
| 新闻社媒模型 | 0.08 | 重要但噪声大，不能单独给高置信买入 |
| 风险收益模型 | 0.08 | 约束止损、波动、收益风险比 |
| 基本面估值 | 0.09 | 短周期内影响较慢，作为辅助 |
| 开源策略蒸馏模型 | 0.07-0.12 | 借鉴 Freqtrade/LEAN/Backtrader/Hummingbot/FinRL 思想，但不是直接运行这些项目 |

注意这些基础权重不是最终权重。每次分析时系统会只保留 `available=true` 的模型，再做归一化：

```text
normalizedWeight_i = adjustedWeight_i / sum(adjustedWeight_available)

weightedUpside =
  sum(model.projectedUpside * normalizedWeight)

weightedConfidence =
  sum(model.confidence * normalizedWeight)
```

模型表现调权：

```text
performanceMultiplier =
  clamp(
    0.76
    + (directionalHitRate - 50) * 0.012
    + (strategyHitRate - 50) * 0.009
    + min(0.12, samples * 0.004),
    0.45,
    1.35
  )
```

解释：

- 到期样本少于 5 条时，不因偶然胜负调权。
- 方向命中率越高，权重越高。
- 策略达标率越高，权重越高。
- 样本越多，最多给一点稳定性奖励。
- 表现差的模型最多被压到 45%。
- 表现好的模型最多提高到 135%，不会无限放大。

市场环境调权：

```text
uptrend:
  技术/突破/策略达标模型小幅加权

range:
  突破类模型小幅降权
  风控/执行类模型小幅加权

volatile:
  技术/突破类模型降权
  风险/执行/市场环境模型加权

downtrend:
  突破/技术/策略达标模型降权
  风险/市场环境模型加权
```

模型一致度调权：

```text
如果多数可用模型方向一致，且一致比例 >= 55%：
  一致方向模型获得小幅 boost

如果模型分歧很大：
  最终置信度被 disagreementPenalty 扣分
```

最后还有硬闸门：

```text
if backtestGate not passed:
  finalConfidence <= cap
  buyEligible = false
```

所以权重真正的角色是“在候选模型之间分配话语权”，不是绕过回测直接得出买入结论。

### 10.4 当前有没有使用神经网络

当前实盘/监控台主决策里，**没有把神经网络、LSTM 或 Transformer 作为主预测模型强行上线**。但当前版本已经接入了 Python 本地机器学习头：约束岭回归用于收益/因子/特征分回归，逻辑回归用于策略达标 Meta-label。它们不是人工权重，而是从到期预测样本中学习参数，并通过时间序列样本外验证控制上线。

现在已经实际工作的部分是：

- 规则型技术面模型。
- 新闻/社媒可解释打分模型。
- 历史相似窗口模型。
- 自监督预测记录与后验校准。
- Python 本地约束权重学习、特征分回归、因子分回归、回测 Meta-label。
- 因子 IC/Rank IC 和 alpha evolution。
- 多模型 ensemble 和回测质量闸门。
- LLM/API 辅助文本解释、策略总结和部分自然语言分析。

已经预留但还不能说“已训练上线”的部分是：

- LightGBM。
- LSTM。
- Transformer。
- Qlib 标准训练管线。

原因很直接：神经网络不是天然更准。对短周期股票预测来说，如果数据量不足、新闻时间戳不准、财报/公告不是 point-in-time、样本切分没做 embargo，神经网络很容易把未来函数和噪声学进去，表现会比规则模型更危险。

正确顺序应该是：

```text
规则模型 + 回测闸门稳定运行
  -> 累积足够预测样本和真实后验
  -> 建立 point-in-time 特征矩阵
  -> 先训练 LightGBM 基线
  -> LightGBM 样本外优于当前系统
  -> 再训练 LSTM/Transformer
  -> 深度模型连续样本外优于 LightGBM
  -> 才允许进入 ensemble，且初始权重封顶
```

因此，如果要提高准确率，下一步最该做的不是直接上 Transformer，而是先把这些人工权重变成可学习的校准权重。当前已经落地的 Python 本地权重学习是：

```text
quant_core/local_model.py
  train_local_ensemble_weights(samples)
    -> 读取已到期预测样本
    -> 提取每个子模型当时的 projectedUpside
    -> 用真实 forwardReturnPct 做标签
    -> 时间序列 train / validation / test 切分
    -> 在 simplex 约束下训练 ridge 权重
    -> 如果验证集和未触碰测试集 MSE 都优于旧 ensemble，且方向/达标率不恶化
       才启用 oos-optimized-simplex 权重
```

数学形式：

```text
min_w  mean((sum_i w_i * pred_i - y)^2) + lambda * ||w - w_prior||^2

s.t.   w_i >= 0
       sum_i w_i = 1
```

这里 `w_prior` 是旧系统线上归一化权重的时间窗口平均值，避免模型因为少量样本突然把某个子模型权重拉到 100%。上线时还会用 `deploymentBlend` 把学习权重和旧权重混合，样本越多，学习权重占比越高。

更通用的权重学习目标仍然是：

```text
modelWeight_i =
  f(
    model past hit rate,
    strategy hit rate,
    Brier score,
    market regime,
    sector bucket,
    horizon bucket,
    recent drift,
    data quality
)
```

这个 `f()` 可以先用 LightGBM 或逻辑回归学习。只有当它在样本外稳定超过当前手工权重，才替换当前规则。

### 10.5 因子分、特征分和回测分如何改成机器学习

当前新增的 Python 本地模型层不只学习 ensemble 权重，也会分别训练五个线上信号头，并额外训练 LightGBM 可选基线：

| 模型头 | 文件/函数 | 输入 | 标签 | 输出 | 是否进线上 |
| --- | --- | --- | --- | --- | --- |
| `feature_score_head` | `train_regression_head` | 趋势、动量、RSI、量比、20日涨跌、买卖压力、量能加速度、VWAP/POC 偏离、流动性冲击 | 周期真实收益 `forwardReturnPct` | 特征层预测收益 | 样本外 MSE 优于旧预测才进 |
| `factor_score_head` | `train_regression_head` | 因子分、社媒分、宏观分、行业分、资金流、流动性、相对强弱、公告分、历史置信、模型置信、一致度 | 周期真实收益 | 因子层预测收益 | 样本外 MSE 优于旧预测才进 |
| `backtest_meta_head` | `train_logistic_head` | 策略概率、幅度概率、预估收益、最高触达、一致度、因子分、校准分、买压、成交密集区、量能加速度 | `targetWins` | 目标先于止损的概率 | 样本外 Brier 优于旧概率才进 |
| `stop_risk_head` | `train_logistic_head` | 预估收益、最高触达、风险、量比、短中期涨跌、RSI、因子、一致度、流动性、流动性冲击、买压衰减、VWAP/POC 偏离 | `stopWins` | 先触发止损的概率 | 通过后作为负向模型拉低买入 |
| `trade_quality_head` | `train_logistic_head` | 策略概率、幅度概率、预估收益、最高触达、一致度、因子分 | `targetWins && !stopWins` | 交易质量概率 | 通过后过滤“看涨但不适合买”的信号 |

这些模型的共同流程：

```text
历史预测样本
  -> 只取当时可见的 featureScores / signalCounts / ensemble 字段
  -> 按 resolvedAt 时间排序
  -> train / validation / untouched test 切分
  -> 训练集拟合标准化中心和尺度
  -> 验证集选择 lambda
  -> 测试集做最终闸门
  -> active=true 后，JS 用返回的 intercept/weights/centers/scales 对当前股票实时推理
```

所以特征分和因子分不再只是人工加权分数。旧规则仍作为 baseline 和兜底；Python 模型必须证明自己在样本外能降低误差，才以低权重加入 `Python-特征分模型`、`Python-因子分模型`、`Python-回测Meta模型`、`Python-止损风险模型`、`Python-交易质量模型`。

新增的历史回测预测头也会参与权重学习：

| 预测头 | 核心公式/含义 | 作用 |
| --- | --- | --- |
| `orderflow_pressure` | `buyPressure5*4.2 + pressureChange*3.1 + closeLocation*0.7 + volumeAccel*0.9` | 判断主动买入是否连续增强 |
| `volume_profile` | `-profileDistance*0.42 + profileSkew*0.55 + profilePocDistance*0.38 + profileImbalance*2.2` | 判断价格相对成交密集区是突破还是回归 |
| `factor_quality` | `factorQuality*0.14 + trendQuality*1.3 - liquidityShock*0.25` | 把技术趋势、因子质量和风险冲击折成可比收益头 |
| `liquidity_reversal` | `-change5*0.12 + reversalPressure*2.7 + volumeAccel*0.8 - trueRange*0.35` | 捕捉过热后买压背离或放量反转 |

这些头不是固定相信某个指标，而是在每个周期桶里做样本外权重学习。某个头如果在短期有效但中长期无效，它的权重只会在对应周期里上升。

### 10.5.1 失败后的动态微调

实盘预测到期后，系统不会用固定惩罚粗暴调整，而是按预测偏差决定微调幅度：

```text
forecastError = abs(predictedReturn - actualForwardReturn)
missSeverity =
  I(missed) + 0.6 * I(interimAdverse)
  + max(0, -actualForwardReturn) / 8
  + max(0, -maxDrawdown) / 12

adjustmentScale =
  clamp(0.02 + forecastError * 0.012 + missSeverity * 0.035, 0.02, 0.22)
```

含义：

- 轻微偏差只记录为观察样本。
- 方向错误、目标未达、期间大幅回撤会放大调整。
- 单次调整封顶 22%，防止因为一笔失败交易过拟合。
- 调整会按市场、周期、个股、相似行为模式分桶迁移，不会把 CPU 的一次失败机械迁移到所有股票。
- 调整记录会写入本地模型修改日志，并在策略 agent 的模型动线里可查。

### 10.5.2 模型可解释性可视化

`预测学习与准确率 > 模型调整` 现在新增模型参数地图，位置在“失败后的模型调整”上方。它展示：

- 本地 ridge/logistic 模型的最高绝对系数。
- LightGBM / tree 模型的特征重要性。
- 历史 walk-forward 不同周期桶的预测头权重。
- 每个特征的公式、所属家族和为什么允许进入模型。

这个面板用于回答“模型为什么这么判断”。它不是交易开关；真正上线仍然需要通过验证集、测试集、回测质量闸门和仓位风险约束。

### 10.6 Triple-barrier 与 LightGBM 基线

新标签不再只看最后一天涨跌，而是使用 triple-barrier：

```text
target:  持仓周期内先触达目标涨幅
stop:    持仓周期内先触发最大止损
timeout: 到期仍未触发目标或止损
```

这样可以直接训练“先达标还是先止损”，比普通方向预测更贴近真实交易。`stop_risk_head` 会专门学习止损风险；如果它样本外通过，会以负向模型加入 ensemble，避免因为短线涨了一天就盲目买入。

LightGBM 当前作为可选本地基线训练；如果 macOS 环境缺 `libomp` 导致 LightGBM 动态库不可用，则自动降级为 sklearn `GradientBoostingClassifier/Regressor`，仍然作为非线性树模型基线：

| LightGBM 头 | 任务 | 上线条件 |
| --- | --- | --- |
| `lgb_target_before_stop` | `P(targetWins)` | 样本外 Brier 优于现有概率 |
| `lgb_stop_first` | `P(stopWins)` | 样本外 Brier 优于止损概率 baseline |
| `lgb_forward_return` | 周期收益回归 | 样本外 MSE 优于旧收益预测 |
| `lgb_triple_barrier` | target/stop/timeout 三分类 | 样本外准确率和召回达到门槛 |

LightGBM 通过时会先进入准确率页作为研究证据和模型竞争者；没有通过时只显示 `rejected_oos`，不会为了提高表面置信率强行参与买卖。

## 11. 机器学习与深度学习如何接入

这一节是你问的重点：如果要真正使用机器学习、深度学习、Transformer，它们不应该直接拿“今天涨跌”去预测“明天涨跌”。正确做法是把不同特征变成 point-in-time 特征矩阵，再按任务训练不同模型。

### 11.1 特征矩阵怎么构建

每个样本是一只股票在某一天或某个 K 线时点的状态：

```text
sample = {
  market,
  symbol,
  asOfDate,
  horizonDays,
  features: {
    technical,
    factor,
    news,
    social,
    fundamental,
    marketRegime,
    orderflow,
    portfolio
  },
  labels: {
    forwardReturn,
    maxUpside,
    maxDrawdown,
    targetWins,
    stopWins
  }
}
```

特征分组：

| 特征组 | 示例 | 适合模型 | 注意事项 |
| --- | --- | --- | --- |
| 技术面 | 标准化 MACD、RSI、均线差、ATR、量比、波动率 | LightGBM、LSTM、Transformer | 必须无量纲，不能让价格绝对值骗模型 |
| 因子层 | 动量、反转、VWAP gap、range position、流动性、校准因子 | LightGBM、Qlib | 需要 IC/Rank IC 和六项质量闸门 |
| 新闻文本 | 事件类型、影响路径、方向、行业传导、来源可信度 | 文本分类器、LLM embedding、Transformer | 不能只看情绪词，要按产业链传导 |
| 社媒 | Reddit 相关度、影响力、有效性、操纵风险、truthScore | LightGBM、文本模型 | 高热度不等于真实，必须惩罚喊单 |
| 基本面 | PE、forward PE、利润率、股息、beta、财报变化 | LightGBM、线性基线 | 财报必须按发布日期 point-in-time |
| 市场状态 | 指数趋势、利率、汇率、大宗、风险偏好 | HMM proxy、LightGBM、Transformer | 同一信号在 risk-on/risk-off 下含义不同 |
| 订单流 | 主动买卖、VWAP、吸收、放量异常、FVG/ICT proxy | LightGBM、序列模型 | 逐笔不可用时只能标成 proxy，不能冒充真实 L2 |
| 组合约束 | 当前仓位、现金、行业集中、相关性、止损空间 | 规则模型、组合优化 | 这是执行层，不应该作为未来收益标签泄漏 |

### 11.2 标签如何定义

系统至少训练四个任务，而不是一个“涨/跌”：

```text
方向标签：
directionLabel = forwardReturn > 0

目标达标标签：
targetLabel = targetWins

止损风险标签：
stopLabel = stopWins

幅度回归标签：
returnLabel = forwardReturn
maxUpsideLabel = maxUpside
drawdownLabel = maxDrawdown
```

如果你的策略是“15 日内上涨 5%，置信 80%”，最重要的不是普通方向标签，而是：

```text
targetLabel = 15 日内是否先触达 +5%
stopLabel = 是否先触发止损
```

这也是为什么系统要把“方向正确”和“交易成功”分开。CPU 这种情况可能方向模型短期看多，但目标达标/止损模型不够强，就不应该给买入。

### 11.3 LightGBM 怎么用

LightGBM 适合当前阶段，因为它对中小样本、非线性特征、缺失值更稳，比深度模型更不容易在小样本上过拟合。

部署方式：

```text
本地历史 K 线/新闻/因子/预测记录
  -> feature builder
  -> train/validation/test time split
  -> LightGBM classifier/regressor
  -> 输出概率和特征重要性
  -> 写入 model-calibration
  -> ensemble 读取
```

模型任务：

| 模型 | 输入 | 输出 | 用途 |
| --- | --- | --- | --- |
| `lgb_direction` | 技术面+因子+市场状态 | `P(forwardReturn > 0)` | 方向概率 |
| `lgb_target` | 技术面+因子+新闻+社媒+策略参数 | `P(targetWins)` | 是否值得买入 |
| `lgb_stop` | 波动率+流动性+新闻风险+仓位 | `P(stopWins)` | 止损风险 |
| `lgb_return` | 全特征 | `E(forwardReturn)` | 周期末收益 |
| `lgb_max_upside` | 趋势+量能+新闻+历史相似 | `E(maxUpside)` | 周期内最高触达 |

训练约束：

- 使用时间序列切分，不能随机打乱。
- 使用 purged/embargo split，15 日标签后面要留空档。
- scaler/缺失值/极端值处理只在训练窗口拟合。
- 早停只能看验证集，不能看测试集。
- 上线只读取通过验证窗口的模型。

输出进入系统：

```text
LightGBM probability
  -> confidence calibration
  -> model view
  -> ensemble normalizedWeight
  -> backtestGate
```

### 11.4 LSTM 怎么用

LSTM 适合学习连续 K 线状态，比如趋势逐步走强、波动收缩后放量、连续吸收、新闻冲击后的延迟反应。

输入不是单日特征，而是一段序列：

```text
X_t = [
  t-59 features,
  t-58 features,
  ...
  t features
]

y_t = 未来 horizon 的 targetWins / forwardReturn / maxUpside
```

适合输入：

- 标准化收益率。
- 标准化 MACD/ATR/RSI。
- 量比序列。
- VWAP gap 序列。
- 新闻冲击分序列。
- 社媒热度分序列。
- 市场 regime 序列。

为什么不能一开始就重用 LSTM 做主模型：

- 单票样本少，容易记住历史噪声。
- 免费数据分钟线不完整，序列不稳定。
- 新闻和社媒时间戳如果不准，很容易产生未来函数。

正确上线方式：

```text
先用 LightGBM 建立强基线
  -> LSTM 只作为辅助序列模型
  -> 样本外连续优于 LightGBM 才提高权重
  -> 否则只显示为参考，不参与买入
```

### 11.5 Transformer 怎么用

Transformer 适合处理多源序列和文本，但也最容易过拟合。它的合理用途有两个：

第一类是**文本 Transformer**：

```text
新闻/Reddit 文本
  -> event extraction
  -> entity linking
  -> sector/supply-chain relation
  -> sentiment + event type + credibility
  -> news embedding
```

输出不是一句“利好/利空”，而是结构化字段：

```text
{
  eventType: "rate_cut" | "war" | "earnings_beat" | ...,
  direction: -1..1,
  credibility: 0..1,
  affectedSectors: [],
  affectedSymbols: [],
  impactHorizon: "intraday" | "1-5d" | "15d+",
  uncertainty: 0..1
}
```

第二类是**时序 Transformer**：

```text
多日特征序列 + 新闻事件序列 + 市场状态序列
  -> temporal attention
  -> P(targetWins), P(stopWins), E(maxUpside)
```

它比 LSTM 更擅长识别“哪几天/哪类事件”对预测贡献最大，例如：

- 一次政策新闻之后的行业扩散。
- 大宗价格变化对澳洲矿业股的延迟影响。
- 财报后量价结构持续 3-5 天强化。
- 风险事件对高 beta 成长股的同步压制。

但 Transformer 上线必须满足：

- 每个市场有足够多样本。
- 文本时间戳严格早于预测时点。
- 训练/验证/上线窗口完全分离。
- 注意力结果只能辅助解释，不能当作因果证明。
- 样本外收益和 Brier 分数连续优于 LightGBM。

### 11.6 Qlib 在这里的位置

Qlib 不是直接替代当前系统，而是作为“规范训练管线”接入：

```text
本地真实行情与因子
  -> Qlib data handler
  -> factor processor
  -> dataset split
  -> LightGBM/LSTM/Transformer
  -> recorder
  -> prediction artifact
  -> Node ensemble 读取结果
```

Qlib 模型输出必须包含：

- `prediction`: 未来收益或目标概率。
- `score`: 股票横截面排序分。
- `modelName`: LightGBM/LSTM/Transformer。
- `trainWindow/validWindow/testWindow`。
- `IC/RankIC`。
- `hitRate`、`targetHitRate`、`stopRate`。
- `featureImportance` 或 attention summary。
- `dataVersion` 和 `asOfTime`。

如果 Qlib 只显示安装成功，但没有配置 data handler 和训练任务，它只是“可用”，不是“模型已上线”。

### 11.7 深度模型如何避免过拟合

深度模型必须通过这些闸门：

1. 先超过简单基准：随机、买入持有、简单动量、LightGBM。
2. OOS 命中率不能只高在训练集，验证和测试都要稳定。
3. 同一市场、同一行业、同一周期分桶评估，不能混成一个大平均。
4. 模型输出概率要做校准，Brier 分数不能恶化。
5. 连续失败的模型自动降权或暂停。
6. 高频微调只能更新校准层，不能每天重训主模型追逐当天涨跌。

真正上线时，深度模型应该作为 ensemble 的一个子模型：

```text
deepModelOutput =
  {
    confidence,
    projectedUpside,
    targetProbability,
    stopProbability,
    uncertainty,
    oosMetrics
  }

if oosMetrics.pass:
  add to ensemble with capped weight
else:
  show as research-only
```

## 12. Alpha 进化与高级统计模型

Python quant core 里已经有一个本地 alpha evolution 框架，思想来自 QuantaAlpha，但实现是本地轻量版本，不复制外部项目代码。

流程：

```text
基础因子 seed
  -> zscore/rank/delta/smooth/vol_adjust/negate 变异
  -> blend/spread/gated 交叉
  -> IC/RankIC/validation/test 评估
  -> 复杂度、冗余、过拟合惩罚
  -> Top candidates
```

当前 seed 包括：

- `mom_quality`: 动量减波动。
- `gap_reversal`: 隔夜跳空反转。
- `liquidity_impulse`: 成交量确认的价格冲击。
- `vwap_reclaim`: 价格重新站回成交成本区。
- `macd_volume_gate`: MACD 动量乘量能异常。
- `range_breakout`: 区间位置加 ATR 扩张。
- `body_pressure`: K 线实体和收盘位置压力。
- `trend_vwap_spread`: 长趋势和 VWAP 偏离。

每个候选因子会做：

```text
fitness =
  abs(validationIC) * 42
  + abs(testIC) * 34
  + abs(rankIC) * 20
  + stabilityBonus
  + qualityGateBonus
  - redundancyPenalty
  - complexityPenalty
  - overfitPenalty
```

六项质量闸门：

- 无量纲。
- 丰富度。
- 无未来函数。
- 缺失值。
- 极端值。
- 标准化。

同时还有几个高级统计模型作为参考层：

| 模型 | 当前作用 | 是否直接给买入 |
| --- | --- | --- |
| 几何布朗运动 GBM | 给漂移、波动和 P10/P90 基线 | 否 |
| HMM-style regime proxy | 判断 risk-on/risk-off/震荡/高波动 | 否，影响权重和门槛 |
| EWMA + Parkinson 波动率 | 衡量波动冲击和风险状态 | 否，进入风险模型 |
| Markowitz single-asset proxy | 估算单票主动权重倾向 | 否，组合约束参考 |
| Cointegration/stat-arb | 需要多股票同步面板，当前是下一步 | 未上线 |

这些模型的定位是“增强解释和筛选”，不是绕过回测给交易指令。

## 13. 强化学习/Agent 奖励惩罚

当前 agent 是纸面训练和策略回放，不会自动实盘下单。

Agent 会维护：

- 现金。
- 持仓。
- 每笔模拟交易。
- 胜负统计。
- 策略书。
- 历史周期归档。
- 亏损经验。

奖励逻辑：

- 盈利交易加分。
- 达到目标收益加分。
- 风险调整收益为正加分。
- 在回撤较小的情况下盈利，加额外分。
- 高质量回测交易数越多，策略稳定性加分。

惩罚逻辑：

- 亏损交易扣分。
- 先触发止损扣分。
- 高波动低胜率扣分。
- 过度追涨、证据薄弱、高置信误判会记入模式惩罚。
- 同类错误重复出现，会降低该 agent 的 aggressiveness。

调仓判断：

1. 当前股票是否仍满足策略入场条件。
2. 是否触达止损或风险阈值。
3. 当前持仓周期是否接近策略周期。
4. 后续上涨空间是否仍高于持仓风险。
5. 组合层面是否过度集中。
6. 是否需要保留补仓空间。
7. 与其他持仓是否高度同向，是否需要降低相关性。

调仓是否有效的评价：

- 调仓后收益是否改善。
- 最大回撤是否降低。
- 是否避免止损。
- 是否错失后续上涨。
- 净收益是否覆盖交易成本和滑点。

### 13.1 Agent 决策分如何计算

agent 当前不是“已经训练好的自动交易 AI”，而是**纸面交易 agent + 历史 replay 策略选择器**。它会根据风格不同使用不同打分函数。

回撤反弹 agent 更重视低 RSI 和反弹空间：

```text
reversionScore =
  46
  + (50 - RSI) * 0.75
  + projectedMaxUpside * 2.4
  + (analysisConfidence - 55) * 0.22
  + marketBias * 0.55
  + evidence * 0.08
  + learnedBias
```

突破 agent 更重视置信、上探空间、趋势、放量和市场环境：

```text
breakoutScore =
  35
  + (analysisConfidence - 48) * 0.42
  + projectedMaxUpside * 3.1
  + (trendScore - 48) * 0.22
  + (volumeRatio - 1) * 11
  + max(0, change5d) * 0.45
  + maxUpsideProbability * 0.08
  + marketBias * 0.7
  + learnedBias
```

新闻/资金流 agent 更重视新闻证据、因子分和目标达成概率：

```text
newsFlowScore =
  34
  + evidence * 0.34
  + factorScore * 0.20
  + targetProbability * 0.12
  + projectedFinalReturn * 2.6
  + (trendScore - 50) * 0.12
  + marketBias * 0.55
  + learnedBias
```

稳健配置 agent 更重视风险分、最终收益概率和下行风险控制：

```text
riskBalancedScore =
  28
  + analysisConfidence * 0.24
  + targetProbability * 0.18
  + finalReturnProbability * 0.10
  + (riskScore - 45) * 0.28
  + max(0, trendScore - 50) * 0.14
  + evidence * 0.08
  - max(0, downsideConfidence - 45) * 0.18
  + learnedBias * 0.60
```

每个 agent 还会通过历史 replay 更新自己的偏置：

```text
aggressiveness = clamp(0.7 + max(0, bestStrategyScore) / 38, 0.55, 1.45)
confidenceBias = clamp(previousBias + bestStrategyScore * 0.012, -5, 5)
```

如果某类策略 replay 分数下降，agent 的进攻性会下降；如果同类策略长期有效，agent 才会提高参与度。这里的目标不是让 agent 每次都交易，而是让它在净收益、回撤、成本之后仍然有优势时才更积极。

## 14. 仓位与组合约束

单只股票不能因为“还有现金”就满仓买入。

系统会考虑：

- 总资金。
- 可用资金。
- 已持仓市值。
- 单票最大持仓比例。
- 保留现金比例。
- 止损空间。
- 未来补仓空间。
- 行业集中度。
- 市场 beta。
- 持仓相关性。

买入建议必须通过：

- 策略达标概率。
- 幅度命中概率。
- 回测质量闸门。
- 模型共识。
- 风险收益比。
- 组合约束。

## 15. CPU 事件的教训

CPU 这次亏损暴露的问题：

- 模型给过高置信，但没有足够强制回测门槛。
- 单日/短期价格变化影响过大。
- 预测窗口内不应该因为一天涨跌就剧烈改变结论。
- 若旧预测还没到期，新预测应该先做“纠偏”，而不是完全覆盖旧预测。
- 买入动作应要求回测质量通过，而不是只看当前模型置信。

本次修复对应：

- 降低短线涨幅权重。
- 增加过热惩罚。
- 增加服务端 backtestGate。
- 增加前端 clientBacktestGate。
- 正向预测没通过回测时封顶置信。
- 没通过回测时阻断买入信号。

## 16. 当前限制

仍然要承认：

- 市场短周期预测天然噪声很大。
- 单票 15 日内涨 5% 是高难任务。
- 新闻和社媒存在真假、滞后和噪声。
- 免费行情源可能缺失分钟线、L2、逐笔或历史深度。
- 回测样本不足时，系统应该保守，而不是假装准确。

因此准确率提升的正确路径不是“让 AI 更大胆”，而是：

1. 积累更多真实预测样本。
2. 按市场、行业、周期分桶。
3. 建立 walk-forward 回测。
4. 严格禁用未来函数。
5. 用回测失败经验反向惩罚同类信号。
6. 对低命中模型降权或禁用。
7. 对高波动、低流动性、新闻驱动票提高门槛。

## 17. 下一步优化路线

优先级最高：

1. 把每次预测和实际 1/5/15 日结果全部持久化。
2. 对每个市场建立独立 walk-forward 校准桶。
3. 对“买入信号”单独统计命中率，而不是混在普通方向预测里。
4. 对“先止损再上涨”单独惩罚。
5. 建立模型禁用机制：连续低于基准时暂停参与买入决策。
6. 引入更严格的 purged/embargoed split。
7. 对新闻和社媒做交叉验证，单一社媒热帖不能单独抬高买入置信。

最终原则：

**宁可少给买入提醒，也不能在回测证据不足时给高置信买入。**
