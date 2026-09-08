# Kimi 子代理负载分配调研与改进方案

## Kimi 源码调研

调研日期：2026-09-06。证据来自本地 `../kimi-code`，HEAD 为 `7bc5b2027cd80e19dcacf43ed92aad749964a9e3`，调研时该仓库工作区干净。检查了 v1 `packages/agent-core` 与 v2 `packages/agent-core-v2` 的内置 profile、普通 Agent、AgentSwarm、任务通知和批调度链路。以下否定结论限定于这些默认路径，不代表用户自定义 profile、其他实验功能或线上模型行为。

### 结论

**没有发现 Kimi 在上述路径实现按实际工作量自动拆分、迁移或抢占 coder 的负载均衡器，也没有发现普通模式要求主 agent 必须保留关键路径实现工作的提示词。** 它主要依靠调用者先划分工作范围、为真正独立的工作选择后台执行，以及 Swarm 模式的细粒度分解提示。调度层管理的是启动速度、并发与 provider 限流；不会理解一个 coder 的剩余任务并把它分给空闲主 agent。

这一结论不意味着 Kimi 已经解决了“一个 coder 很忙、主 agent 很闲”：普通前台调用允许主 agent 等待；Swarm 也等待整个批次。应借鉴其分工语义，而不是把异步通知或限流队列误认为任务负载均衡。

### 1. 普通 Agent：先保证独立工作，后台模式不会创造可并行性

- 后台提示要求：只有主 agent 还有其他工作、下一步不依赖子代理结果时，才用 `run_in_background=true`；否则默认前台。禁止后台启动后马上 `TaskOutput`、sleep 或其他方式等待。v1、v2 内容相同。[v1 提示词](../../../kimi-code/packages/agent-core/src/tools/builtin/collaboration/agent-background-enabled.md#L1)、[v2 提示词](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agent-background-enabled.md#L1)
- 这在工具实现中是实在的执行差异：后台注册后立即返回；前台 `await waitForForegroundRelease(taskId)`，只有结束或被用户移到后台才释放。[v2 agentTool.ts:424–485](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agentTool.ts#L424)；v1 对应 `agent.ts:261–303`。[v1 agent.ts](../../../kimi-code/packages/agent-core/src/tools/builtin/collaboration/agent.ts#L261)
- 后台结束会构造 `role: 'user'` 的 `TaskNotificationStepRequest` 并放入主循环队列，主 agent 不必轮询。[v2 taskService.ts:1096–1112](../../../kimi-code/packages/agent-core-v2/src/agent/task/taskService.ts#L1096)
- 任务提示要给明确目标、已有认识、确切路径/命令；不要把定位自己已知内容的成本转交给子代理。简单一两步的工作直接完成。已委派的范围不要重复调查或中途抢回来。[v2 agent.md:3–16](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agent.md#L3)

**含义：** 前台/后台是在选择等待方式；它不会降低一个大任务本身的耗时。如果主 agent 没有可独立推进的事项，切到前台只是合理表达依赖关系，并没有实现负载均衡。

### 2. 主 agent 仍能编码；coder 不是整个团队唯一写入者

默认主 agent 的工具包含 `Write`、`Edit`、`Bash`；coder 描述中的“only subagent type with file-editing tools”限定的是**子代理类型**，不是禁止主 agent 编码。[v1 agent.yaml:8–14、37–43](../../../kimi-code/packages/agent-core/src/profile/default/agent.yaml#L8)、[v2 profiles.ts:12–18、94–112](../../../kimi-code/packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts#L12)

已委派范围不可重复工作，是 `Agent` 提示词的范围约束，并非整个 cwd 全局单 writer 的提示。结合主 agent 保留编辑工具，可以推断普通模式允许主 agent 负责另一独立范围；这里没有声称存在文件锁或自动冲突隔离。[v2 agent.md:16](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agent.md#L16)

默认 coder 要完成技术上完整的最终交接，包括修改原因、文件路径、验证和遗留事项；工具列表不包含 `Agent` / `AgentSwarm`，因此默认 coder 不会自己递归拆出更多 coder。[v1 coder.yaml:5–30](../../../kimi-code/packages/agent-core/src/profile/default/coder.yaml#L5)、[v2 profiles.ts:46–86](../../../kimi-code/packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts#L46)

### 3. AgentSwarm：细分由模型完成，队列只执行给定 items

工具提示适合“同类任务、不同输入”，异构的少量任务应在同一消息发多个普通 `Agent` 调用。它支持最多 128 个子代理，鼓励将大任务划分为清晰、独立的 items。[v2 agent-swarm.md:3–11](../../../kimi-code/packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.md#L3)

Swarm 模式的附加提示更强：探索后划分 distinct scope，避免重复或冲突；在职责不冲突的前提下尽可能细分，只合并真正不可分割的任务。但该模式同时明确要求主 agent “do not handle the main work yourself”。因此它针对的是子代理间的分解与并行，并不追求主 agent 与 coder 同时忙于实现。[v2 enter-reminder.md:9–21](../../../kimi-code/packages/agent-core-v2/src/features/swarm/agent/enter-reminder.md#L9)

实现把已有 `specs` 映射成任务，每项 `runInBackground: false`，随后 `await swarmService.run(...)`；批调度要等每个输入槽都有结果才结束。工具还要求本次响应只能有这个工具调用。[v2 agentSwarmTool.ts:179–211](../../../kimi-code/packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agentSwarmTool.ts#L179)、[agentRunBatch.ts:511–516](../../../kimi-code/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts#L511)、[agent-swarm.md:11](../../../kimi-code/packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.md#L11)

**含义：** 细分可以减少一个大 coder 任务拖住其他工作的概率，但运行时没有自动二次拆分长尾任务；整个批次仍可能受最慢项影响。

### 4. 调度算法：供给侧限流与并发控制，不是任务时长均衡

v1 `SubagentBatch` 与 v2 `AgentRunBatch` 的主要规则一致：

- 正常阶段先启动最多 5 项，此后每 700 ms 再启动 1 项；可用 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 限制并发，不设置时正常阶段没有活动任务数量上限。
- 遇到 provider rate limit 时保存 agent id、重排该任务、指数退避，并缩小并发容量；连续 3 分钟无新限流时逐步恢复容量。
- 项目完成释放槽位并重新调度 pending 队列；超时只失败该项，最后汇总所有结果。

规则与实现证据：[v1 subagent-batch.ts:13–30](../../../kimi-code/packages/agent-core/src/session/subagent-batch.ts#L13)、[v2 agentRunBatch.ts:185–216](../../../kimi-code/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts#L185)、[v2 :358–480](../../../kimi-code/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts#L358)、[v2 :631–644](../../../kimi-code/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts#L631)。

调度状态记录任务、重试次数、重试就绪时间和是否启动；任务列表在构造时生成。这里没有预计工作量、剩余工作量、主 agent 空闲时间或动态生成新子任务的状态与分支。[v2 agentRunBatch.ts:75–135](../../../kimi-code/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts#L75)

### 5. 超时、停止和恢复是保险，不是短周期工作切片

普通 Agent schema 没有逐次调用的 milestone、预计工作量或协作式 yield 参数，只有任务、类型、resume、后台、fork、model 等字段。[v2 agent.ts:29–62](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agent.ts#L29)

提示词写“fixed 2-hour timeout”；实现更准确的语义是默认 2 小时，可通过配置/环境变量覆盖。Swarm 也默认 2 小时。这不是用于快速再分配工作的量子时间片。[普通 subagent/configSection.ts:25–26、50–79](../../../kimi-code/packages/agent-core-v2/src/session/subagent/configSection.ts#L25)、[Swarm configSection.ts:13–42](../../../kimi-code/packages/agent-core-v2/src/features/swarm/configSection.ts#L13)

普通 Agent 将 timeout 传给任务服务，超时会终止任务；任务服务虽有自动后台化能力，但该 Agent 注册路径没有开启 `autoBackgroundOnTimeout`。用户可停止或将前台任务移到后台，超时后提示建议 resume 原 agent 保留上下文；这些都是停止、释放等待或恢复同一项工作，不是把剩余任务安全转移给其他 agent。[agentTool.ts:424–434、479–485](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agentTool.ts#L424)、[taskService.ts:680–705](../../../kimi-code/packages/agent-core-v2/src/agent/task/taskService.ts#L680)、[agent.md:10–12](../../../kimi-code/packages/agent-core-v2/src/agent/tools/agent/agent.md#L10)

### 对本插件方案的约束

1. 如果本插件已有前后台选择和结束通知，重复增加这些提示不能解决任务粒度问题。
2. 最直接的借鉴是：把“子代理中只有 coder 可写”与“主 agent 不能写”分开；用明确范围分工替代笼统把实现都交给一个 coder。
3. Kimi 的 Swarm 细分提示可以移植为委派前的判断，但不应把“尽可能多 agent”照搬成默认策略；还要衡量交接成本、写入冲突和关键依赖。
4. 如果引入 checkpoint、软预算或安全交接，应清楚标明这是本插件新增设计；上述 Kimi 路径没有提供现成的长尾抢占协议。

## 当前插件的差距

对照版本：`kimi-like-subagent` HEAD `e2e808085ef937976c038ea4099a1aad4d5ee730`。以下是静态代码事实及其设计含义，不是对用户实际会话的性能复现。

| 事实 | 源码 | 对当前问题的含义 |
| --- | --- | --- |
| 已要求后台任务必须有独立工作可并行，并禁止轮询 | `prompts/guidelines/Agent.md:1–3`、`prompts/tools/Agent.md:1` | 不能只把 Kimi 的同类提示再抄一遍，期待解决长 coder 问题。 |
| 主 agent 被要求负责 scope、验证、整合和最终汇报，但没有明确保留一个执行任务 | `prompts/modes/delegation.md:5–9` | 提示允许模型把主要实现全部交出去，之后只能验收；这是待行为评测验证的解释。 |
| 同 cwd 禁止并发写，coder 被告知自己是唯一写入者 | `prompts/modes/delegation.md:7`、`agents/coder.md:7` | 单个 coder 接走主要实现后，parent 不能再通过并行编码分担工作。此约束是提示词规则，不是普通 Agent 的文件锁。 |
| 前台调用直接等待 child completion；只有后台调用立即返回 | `src/agent-service.ts:398–400,455–457` | parent 在前台工具等待期间无法重新决策。 |
| Swarm 对固定 work 数组调度，全部结束才返回；容量随限流调整 | `src/scheduler.ts:21–42,45–119`、`src/tools.ts:214–249` | 属于并发控制，不会拆分正在执行的大任务，也不会将工作分给 parent。 |
| 默认 2 小时超时，超时直接 abort；没有阶段交付语义 | `src/config.ts:12–24`、`src/runtime.ts:178–202` | 超时是失败兜底，无法作为正常的负载平衡策略。 |
| completion 用 followUp 通知；活动流主要进入 state/monitor | `src/agent-service.ts:262–270,324–338` | 已有可复用事件，但没有语义上的“任务膨胀、需要拆分、交接完成”反馈。 |

还有一个宿主边界：本地安装的 Pi `0.84.4` 在同轮并行工具执行中使用 `Promise.all`，主循环等整个工具批次返回后才进入下一轮。因此 `Agent(foreground) + Read` 同轮发出，只能重叠这一次 Read，不能让 parent 持续推进多轮工作。证据：`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:129–158,330–370`。此处引用安装产物，版本由 `package.json:23–35` 固定。

## 建议：先改善分工，再补运行中反馈

优化目标是：在结果质量与成本可接受的前提下，缩短端到端完成时间和可避免的等待。不要把 parent 忙碌率或 subagent 数量本身设为目标。不可并行、必须等待依赖的任务，应允许主 agent 自己完成，或者为了隔离上下文而有意识地前台委派。

### 第一阶段：让每次委派形成具体的分工

改动边界以 `prompts/modes/delegation.md`、`prompts/guidelines/Agent.md`、`prompts/tools/Agent.md`、`agents/coder.md` 为主。

主 agent 在调用前必须形成以下内容，无须每次向用户输出一份计划：

1. **parent 的任务**：当前就能开始、有明确交付物的一块工作。默认保留最依赖当前上下文、最影响下一步决策的工作；不能只写“等结果后 review”。
2. **child 的任务**：一个可独立验收的结果，包含已知路径、必要上下文、范围和停止条件。避免“实现整个功能、补全所有测试、修复全部失败并做最终整合”这类串联大包。
3. **依赖与冲突**：parent 下一步是否需要 child 结果，是否修改 child 正在读取的证据。读写冲突同样算冲突。
4. **执行选择**：存在有价值的独立工作才用 background；没有则重新划分，或直接做，或明确选择 foreground 的上下文隔离收益。禁止为了调用工具而编造小任务。

在现有单 writer 规则下，普通编码任务优先采用 **parent 写代码，explore/plan 做不冲突的定向研究**；需要 coder 时，让它负责闭合的小任务，parent 同期推进另一份独立调查、设计判断或验收准备。测试只有在不依赖尚未完成的代码、也不会共享写入产物时才算独立工作。

建议提示词核心表达：

> 保留一个自己现在可以推进的实质任务。仅委派有清晰交付边界的子任务；不要把整个主要实现交给 coder 后只留下等待与验收。若没有独立工作，优先自己处理，或基于上下文隔离收益选择前台委派。任务超出原定范围时，子 agent 应在安全边界交付已有结果、阻塞点与剩余工作，由主 agent 决定下一阶段。

例如，“新增请求重试”应让 parent 负责重试状态机与调用路径，child 检查一个未被 parent 修改的外部适配层，报告兼容性约束。如果工作天然只有同一处紧耦合修改，直接由 parent 完成。不要为了分摊工作让两个 agent 同时编辑它。

第一阶段可以先将上述分工放在提示词与评测输出里，不急于引入一套任务图 API。若多轮评测仍频繁出现虚假的 parent 工作，再将 `parent_work`、`deliverable`、`stop_condition` 升级为结构化委派字段。字段非空只能保证显式表达，不能证明语义独立。

### 第二阶段：阶段性交付与安全交接

给长任务加入可观测的反馈点，复用 `runtime → AgentService → state/monitor`，不要让 TUI 反向承担调度职责。

- 记录运行耗时、模型轮次、最近工具活动与 child 主动报告的 checkpoint。工具活动只能说明“仍在工作”，不能推断完成百分比或剩余时间。
- checkpoint 至少包含：已完成交付、变更路径、已运行检查、阻塞、剩余任务、是否仍有活动工具。区分“进度报告”和“已暂停且可交接”，前者不能释放 writer 所有权。
- 先用可配置的软预算请求 checkpoint；到达软预算不直接杀掉 coder，也不自动让 parent 接管。预算数值应由实际轨迹校准，不能将固定几分钟当成适用于所有模型的标准。
- child 在工具完成后的安全边界结束本阶段，将执行成功与整个任务完成分开表达。正常阶段返回仍可保留现有 run 的 `completed`，另记任务 `needs_followup`；若以后支持保持存活的暂停态，再扩展生命周期，不能把超时伪装成成功 checkpoint。
- parent 收到交付后选择：继续 resume 同一 agent、拆分尚未开始且相互独立的工作、或在确认旧 writer 已退出且工作区可读后自己接手。保持已有上下文，避免重新做 child 的探索。

特别注意通知不能穿透前台 await：Pi 的 `followUp` 在当前内层循环结束后消费，`steer` 也在循环边界消费；都不能让等待未返回工具的 parent 立即开始思考（`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:137–161`）。因此前台长任务必须让 child 阶段返回，或者另行实现有明确 signal/结果交付语义的 detach；仅加一个定时提醒没有调度效果。后台 checkpoint 通知也应合并、去重，只在状态变化时触发，避免定时唤醒造成额外空转。

实现位置建议：`src/types.ts` 定义 checkpoint 数据，`src/runtime.ts` 采集与控制 child 的安全阶段结束，`src/agent-service.ts` 管理阶段结果和通知，`src/state.ts` 持久化可恢复信息。具体暂停接口应先针对 Pi 的 session 生命周期做小范围验证；目前不能声称插件已经具有可靠的暂停/交接能力。

### 第三阶段：需要并行编码时，再细化写入边界

Kimi 普通模式提示按 scope 分工，当前插件按整个 cwd 排斥并发 writer；这是可以改进的差异，但直接删除单 writer 提示会引入新的正确性问题。

若真实任务需要 parent 与 coder 同期写代码，建议显式声明读写范围与所有者，并为独立 writer 使用隔离工作区。现有实验性 Tower 已有 worktree、mission scope 与合并检查入口，可先复用其能力做受控验证（`src/tower.ts:34–47,155–228,399–424`，`prompts/tools/TowerMerge.md:1`），无需把整个 Tower 流程设为普通 Agent 默认行为。

同 cwd 仅按文件分开也未必独立：锁文件、生成产物、格式化、全仓测试、git 操作会跨越单文件范围。若以后支持同 cwd 并发写，需要明确冲突和全局操作串行规则；首阶段不依赖此能力。

## 如何验证方案确实改善用户的问题

现有 `evals/eval-prompts.mjs:21–49` 只判断一次 `direct|agent|swarm` 选择；即使通过，也不能证明后续没有长时间等待。`tests/prompts.test.ts` 和 `tests/harness.test.ts` 验证提示加载与注入，同样不覆盖执行质量。

需要增加真实多轮、记录 parent/child 时间线的 A/B 场景：

| 场景 | 需要观察的行为 |
| --- | --- |
| 一个紧耦合的代码修改 | 不为并行而强行拆分；允许 parent 直接完成。 |
| 编码与独立调查可并行 | 后台 child 启动后，parent 实际推进明确交付物，不立即等待或反复 TaskList/TaskOutput。 |
| coder 执行中发现范围远超预期 | 返回阶段交付与剩余工作，parent 能重新决策；不重做已有成果。 |
| 一批任务中只有一个长尾任务 | 记录批次等待，并验证可拆分的剩余工作有无重新分配收益。 |
| 存在读写冲突或共享构建产物 | 不通过违反写入边界来换取表面上的并行。 |

固定代码起点、模型配置与任务，比较多次运行的完成质量、总耗时、成本、重复探索、轮询次数，以及“仍有可执行独立工作却等待 child”的时间。普通日志只能量出原始阻塞时间；是否可避免，需要任务依赖信息和轨迹评审，不能把所有 foreground 等待都算失败。

运行时阶段交付另做确定性测试：前台调用确实在阶段结束后返回；后台通知不重复；取消和 checkpoint 竞争不会双重结束；只有旧 writer 停止后才能转移所有权；resume 保持原 agent；无进度事件不能被误判为任务完成。

推荐先落地第一阶段和多轮评测，依据数据决定第二阶段是否必要，再考虑并行 writer。当前提交只新增调研方案，没有修改插件实现，也没有运行付费模型评测或宣称已测得加速。
