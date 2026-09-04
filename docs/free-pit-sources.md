# 免费 PIT 数据源接入说明

项目将免费数据源分为两类：

- **Strict PIT**：必须有事件发生时间和首次公开/可用时间，才能进入正式 OOF。
- **Shadow**：可以帮助研究和监控，但缺少完整历史版本或发布 vintage，不能改变生产概率和模型权重。

## 已接入

| Source | Market | Dataset | Status |
| --- | --- | --- | --- |
| SEC EDGAR | US | filings / XBRL fundamentals | Strict PIT |
| SEC EDGAR bulk submissions | US | historical filing metadata / lifecycle evidence | Strict PIT when `acceptanceDateTime` is present |
| ASX official announcements | ASX | announcements / listing / corporate actions | Strict event PIT |
| ASX Codes and Descriptors | ASX | security-type and code semantics | Shadow until a dated archive is available |
| ABN Bulk Extract | ASX | ABN/ACN entity identity | Shadow current snapshot; not a historical financial feature |
| Tushare | CN | financial indicators / listing / dividends | Strict when `ann_date` is present |
| BaoStock | CN | adjustment factor coverage | Strict action receipt |
| FRED/ALFRED | US/ASX/CN | macro vintages | Strict vintage |
| CNINFO official disclosure | CN | announcements / financial disclosures | Strict event PIT |
| RBA official RSS | ASX | policy releases / speeches | Strict event PIT |
| GDELT | US/ASX/CN | global events and news | Shadow event feature |
| BLS public API | US | macro series | Shadow until release vintages are available |
| ABS SDMX Data API | ASX | CPI / GDP macro Shadow series | Shadow until a release-calendar snapshot is preserved |
| Eastmoney public data center | CN | dividends / stock dividends / ex-date actions | Strict fallback only when publication and ex-date fields are present |
| Alpha Vantage `LISTING_STATUS` | US | active/delisted lifecycle snapshots | Strict event PIT, quota-limited |
| Nasdaq Trader Symbol Directory | US | symbol、交易所和 ETF/基金等资产类型 | Shadow current snapshot; 需保存带日期快照，不能单独重建退市历史 |
| OpenFIGI | US/ASX/CN | FIGI、ticker、交易所和证券类型映射 | Shadow identity; 无 key 可用但限流更低，历史训练前必须保存日期化映射 |
| GLEIF API | US/ASX/CN | LEI、法律实体、母子公司和部分 ISIN/BIC 映射 | Shadow identity; 不提供财报数值或收益标签 |
| ASX Company Directory | ASX | 当前公司、代码和证券类型目录 | Shadow current snapshot; 不能替代历史成分股/退市档案 |
| ABN Lookup Web Services | ASX | ABN/ACN、实体名称和状态 | 需要免费 GUID；只做实体身份，不能替代历史财报 |
| SimFin as-reported API | US | historical statements | Strict only when a filed/published timestamp is present |
| AKShare public adapters | CN | public-source fallback | Shadow unless a source release timestamp is preserved |
| RiceQuant RQData | CN | historical bars / adjusted bars | Strict bars during the licensed trial; retain license expiry and source version |

官方入口：

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [ASX Historical Announcements](https://www.asx.com.au/markets/trade-our-cash-market/historical-announcements)
- [ASX Codes and Descriptors](https://www.asx.com.au/markets/market-resources/asx-codes-and-descriptors)
- [ABN Bulk Extract](https://data.gov.au/data/dataset/abn-bulk-extract)
- [CNINFO](https://www.cninfo.com.cn/?lang=en)
- [FRED / ALFRED](https://fred.stlouisfed.org/docs/api/alfred/)
- [RBA Statistics](https://www.rba.gov.au/statistics/)
- [ABS Data API](https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide/using-api)
- [GDELT DOC API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- [Alpha Vantage documentation](https://www.alphavantage.co/documentation/)
- [Nasdaq Trader Symbol Directory](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs)
- [OpenFIGI API documentation](https://www.openfigi.com/api/documentation)
- [GLEIF public API](https://www.gleif.org/en/lei-data/gleif-api)
- [ASX Company Directory](https://www.asx.com.au/markets/trade-our-cash-market/directory.html)
- [ABN Lookup Web Services](https://abr.business.gov.au/Tools/WebServices/1000)
- [SimFin API](https://www.simfin.com/en/api/)
- [AKShare documentation](https://akshare.akfamily.xyz/)
- [Eastmoney Data Center](https://data.eastmoney.com/)
- [Nasdaq Trader Symbol Directory](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs)
- [GLEIF public API](https://www.gleif.org/en/lei-data/gleif-api)
- [ABN Lookup Web Services](https://abr.business.gov.au/Tools/WebServices/1000)
- [ASX Company Directory](https://www.asx.com.au/markets/trade-our-cash-market/directory.html)
- [SSE listed-company disclosure search](https://www.sse.org.cn/disclosure/notice/company/)

## 本轮核实的公开来源边界

以下入口可以直接补充身份、上市状态或公告索引，但不能把当前快照推断成历史 PIT：

| 来源 | 可以补的字段 | 进入正式 OOF 的条件 | 当前限制 |
| --- | --- | --- | --- |
| Nasdaq Trader | US symbol、交易所、ETF/基金标记等 | 必须保存带日期的目录快照，并与历史上市状态关联 | 目录主要反映当前交易日，不能单独重建完整退市历史 |
| GLEIF API | LEI、法律实体、母子公司关系、BIC/ISIN 映射 | 保存查询时间、返回版本和实体映射证据 | 身份数据，不提供财报数值或收益标签 |
| ABN Lookup | 澳大利亚 ABN/ACN、实体名称和状态 | 记录查询 GUID、查询时间与状态生效日期 | 需要注册 GUID；不能替代 ASX 财报或历史成分股 |
| ASX Company Directory | 当前上市实体、退市实体入口、代码语义 | 对历史公告/上市变更保存原始公告时间 | 当前目录不是完整历史股票池 |
| SSE / CNINFO | CN 上市公司公告、上市/终止上市公告 | 使用公告发布日期/披露时间和原文哈希 | 公告索引不自动提供统一结构化基本面 |

本轮核实结论：公开来源足以推进身份、公告和部分生命周期清洗，但不能凭空补出 ASX 10 年结构化基本面。ASX 这部分仍需解析官方公告 PDF，或接入拥有历史财报字段和披露时间的授权源；未满足条件的记录继续保留在 Shadow。

OpenFIGI 的官方文档说明：未认证请求可以直接使用，但速率限制低于 API key；因此本项目将它接入为身份映射/资产类型清洗源，不将它当作财报、新闻或 PIT 收益源。Nasdaq Trader 和 ASX Company Directory 同样是当前目录快照，写入时必须带 `as_of`/`available_at`，不能把当前目录回填成历史股票池。ABN Lookup 的免费服务需要用户申请 GUID；在 GUID 写入 `.env.local` 前，项目只保留 `requires-guid` 状态。

CNINFO runs in the resumable `pit-enrichment` background job and writes both `news` and `financial_disclosures` records. BLS and GDELT records are written with `historicalAvailabilityVerified=false`; this is intentional and prevents current revisions or media snapshots from becoming historical training facts.

SEC filing metadata is written separately to `financial_disclosures`. CompanyFacts numeric facts remain in `fundamentals`; the filing `acceptanceDateTime` is the `available_at` gate. This prevents the situation where US filing evidence exists but the disclosure coverage counter remains zero.

## Configuration

Copy the optional variables from `.env.example` into `.env.local` when needed:

```text
CNINFO_PIT_ENABLED=true
CNINFO_PIT_YEARS=8
BLS_PIT_ENABLED=true
BLS_PIT_YEARS=20
```

The source health endpoint is `GET /api/free-pit-sources`. The field-level gap endpoint is `GET /api/pit-gap-report?market=ASX|US|CN|ALL`; it reports verified coverage, missing required fields, eligible source identities and the next resumable action. The existing data health page also displays the source tier. Raw responses and normalized records remain local; API keys are never returned to the frontend.

For FRED/ALFRED, `FRED_API_KEY` and the comma-separated `FRED_API_KEYS` pool are treated as one failover pool. Concurrent macro series are distributed across the pool, quota/authorization failures rotate to the next key, and an all-key failure is recorded in the PIT job instead of being silently converted to zero rows. Macro coverage is measured by distinct verified observation dates and verified series, not by stock-symbol coverage; `trainingUniverseCoveragePct` is intentionally not the macro denominator.

SimFin registration is an existing-account check, not a quota workaround. If the account is already linked, the Web API page exposes the account key and the project reads it only from `.env.local`; the key is never committed, logged or returned by `/api/free-pit-sources`.

ABS uses the public SDMX REST endpoint without a key. The adapter is configurable by `ABS_SDMX_DATASETS` and stores current-vintage observations with an explicit Shadow flag because the public response does not itself provide a complete historical release calendar. It must not be promoted to strict OOF until release snapshots are archived.

Eastmoney's public dividend endpoint is now a CN corporate-action fallback. It requires a publication date together with an ex-dividend or record date, preserves cash/stock-dividend fields and keeps the source and fallback error in the resumable job receipt. It improves event coverage, but it does not replace an exchange-grade adjustment-factor history; the corporate-action gate still uses audited verified coverage.

## Operating rule

Do not use additional accounts to bypass quotas. A source is useful only when its identity, timestamp, revision and market scope can be audited. Adding more copies of the same revised dataset increases request volume but does not increase PIT quality.
