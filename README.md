# kimi-like-subagent for Pi

一个面向 Pi 0.84.x 的用户级 extension。它把 Kimi Code 中已经验证过的 subagent 机制拆成两层：

- **prompt 层**：所有 tool 描述、主 Agent 的委派策略、Swarm/Tower mode reminder、subagent profile prompt 都是独立 Markdown 文件。
- **harness 层**：负责真实的 session 隔离、工具白名单、resume/background 生命周期、调度、状态持久化、模型绑定和 Tower merge gate。

二者之间只有文件加载与 `before_agent_start` 注入接口，因此可以单独测试 prompt，也可以用假 runtime 测 harness，不需要靠修改全局 `AGENTS.md` 才能改变行为。

## 每项能力带来的收益

| 能力 | 预期收益 | 明确代价/边界 |
| --- | --- | --- |
| `Agent` 前台执行 | fresh context 降低主上下文污染；结果依赖关系保持显式 | 启动有固定成本，不适合小任务 |
| 同一响应中的多个 `Agent` | 复用 Pi 原生并行 tool-call 调度，适合少量异构任务 | 调用者仍须确保任务不重叠 |
| background + `Task*` | 主 Agent 可继续真正独立的工作；结束时自动唤回，无需轮询 | 进程退出后 running task 标记为 lost，但 agent session 可 resume；child 不能再启动 background grandchild，避免父 extension 已销毁后留下孤儿任务 |
| `AgentSwarm` | 对同一任务模板的多 item fan-out 更简洁；resume 与新任务可同批运行 | 为降低 rate-limit，前 5 个立即启动，之后每 700ms 一个；默认不硬设并发上限 |
| profile 工具白名单 | `explore`/`plan`/survey/reviewer 的只读性由工具集合强制，而非只靠 prompt | `bash` 本身不是通用沙箱；实现 worker 仍需 worktree 与 merge gate |
| per-agent resume | 失败、超时或后续追问不必丢掉子会话上下文 | profile 定义更新后 resume 使用当前 profile 工具与 subagent allowlist；Tower agent ID 只能由持有该 roster 的 owner session 恢复 |
| conditional model pool | 未配置时零心智负担并继承主模型；配置后才暴露 alias，保留 `primary` 质量逃生口 | Pi 版本要求显式写 `alias -> provider/model`，不复用 Kimi TOML schema |
| 过短总结续写一次 | 减少“任务做完但 handoff 不可用”的情况 | 默认只重试一次且阈值 200 字符，避免循环和额外成本 |
| project profile 信任边界 | 未信任仓库的 profile 描述、设置与 extension 不进入父/子 Agent；显式点名独有 project profile 时才会请求一次确认 | 非交互模式下未信任 project profile 会 fail closed；同名 override 要等项目受信任 |
| `/swarm` mode prompt | 只在需要时提高分解倾向，不污染所有会话 | 不替模型制造可并行性；不能并行的任务仍应直接做 |
| 实验性 Tower | writer 使用独立 branch/worktree；reviewer 使用目标 tip 的 detached、无项目资源信任 worktree；scope、依赖、live-task、评审建议、dirty-base snapshot 和会话所有权由代码把关 | 需要 Git、至少一个 commit，并增加 branch/worktree/review 开销；默认关闭；它是 Git 工作流隔离，不是 OS 安全沙箱 |

## Kimi 对齐的工具契约

- `Agent(prompt, description, subagent_type?, resume?, run_in_background?, model?)`
- `AgentSwarm(description, prompt_template?, items?, resume_agent_ids?, subagent_type?, model?)`
- `TaskList()`、`TaskOutput(task_id)`、`TaskStop(task_id)`
- Tower（实验）：`TowerInit`、`TowerPlan`、`TowerSpawn`、`TowerMerge`、`TowerTeardown`、`TowerSend`、`TowerInbox`、`TowerFinding`、`TowerReview`、`TowerMission`、`TowerStatus`

与 Kimi 当前稳定行为一致，`fork` 没有暴露；它在 Kimi 中仍由 experimental flag 控制。`AgentSwarm` 还会强制成为一次 assistant response 中唯一的 tool call，最多 128 个成员；无 resume 时至少需要两个 item，且模板填充后的 prompt 必须互不相同。

## 安装与启用

目录安装到：

```text
~/.pi/agent/extensions/kimi-like-subagent/
```

Pi 会自动加载目录下的 `index.ts`。安装或配置修改后运行 `/reload`，或重启 Pi。该插件与 `pi-subagents` 注册同名工具，不应同时启用；保留旧包但禁用其全部资源的 Pi settings 写法是：

```json
{
  "source": "npm:pi-subagents",
  "extensions": [],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

默认无需配置。可选配置位于：

```text
~/.pi/agent/kimi-like-subagent/config.json
```

参考 [config.example.json](./config.example.json)。配置解析是 strict 的：拼错 key 会在加载时失败，而不会静默忽略。

常用命令：

```text
/swarm on
/swarm off
/swarm <只对下一轮生效的任务>
```

## Subagent TUI 监控

默认的 `compact` 模式会在编辑器上方嵌入一个小型任务条，只显示仍在执行的顶层任务。Swarm 在这里聚合成一行，不会用每个 member 占满屏幕；默认最多显示两行任务：

```text
Subagents  3 active · 2 queued · +1 hidden · /tasks
● explore  inspect runtime · Read src/runtime.ts · 2s
● Swarm  inspect renderers · 1 running · 2 queued · 0/3 done · 2s
```

前台 `Agent`/`AgentSwarm` 的原生 tool card 也会实时更新。折叠状态维持约两行，展开 Swarm card 后才显示成员。两种视图共享一个与 session/runtime 解耦的 monitor projection，因此界面不会通过轮询日志推测状态，也不会把渲染数据塞进模型可见结果。

`/tasks` 打开固定宽度的单列浮层。它支持：

- 顶层任务列表与 active/all 切换；
- 进入 Swarm 成员列表，再进入单个 member 详情；
- 查看最新活动、工具调用和有限的输出预览；
- 在仍运行的 task 详情中按 `S`，再按 `Y` 确认停止。

`/subagents settings` 可即时调整下面三项，并原子写回同一份 `config.json`；保存失败时不会改变当前界面：

```json
{
  "tui": {
    "mode": "compact",
    "task_scope": "all",
    "max_visible_tasks": 2
  }
}
```

- `mode`：`compact` 显示任务条；`minimal` 不渲染任务条，只通过可组合的 footer status 显示 active 数量。前台 tool card 在两种模式下都保留。
- `task_scope`：`all` 同时显示前台与后台任务；`background` 只显示 detached task。
- `max_visible_tasks`：任务条最多显示 `1`–`4` 行，默认 `2`。

插件只占用 `kimi-like-subagent:tasks` 这个 widget/status key，沿用当前 Pi theme，不替换 footer，也不修改 Pi core。任务条在插件加载时按 `aboveEditor` 注册；Pi 当前没有 widget priority API，所以它通常位于更早注册的 todo widget 下方，但后加载插件仍可能改变相对顺序。实现不会反复注册 widget 来争抢位置。

开启实验性 Tower：

```json
{
  "experimental": { "tower": true }
}
```

重载后先 `/tower on` 或直接调用 `TowerInit`。Tower worker worktree 创建失败时不会启动 writer。主 checkout 有未提交改动时，spawn 会用临时 Git index 创建只供 child 使用的 WIP snapshot，不修改主 checkout。merge 前该 snapshot 的内容必须已经提交/恢复到当前 base，避免用户后来丢弃的未评审 WIP 被 worker branch 静默带回；merge 若会碰到主 checkout 的 dirty 文件也会拒绝。

Tower state 记录 owning Pi session 与进程。第二个仍存活的 session 会被拒绝；原 session 正常关闭或进程死亡后，新 session 可接管，旧 roster 会被清理，仍为 active 的 mission 会转为 paused，提示用新 worker 继续。这个行为对应 Kimi 的 session ownership/adoption 语义，只是 Pi 插件以 PID liveness 代替 Kimi 内部 session registry。

## 自定义 profiles

加载顺序为 built-in → user → nearest project，后者优先：

- user：`~/.pi/agent/agents/**/*.md`
- project：从 cwd 向上找到的最近 `.pi/agents/**/*.md`

替换内置同名 profile 必须显式写 `override: true`。示例：

```md
---
name: security-auditor
description: Read-only security audit with local evidence.
tools: read, grep, find, ls
disallowed_tools: edit, write
subagents: coder, explore
---
Inspect the bounded scope, cite paths and lines, and do not modify files.
```

`tools` 与 `disallowed_tools` 会同时影响模型可见工具和实际 session allowlist。MCP server 可写成 `mcp__server__*`。自定义 profile 只有在 `tools` 明确含 `Agent`/`AgentSwarm`（或 `*`）时才拥有委派工具；`subagents` 再限制可启动的 profile，省略时默认只允许 `coder`、`explore`、`plan`。内置 profile 不能递归委派。

未信任项目的 `.pi/agents` 不会出现在主 Agent 的可用 profile 列表中，也不会进入 child 的资源加载器。用户显式点名一个项目独有 profile 时，交互会话可以单独确认该 profile；若要让项目 profile 覆盖同名内置/用户 profile，应先用 Pi 自身的 trust 流程信任项目。

## secondary model pool

只有配置 pool 后，`Agent`/`AgentSwarm` schema 才出现 `model` 参数：

```json
{
  "secondary_model": {
    "default_model": "fast",
    "models": {
      "fast": {
        "model": "provider/model-id",
        "description": "Cheap exploration and routine edits",
        "thinking_level": "low"
      }
    },
    "default_effort": "medium",
    "force": false
  }
}
```

`primary` 是保留 alias。`force: true` 时 pool 必须只有一个 entry，call-site 不得覆盖。resume 永远保留原 agent 的模型。

## 为什么不依赖 prompt-snippets

现有 `prompt-snippets` 很适合做**用户主动、单轮、可见的实验开关**：它能把一个 delegation snippet prepend/append 到下一条用户消息，操作成本低，也天然适合人工 A/B。

但它当前在每次发送后清空，并通过 `input` hook 改写 user message，而不是修改 system prompt。因此它不能可靠承担这些职责：

- 根据 `Agent`/`AgentSwarm` 是否实际 active 条件注入策略；
- 让 background completion 触发的自动轮次仍获得 mode reminder；
- 持续维护 `/swarm on` 与 Tower 生命周期；
- 设置每个 child 自己的 system prompt 与工具策略；
- 保证 prompt 实验不改变 harness 的状态机。

所以本插件用自己的 Markdown prompt 资源和 `before_agent_start` 注入；不修改也不依赖 `prompt-snippets`。后者仍可用于临时叠加更激进/更保守的主 Agent 策略，作为人工实验层。这样做的代价是本插件多了一个很薄的 prompt loader，但换来了可重复的系统级行为和独立测试 seam。

## 验证

开发测试覆盖：strict config、model binding、profile/tool allowlist、Swarm 输入与发射节奏、prompt 条件注入、monitor 状态投影、TUI 宽度/聚合/设置/停止交互，以及 Tower scope 与 exact-tip review gate。

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
node evals/eval-prompts.mjs
```

离线 eval 只验证 case/schema 和生成的 A/B prompt；不会调用模型。显式加 `--live` 才运行 Pi 模型评估：

```sh
node evals/eval-prompts.mjs --live --pi /path/to/pi --model provider/model
```

## 已知边界

- Pi extension API 没有 Kimi 的完整 permission-rule engine；本插件用 profile allowlist、project trust 和 Tower gate 提供关键结构性约束。
- Pi extension API 没有 `aboveEditor` widget 的显式排序优先级；本插件保持单次注册并接受加载顺序，而不是抢占其他插件的视图。
- `explore`、`plan`、Tower survey/reviewer 都不拥有 `bash`/`edit`/`write`。reviewer 还会关闭 project context/extensions，避免执行待评审分支新增的资源。实现 worker 的 `edit`/`write` 受 worktree、symlink 与 scope 硬检查；其 `bash` 仍可访问工作树之外，无法靠静态命令解析变成安全沙箱。merge gate 会拒绝 out-of-scope diff，但高风险仓库仍应叠加 OS/container sandbox。
- Tower inbox 是持久 mailbox，不主动中断正在运行的 sibling；worker 在自然工具边界读取，parent 会被 worker completion 自动唤回。
- session、task 与 Tower audit state 都持久化，但进程内执行不会跨 Pi 重启继续；重启后可用 agent ID resume。
