# dsh-cbx-orch

把 cbx-orch 的持久化任务编排能力移植为 **DeepSeek Harness (dsh) 插件**。在 dsh 内直接编排外部编码 CLI（codebuddy / opencode / omp / cline / qwen），任务状态、队列、测试日志、diff、审查报告全部落盘，进程崩溃后可恢复续跑。

```text
创建任务 → 执行 → 保存原始日志 → 跑测试 → 生成 diff → 审查 → 必要时返工
```

## 这是什么

`dsh-cbx-orch` 是一个 **dsh bundle 包**：它导出两个 cordis 插件（core + web），把 cbx-orch 的编排引擎接入 dsh 的插件机制。

| 能力 | 落点 |
| --- | --- |
| 编排引擎（状态机/队列/重试/审查/artifact/审批/adaptive） | `ctx.cbx` 服务 + 移植的引擎模块 |
| 5 个外部执行器适配器（codebuddy/opencode/omp/cline/qwen）+ 自定义插件执行器 | 经 `ctx.subprocess` 拉起子进程 |
| `cbx_*` 工具 | `ctx.tools`（dsh agent 可直接调用） |
| `/cbx-*` 斜杠命令 | `ctx.commands` |
| Web 仪表盘 + REST + SSE | `ctx.webServer`，挂在 `/cbx` 前缀下 |
| `.cbx.json` 工作区配置 | 保留，与插件配置叠加 |

与 cbx-orch 原版的差异：MCP server、独立 CLI、TUI 在 dsh 内被原生工具/命令/Web 取代，不再移植。任务 worker 改为**进程内调度**（执行器/测试仍是树级可终止的 `ctx.subprocess` 子进程），取消时经 job-runtime 终止活动子进程。core/web 插件会为各工作区拉起**常驻调度器**（30s 定时 dispatch + 租约防多实例），崩溃重启后自动回收死 worker 并续跑遗留任务：

- **进程内死 worker 即刻回收**：worker 注册表注销即判死（不等 45s 心跳超时），并发槽立即释放。
- **僵尸接管**：事件循环阻塞的 worker（心跳停更但进程存活）由调度器接管——写取消标记、终止其子进程、强制释放本进程持有的 `run.lock`/`gate.lock` 后重派，不再出现"重派撞锁直到熔断"的永久卡死。
- **崩溃续跑跳过已完成 stage**：链式任务的 stage 报告逐个持久化，回收重入时已完成的 stage 直接跳过，不整链重放。
- **审批通过原子重入队**：before_run 审批的状态回 queued 与队列条目重新激活在同一事务落盘，不存在"已批准但永不调度"的窗口。
- 死 worker 回收按连续计数熔断（3 次后停止重派，指数退避重试）；`needs_fix`/`review_failed` 在队列视图中显示真实状态而非 failed。

## 安装

作为一个 bundle 包装进某个 profile：

```sh
# 发布后
dsh plugin --profile web add dsh-cbx-orch

# 本地开发（file: 链接）
# 在 $DSH_HOME/profiles/<name>/package.json 加依赖并安装
```

> **npm ≥ 11.6 注意**：install-scripts 门控会跳过 `better-sqlite3` 的 node-gyp 构建（依赖包内声明的 allowScripts 不被认作覆盖），导致启动时报 native binding 缺失。自救：
>
> ```sh
> npm install-scripts approve better-sqlite3
> npm rebuild better-sqlite3
> ```
>
> pnpm 用户在 profile 的 `pnpm-workspace.yaml` 配 `allowBuilds`。`smoke/pack.sh` 已内置该兜底，可作为发布前检查（`npm run smoke:pack`）。

profile 的 `dsh.profile.bundles` 需要包含 `dsh-cbx-orch`（与 `@deepseek-ai/dsh-base` 一起）。core 插件需要 `subprocess`/`tools`/`commands`（base bundle 提供）；web 插件额外需要 `webServer`，只在 web profile 激活。

> 与 harness 原生服务（jobs/schedule/subagents/settings/事件）的边界与互操作设计见 [docs/alignment.md](docs/alignment.md)。

```sh
dsh --profile web
```

启动后访问 `http://127.0.0.1:3080/cbx/` 查看仪表盘。

## 工具（`ctx.tools`）

| 工具 | 作用 |
| --- | --- |
| `cbx_run` | 创建并排队一个任务（task/executor/test/review/isolated/carry_dirty/审批门等）；`executor` 缺省/"auto" 时按本机已安装的 agent CLI 自动路由；`carry_dirty` 把未提交改动带进隔离 worktree |
| `cbx_executors` | 探测本机已安装/可解析的编码 agent CLI（codebuddy/opencode/omp/cline/qwen）及其 envVar 覆盖 |
| `cbx_status` | 任务状态/阶段/尝试 |
| `cbx_list` | 列出工作区所有任务 |
| `cbx_queue` / `cbx_queue_pause` / `cbx_queue_resume` | 队列查看与暂停/恢复 |
| `cbx_dispatch` | 调度队列（回收死 worker + 启动排队任务） |
| `cbx_continue` | 按 review.md/测试失败返工续跑 |
| `cbx_cancel` | 取消任务并终止执行器进程树 |
| `cbx_retry` | 重试失败任务 |
| `cbx_approve` | 批准等待审批的任务 |
| `cbx_result` / `cbx_artifact` / `cbx_artifacts` / `cbx_logs` | 读 result.json / 任意产物 / 产物列表 / agent.log 增量 |
| `cbx_watch` | 轮询任务到终态，并**累计返回执行器处理消息（agent.log 尾部）与状态迁移**——让当前会话看到委派代理做了什么，而不只是最终结果 |
| `cbx_health` | 队列深度、状态计数、失败/重试、死信（不含任务正文）。**默认只读**；`prune: true` 时才应用保留期清理 |
| `cbx_clean` | forget/purge 任务（含 worktree 清理） |
| `cbx_list_workspaces` | 列出已授权的工作区（不扫描任意 root 或子目录） |
| `cbx_review_gate` | 对未提交改动跑独立审查 |

> **执行器路由（先检测本机 agent CLI，再路由委派）**：`cbx_run` / `/cbx-run` / Web 创建接口在创建任务前先探测本机已安装的编码 agent CLI（codebuddy/opencode/omp/cline/qwen）。`executor` 未指定或为 `"auto"` 时，自动选择**偏好顺序中第一个已安装**的执行器；显式指定某个内置执行器但**未安装**时，默认自动回退到下一个可用 CLI（回退会写入返回信息与日志，`autoFallback` 语义见源码）；插件路径不参与内置路由。本机一个编码 CLI 都没有时**创建即报错**并列出安装指引（取代原先"创建后执行时 spawn 崩溃"的失败模式）。探测结果带短 TTL 缓存，命中即复用；偏好顺序可用工具参数 `executor_preference` 或 `.cbx.json` 的 `executorPreference` 覆盖（缺省 = 内置声明顺序 codebuddy, opencode, omp, cline, qwen）。`cbx_executors` 工具可随时查看当前探测结果。
>
> **工具参数使用 snake_case**（如 `timeout_ms` / `max_retries` / `max_turns` / `executor_preference`）；`.cbx.json` 配置键与 Web/命令层使用 camelCase（`timeoutMs` / `maxRetries` / `maxTurns` / `executorPreference`）。二者仅命名风格不同，语义一一对应。
>
> **默认工作区**：各工具/命令的 `workspace` 参数可省略，缺省 = 当前 agent 会话的工作目录（目录委派时设定，见「行为语义」）；显式传参必须命中工作区白名单。
>
> **会话内后台任务桥**：`cbx_run` / `cbx_continue` / `/cbx-run` / `/cbx-continue` 在 harness 提供 `ctx.jobs`（dsh-base 的 dsh-jobs-local + agent preset 的 dsh-tool-jobs）时，把委派注册为 `kind: "cbx"` 的原生后台任务——当前会话可实时看到执行进度与最终输出（`job_output` / `job_wait` / `job_kill` 可用，完成后有完成通知），`job_kill` 幂等转发为 `cbx_cancel`。桥不可用时（无 agent 上下文 / 无 jobs 服务 / 并发上限）静默退化为旧行为：cbx job 照常运行，只是不在会话内显示。返回消息中的 `session job <id>` 提示即此桥已启用。
>
> **任务清单直接显示在当前会话**：`cbx_run` / `cbx_continue` 的提交响应、`/cbx-run` / `/cbx-continue` 的回复、会话后台任务的 `job_output` 首轮快照以及完成通知，都会直接附上当前工作区的**全量任务清单表格**（Job ID / Status / Phase / Attempt / Updated），不再需要先调 `cbx_list` 或打开仪表盘才能看到编排全局；清单来自落库后的实时快照（`src/format.ts` 的 `formatTaskList` 统一格式化）。
>
> **委派处理消息流入当前会话**：执行器（外部编码 CLI）的处理过程——工具调用/推理/文件编辑的原始转录（agent.log）与状态迁移——现在会进入当前会话视图：① `cbx_watch` 轮询期间累计状态迁移 + agent.log 尾部，终态时连同最终状态一起返回（`include_log` / `max_log_chars` 可调，`since` 支持续读）；② 会话后台任务的完成通知（jobs-bridge 投递）自带 agent.log 尾部摘要（"处理消息（agent.log）"，截断到 8K 内，完整内容仍在磁盘），因此委派结束当前会话直接看到委派代理做了什么；③ `job_output` 运行期即可增量读到 agent.log 尾部。
>
> **输出上限**：`cbx_result` / `cbx_artifact` 的文本输出截断到 64K 字符（保头尾并标注总长）；`cbx_status` / `cbx_cancel` / `cbx_approve` 等返回 state 的工具对超长字符串字段做深截断（8K）。完整内容仍在磁盘工件里，需要时用 `cbx_logs` 增量读取。

## 斜杠命令（`ctx.commands`）

`/cbx-run <task>`、`/cbx-status <job_id>`、`/cbx-continue <job_id> [message]`、`/cbx-cancel <job_id>`、`/cbx-list`、`/cbx-queue [pause|resume]`、`/cbx-result <job_id>`、`/cbx-web [workspace]`。

`/cbx-web [workspace]` 开启 cbx 仪表盘：解析当前工作区（或显式指定的 workspace，受白名单约束）后给出 Web 仪表盘链接，并尝试在系统默认浏览器打开；未加载 `cbx-orch-web` 插件的 headless profile 会给出提示。

## Web API

挂在 `/cbx` 前缀下（`ctx.webServer`）。无尾斜杠访问 `/cbx` 会 301 到 `/cbx/`（页面内资源与 API 全部相对路径引用，必须停在带尾斜杠的 URL 上）：

- `GET /cbx/` — 仪表盘 HTML（带 `default-src 'self'; frame-ancestors 'none'` CSP）
- `GET /cbx/events` — SSE 实时事件流（Last-Event-ID 回放，单连接回放上限 1000 条；服务端连接数上限 16，慢客户端背压超限会被断开）
- `GET /cbx/api/workspaces|jobs|queue|metrics`
- `GET /cbx/healthz`
- `GET /cbx/api/jobs/<id>[/artifacts|/artifact/<name>|/timeline|/executor|/agent.log]`
- `POST /cbx/api/jobs`（创建）、`/cbx/api/jobs/<id>/approve|cancel|retry|continue|forget|purge`、`/cbx/api/queue/pause|resume`

数据端点鉴权用 `Authorization: Bearer <token>` 或 HttpOnly cookie `cbx_token`（HTTPS 下自动追加 `Secure`；**不接受 URL query token**——会泄漏进浏览器历史与代理日志）。首页、静态资源 `/cbx/style.css` 与 `/cbx/app.js`、`/cbx/healthz` 以及登录端点 `POST /cbx/auth`（body `{"token": "..."}`，验证通过才下发 cookie，每 IP 每分钟限 10 次、成功登录即清零计数）开放；其余数据端点（包括 `/cbx/api/metrics`）需要鉴权。`/cbx/healthz` 与 `/cbx/api/metrics` 均为只读（不触发保留期清理）。

## 配置

### 插件配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: cbx-orch
      name: 'dsh-cbx-orch'
      config:
        executor: codebuddy   # codebuddy / opencode / omp / cline / qwen / 插件路径
        review: true          # 测试通过后跑独立审查
        isolated: true        # git worktree 隔离执行
        carryDirty: false     # 隔离任务携带未提交改动（缺省 false：isolated+dirty 创建即报错并给补救；true：把未提交改动带进 worktree 执行）
        workspaces: []        # cbx 工具工作区白名单；空/缺省 = 默认工作区跟随目录委派（agent 会话 cwd），显式列表仅精确放行
        executors:
          envAllowlist: []    # 可选硬化：非空时执行器/测试子进程只继承这些环境变量
                              #（外加 PATH/HOME 等不可缺系统变量）；空/缺省 = 完整继承宿主 env
    - id: cbx-orch-web
      name: 'dsh-cbx-orch/web'
      config:
        web:
          token: ''           # 非空 = 使用配置值；空/缺省 = 读取或生成 <首个工作区>/.cbx/web.token（生成时 0600），无免鉴权模式
          workspaces: []      # ?workspace= 白名单；空 = 跟随 harness 工作区注册表（会话目录），注册表不可用/为空时回落进程 cwd
```

> **`executors.envAllowlist`（可选硬化，支持工作区级覆盖）**：默认情况下，执行器/测试/审查子进程**完整继承宿主进程的 `process.env`**——这是 cbx 的有意设计：编码 CLI（codebuddy/opencode/omp/cline/qwen）依赖环境里的 API 凭据才能工作，过滤会破坏认证。代价是"受损/不可信执行器能读取宿主全部凭据"。若你的执行器来源可受控但你想收窄暴露面，可设置白名单——此时只把这些变量加上 `PATH/HOME/TEMP` 等不可缺系统变量传给子进程，其余一律剔除。空/缺省即恢复完整继承，完全向后兼容。
>
> **配置优先级（自上而下）**：
> 1. **工作区级** `.cbx.json` 顶层 `executors.envAllowlist`（最具体，优先）；
> 2. **全局** 插件 config 的 `executors.envAllowlist`（缺省回落）；
> 3. 均未配置 = 完整继承宿主 env。
>
> 工作区一旦显式配置即覆盖全局（工作区配置 `envAllowlist: []` 表示"显式只继承系统变量"，同样覆盖全局）；工作区未配置才回落到全局。工作区级配置经任务工作区解析；非任务调用按 `cwd` 向上定位最近含 `.cbx/` 的工作区，**隔离 worktree** 内还会按 `.cbx-worktrees` 布局反解到主工作区（`.<repo>.cbx-worktrees/<jobId>` → 主工作区）。对执行器/测试/审查/Git 全部子进程生效，文件修改最多 5s 后生效（短缓存）。

core 的 `workspaces` 是 `cbx_*` 工具的工作区白名单：**空或缺省 = 默认工作区跟随目录委派**——无显式 `workspace` 参数时，以当前 agent 会话的工作目录（`session.header.cwd`，即目录委派时设定的目录）为默认工作区，回落 harness 进程 cwd；显式列表只授权其中精确的 workspace。路径通过 `realpath` canonicalize（Windows 下折叠路径大小写），越权、缺失路径或非目录都会拒绝。`cbx_list_workspaces` 只列出该白名单中的 workspace，不再扫描任意 root 或子目录。

Web 的 `web.workspaces` 继续作为 Web `?workspace=` 选择的独立 allowlist，但使用相同的 `WorkspacePolicy` 语义（canonicalization、越权/不存在/非目录拒绝）。core 的 `workspaces` 与 Web 的 `web.workspaces` 是两个独立配置，不会自动共享配置值。

**Web 空配置的默认工作区来源（v0.1 起）**：`web.workspaces` 为空/缺省时，Web 层不再盲回落 `process.cwd()`，而是跟随 **harness 工作区注册表**（`ctx.workspaceRegistry`，即用户在 harness GUI 中实际打开过的目录；DMS 会话目录 `sessions/--<path>--` 由 harness 维护）。这保证了「在某个工作区会话里跑 `/cbx-run` 创建的任务，能在同一目录的仪表盘上看到」——Web 层本身没有会话上下文，注册表是 harness 侧对「用户工作区」的权威来源。注册表不可用或为空时（例如无 harness workspace 服务的瘦身 profile）回落进程 cwd，保持旧行为。

### 工作区配置（`.cbx.json`，与 cbx-orch 相同）

`executor`、`testCommand`、`review`、`isolated`、`timeoutMs`、`maxRetries`、`maxTurns`、`maxConcurrent`、`reviewRules`、`approval`、`git`、`reviewGate`（`enabled`、`failOpen`）、`notifications`（webhook/OTLP outbox）、`governance`（retention/redact）、`telemetry`、`ui.token`、`executors`（`envAllowlist`，工作区级环境白名单，见「配置」节）等，见 cbx-orch 文档。

## 行为语义

- **重试预算**：`maxRetries` = 首次执行失败后允许的重试次数，总执行次数 = 1 + maxRetries（`maxRetries: 1` 即 2 次执行 + 1 次修复重试）。每个 stage 的预算独立持久化，崩溃重入不重置；用户 resolve Human Gate 或显式 retry 时归零。
- **默认工作区跟随目录委派**：`cbx_*` 工具与 `/cbx-*` 命令在未显式传 `workspace` 时，默认工作区 = 当前 agent 会话的工作目录（`session.header.cwd`，即目录委派时设定的目录），无 agent 上下文时回落 `process.cwd()`。空配置（`workspaces: []`）时委派到哪个目录就在哪个目录跑；显式白名单仍精确匹配，会话 cwd 不在列表内同样拒绝并提示配置位置（profile `cordis.patch.yml` 的 `config.workspaces` / `config.web.workspaces`）。调度器按工作区动态拉起（入队即 `ensureScheduler`），委派目录无需预先配置即可自动接管队列。**常驻调度器只在显式配置的工作区于插件启动时预拉**（崩溃重启后无需等下一次入队就能续跑遗留任务）；空配置时工作区跟随委派目录动态解析、没有单一权威目录，故不预拉 `process.cwd()` 的调度器（避免在启动目录凭空创建 `.cbx/`），这些目录的调度器仍在入队/派发时按需拉起并同样续跑遗留任务。
- **创建期前提校验（省去无谓的崩溃循环）**：`isolated=true` 但工作区不是 Git 仓库时，`cbx_run`/Web 创建接口**创建即报错**，错误信息直接给出修复建议（`git init` 或 `isolated: false`）。已入队的此类任务崩溃熔断时，队列错误的 `最后崩溃原因` 会带出真实的 `worker_crash` 根因，而不是笼统的"worker 反复无法恢复"。工作区授权被拒时，错误会列出当前允许的工作区与配置位置（profile `cordis.patch.yml` 的 `config.workspaces` / `config.web.workspaces`）。
- **隔离任务 + 工作区脏基线（`carryDirty`）**：`isolated=true` 且工作区有未提交内容时，隔离 worktree 从干净基线创建，带不动脏状态。缺省（`carryDirty` 未设）时 **`cbx_run`/`/cbx-run`/Web 创建即报错**并列出三种补救（先 `git commit`/`stash`、设 `carryDirty: true`、或 `isolated: false`），不再让任务带病入队、执行期才 `dirty_baseline` 崩溃。设 `carryDirty: true`（工具参数 `carry_dirty`，或 `.cbx.json`/插件配置 `carryDirty`）后，创建时会把当前未提交改动（已跟踪 diff + 未跟踪文件）带进隔离 worktree——任务在 worktree 里对"进行中的工作"安全执行，不污染主工作区、也无需先提交；任务结束时 worktree 仍按既有语义清理。适用于"审查/继续未提交的改动"这类场景。
- **取消语义**：取消先落盘标记再终止子进程；正在收口的 done 遇到取消标记会改按取消收口（state 与队列条目保持一致）。跨进程清理残留执行器时先校验 pid 归属（记录 spawn 时刻，按平台比对进程实际启动时间），pid 已被系统复用时跳过 kill 并落审计事件——宁可留待人工处理，不误杀无关进程树。
- **审批流**：before_run 审批通过即原子重入队并立即 dispatch；before_complete 审批在 commit 前后各核一次取消标记，证据哈希与 worktree 快照不符则拒绝完成（`completion_evidence_stale`）。
- **基线漂移（v2 指纹）**：脏指纹只统计已跟踪文件的状态与 diff——工作区里的未跟踪 scratch 文件、其他任务留下的产物不再触发误报。旧任务仍按 v1 比对，显式 `refresh_baseline` 时升级到 v2。
- **依赖守卫**：对修改与**新建**依赖声明/锁文件同责（事件中标注「新增」）；执行器静默引入新依赖会被拦截并要求恢复。
- **worktree 自愈**：`git worktree add` 撞到上次崩溃残留的孤儿目录时自动 prune + 清除 + 重试一次，不再永久失败。
- **符号链接**：未跟踪的符号链接/junction 不被跟随——diff 与审计材料记录链接本身而非目标内容，工作区之外的文件不会被吸进任务产物。
- **skipReview**：契约中全部 stage 声明 `skipReview` 时，完成门不再要求 `review.md` 与 `VERDICT: PASS`（job 级 `review: true` 与 stage 级跳过不再互锁死）。
- **执行器 CLI 版本耦合**：内置适配器（`src/executors/builtin.ts`）把 `(prompt, permissionMode, maxTurns)` 翻译成各 CLI 的具体参数（codebuddy 的 `--max-turns`/`--permission-mode`、opencode 的 `--auto`、qwen 的 `--yolo`/`--max-session-turns` 等）。这些参数可能随 CLI 版本漂移；升级外部 CLI 后请回归冒烟（`npm run smoke:e2e` 或 mock 版）。版本由工作区 `.cbx.json` 的 `executor`/`reviewExecutor` 或工具参数选择。

## 数据布局

任务数据默认存工作区 `.cbx/jobs/<job-id>/`（需求、状态、事件流、测试日志、diff、审查报告）+ `.cbx/state.sqlite`（WAL，队列/outbox/事件 seq 的权威存储；jobs 表为状态权威，state.json 为人类可读镜像）。体量控制：

- `agent.log` / `test.log`：内存采集尾部 4MB，磁盘落盘上限 32MB（超限留标记停止写入）。
- `events.ndjson`（job 级与工作区级）/ `telemetry.ndjson`：超 10MB 滚动单代 `.1`。
- `active.pid`：JSON 记录 `{"pid", "startedAt"}`，供取消/重试路径做 pid 归属校验。
- `agent.log.cursor`：`cbx_logs`/Web 增量读时记录上次协商的字节游标，agent.log 被手动截断/重建时自动从尾部重对齐（见 `readAgentLogIncremental`）。

**事件一致性说明**：事件同时写 `events.ndjson`（审计轨迹，权威）与 SQLite `events` 表（SSE 回放/查询源）。SQLite 镜像写入失败时不让事件发布失败、也不重试——它会与 ndjson 暂时漂移，属主动降级。镜像失败累计计数经 `/cbx/api/metrics`（`healthz` 只读指标）的 `eventMirrorFailures` 暴露（进程内存态，重启归零），>0 时说明 SSE 回放可能与此 job 的 ndjson 不一致，值得排查。

## 安全说明

- **环境变量继承**：执行器/测试命令的子进程完整继承宿主的 `process.env`（与终端直接运行一致）。这是有意设计——编码 CLI（codebuddy/opencode/omp/cline/qwen）依赖环境中的 API 凭据才能工作，因此不做变量过滤。可选硬化：插件 config 的 `executors.envAllowlist` 可收窄（见「配置」节）；日志落盘边界仍统一脱敏。
- **落盘脱敏**：`agent.log` / `test.log` / `events.ndjson` 在写入边界对常见凭据形状（OpenAI/GitHub/Slack/Google/AWS key、私钥、Bearer token）做正则脱敏（流式跨 chunk 边界保留 16 字节重叠，防 key 被切断漏网）；事件流与遥测 span 中的长字段同时做长度截断，敏感键名（token/password/secret/…）整体替换；`plugin-request.json`（内嵌完整 prompt）在插件宿主读取后立即删除，不留持久副本。
- **测试命令防线**：黑名单在匹配前先归一化（剥引号/反斜杠/`${var}`/`%var%`），拦截 `r\m`、`r""m` 一类拼接绕过；覆盖 `rm -rf`/`del /s`/`find -exec`/`git clean`/`truncate`/`dd`/`shred`/首 token `eval`/PowerShell 全部 `-EncodedCommand` 缩写；创建时与**执行时各验一次**（context.json 是执行器可写文件）。仍属软防线——非隔离任务请运行在受控环境，敏感场景建议 `isolated: true`。
- **进程终止安全**：跨进程 kill 前按 pid 归属校验（见「行为语义」）；Windows 树杀始终走 `taskkill /T /F`（不用会漏掉孙进程的 `child.kill`）；abort 后设硬死线，杀不死的子进程不再让任务永久挂起。
- **路径安全**：jobId 全链路校验（字符集白名单 + 拒绝 `..`/Windows 设备名/尾点段），目录删除与 context 写入共用同一道门；未跟踪符号链接不被跟随。
- **Web 鉴权**：`web.token` 非空时直接使用配置值；为空或缺省时，插件先从首个生效工作区（显式列表 / harness 注册表派生的第一项，见「配置」节）的 `.cbx/web.token` 读取非空值，文件不存在或为空则生成随机 token，并以 `0600` 权限写入该文件，后续未配置显式 token 的启动会复用它。未配置显式 token 时启动日志只打印 token 文件路径，不打印 token 值；浏览器提示从该文件或日志路径取得 token。**token 无法解析时拒绝挂载 Web 路由（fail-closed）**，绝不退化成无鉴权面。浏览器端首次请求数据端点收到 401，页面弹出 token 输入框，经 `POST /cbx/auth` 换取 HttpOnly cookie（SameSite=Strict，HTTPS 下加 Secure；token 不出现在页面源码或 URL）。`/healthz` 与 `/api/metrics` 均为只读，但只有 `/healthz` 公开，`/api/metrics` 仍需鉴权（均不触发保留期清理）。仪表盘带 CSP；SSE 有连接数与背压上限。
- **review stop-gate**：审查执行异常/超时/非零退出/无法解析 VERDICT 时默认 **fail-closed 拦截**（门禁的意义就是拦住行为异常的审查代理）；基础设施错误（如配置读取失败）仍放行以维持 hook 契约。需要旧行为配置 `reviewGate.failOpen: true`。
- **执行器插件**：`executor` 指向工作区内的插件路径时，默认仅告警不强制白名单；生产环境请配置 `plugins.enforce=true` 与 `allowPaths`/`allowSha256`（路径/哈希白名单校验后才加载）。

## 开发

```sh
npm install
npm run build        # tsc → lib/
npm run typecheck
npm test             # build + node --test（纯函数单测：校验/pid 归属/审计/证据门/上下文包/存储）
npm run smoke:e2e    # 端到端冒烟：起 dsh profile → 静态面/鉴权/SSE/任务生命周期 21 项断言
```

### 冒烟测试

本地 profile（`$DSH_HOME/profiles/cbx`）已配置为 `[dsh-base, dsh-web-app, dsh-cbx-orch]`，可 `dsh --profile cbx --port 3180` 启动后访问 `/cbx/`。

无真实编码 CLI 时也可验证全生命周期（create→run→test→done + 取消树级终止）：

```sh
CBX_SMOKE_MOCK=1 bash smoke/e2e.sh
```

`smoke/mock-executor/codebuddy.mjs` 是一个 npm-发布之外的冒烟假执行器，经 `CBX_CODEBUDDY` 注入 `findExecutable`，不依赖 PATH。CI 的 `e2e-mock` job 即用它跑通任务生命周期断言。

## 许可

MIT。引擎部分移植自 [cbx-orch](https://github.com/zerosloney/cbx-orch)（MIT）。
