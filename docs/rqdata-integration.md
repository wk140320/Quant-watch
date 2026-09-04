# RQData 集成说明

RQData 作为 CN 市场的受控历史行情补齐源，不会被暴露到浏览器，也不会绕过供应商额度。许可证只从本机 `.env.local` / `.env` 读取，分享版本只保留空变量名。

## 已完成

- RQSDK/RQData Python 包已安装到项目 `.venv`；生产 ML worker 使用 `.ml-venv`，不再把 RQSDK/torch/OpenMP 直接加载进训练进程。
- 当生产 worker 发现 `rqdatac` 不在隔离环境时，`RQDATA_PYTHON_BIN` 会通过独立 JSON helper 调用已授权的 RQData 运行时；helper 只返回行情结果，不返回许可证或密钥。
- `rqdata-status` 会检查配置、许可证有效期和供应商额度。
- `rqdata-candles` 只读获取 CN 日线并写入统一数据湖，主键使用 `market:exchange:symbol:interval:timestamp`。
- 批量回填任务 `rqdata-backfill` 支持分批、失败记录和训练完成后的 CN 严格 OOF 重建。
- 许可证到期后自动停止请求，不会回退成模拟数据。
- `/api/pit-provider-status` 和 `/api/free-pit-sources` 展示 RQData 的状态、有效期和用途。
- 状态中的 `runtime`、`helperPython` 和 `pythonPackage` 用于区分“已配置”“可请求”和“仅有许可证但运行时缺失”。

## 数据边界

RQData 本轮主要补足历史 OHLCV、复权行情和横截面样本。财报、公告、新闻与宏观数据仍必须使用各自的 `event_time`、`available_at` 和版本验证；不能因为 RQData 有历史行情，就把后验财报或新闻回填进过去的 OOF。

## 一个月使用策略

1. 先完成 CN 5 日模型的严格 OOF 重建，确认数据版本和新增样本确实进入训练。
2. 每日只追加新完成交易日和成熟标签，不重复拟合相同数据。
3. 每周比较 Challenger 与冻结测试集，只有 Brier、ECE、EV、PSI 和滚动折同时改善才保留。
4. 到期前冻结最终数据版本、OOF 预测和训练报告；到期后系统自动进入本地数据复用模式。

RQData 扩大的是证据规模和覆盖，不承诺准确率必然上升。生产晋级仍由严格门控决定。
