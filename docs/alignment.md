# 与 DeepSeek Harness 原生服务的对齐设计

状态：设计文档（记录边界决策与互操作路径，非实现承诺）。
范围：dsh-cbx-orch（重型编排）、dsh-ralph-loop（自愈闭环）、dsh-state-graph（图原语）与 harness 原生服务的对应关系。

## 结论先行

1. **三个插件已经深度使用 harness 的服务面**：`tools`/`commands`/`subprocess`/`webServer`/`llm` 全部走原生注册与 seam，这部分不需要"对齐"，已经是对齐。
2. **cbx 的 job/队列体系保持自研，不重写到 `ctx.jobs`**——两者的语义域不同（见 §3），重写是负资产。
3. **真正值得做的互操作是薄层**：settings 覆盖、可选的事件桥、以及把 cbx 的能力以 harness 语义暴露给其他插件（§4）。

## 1. 概念映射

| cbx/ralph/state-graph 概念 | harness 原生对应 | 关系 |
|---|---|---|
| `ctx.cbx`（编排器服务） | `ctx.jobs` / `ctx.subagents` / `ctx.workflow` | **并存**，语义域不同（见 §3） |
| cbx job（持久化任务） | `ctx.jobs` 的 job（会话内后台任务） | 不互通：cbx job 是独立生命周期 + SQLite 权威状态 |
| cbx 队列（queue/serve/dispatch） | `ctx.schedule`（cron 任务） | 不互通：cbx 队列是任务调度，不是时间调度 |
| cbx 执行器（外部 CLI） | `ctx.subagents`（子代理） | 边界：cbx 拉外部编码 CLI，subagents 是 harness 进程内代理 |
| cbx 工具/命令 | `ctx.tools` / `ctx.commands` | **已原生注册**（17 工具 + 7 命令） |
| cbx 子进程 | `ctx.subprocess` | **已走 seam**（树杀/取消/超时/脱敏） |
| cbx Web 仪表盘 | `ctx.webServer` | **已原生挂载**（`/cbx` 前缀路由） |
| cbx 配置 `.cbx.json` | `ctx.settings` | **未来覆盖层**（§4.1） |
| cbx 事件（job.state_changed 等） | `session/event` / `session` 事件流 | **未来可选桥**（§4.2） |
| ralph 的 `ctx.ralph` | `ctx.jobs`/`subagents` 的循环执行模式 | 互补：ralph 是"单次任务内自愈"，cbx 是"跨任务编排" |
| state-graph 的 `ctx.graph` | `ctx.workflow`（动态工作流引擎） | 互补：graph 是声明式图原语，workflow 是 harness 线程内引擎 |

## 2. 已对齐面（现状，无需改动）

- **工具面**：`cbx_*` 全部经 `ctx.tools.register(defineTool(...))` 注册，参数 DSL、output schema、`ToolRunContext` 语义与官方插件一致；自动随插件 fiber 生命周期注销。
- **命令面**：`/cbx-*` 经 `ctx.commands.register`，`CommandInvocation`/`CommandResult` 契约完全匹配。
- **进程面**：执行器/测试子进程经 `ctx.subprocess.spawn`（树级终止、grace 升级、collect 模式），取消经 harness 句柄 + 自研 pid 归属校验（后者是 cbx 特有需求：跨进程残留清理）。
- **Web 面**：仪表盘经 `ctx.webServer.register({kind:'prefix', path:'/cbx'})` 原生挂载。
- **LLM 面**：ralph 经 `ctx.llm.stream` + `BlockAssembler`，错误语义（finish 块）已正确消费。

## 3. 边界决策：cbx 为什么保留自研 job/队列

**结论：重写到 `ctx.jobs` 是负资产，明确不采纳。**

理由：
1. **语义域不同**。`ctx.jobs`（dsh-jobs）是"会话内的后台任务"（随 session 生命周期、`job_*` 工具面）；cbx job 是"工作区级的持久化交付流程"（独立于任何会话、跨进程崩溃恢复、git worktree 隔离、审批门）。强行映射会让两边的恢复语义互相污染。
2. **cbx 队列语义是自有的**：单主租约调度、心跳即刻回收、僵尸接管、指数退避熔断、审批条目状态——这些在 harness 的 `ctx.jobs`/`schedule` 里没有对应物，映射要么丢失语义要么在 harness 侧打补丁。
3. **成本不对称**。cbx 的 SQLite 权威状态 + 文件锁 + 恢复逻辑已稳定（五轮修复 + 60 用例 + E2E 验证）；迁移收益只是"少一套体系"的认知整洁，代价是重写风险。
4. **长期正确的整合形态不是"重写"而是"注册"**：把 cbx 的引擎作为 harness 的一个服务面（已是 `ctx.cbx`），让需要的人按需使用——这正是 harness 的插件哲学。

## 4. 值得做的互操作（薄层）

### 4.1 settings 覆盖层（建议做）
cbx 配置现在只读 `.cbx.json`（工作区级）。可加一层"harness settings 优先/并存"：`ctx.settings` 的 `cbx` 命名空间作为 `.cbx.json` 之上的覆盖源（读取时合并，`.cbx.json` 优先或 settings 优先需定策略）。收益：用户能从 harness 的设置界面统一管理多个插件配置；成本：`loadConfig` 需要拿到 `ctx`（现在是纯文件读），要注入读取器。

### 4.2 事件桥（可选，按需做）
cbx 事件（`job.state_changed` 等）目前走自有事件流 + SQLite 回放，不进 harness 的 `session/event`。桥接的价值：harness 的 Trajectory/Web UI 能看到 cbx 任务流转。代价：cbx 事件没有 session 归属（job 独立于会话），需要定义"桥到哪个 session"（可桥到发起 job 的 session，job 记录里可存 initiator）。建议在"跨会话恢复"场景出现需求时再做。

### 4.3 子代理面（暂不做）
把 cbx 执行器包装成 `ctx.subagents` provider 看起来诱人（统一子代理管理），但 cbx 执行器是外部 CLI、非 harness 进程内代理，强行包装会损失 cbx 的退出码/超时/审查语义。保持边界。

### 4.4 长期：引擎内核抽取
ralph 的"失败→反思→学习"、cbx 的"失败→review→lessons"、state-graph 的图路由本质同族。长期可把"带反思的循环执行"抽象为 state-graph 上的一个模式（`ReflectiveLoopNode`），ralph 退化为该模式的实例，cbx 的 stage 循环也可声明式表达。这是一次"三合一"重构，收益是心智模型统一，风险是需要动 ralph/cbx 两套成熟状态机——建议在所有短期项清完后单独评估。

## 5. 集成准则（写给未来插件作者）

1. **优先用 harness 原生注册面**（tools/commands/subprocess/webServer/llm/skills），不要自建平行的"工具系统"。
2. **只有 harness 没有对应语义时才自研**（如 cbx 的队列恢复），并保持自研面小而清晰、对外仍以 `ctx.*` 服务暴露。
3. **事件命名空间化**：插件事件用 `插件名/事件` 前缀（`cbx/*`、`ralph/*`、`graph/*`），不与 harness 原生事件冲突。
4. **配置优先经 `ctx.settings` 或明确定义的配置文件**，不要在多个地方重复解析同一配置。
5. **恢复语义优先复用 harness 的持久化/会话原语**；确需自建持久化时，遵守"单一权威源 + 镜像降级 + 事件审计"三权分立（cbx 已验证）。
