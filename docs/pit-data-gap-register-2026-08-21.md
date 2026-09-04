# PIT 数据缺口与免费来源登记

更新时间：2026-08-21（Australia/Sydney）

这份登记表把“缺什么”与“能否进入正式 OOF”分开。免费来源可以补齐数据，但只有保留 `event_time`、`available_at`、`first_seen_at`、`revision`、来源和市场范围，且能通过点时审计，才允许进入严格训练。没有发布时点的当前回填数据只进入 Shadow 或页面展示。

## 当前缺口

| 数据层 | 必需字段 | 当前问题 | 影响市场 | 优先级 |
| --- | --- | --- | --- | --- |
| 统一行情 | `market`, `exchange`, `symbol`, `interval`, `timestamp`, `open`, `high`, `low`, `close`, `volume`, `source`, `available_at` | 行情已较完整，但 ASX/US 仍有异常跳变隔离；分钟和盘口不能替代日线历史 | US / ASX / CN | P0 |
| 历史股票池 | `listing_date`, `delisting_date`, `index_name`, `membership_from`, `membership_to`, `identifier_map`, `available_at` | 不能把今天的成分股回填到历史；退市、换代码和历史指数成员不完整 | US / ASX / CN | P0 |
| 公司行动 | `action_type`, `ex_date`, `record_date`, `pay_date`, `ratio`, `cash_amount`, `adjustment_factor`, `raw_price`, `adjusted_price`, `available_at` | 覆盖率仍不足 95%，调整价格序列不完整，异常收益会污染标签 | US / ASX | P0 |
| PIT 基本面 | `period_end`, `filed_at`, `published_at`, `available_at`, `revision`, `currency`, `unit`, `revenue`, `operating_income`, `net_income`, `cfo`, `capex`, `cash`, `debt`, `shares`, `roe`, `roic` | 原始字段已有采集，但部分市场聚合层未激活；没有可用时点的记录不能进入正式 OOF | US / ASX / CN | P0 |
| 公告与新闻 | `event_time`, `published_at`, `available_at`, `first_seen_at`, `source_url`, `entity`, `event_type`, `sector_context`, `upstream_downstream`, `revision`, `novelty` | 公司事件覆盖不能等同于事件预测有效；无事件时应 abstain，不应强行输出 | US / ASX / CN | P1 |
| 行业语义 | `taxonomy`, `sector`, `industry`, `effective_from`, `effective_to`, `source`, `available_at` | ASX/US 行业映射不足；CN 行业横截面过窄时行业残差不可信 | US / ASX / CN | P1 |
| 宏观 vintage | `series_id`, `observation_date`, `release_date`, `realtime_start`, `realtime_end`, `vintage`, `value`, `source` | FRED 现值不能代替历史版本；宏观数据必须按发布时点连接 | US / ASX / CN | P1 |
| 执行与订单流 | `bid`, `ask`, `trade_price`, `trade_size`, `venue`, `trade_count`, `spread`, `source`, `available_at` | 仅能改善入场、滑点和容量；当前不应把 IEX/单一来源冒充全市场 L1/L2 | US / ASX / CN | P2 |

## 市场补齐路线

### US

1. 用 SEC EDGAR Submissions、Company Facts 和 bulk submissions 补 `filed_at/acceptanceDateTime`、财务原始字段和公司生命周期。
2. 用 Alpha Vantage `LISTING_STATUS` 或有明确事件时间的列表快照补活跃/退市候选；未取得精确生效日期时只能作为 Shadow。
3. 用有 ex-date/支付日期的公司行动源补拆股、分红和复权；没有完整历史调整因子时，训练先隔离异常收益而不是强行修正。
4. 用 GICS/SIC 的有效期表补行业，并在每日横截面上先完整计算行业排名，再抽样训练。

### ASX

1. 用 ASX Historical Announcements、上市/代码变更和公司公告补事件、停牌、换代码和公告时间。
2. 保存官方公告原始链接、发布日期、price-sensitive 标记及解析版本；抓取时间不能当作发布时点。
3. 补历史成分股和公司行动后，才允许启用行业残差专家；当前 `sectorSemantics` 未通过时保持关闭。
4. RBA、ABS 和商品/汇率宏观序列只通过发布日期或可复现 vintage 加入。

### CN

1. 用 CNINFO、上交所、深交所公告和披露时间补财报、公告、回购、减持、分红和公司行动。
2. 用 Tushare、BaoStock、RQData 交叉核对复权因子和交易日；其中带许可证的数据只能在有效期内使用，原始来源和版本必须落盘。
3. 用 AKShare 只作公开来源适配器；没有披露时点的回填记录不进入严格 OOF。
4. 恢复至少 500 只可交易股票的行业映射，行业组少于 10 只时不计算行业残差。

## 免费或低门槛官方入口

| 来源 | 官网/文档 | 可补内容 | 进入正式 OOF 的条件 |
| --- | --- | --- | --- |
| SEC EDGAR | [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | US filing、XBRL Company Facts、filing history | 使用 `acceptanceDateTime`/申报可见时间，保存原始版本；官方 API 不需要 API key |
| ASX | [Historical Announcements](https://www.asx.com.au/markets/trade-our-cash-market/historical-announcements) | ASX 公告、价格敏感事件、代码/历史公告检索 | 使用公告发布时间和原始链接；遵守个人/非商业使用条款 |
| CNINFO | [巨潮资讯网](https://www.cninfo.com.cn/?lang=en) | A股法定披露、财报、公告和公司事件 | 使用公告时间、证券代码和原始附件；转载抓取时间不能替代发布时间 |
| SSE / SZSE | [上交所披露](https://www.sse.com.cn/disclosure/) / [深交所披露](https://www.szse.cn/disclosure/) | 交易所公告、公司行动、披露信息 | 保存官方披露时点和修订关系 |
| FRED / ALFRED | [FRED API](https://fred.stlouisfed.org/docs/api/fred/fred/) / [ALFRED API](https://fred.stlouisfed.org/docs/api/fred/alfred.html) | 利率、通胀、就业、信用和历史 vintage | 用 `realtime_start/end` 或 vintage 下载；FRED 当前值不能回填历史 |
| RBA | [RBA Statistics](https://www.rba.gov.au/statistics/) | 澳元、利率、金融条件、政策发布 | 保存发布日期、修订和原始表版本 |
| ABS SDMX | [ABS Data API](https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide/using-api) | 澳大利亚宏观、劳动力、价格和行业数据 | 记录 dataflow、release 时间和修订版本 |
| GDELT | [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | 全球新闻事件和主题 | 仅作 Shadow，需事件聚类、首次可见时间和来源质量审计 |
| BLS | [BLS Developers](https://www.bls.gov/developers/) | US 宏观系列 | 没有完整历史 release vintage 时保持 Shadow |
| Alpha Vantage | [官方文档](https://www.alphavantage.co/documentation/) | US 行情、上市状态、基本面补充 | 免费配额有限；需按事件时间和来源能力标记，不能当作全市场实时源 |
| SimFin | [SimFin API / free account](https://www.simfin.com/en/api/) | US as-reported 基本面、CSV bulk | 只有存在 filed/published 时间才进严格 OOF；否则 Shadow |
| AKShare | [在线文档](https://akshare.akfamily.xyz/) | CN 公开行情、公告和数据适配 | 依赖的底层来源要能提供发布时点；否则 Shadow |

## 不应做的事情

- 不通过多个账户复制同一供应商来绕过额度；这不会增加 PIT 质量，也会破坏审计可追溯性。
- 不把当前修订后的财报、当前指数成分或今天下载的历史曲线伪装成过去可见数据。
- 不用新闻数量、事件覆盖率或页面“有数据”替代事件预测的 OOF 增益。
- 不降低 50,000 行、250 个独立日期、概率桶支持、Top10、Brier、ECE、EV 和滚动稳定性门槛来制造晋级。

## 当前验收口径

数据层达到“已采集”不等于“可训练”。每次补齐后必须重新生成完整内容哈希、PIT 审计、异常隔离、横截面标签和冻结 OOF；只有新 OOF 在未触碰 lockbox 上改善，才允许更新 Challenger。没有新增有效数据时只评估，不重复拟合同一版本。
