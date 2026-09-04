# 2026-08-22 升级进度

## 已完成

- 数据质量阻断已前移到 OOF 拟合之前。`trainingBlocked=true` 时不再训练、保存模型或写入最新版本。
- 基本面 `source/verified/temporalValid/nonNull/nonZero/actionable` 改为逐行统计，避免一条有效记录被误报成整池覆盖。
- 特征方案增加 `null/no-model` 基线与 1-SE 选择；候选没有稳定增量时保留弃权基线。
- US 训练池识别并排除 ETF、CEF、优先股、权证、SPAC 和单位证券；ADR 与普通股保留独立标记。
- Nasdaq Trader、ASX Company Directory、ASX Codes and Descriptors、GLEIF、ABN Lookup、ABN Bulk Extract 已进入数据源目录。
- GLEIF/ABN 身份记录已接入 PIT enrichment；身份记录默认 `Shadow`，不会伪造历史财务覆盖或 Alpha。
- 服务版本已更新为 `2026-08-22-pit-gated-v112`。
- macOS compressed/dataless 的旧 `backend/config/env.mjs` 已替换为兼容入口，服务、测试和后台模块现在共享同一环境加载器。
- 性能样式补充了不可见研究面板的 `content-visibility` 和 intrinsic size，避免首次打开时绘制全部隐藏工作区。
- 空模型合同已端到端生效：`null/no-model` 在折级 OOF 直接返回 `NO_MODEL`，不再调用 Ridge、分位数或其他后备拟合；旧折级检查点因 `no-model-propagation-v2` 合同版本不匹配而自动失效。
- Brier/方向筛选器在所有候选不优于先验或稳定性不足时返回空集，不再强制挑选“最不差”模型；空候选不会生成概率、收益区间、权重或可用模型。
- 主训练锁箱现在在标签锦标赛和任何模型拟合前创建，并写入 `lockbox_created_before_fit`、数据版本、特征哈希、宇宙版本、成本、切分策略和 `comparison_key`。
- Champion 注册新增成对非劣保护：跨 `comparison_key` 的候选不能覆盖旧 Champion；同键候选若没有覆盖率至少 90% 的 `nonInferior` 成对证据，也只能保留为 latest/best-challenger。
- 顶层训练结果同步真实候选状态：所有 horizon 都无可用模型时返回 `available=false`、`status=NO_MODEL`、`manifest.model_version=null`，注册层不会因为有原始行情行数就写入一个形式上的模型版本。
- 新晋级证据已升级为 `single-promotion-evidence-v3`：v2 仅保留作历史兼容读取，新证据必须绑定 `comparisonKey`、比较字段、拟合前冻结锁箱、候选状态和内核门；服务端生产门只接受 v3。
- SQLite 证据库新增 `schema_migrations`、`dataset_snapshots`、`experiment_runs`，训练任务落盘时登记数据快照、内容摘要、特征/标签版本、比较键和训练指纹；新增 `/api/evidence/snapshots` 与 `/api/evidence/experiments` 供审计读取。
- 普通后台队列新增任务老化保护：超过 `BACKGROUND_STALE_QUEUE_AGE_MS`（默认24小时）的未启动普通任务会转为 `deferred/queue_stale`，保留可审计记录并允许手动重启；带恢复路径的历史/PIT任务继续保留断点恢复，不会被误清理。
- 旧后台任务文件导入现在区分“文件不可读/已脱水”和“JSON损坏”：不可用产物不会被伪造成零样本或失败训练；可读任务仍会写入统一轨迹。
- `.cache/models/**/manifest.json.gz` 已接入统一证据库，恢复数据快照、内容哈希、股票池版本、特征架构、折数和实际行数；当前可读模型清单 30 份均已导入，三市场均可在 `/api/evidence/snapshots` 查询。
- 任务中心新增只读快速摘要通道、页码和“加载更早任务”：首页只读任务元数据，点击单个任务才加载检查点、子任务、训练结果和审计原文；近期任务不会因大 OOF 文件或启动期证据导入而卡住。
- 任务中心进一步改为 SQLite 轻量索引：归档目录约 896MB 时首页轮询不再解析大体积回测 JSON；终端任务详情也从索引返回阶段、检查点和结果摘要，原始产物只保留给专门审计读取。
- 因子进化自动调度新增数据签名闸门：时间间隔到达但数据版本未变化时不再重复创建任务；失败尝试会留下签名和失败原因，只有新数据或人工重启才会再次执行。
- 学习进度 API 增加有界超时和本地缓存优先：策略页直接读取已有曲线，证据导入在后台进行；无响应时明确显示缓存/导入状态，也不会把“0”包装成模型成绩。

## 验证结果

- Node：150/150 通过。
- Python（项目 `.venv`）：121/121 通过。
- 新增黑盒探针：空模型传播、全候选劣于先验、方向筛选空结果、锁箱创建时点和 Champion 比较键非劣保护均通过。
- 训练前阻断回归：返回 `blocked_data_quality`、`modelVersion=null`、`oofRows=0`。
- 本地服务：`http://127.0.0.1:8787`，Python Core 可用，真实订单执行保持关闭。
- 后台任务中心已实测返回 24 小时分页；最近一页可见真实 CN 回测运行状态、创建/更新时间和进度，详情接口继续提供阶段流程。
- 任务中心快速摘要实测约 0.02 秒返回；失败任务详情可立即看到 `failureCategory`、当前阶段和子任务状态，不再因读取大型 JSON 超时。
- 学习进度接口实测约 0.02 秒返回，当前 ASX 可见 123 个严格轨迹点；实时观察与后台导入状态通过 `refresh` 字段明确返回。
- 证据导入首轮实际结果：任务文件发现 5,716 份，其中 620 份可读并已登记，1,440 份为不可用旧产物，0 份新增 JSON 损坏；模型压缩清单发现 30 份、导入 30 份。

## 当前真实模型状态

阶段一数据就绪不等于模型晋级。当前三市场仍没有 Champion：

| 市场 | 阶段一数据 | BA | Brier Skill | ECE | Top10 | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| ASX | 阶段一就绪；PIT 67.45% | 50.00% | -0.00495 | 2.01% | 35.70% | Research，0/5 正向折 |
| US | 阶段一就绪；PIT 68.84% | 50.00% | -0.00250 | 2.10% | 48.70% | Research，0/5 正向折 |
| CN | 阶段一就绪；PIT 60.79% | 50.00% | -0.01610 | 4.79% | 46.89% | Research，0/5 正向折 |

本轮统一快照中的原始行数分别约为 ASX 713,435、US 853,849、CN 991,579；三者的模型族都因内层 null/1-SE 规则没有证明稳定增量，实际线上候选不能被描述为完整异构集成。`expectedValuePct` 仍为 `null`，因为没有通过长仓证据门，系统没有用 fallback 伪造 EV。

### 本轮服务重启后的本地严格证据复核

| 市场 | 严格轨迹点 | 最新模型 | BA | Brier Skill | ECE | Top10 | 结论 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| ASX | 123 | `asx-multitask-81ece60b3fa0` | 50.00% | -0.001358 | 2.51% | 36.79% | 未形成 Champion |
| US | 78 | `us-multitask-f28b9a9ccfbd` | 51.50% | 0.000831 | 1.61% | 48.70% | 未形成 Champion |
| CN | 78 | `cn-multitask-e1f99b8cb5b5` | 50.00% | -0.008693 | 4.18% | 46.89% | 未形成 Champion |

以上是本地缓存中的严格 OOF 记录，不是新训练成绩；本轮没有用失败任务或实时观察数据覆盖这些指标。

ASX 的官方披露事件覆盖约 99.71%，但结构化数值基本面训练覆盖约 0.86%；披露事件不能替代可行动财务字段。US/CN 还必须在资产和公司行为清洗后的同一 lockbox 上重新生成严格 OOF。

## 尚未完成

- 这次完成的是台账中最优先的“防止假进步”核心 P0，不等于 344 项原子任务全部完成；数据 ETL、历史宇宙、标签锦标赛、多专家 OOF 和 Paper/Shadow 时间证据仍需后续独立产物验收。
- 当前后台任务已对账为 `active=0`、`queued=0`；历史上曾出现的 US 60% 任务已结束或被确定性取消，不再作为“正在训练”展示。

- 预测能力仍未达标：ASX/US/CN 的最新严格 OOF 都未通过 Brier、滚动折、Top10、概率分辨率或成本后 EV 门；NDCG 已有数值，但不能替代 Top10 可交易命中率。
- 需要在清洗后的同一 lockbox 上继续完成真正的 US 资产/行业语义、ASX 公告数值 ETL、CN 宽行业/周期实验，再重建三市场严格 OOF。
- 在新 OOF 证据上构建非负、限权重的多专家集成，并验证是否存在独立增量。
- 取得至少 4/5 正向折、Brier Skill 达标、ECE 达标、Top10 和成本后 EV 同时达标后，才允许进入 Qualified Shadow。
- ASX 官方 4E/4D、年报、半年报和 5B PDF 的数值字段仍需继续 ETL；目前保留为严格事件证据，不虚构数字。
- 60 个 Qualified Shadow 交易日、300 个信号，以及后续 120 日/500 信号的 Paper Champion 不能由一次离线训练完成，必须等待真实新日期成熟后验收。
- 当前统一模型快照虽已恢复到证据库，但它们仍是 Research/Shadow 证据，不能因为“有 30 份清单”就视为多专家或 Champion；需要重新生成严格 OOF 的方向、排序、收益和风险专家，并完成成对比较。
- 当前因子进化批次已确定性结束为 `restart_budget_exhausted`，原因是服务重启恢复预算耗尽，不代表候选因子成功；同一输入签名已被调度闸门记账，后续需在新数据或人工调整资源后重启。

## 2026-08-23 回归修复

- 定位到上一轮明显退化的主要放大器：方向特征方案的 `null/no-model` 结果被当成整折 `NO_MODEL`，同时丢弃路径、排序、收益和事件专家证据；这不是“方向无技能”，而是“所有专家都无技能”的错误合并。
- 修复为模型族隔离门控：方向头无证据时明确 `directionModelStatus=NO_MODEL`、输出弃权；路径/排序/收益/事件/Regime 仍可生成 Research 证据，并继续接受各自 OOF 门控。真正缺少标签或样本时才返回整折 `NO_MODEL`。
- 生产门仍然关闭：方向模型缺失时不生成方向概率、不激活 long-trade gate、不允许 Paper 买入；本次修复只恢复证据可比性，不把退化伪装成提升。
- 新增回归测试覆盖“方向弃权但独立路径/排序证据保留”场景。
- 验证结果：Python 122/122 通过；Node 150/150 通过；Node/Python 语法检查和 `git diff --check` 通过。

### 2026-08-23 注册表语义与运行恢复补强

- 训练结果现在明确区分 `attemptCompleted`、`modelProduced`、`candidateStatus`、`trainingStatus` 和 `modelFamilyStatus`；一次训练完成不再等同于形成完整模型。
- 注册表保存每个 5 日模型族的 `PARTIAL/NO_MODEL` 状态与阻断原因，读取生产门时同时检查路径专家和方向专家，避免旧条目或中性占位重新打开买入门。
- 注册表新增 `latestAttempt` 与 `latestEligibleModel` 双指针；失败、空模型或部分模型只更新尝试指针，不会覆盖最近一个真实候选。
- Champion 决策新增空模型族保护：`PARTIAL`、`NO_MODEL` 或 `EVIDENCE_INSUFFICIENT` 候选不能成为 Champion，即使其他研究专家有 OOF 证据也只能留在 Research/Shadow。
- 清理了占用 8787 但不接受请求的旧服务实例，并用同一入口重启；本地健康、任务中心快速摘要和模型报告接口已完成实测。
- 本轮未重复运行相同数据/相同假设的三市场全量训练；最新 ASX 仍是部分研究证据，不是生产突破。
- 学习进度快速缓存同步修复旧 `promotionEligible` 标记；当前 ASX 快照已实测为 `false`，旧记录归类为 `REJECTED_LEGACY`，不会再被页面当成可晋级模型。

### 为什么最近看起来退化

最近 ASX 缓存显示 Accuracy 约 61.2%，但 Balanced Accuracy=50%、Precision=0%、Recall=0%、Top10=36.8%，说明方向头几乎全部预测为“不上涨”；普通 Accuracy 被类别基准掩盖，不能视为模型能力。上一轮更严格的 null 规则又把这一个方向失败扩大成整折失败，因此页面同时失去了有效路径/排序证据。修复后需要在同一冻结数据上重新生成 OOF，旧缓存数字不会被自动改写。

## 2026-08-24 状态复审与仍有效路线

### 本轮完成

- 训练样本口径升级为 `eligibleRows / effectiveRows / fittedRows / oofRows / independentTestDates`。此前页面的 `effectiveRows=0` 是字段断链，不是没有训练数据；旧轨迹在读取时标记为 `legacy-derived-from-raw-rows`，新训练会直接写入 `training-sample-counts-v2`。
- 当前最新严格证据实际包含：ASX 713,430 拟合行与 193,920 OOF 行；US 774,387 拟合行与 225,661 OOF 行；CN 705,097 拟合行与 233,820 OOF 行。三者均有 198 个独立测试日期，但核心方向/路径族仍为 `NO_MODEL`，所以候选状态保持 `PARTIAL`，`promotionEligible=false`。
- 后台恢复规则不再自动续跑“由监管器创建、尚无任何完整 OOF 折”的中断训练。该任务会转为 `interrupted_supervisor_requires_review`，必须改变计划或人工明确重启。
- 学习进度快速缓存与标准服务使用同一非零样本修复合同；策略页不再把已有几十万拟合行显示为零。
- 监管状态初始化改为一次性原子加载，外部通知和模型日志写入设置 1 秒旁路上限；状态页不再被手机推送、审计日志或首次加载竞态拖住。
- 监管器优先读取 SQLite 任务索引，只有真正运行中的任务才读取内存 Job；终止任务不再走可能脱水或缓慢的原始产物通道。
- 没有实际 Job、没有人工排队且自动训练关闭时，遗留 `queued` 状态按 `completed_not_promoted` 展示，避免首页出现不存在的排队任务。

### 计划有效性重判

仍有效且应继续执行：

1. ASX 官方财报/公告 PDF 数值 ETL，重点提升带真实 `available_at` 的严格基本面覆盖；披露事件覆盖不能替代营收、利润、现金流、杠杆等逐行字段。
2. ASX/US 行业语义和历史成分股修复、CN 稳定宽行业映射；随后按完整每日横截面重建 OOF。
3. 六类预注册标签锦标赛，以及方向、Top-K 排序、条件收益、尾部风险、事件/基本面专家各自的外层验证。
4. 只允许通过独立增量门且残差足够不同的专家进入非负、限权重 OOF stacking；没有通过的专家保留为 Research 证据。
5. 通过离线硬门后积累 Qualified Shadow 60 日/300 信号和 Paper 120 日/500 信号。

已经失效或当前不应执行：

- 仅增加 OHLCV 行数、重复同一数据和参数的大训练。三市场已经拥有 70 万级主任务行与约 20 万级 OOF，数据“数量”不再是主要瓶颈。
- 为提高训练次数而重复拟合；没有新增独立日期、PIT 字段或新假设时只评估，不训练。
- 在核心树/线性专家尚未证明独立增量前继续增加 LSTM、Transformer 或高方差 RL。
- 降低 57%/60% 门槛、用普通 Accuracy 替代 Balanced Accuracy、Top10、Brier Skill 和成本后 EV。

必须等待真实时间而非代码补齐：Qualified Shadow 与 Paper Champion 的独立交易日、成熟标签和真实执行证据。等待期间可以继续数据 ETL、标签实验和 Research OOF，但不能声称已经完成线上验收。

## Growth With Value 状态（2026-08-22 AEST）

- 官方首页和 API 文档仍宣传 Starter 计划，包含每日 250 次 API 调用；这只能证明产品方案存在，不能证明当前注册入口可用。
- 官方首页的 Register/Start Free 链接指向的旧路径 `/registration/` 及 Starter 参数路径，实测均返回 HTTP 404；因此本轮没有新建账号，也不能确认网站当前是否接受新注册。
- 本机环境中已经存在 `GROWTH_WITH_VALUE_API_KEY(S)` 配置，服务状态显示为 `ready`；这表示现有 key 可供适配器尝试使用，不等于新注册成功，也不等于每个接口/套餐权限都已验证。
- 适配器已经保留在服务端：配置 `GROWTH_WITH_VALUE_API_KEY` 或 `GROWTH_WITH_VALUE_API_KEYS` 后才会请求 `inc/bs/cf`；无 key 时保持 `missing_key`，接口失败时只记录 provider warning，不阻塞其他市场，也不伪造基本面数据。
- 在注册页面恢复或用户手动取得 key 前，Growth With Value 记录只能作为未配置数据源；即使拿到 API，缺少 filing/available 时间戳的记录也仍然只进 Shadow，不能直接进入严格 OOF。

## 数据源规则

公开身份目录不需要注册。ABN Lookup 只有在用户提供官方 GUID 后才能启用；不生成伪 GUID、不批量注册账号、不用额外账号规避供应商额度。没有历史发布时间/版本的身份或宏观记录只进入 Shadow。

## 2026-08-24 标签实验与比较身份补强

- 标签锦标赛继续只读取严格 purged OOF 折，不读取最终锁箱；候选必须保留完整日期截面，测试成员覆盖不低于 95%。
- 候选晋级门改为随实际折数计算：至少 75% 折同时满足 `BA > 50%`、`Brier Skill > 0`、`Top-Decile Lift > 0`；5 折时必须至少 4 折为正。缺折或任一主指标失败都会保留明确拒绝原因，不再强选最不差标签。
- 事件标签改为“已验证可行动事件后的市场残差收益为正”。它作为稀疏事件专家单独验收，不能与全市场普通方向标签争夺同一个冠军。
- 实验账本新增单假设合同。显式同时修改多个假设的请求会在拟合前拒绝；即使违规记录到达账本，也会被强制标记为 `rejected_multiple_hypotheses` 和 `promotionEligible=false`。
- 锁箱测试签名不再只哈希日期范围或配置摘要，而是哈希每一折真实的 `fold × date × symbol × rowHash`。训练成员、测试成员、完整宇宙和拆分边界分别生成独立哈希。
- `ComparisonKey` 现在显式包含 `trainMembershipHash`、`testMembershipHash`、`universeMembershipHash`、`labelHash`、`featureHash`、`costHash` 和 `splitHash`；数据、标签、成本、特征或测试成员任一变化都会进入新的不可比较组。
- 本轮没有启动三市场重复大训练，也没有改变页面置信率或模型门槛。新合同只对后续新快照/新假设训练生效；旧证据继续保留为 Legacy/Research。
- 回归结果：Python `126/126`，Node `137/137`，合计 `263/263`；`server.mjs` 与 `app.js` 静态检查通过。

### 下一批仍有效任务

1. 实现锁箱 `frozen → opened → consumed` 单向状态与一次读取审计，完成 `T0211-T0213/T0220`。
2. 将训练、标签锦标赛、因子、Alpha 和 Agent 的不可变产物继续统一到证据数据库，并核验页面只比较相同 `ComparisonKey`。
3. 提升 ASX 严格数值基本面覆盖、ASX/US 行业与历史宇宙语义、CN 宽行业和交易制度字段；仅在数据版本或唯一假设变化后重建 OOF。
4. 分别验收方向、完整横截面 Top-K、条件收益、尾部风险、事件/基本面专家；至少两个低残差相关家族通过后才允许 OOF stacking。
5. 离线硬门未通过前保持 Research/No Trade；Qualified Shadow 与 Paper 的真实日期证据不能用回测或重复训练替代。

## 2026-08-24 锁箱验收与概率证据修复

- 完成锁箱 `frozen_untouched → opened → consumed` 单向状态机，并把它接入 5 日主候选的最终外层验收。每个锁箱只允许一个不可变 candidate ID 读取一次；通过、拒绝、异常都会消费锁箱，之后不能重开。
- Python 内核、PromotionEvidence v3 和训练监工统一要求 `consumed + accepted + accessCount=1`。仅创建但从未验收的锁箱不再被误认为可晋级证据。
- 修复缓存命中状态污染数据版本的问题。同一数据第一次构建矩阵和第二次命中缓存会得到相同数据版本与锁箱 ID，不能借由重复运行绕过一次读取约束。
- 新增月度标签流行率与交易成本 0.5x/1x/2x/3x 压力测试。2x 成本导致标签大面积翻转时，`labelNoiseStable` 直接阻断生产晋级；没有第二条真实可执行价格序列时不伪造延迟入场实验。
- Brier Skill 的基准概率改为对应训练窗口的类别流行率。标签锦标赛、特征方案选择、方向模型窗口筛选、每折 OOF 和最终 meta-test 都不再使用测试期真实上涨比例作为先验。
- 方向模型选择在历史达到 480 个日期时使用最多六个预注册时间窗口；较短历史保持三个不少于 60 日的窗口，避免用过小切片制造稳定性。
- 专家边际贡献生产门由允许 `-0.001` 收紧为必须 `>= 0`。任何降低最终 Brier 的专家都不能靠“多模型”名义进入正式集成。
- 新增 `quant_core/contracts/metric-contract-5d.json`，固定 5 日任务的入场、成本、Brier 基准、Top10、NDCG、EV、区间和 No Trade 定义；合同哈希进入 ComparisonKey，指标口径变化后不得与旧候选直接比较。

本批仍不代表模型已经达标。它修复的是“如何证明进步”：新训练可能因更诚实的 Brier 基准而显示更低分，但不会再把测试期分布信息、重复锁箱或负边际专家包装成能力提升。只有新数据版本或预注册的单一新假设才值得产生下一轮 OOF。

验证结果：Python `130/130`、Node `138/138`，合计 `268/268`；`server.mjs`、`app.js` 静态检查及差异空白检查通过。后台已使用新内核重启，健康接口与任务中心快速接口均正常。
