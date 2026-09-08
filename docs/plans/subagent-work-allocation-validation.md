# 工作分配首批验收记录

日期：2026-09-08。范围：四处提示优化、轻量 Pi 行为 smoke、TUI 渲染回归。未实现运行时 checkpoint、软预算调度或并行 writer。

## 环境与限制

- Pi CLI：0.85.1；项目锁定的 Pi SDK：0.84.4。没有升级项目依赖。
- 所有 live 行为测试和两路独立审查均使用 Pi 的 `openai/gpt-5.6-sol`，`thinking=high`。请求发送前核对 provider、模型 ID 和请求中的 reasoning effort；不使用 `openai-codex`。
- 每次验收命令最多 18 次请求、每请求最多 4,096 输出 tokens、每用例最多 180 秒。累计已完成请求达到 60,000 tokens 时停止新请求；并发中的请求可超过阈值。该阈值不是整个开发会话的总量限制。
- 每项仅为一两个交付物和少量 fixture 文件，不开展性能 A/B。后两项显式指定委派类型，验证执行行为，不验证模型能否自主找到最佳拆解。
- direct 使用默认 Pi parent 提示；background、scope 使用精简 parent 提示及完整 Agent guidelines/模式注入。child 保留内置 profile。最终 harness 使用 RPC，允许 parent 结束当前轮次后由后台通知继续。
- 模型配置与认证配置复制到受限临时目录，命令结束后删除；不修改用户日常设置。原始轨迹、结果和 session 保留在下述临时产物目录。

## 最终行为观察

| 场景 | 观察与检查 | 结论 |
| --- | --- | --- |
| direct | `normalizeName` 正确 trim/lowercase；没有 Agent/Swarm；独立 Node 断言通过 | 简单任务直接执行行为通过。5 次请求，37,499 tokens。 |
| background | 恰好一个后台 explore；parent 在 child 完成前修改 `status.mjs` 并验证；契约文件不变；没有 TaskList/TaskOutput；通知触发最终汇总 | 分工、实际重叠和自动恢复行为通过。8 次请求，60,767 tokens；最终已无待发请求，因此正常结束。 |
| scope | 恰好一个前台 coder；缺少 `wire-v2.md` 时不猜测、不改文件；交付包含已查内容、检查、阻塞和后续要求；parent 核对原文件并报告缺失规范 | 范围控制与部分交付行为通过。6 次请求，47,952 tokens。 |

background 的重叠通过 parent 工具执行前后文件指纹变化和 child task 的起止时间判断，包含 Bash 写入，未将 parent 的前台 Agent 调用区间当作 parent 自己写入。该检查仅用于小 fixture 的顶层文件，不是通用写入归属证明。

人工阅读 background 的 child 和 parent 最终报告时发现一项语义局限：legacy 文档只写了 429 可重试，报告却将其扩大为“仅 429 可重试”。其余共同 Retry-After 格式、GET/HEAD、POST 和代理限制均有对应证据。**这项语义过度推断没有因自动检查通过而被忽略；完整端到端质量验收仍未成立。** 本批没有为了让该输出通过而修改 fixture 的事实。

报告字段使用 `automaticChecksPassed` 与 `manualReviewRequired: true`，不再把自动轨迹检查统称为整体通过。不能仅凭文件不变和工具类型正确，认定阻塞报告或契约比较语义正确。

## 失败与修正

保留全部尝试，不只统计最终成功样本：

| 临时目录后缀 | 结果 | 已记录 tokens |
| --- | --- | ---: |
| `ZXKKSu` | 沙箱内连接错误；无有效模型响应。修正验收器，模型 error 不再因进程退出码为 0 而算执行成功 | 0 |
| `Lp3ZjQ` | direct 通过；后续 background 触发累计阈值，未完成 | 60,327 |
| `aoD8yh` | background 的实现已完成，但 parent 开始 TaskList/TaskOutput 查询及额外检查，随后触发阈值。补充“结束当前轮次并等待通知”的明确规则；修正 Bash 写入漏判 | 74,128 |
| `pl5lOS` | 新规则下无轮询且有实际重叠，但缩减工具时误禁用 explore 的目录工具，child 无法枚举文件；随后触发阈值。恢复 read/grep/find/ls，补充任务中已知的确切路径 | 63,217 |
| `zt2Ndr` | background 行为通过；同批 scope 尚未发送请求就被累计预算阻止 | 60,767 |
| `tuTNod` | 单独完成剩余 scope；未重跑已完成场景 | 47,952 |

各目录前缀为本机临时目录下的 `kimi-work-allocation-`。默认 live 现只运行 background，可单独选择其他场景，避免默认串起一批任务耗尽预算。后续大规模 A/B 没有执行。

另以不会调用模型的假 Pi 可执行文件制造空 session，确认验收器输出失败报告和非零退出码，而不是 JSON 解析崩溃或假通过。

## TUI 与离线检查

- 新增活跃后台任务的长文本、中文宽字符、换行、终端清屏/标题控制序列检查，覆盖宽度 20、40、80；确认 widget 行数稳定、宽度不越界且危险控制序列不泄露。
- 新增 coder 完成交付的折叠/展开检查，确认长部分交付文本不破坏渲染，已完成任务不会残留为活跃后台行。
- 对真实 Agent 工具结果在宽度 24、80 下执行折叠/展开渲染检查；两个委派场景均通过。
- `npm test`：16 个文件、76 个测试通过；`npm run typecheck` 通过；既有离线策略 eval 和新增入口语法检查通过。
- 没有改动生产 TUI 实现；未进行交互终端截图验收。上述证据覆盖渲染输出和既有控制器测试，不等同于肉眼验证整个终端布局。

## 独立代码审查

使用 `code-review` 的 Standards / Spec 两路独立 Pi 审查，每路一个只读模型请求，固定实现起点 `e2e808085ef937976c038ea4099a1aad4d5ee730`。

- Standards：采用空日志/损坏日志的失败报告修正。未采用“TaskRecord 可能 queued”的告警：现有 `AgentRunStatus` 没有 queued，所有活动 TaskRecord 均为 running；Swarm 排队状态位于另外的 monitor member 上。三种固定 fixture 的显式分支保留，暂不引入检查器注册抽象。
- Spec：采用活跃 widget 的危险文本覆盖；将自动检查与人工语义验收明确分开，并逐项阅读真实 child/parent 输出。background 的语义过度推断作为剩余限制保留。

审查产物位于本机临时目录 `kimi-review-D90bgT`。两路分别记录 15,940 和 15,860 tokens。

## 总用量

所有已记录尝试加独立审查：**338,191 tokens**，其中输入 133,554、输出 14,813、缓存读取 189,824。Pi 按本地模型目录价格报告的费用合计约 **USD 0.91**。实际账单以供应商为准，强制停止的未完成请求可能没有完整用量回报。

行为测试本身记录 306,391 tokens；多次修正测试宿主和预算终止导致总量高于单次 smoke 预期。该事实保留在报告中，不用最终成功样本代替实际消耗。后续没有再追加付费 A/B 或自动模型 judge。
