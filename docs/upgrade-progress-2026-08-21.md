# 三市场 AI 金融系统升级进度核对

更新时间：2026-08-21（Australia/Sydney）

本表对应《三市场AI金融超综合审计与升级计划》P0-01 至 P0-14。这里记录工程证据，不把尚未重跑的模型指标写成“已改善”。

数据字段与免费来源登记见 [PIT 数据缺口登记](pit-data-gap-register-2026-08-21.md)。

本轮新增 `GET /api/pit-gap-report?market=ASX|US|CN|ALL`：将缺口字段、当前已验证覆盖、可用来源和下一步可恢复动作放在同一份后端证据中。SimFin 已确认现有账户和 API key 已配置，不再重复注册。

## P0 核对

| 编号 | 内容 | 本轮状态 | 核验依据 |
|---|---|---|---|
| P0-01 | 冻结训练数据、暂停无新假设的自动返工 | 部分完成 | 服务端默认 TRAINING_SUPERVISOR_AUTOREWORK_ENABLED=false；每次训练已创建内容快照。现有旧队列仍需人工清理/封存后才算完全冻结。 |
| P0-02 | 13 个基本面字段进入聚合 | 已完成 | PIT 聚合初始化并累积 FUNDAMENTAL_FEATURE_NAMES；原始财务别名统一映射；新增回归测试。 |
| P0-03 | 分层覆盖率 | 已完成 | 训练摘要新增 source、verified、temporalValid、nonNull、nonZero、actionable 六层，不再用字段存在性代表可用覆盖。 |
| P0-04 | US/ASX 公司行动污染隔离 | 已执行，仍需补齐来源 | 数据湖审计已迭代隔离跨日多倍跳变 2,138 条并生成不可变审计证据；公司行动覆盖仍不足，不能把隔离视为已恢复。 |
| P0-05 | 极端收益与日截面哨兵 | 已完成（门禁） | 未解释的绝对毛收益超过 100% 不进入标签；跨日跳变迭代隔离；日截面均值异常写入 returnAudit 并阻断生产数据就绪。 |
| P0-06 | 四时间戳 PIT 契约 | 部分完成 | 新增 pit-four-timestamps-v1，校验 observation/published/effective/ingested 顺序；旧数据只有兼容回退字段时会被标记 timestampFallbackRows。 |
| P0-07 | SEC 同日可用性语义 | 部分完成 | 不再以抓取时间替代发布/可用时间；尚未完成全量 SEC 历史记录审计，因此正式 OOF 仍不能宣称 PIT 全覆盖。 |
| P0-08 | 不可变内容寻址快照 | 已完成（代码） | create_training_snapshot 写入 snapshots/market=<market>/<snapshotId>.json，文件级 SHA-256；训练缓存和模型数据版本绑定快照。 |
| P0-09 | 训练指纹 | 已完成（代码） | manifest 保存代码 SHA、配置、snapshot、data version、feature schema、标签与成本的组合指纹。 |
| P0-10 | 数据异常硬失败/隔离 | 已完成（门禁） | 异常收益不 winsorize；训练摘要明确记录排除数、解释数、哨兵和 trainingBlocked。 |
| P0-11 | 完整横截面标签锦标赛 | 已完成（代码门禁） | 不再按股票稀疏抽样；要求至少 50,000 行、250 个独立日期、每个合格日期至少 100 个股票，并保留完整日期面板。 |
| P0-12 | null/no-model 候选 | 已完成 | 所有候选未同时满足正 Brier Skill、正 Top-K lift、至少 3 个正向折时，返回 null/no-model，不强选最优负候选。 |
| P0-13 | 调度老化与公平性 | 已完成（代码） | 研究任务等待 15 分钟后获得保留调度机会，任务暴露 queueAgeMs 和 dispatchReason。 |
| P0-14 | queued/training/stale 页面语义 | 已完成（代码） | 监督器没有 concrete activeJobId 时统一显示 queued、0 进度、无虚假 heartbeat。 |

## 本轮验证

- Python 文件无落盘编译检查：通过。
- Node 语法检查：server.mjs、backend/services/job-manager.mjs 通过。
- Node 测试：141/141 通过。
- Python 量化核心测试：117/117 通过。
- 前端视觉专项回归：14/14 通过。
- 新增回归覆盖：基本面字段不再归零、内容哈希快照变化会生成新 snapshot ID、低证据标签锦标赛拒绝强选。

## 本轮真实执行结果

数据湖审计：

- 审计证据：`auditId=68ace1f7455ed4f1d23c722d514895b7`。
- 三市场重新生成冻结快照，训练脚本现在自动选择最近的 frozen snapshot，不再硬编码旧快照。
- 隔离 2,138 条不可解释跨日多倍跳变；原始行不删除，保存在 `.cache/data-lake/quarantine`，训练默认不读取。
- 训练流程改为完整截面轻量标签骨架 + 轮换完整特征矩阵；特征矩阵和每折 OOF 检查点均已落盘。
- CN 标签锦标赛曾在重型阶段被系统中断；已支持复用既有 108MB 矩阵、跳过重型锦标赛先完成 OOF，CN 五折已完成。

三市场冻结 5 日 OOF（本次仅代表 Research/Shadow 证据，不代表生产资格）：

| 市场 | 股票/训练行 | 测试日期 | 方向 BA | 方向 Brier Skill | ECE | 概率桶最小事件 | long gate | 状态 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| ASX | 200 / 155,957 | 198 | 56.29% | 0.0185 | 2.31% | 6 / 4 | 未激活 | Research/Shadow |
| US | 300 / 231,840 | 198 | 49.26% | -0.0010 | 1.66% | 2 / 7,836 | 未激活 | Research/Degraded |
| CN | 500 / 389,660 | 198 | 51.93% | -0.0057 | 5.36% | 5 / 7 | 未激活 | Research/Degraded |

补充事实：ASX 方向模型的概率桶最低仅 4 个事件；US 概率几乎塌缩到 50%，但桶数量大；CN 方向桶最低仅 7 个事件。三市场 `productionEligibility.eligible=false`，没有任何市场进入 Qualified Shadow 或 Production。ASX 的选择性绝对概率 Top10 不是 long-only 排序 Top10，不能把约 71% 作为交易 Top10 命中率。

## 尚未完成的真实验收

1. 公司行动/复权仍未达到模型级 95% 覆盖；本轮原生 OOF 的 ASX/US/CN 行动覆盖为 81.04%/83.87%/99.51%，调整价格覆盖为 45.52%/13.66%/52.00%。行动覆盖不能替代完整复权序列。
2. ASX/US/CN 的历史成分股、退市和行业语义仍不完整；ASX/US 行业字段在本轮训练中未达到 sector residual 的最低支持，不能启用行业残差专家。
3. 新快照上的标签锦标赛已完成可恢复比较：ASX 因完整日截面不足返回 evidence_insufficient，US/CN 完成 5 折比较但所有候选仍 null/no-model；因此标签实验的工程链完成，标签本身没有通过增量门。
4. 原生 ML 运行时问题已隔离：`.ml-venv` 的 CatBoost、LightGBM、sklearn 已成功运行；旧 `.venv` 仍保留为不可默认使用的兼容环境。模型结果仍可能因 OOF 门禁淘汰，但不能再归因于底层导入崩溃。
5. 三市场仍无可执行 Champion：Top10 long-only 成本后 EV、滚动稳定性、概率分辨率和独立专家增益未同时通过。Qualified Shadow、60/120 个交易日 Paper 证据属于未来观察期，不能在一次离线训练中伪造完成。

## 标签锦标赛真实核验（2026-08-21）

本轮把六类标签比较从“只计数”改为共享冻结面板、逐候选逐折的严格 OOF 比较。候选不再复制六份完整特征矩阵；原生 sklearn 先经过隔离子进程探测，异常时安全回退纯 Python 基线并记录原因，避免在 60% 阶段无记录退出。

| 市场 | 结果 | 面板证据 | 候选结果 | 结论 |
|---|---|---:|---|---|
| ASX | evidence_insufficient | 0 个日期达到 100 股票/日 | 无可比较候选 | 当前完整横截面不足，返回 null/no-model |
| US | oof_compared | 80,000 行、800 个合格日期、5 折 | 4 个候选完成比较；sector/event 支持不足 | 最好的候选仍 Brier Skill 为负，严格返回 null/no-model |
| CN | oof_compared | 79,986 行、480 个合格日期、5 折 | 4 个候选完成比较；sector/event 支持不足 | `net_up` BA 较高但 Brier Skill 为负，严格返回 null/no-model |

US 候选摘要：`top_decile_positive` BA 67.06%、Brier Skill -1.2852，属于标签极不平衡，不能作为方向模型；`triple_barrier_target_first` Brier Skill -0.2903。CN 候选摘要：`net_up` BA 56.86%、Brier Skill -0.0771，`top_decile_positive` Brier Skill -1.8827。ASX 因日截面门槛不足没有候选。以上仅为研究比较，未改变任何线上模型或 lockbox。

## 最终回归验收

- Node 语法与测试：141/141 通过。
- Python 量化核心测试：117/117 通过。
- 前端视觉专项回归：14/14 通过；补回本地 `workspace-market-texture-v1.jpg`、`workspace-model-texture-v1.jpg` 的真实 CSS 引用和命名网格契约。
- 数据湖审计：`auditId=68ace1f7455ed4f1d23c722d514895b7`，2,138 条异常跨日跳变隔离到 quarantine，原始数据未删除。

## 原生 ML 运行时复核（2026-08-21）

项目后台当前优先使用 `.ml-venv/bin/python`，不是旧 `.venv`。原生环境已验证：Python 3.11.15 arm64、numpy 2.4.6、scikit-learn 1.5.2、LightGBM 4.5.0、CatBoost 1.2.10、DuckDB 1.4.3；`model-library-status` 返回 CatBoost/LightGBM/sklearn 均可导入且没有 native import error。Qlib 和 PyTorch 位于 legacy `.venv`，作为研究适配器可见；深度模型仍按政策关闭，不影响表格模型训练。

旧 `.venv` 的 SIGBUS/导入超时已被识别为环境故障，并不再作为后台默认运行时。直接用旧 `.venv` 启动历史脚本仍可能复现该故障，命令行训练应使用 `.ml-venv` 或显式设置 `QUANT_ML_PYTHON_BIN`。

这次验收证明的是训练链、标签比较、失败轨迹和页面回归已经可复现；它没有改变三市场的生产资格判断。当前唯一诚实状态仍是：三市场均未形成可执行 Champion，原因由数据覆盖、概率分辨率、Top10 成本后证据、模型独立增益和稳定性门控共同决定。
