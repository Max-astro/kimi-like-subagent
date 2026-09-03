# Kimi Code subagent TUI 调研

> 调研对象是工作区的 `kimi-code/` 与实现前的 `kimi-like-subagent/` 基线 `ddd48e9`；引用路径均相对工作区根目录。结论只依据代码、类型和测试，不包含网页或二手资料。

## 结论先行

Kimi 的关键并不是某一种炫目的进度条，而是三层分离：agent-core 发出带稳定关联 ID 的语义事件，TUI 用有界、可重放的投影状态吸收事件，最后由前台卡片、swarm 面板、后台任务浏览器分别呈现。`subagent.spawned/started/suspended/completed/failed` 事件携带 child、parent tool call、swarm index、background、task、usage 等关联信息；TUI 再按 child id 路由到父工具视图并同时写入 activity store（`kimi-code/packages/protocol/src/events.ts:878-926`，`kimi-code/apps/kimi-code/src/tui/controllers/subagent-event-handler.ts:75-175`）。

当前插件的 harness 已具备运行、持久化任务、日志尾部和后台完成通知，但 UI 信号只有 `text/tool/retry`，工具也没有自定义 renderer；因此首要缺口是“可验证的语义状态流”，不是先造一个复杂全屏界面（`kimi-like-subagent/src/types.ts:140-150`，`kimi-like-subagent/src/tools.ts:188-251`）。

## Kimi 的四类视图与交互

### 1. 前台单 Agent：固定高度的内联任务卡

单个 `Agent` 直接复用父工具调用所在的 transcript 卡片。卡片持有 child id/type、生命周期、模型与 effort、子工具活动、thinking/text、耗时和 tokens，而不是打印一条无限增长的日志（`kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts:557-643`）。运行时头部显示 spinner、状态、模型、工具次数、耗时和 tokens；正文严格保持两行，优先展示正在运行且可预览的子工具，否则展示最新 thinking/text，完成后展示结果或错误尾部（`kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts:1770-1876`，`kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts:1894-1975`）。固定骨架避免完成瞬间造成 transcript 大幅跳动。

卡片接收 child 的文本、thinking、子工具 start/delta/progress/result 与 lifecycle，并只在 active 状态运行计时器（`kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts:1071-1220`，`kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts:1322-1410`）。前台 Agent 立即显示 `Ctrl+B` 提示；按键会收集当前所有可 detach 的前台 Agent/Bash，而非只处理最后一个（`kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts:1031-1069`，`kimi-code/apps/kimi-code/src/tui/utils/foreground-task.ts:3-21`，`kimi-code/apps/kimi-code/src/tui/kimi-tui.ts:3490-3541`）。

### 2. 同轮多个 Agent：从单卡原位升级成聚合组

连续的 `Agent` 工具调用才会分组：第一张卡先正常挂载，第二个出现时原位升级为 `AgentGroup`，后续卡加入；出现非 Agent 工具就结束本组（`kimi-code/apps/kimi-code/src/tui/controllers/streaming-ui.ts:661-682`，`kimi-code/apps/kimi-code/src/tui/controllers/streaming-ui.ts:794-850`）。组组件保存已有 child component 的引用并订阅快照，而不复制另一份运行状态；更新以 200ms 节流，但 phase 变化立即刷新（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-group.ts:1-16`，`kimi-code/apps/kimi-code/src/tui/components/messages/agent-group.ts:83-149`）。

组头展示总数及 queued/running/done/error 分布，结束后聚合工具次数、tokens 和耗时；每行展示 agent 类型、描述、状态和最近活动/错误，并在任一成员可 detach 时保留 `Ctrl+B` 提示（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-group.ts:151-225`）。这是一种 transcript 布局能力，不只是单个工具的 renderer。

### 3. AgentSwarm：内联、响应式的成员矩阵

Swarm 有独立的 transcript 面板。工具参数尚在流式生成时，它就从部分 JSON 中提取 description/prompt/items 建立 pending/queued 成员；随后按 member index/agent id 消化 lifecycle、模型文本和子工具调用（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts:262-439`）。面板同时展示整体阶段和成员状态，空间足够时用多列网格，不足时降级为紧凑文本；终态包括 completed/failed/aborted/cancelled，rate limit 则显示 suspended/resumed（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts:13-47`，`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts:442-685`，`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts:1053-1100`）。

Kimi 还用已完成样本估算未完成成员进度，单个活跃成员被限制在 85% 以下，并以 80ms 动画追赶估计值（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress-estimator.ts:73-95`，`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress-estimator.ts:159-227`，`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts:736-765`）。这属于视觉增强，不是正确监控所必需的状态。

底层 swarm scheduler 初始并发为 5、错峰 700ms，rate limit 时会 suspend/requeue 并动态调节容量；面板的 suspended/resumed 并非凭空制造的 UI 状态（`kimi-code/packages/agent-core/src/session/subagent-batch.ts:12-41`，`kimi-code/packages/agent-core/src/session/subagent-batch.ts:302-358`）。

### 4. 后台 task：轻量提醒、footer 计数、按需全屏详情

后台 agent 启动与结束会各写一条 transcript 状态，footer 分开统计后台 Bash 和 Agent；完成事件会去重，避免 subagent 与 task 两套终态重复通知（`kimi-code/apps/kimi-code/src/tui/controllers/subagent-event-handler.ts:265-359`，`kimi-code/apps/kimi-code/src/tui/components/chrome/footer.ts:424-440`）。状态消息只显示 started/completed/failed、描述、模型/effort 和错误，不把持续日志塞入主对话（`kimi-code/apps/kimi-code/src/tui/components/messages/background-agent-status.ts:9-40`，`kimi-code/apps/kimi-code/src/tui/utils/background-agent-status.ts:17-42`）。

用户通过 `/tasks` 进入三栏全屏浏览器：任务列表、元数据详情、输出预览；支持方向键/j/k、Tab 切换 active/all、R 刷新、S 停止并二次确认、Enter/O 打开、Q/Esc 返回，且每秒刷新（`kimi-code/apps/kimi-code/src/tui/commands/registry.ts:262-267`，`kimi-code/apps/kimi-code/src/tui/controllers/tasks-browser.ts:58-133`，`kimi-code/apps/kimi-code/src/tui/components/dialogs/tasks-browser.ts:239-331`）。运行中 Agent 的预览来自内存 activity store，因为 durable output 可能要到完成才齐全；打开后使用专门的 agent activity viewer，其他任务使用 output viewer（`kimi-code/apps/kimi-code/src/tui/controllers/tasks-browser.ts:227-241`，`kimi-code/apps/kimi-code/src/tui/controllers/tasks-browser.ts:337-442`）。

## 从运行态到 UI 的状态流

```text
child session / batch scheduler
  -> protocol semantic events (agentId + parentToolCallId + taskId/swarmIndex)
  -> SessionEventHandler.routeChildAgentEvent
       -> SubagentActivityStore（有界、与 UI 组件无关）
       -> childId -> parent tool 映射
            -> ToolCallComponent / AgentGroup / AgentSwarmProgress
  -> background.task.*
       -> transcript status + footer count + TasksBrowser/viewer
```

core 在 spawn/resume 时发出相同 child id 的生命周期，在真正运行前发 started，结束时发带 summary/usage/contextTokens 的 completed，失败则发 failed（`kimi-code/packages/agent-core/src/session/subagent-host.ts:166-206`，`kimi-code/packages/agent-core/src/session/subagent-host.ts:378-436`，`kimi-code/packages/agent-core/src/session/subagent-host.ts:587-635`）。TUI 只有一个 session event 入口，先做 session 隔离，再将 child 事件路由给 subagent handler（`kimi-code/apps/kimi-code/src/tui/controllers/session-event-handler.ts:207-223`，`kimi-code/apps/kimi-code/src/tui/controllers/session-event-handler.ts:262-310`）。

`SubagentActivityStore` 是这条链的测试缝：它用纯 fold 保存有界的 step、文本、工具参数/进度/结果和 retry，resume 保留旧活动但重置为 running，终态统一收口（`kimi-code/apps/kimi-code/src/tui/controllers/subagent-activity-store.ts:1-18`，`kimi-code/apps/kimi-code/src/tui/controllers/subagent-activity-store.ts:108-137`，`kimi-code/apps/kimi-code/src/tui/controllers/subagent-activity-store.ts:147-307`）。这使 renderer 可以替换、后台 viewer 可以复用，而 agent harness 无需知道 TUI。

## 当前插件已有能力与缺口

| 层面 | 已有信号/能力 | 对监控的缺口 |
|---|---|---|
| 运行时 | child session 将 `text_delta`、`tool_execution_start`、`auto_retry_start` 转成 `text/tool/retry`（`kimi-like-subagent/src/runtime.ts:123-140`） | 没有 queued/spawned/started/suspended/terminal 事件；没有 thinking、tool delta/progress/result，也没有稳定 parent tool/swarm index/task 关联。|
| 任务状态 | agent/task 已有 running/completed/failed/aborted/timed_out/lost，记录 model、时间、session file、stop reason 和 output preview（`kimi-like-subagent/src/types.ts:64-94`） | 状态是存储快照，不是可订阅的 UI 投影；重启时 running 只会变为 lost（`kimi-like-subagent/src/state.ts:39-65`）。|
| 日志 | 每次 update 追加到任务输出文件并保留 4096 字符尾部（`kimi-like-subagent/src/agent-service.ts:233-242`，`kimi-like-subagent/src/state.ts:143-149`） | `tool` 只有名称/参数，没有结束与结果；swarm 成员的 live update 没有转发到调用者。|
| 前台工具 | `Agent.execute` 把 update 作为 Pi 的 partial tool result 上送；前台最终返回结构化结果（`kimi-like-subagent/src/tools.ts:188-251`） | 没有 `renderCall/renderResult`，因此只会走通用工具 UI；raw text details 也不是稳定 renderer contract。|
| Swarm | scheduler 有成员任务状态，工具只在成员 settle 后报告 `settled/total`（`kimi-like-subagent/src/tools.ts:130-185`） | 看不到 queued/running/retry、成员当前活动和成员身份到 UI 的映射。|
| 后台 | detached 立即返回 task id；结束时发送可显示、会触发 follow-up turn 的 custom message（`kimi-like-subagent/src/agent-service.ts:258-273`，`kimi-like-subagent/src/agent-service.ts:276-385`） | 没有运行中 badge/列表/用户直达入口；custom message 无专用 renderer。`TaskList/Output/Stop` 只是给模型调用的工具（`kimi-like-subagent/src/tools.ts:287-332`）。|
| 验证 | 现有测试覆盖工具注册、tail 上限和终态输出不重复（`kimi-like-subagent/tests/tool-registration.test.ts:35-81`，`kimi-like-subagent/tests/state.test.ts:8-38`） | 没有事件 reducer、渲染快照、窄终端、后台刷新或交互测试。|

Pi 本身已经提供低成本接缝：工具定义支持 partial `onUpdate` 与 `renderCall/renderResult`，更新会令现有 ToolExecutionComponent 以 `isPartial` 重绘；extension UI 还提供 `setStatus`、`setWidget` 和带键盘焦点的 `custom()`（`pi_agent/packages/coding-agent/src/core/extensions/types.ts:133-212`，`pi_agent/packages/coding-agent/src/core/extensions/types.ts:412-499`，`pi_agent/packages/coding-agent/src/modes/interactive/tool-execution.ts:175-187`，`pi_agent/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3337-3377`）。因此不必修改 Pi core 才能交付首版。

## 值得最小化借鉴的设计

以下顺序按预期收益而不是视觉复杂度排列：

1. **先建立 UI-neutral 的语义事件与纯 projection reducer。** 事件至少表达 task created、queued/running/retrying、activity、settled，并携带 agent/task/parent tool/swarm member ID；projection 只保留有界的最新文本、当前工具、计数和终态。收益是 prompt、harness、TUI 三者真正解耦，同一事件序列可做 reducer 单测，也能同时驱动内联卡片和后台列表。Kimi 的 lifecycle contract 与 activity store 已验证这条边界（`kimi-code/packages/protocol/src/events.ts:878-926`，`kimi-code/apps/kimi-code/src/tui/controllers/subagent-activity-store.ts:147-307`）。

2. **用 Pi 现有 tool partial renderer 做前台 Agent 卡。** 首版只显示 phase、profile/description、elapsed、最新一条活动、tool count 和终态摘要；保持 2–3 行固定高度。收益是改动局部、无需全局 widget、自然跟随 transcript、headless 模式仍可退回文本结果。Pi 的 renderer 上下文已有 `isPartial/expanded/toolCallId/invalidate`（`pi_agent/packages/coding-agent/src/core/extensions/types.ts:412-445`）。

3. **Swarm 只呈现真实成员状态和 `settled/total`。** 使用同一 projection 输出逐成员 queued/running/retrying/done/error 和最新活动，窄屏退化为单列。收益是用户能定位卡住/失败成员，又不引入虚假百分比；当前 scheduler 的真实 settle 点已足够作为第一阶段依据（`kimi-like-subagent/src/tools.ts:130-185`）。

4. **后台先做低侵入的两级入口。** 常驻区只用 `setStatus` 显示运行数量；命令打开一个紧凑 task 列表/详情，复用现有 `TaskRecord` 与 output tail，并提供 refresh/stop/open/close。收益是主对话安静、后台任务仍可发现；Pi 已提供 `custom()` 和 status API，不要求照搬 Kimi 三栏布局（`pi_agent/packages/coding-agent/src/core/extensions/types.ts:133-212`）。

5. **完成通知与监控复用同一 projection。** 为已有 background custom message 注册简洁 renderer，使用相同终态对象渲染，避免“通知说完成而任务面板仍 running”的双状态源。Kimi 对 subagent/task 双终态去重的处理说明此问题真实存在（`kimi-code/apps/kimi-code/src/tui/controllers/subagent-event-handler.ts:297-359`）。

这些模块都不需要改动 subagent system prompt 或主 agent 的 launch-policy prompt；TUI 只消费 harness 事件。若继续使用 prompt-snippets，它仍应只负责“何时/为何启动 subagent”，不负责产生 UI 状态。

## 首版不宜照搬的 Kimi 设计

- **估算百分比、动画进度条和 braille 大矩阵。** Kimi 的算法依赖完成样本、工具调用 tick 和丰富生命周期，仍只能把未完成项估到上限而非真实进度（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress-estimator.ts:109-227`）。当前插件信号不足，复制它会增加复杂度并制造精确度幻觉；真实 phase/count 更有用。
- **同轮 AgentGroup。** Kimi 能在 transcript controller 中把已挂载的兄弟组件原位替换成组（`kimi-code/apps/kimi-code/src/tui/controllers/streaming-ui.ts:794-850`）；普通 Pi extension 的单工具 renderer 没有跨 sibling 重排接口。首版强做会突破插件边界，AgentSwarm 已是更清晰的并行聚合入口。
- **完整三栏 `/tasks` 与两套全屏 viewer。** Kimi 需要分别维护 activity viewer 和 durable output viewer，并处理 1 秒 polling、焦点、滚动、响应式尺寸和 stop 确认（`kimi-code/apps/kimi-code/src/tui/controllers/tasks-browser.ts:258-513`，`kimi-code/apps/kimi-code/src/tui/components/dialogs/tasks-browser.ts:239-331`）。当前任务数和日志语义尚简单，紧凑列表先验证价值更合算。
- **流式不完整 JSON 参数解析。** Kimi 为了在 tool arguments 完成前建 swarm 面板而维护 tolerant parser（`kimi-code/apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts:850-899`）；Pi 已将解析后的 args 和 `argsComplete` 交给 renderer，首版等待稳定参数即可（`pi_agent/packages/coding-agent/src/core/extensions/types.ts:426-445`）。
- **`Ctrl+B` 前台转后台。** 这不是纯视图功能：Kimi 的 Agent 工具本来就统一注册到 BackgroundManager，前台只是等待或 detach（`kimi-code/packages/agent-core/src/tools/builtin/collaboration/agent.ts:220-308`）。当前插件 foreground 调用直接 await runtime，并将 abort signal 与该调用绑定（`kimi-like-subagent/src/agent-service.ts:276-385`）；在没有定义 detach 后 signal、结果交付和所有权语义前，不应把一个按键伪装成 UI 小功能。
- **完整活动历史跨会话回放。** 当前插件持久化的是 output tail 和状态，不足以还原 thinking/subtool 生命周期。首版应诚实显示 lost/终态与日志尾部；以后若用户确实需要，再持久化有界的语义 projection，而不是保存无限 raw event。

## 下一步分析应先确定的行为边界

实现前最值得和用户确认的是三个真实产品选择：前台卡默认保持几行、后台入口是“状态栏 + 紧凑弹窗”还是直接全屏、以及 monitor 是否允许 stop。它们分别决定信息密度、UI 组件规模和写操作授权；不会反过来改变上面的事件/reducer 基础。相反，百分比进度、AgentGroup、Ctrl+B detach 并不是首版必须解决的问题。
