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

插件已发布到 npm registry（`dsh-cbx-orch`，随 `v*` tag 由 CI 自动发布）。在 DeepSeek Harness 中通过 npm 包路径安装——`dsh plugin add` 会安装依赖并自动把包名追加到 profile 的 `dsh.profile.bundles`：

```sh
dsh plugin add --profile web dsh-cbx-orch     # web profile（含 web 插件层）
dsh plugin add --profile dev dsh-cbx-orch     # 任意 profile（仅 core 层）
dsh --profile web --dump-config              # 确认 cbx-orch / cbx-orch-web 行已组合
```

> **better-sqlite3 构建门控**：`dsh plugin add` 在 profile 的 `pnpm-workspace.yaml` 中已有 `allowBuilds` 占位（默认 `set this to true or false`，非布尔会导致安装失败）。把占位改为 `true` 后重跑 add 即完成原生构建：

> ```yaml
> # <profile>/pnpm-workspace.yaml
> allowBuilds:
>   better-sqlite3: true
> ```

> **npm ≥ 11.6 注意**（npm 而非 pnpm 安装时）：install-scripts 门控会跳过 `better-sqlite3` 的 node-gyp 构建（依赖包内声明的 allowScripts 不被认作覆盖），导致启动时报 native binding 缺失。自救：
>
> ```sh
> npm install-scripts approve better-sqlite3
> npm rebuild better-sqlite3
> ```

profile 的 `dsh.profile.bundles` 需要包含 `dsh-cbx-orch`（与 `@deepseek-ai/dsh-base` 一起），`dsh plugin add` 会自动追加；core 插件需要 `subprocess`/`tools`/`commands`（base bundle 提供）；web 插件额外需要 `webServer`，只在 web profile 激活。升级到新版本：`dsh plugin add --profile web dsh-cbx-orch@latest`。

```sh
dsh --profile web
```

启动后访问 `http://127.0.0.1:3080/cbx/` 查看仪表盘。

## 工具（`ctx.tools`）

| 工具 | 作用 |
| --- | --- |
| `cbx_run` | 创建并排队一个任务（task/executor/executor_preference/executor_requirements/routing_strategy/test/review/isolated/carry_dirty/审批门等）；`executor` 缺省/"auto" 时按本机已安装的 agent CLI 自动路由（能力感知 + 策略打分）；`executor_requirements` 表达任务需求（自动从 permission_mode/plan 推导）；`routing_strategy` 选策略（first-available/capability-best/cost-aware/fastest/round-robin/least-recently-used）；`carry_dirty` 把未提交改动带进隔离 worktree；`idempotency_key` 幂等防重——同键同载荷重试返回既有任务（deduplicated=true），同键不同载荷显式拒绝，创建失败自动释放预留 |
| `cbx_executors` | 探测本机已安装/可解析的编码 agent CLI（codebuddy/opencode/omp/cline/qwen）及其 envVar 覆盖；给定 workspace 时额外显示每个执行器的**能力声明与健康度**（成功/失败/延迟） |
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

> **执行器路由（能力感知 + 多因子决策）**：`cbx_run` / `/cbx-run` / Web 创建接口在创建任务前先探测本机已安装的编码 agent CLI（codebuddy/opencode/omp/cline/qwen），然后**按需求过滤 + 策略打分**选出最合适的一个。内置执行器声明 `capabilities`（autoApprove / planMode / sandbox / headless / maxTurnsSupport / streaming）与成本/速度档位（costTier / speedTier）：
> - **需求过滤**：任务可表达 `executor_requirements`（工具参数，或 `.cbx.json` 的 `executorRequirements`）；路由层**先剔除不满足需求的执行器**。`permission_mode`/`plan` 会自动推导需求——`auto`/`dontAsk` → 需要 `autoApprove`（例如此时自动排除 **omp**，它没有 auto-approve flag，会卡在交互授权）；`plan` → 需要 `planMode`。
> - **策略打分**：在满足需求的候选中按 `routing_strategy`（工具参数，或 `.cbx.json` 的 `routingStrategy`）打分选最优：`first-available`（缺省，按偏好顺序，等价旧行为但叠加需求过滤）/ `capability-best`（能力最多优先）/ `cost-aware`（成本最低优先）/ `fastest`（速度最高优先）/ `round-robin` / `least-recently-used`（最久未用优先）。分数综合偏好顺序 + 能力 + **健康度** + 策略项。
> - **健康度追踪（滑动窗口口径）**：每次执行器调用后把成功/失败/延迟/最近使用回写到 `<workspace>/.cbx/executor-health.json`（进程内即时生效，最佳努力异步落盘）。路由与档位校准以**最近 20 次结果的滑动窗口**为准：连续失败降权从窗口尾推导并随新证据老化、延迟罚用窗口均值、成功奖只计窗口内——历史功劳不再永久托底；终身累计仍保留为审计口径。失败语义细分：超时与崩溃（非零退出/启动失败）分档降权。`cbx_executors`（给定 workspace）可查看每个执行器的能力、健康度与**档位出处**（measured=实测校准 / configured=`executorTiers` 人工覆盖 / declared=声明估值）。
> - **兼容旧语义**：`executor` 未指定或 `"auto"` 时自动选择；显式指定但**未安装**默认回退到满足需求的可用 CLI（回退原因写进返回信息与日志，`autoFallback:false` 可关闭）；**插件路径不参与内置路由**（原样返回）。本机一个可用（且满足需求）的编码 CLI 都没有时**创建即报错**并给出安装/需求提示。探测结果带短 TTL 缓存；偏好顺序可用 `executor_preference` 或 `.cbx.json` 的 `executorPreference` 覆盖（缺省 = 内置声明顺序 codebuddy, opencode, omp, cline, qwen）。
> - **命令层显式覆盖（`/cbx-run`）**：斜杠命令没有结构化 `executor` 参数，用输入语法覆盖——`--executor <name>` / `--executor=<name>`（任意位置，解析后从任务文本剔除，也接受插件路径）或前导 `@<name>` 简写（仅当命中内置注册名/别名才剥离，不误伤以 @ 开头的普通任务）。优先级与工具对齐：显式覆盖 > `.cbx.json` `executor` > 插件配置默认。
>
> **工具参数使用 snake_case**（如 `timeout_ms` / `max_retries` / `max_turns` / `executor_preference`）；`.cbx.json` 配置键与 Web/命令层使用 camelCase（`timeoutMs` / `maxRetries` / `maxTurns` / `executorPreference`）。二者仅命名风格不同，语义一一对应。
>
> **默认工作区**：各工具/命令的 `workspace` 参数可省略，缺省 = 当前 agent 会话的工作目录（目录委派时设定，见「行为语义」）；显式传参必须命中工作区白名单。
>
> **会话内后台任务桥**：`cbx_run` / `cbx_continue` / `/cbx-run` / `/cbx-continue` 在 harness 提供 `ctx.jobs`（dsh-base 的 dsh-jobs-local + agent preset 的 dsh-tool-jobs）时，把委派注册为 `kind: "cbx"` 的原生后台任务——当前会话可实时看到执行进度与最终输出（`job_output` / `job_wait` / `job_kill` 可用，完成后有完成通知），`job_kill` 幂等转发为 `cbx_cancel`。委派时的**路由决策**（选了谁、是否自动路由/回退、原因）在 `job_output` 首轮快照与完成通知中直接可见（「已（自动路由到）委派给执行器 X（原因）」）。桥不可用时（无 agent 上下文 / 无 jobs 服务 / 并发上限）静默退化为旧行为：cbx job 照常运行，只是不在会话内显示。返回消息中的 `session job <id>` 提示即此桥已启用。
>
> **前台子代理外观层（subagent facade）**：同一批委派还会在 harness 提供 `ctx.sessions` 时发布为**子代理镜像会话**（`src/subagent-facade.ts`）——在 Web 侧边栏「任务管理」页的**子代理树（前台）**里像子代理一样显示一张卡片（`cbx <jobId>: <任务摘要>`，provider=cbx），点击卡片即可实时查看执行器输出（agent.log 增量镜像为 transcript，含状态迁移行）；镜像**首条 assistant 消息**即声明执行器与路由原因（与桥的首轮快照同款文案），终态摘要保留路由决策。cbx job 进入终态后追加结果摘要并 detach，卡片转为 inactive 的已完成子代理（无会话持久化时消失）。与后台任务桥是两条并存通道：桥接「后台任务」，外观层接「前台子代理树」，任一失败都不影响 cbx 本体执行。已知边界：镜像会话没有真实 harness agent，因此不可冷恢复/续跑（one-shot 镜像），运行期状态灯按 harness 对 live 子会话的统一规则标 running。发布失败（无 agent 上下文 / 无 sessions 服务 / 会话创建被拒）会在返回消息中说明原因。
>
> **任务清单直接显示在当前会话**：`cbx_run` / `cbx_continue` 的提交响应、`/cbx-run` / `/cbx-continue` 的回复、会话后台任务的 `job_output` 首轮快照以及完成通知，都会直接附上当前工作区的**全量任务清单表格**（Job ID / Status / Phase / Attempt / Updated），不再需要先调 `cbx_list` 或打开仪表盘才能看到编排全局；清单来自落库后的实时快照（`src/format.ts` 的 `formatTaskList` 统一格式化）。
>
> **委派处理消息流入当前会话**：执行器（外部编码 CLI）的处理过程——工具调用/推理/文件编辑的原始转录（agent.log）与状态迁移——现在会进入当前会话视图：① `cbx_watch` 轮询期间累计状态迁移 + agent.log 尾部，终态时连同最终状态一起返回（`include_log` / `max_log_chars` 可调，`since` 支持续读）；② 会话后台任务的完成通知（jobs-bridge 投递）自带 agent.log 尾部摘要（"处理消息（agent.log）"，截断到 8K 内，完整内容仍在磁盘），因此委派结束当前会话直接看到委派代理做了什么；③ `job_output` 运行期即可增量读到 agent.log 尾部。
>
> **统一的会话消息（`src/session-message.ts`）**：`cbx_run` / `cbx_continue` / `cbx_status` / `cbx_watch` 与会话后台任务桥的终态摘要，全部收敛到同一套富化消息，讲话一致、可行动：**状态 + 阶段人话说明**（如 `needs_fix（等待补充说明）`、`awaiting_approval（执行前等待审批）`）+ **执行器/路由决策** + **任务清单** + **产物目录指针（job dir）** + **处理消息（agent.log）**。每条消息按状态给出**下一步行动**（`下一步: 批准 cbx_approve <id>` / `按失败原因修复续跑 cbx_continue <id> <指令>` / `跟踪进度 cbx_watch <id>` / 完成时 `读结果 cbx_result <id>`），让当前会话（代理）一眼知道自己该调哪个工具。状态迁移行统一为 `[status / phase (attempt N) · executor]`（桥的实时进度带上执行器名）。
>
> **输出上限**：`cbx_result` / `cbx_artifact` 的文本输出截断到 64K 字符（保头尾并标注总长）；`cbx_status` / `cbx_cancel` / `cbx_approve` 等返回 state 的工具对超长字符串字段做深截断（8K）。完整内容仍在磁盘工件里，需要时用 `cbx_logs` 增量读取。

## 斜杠命令（`ctx.commands`）

`/cbx-run [--executor <name>|@<name>] <task>`（执行器覆盖语法见「执行器路由」节）、`/cbx-status <job_id>`、`/cbx-continue <job_id> [message]`、`/cbx-cancel <job_id>`、`/cbx-list`、`/cbx-queue [pause|resume]`、`/cbx-result <job_id>`、`/cbx-web [workspace]`。

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

`executor`、`executorPreference`、`executorRequirements`（如 `{ autoApprove: true, exclude: ["omp"] }`）、`routingStrategy`（`first-available`/`capability-best`/`cost-aware`/`fastest`/`round-robin`/`least-recently-used`）、`testCommand`、`review`、`isolated`、`timeoutMs`、`maxRetries`、`maxTurns`、`maxConcurrent`、`reviewRules`、`approval`、`git`、`reviewGate`（`enabled`、`failOpen`）、`cost`（`maxExecutorInvocations`，执行器调用硬上限，见「成本治理」）、`notifications`（webhook/OTLP outbox）、`governance`（retention/redact）、`telemetry`、`ui.token`、`executors`（`envAllowlist`，工作区级环境白名单，见「配置」节）等，见 cbx-orch 文档。

> **`.cbx.json` 是可信配置（严格校验，未知字段拒绝）**：`.cbx.json` 由 `loadRuntimeConfig` 严格校验——**任何未知字段都会导致配置整体加载失败**（而非静默忽略），拼写错误、误加字段、或旧版本不认识的字段都会让整个工作区的 cbx 不可用，并报出具体字段名。这是有意设计：静默忽略未知策略字段会让安全/成本控制悄悄失效（如拼错的 `maxExecutorInvocations` 会让成本闸不生效），宁可显式失败。**含义与注意事项**：
> - 升级插件时，旧版 `.cbx.json` 若无新版新增字段可正常加载（向后兼容）；但**降级**到不识别新字段的旧版本会拒绝加载——升级前请确认不需要降级。
> - 迁移/升级流程中若遇到"不支持字段"报错，删除或修正对应字段即可，不会损坏已有任务数据（配置校验独立于任务状态）。
> - **不要把来自不可信来源的 `.cbx.json` 带入工作区**：它是可信配置，控制执行器/测试子进程的启动参数（`testCommand`）、网络投递目标（`notifications.webhook` / `telemetry.endpoint`，插件进程会向该地址发 POST，存在 SSRF 面）、插件白名单（`plugins.allowPaths/allowSha256`）等。从外部 clone 的仓库自带的 `.cbx.json` 应先审查再使用。

## 行为语义

- **重试预算**：`maxRetries` = 首次执行失败后允许的重试次数，总执行次数 = 1 + maxRetries（`maxRetries: 1` 即 2 次执行 + 1 次修复重试）。每个 stage 的预算独立持久化，崩溃重入不重置；用户 resolve Human Gate 或显式 retry 时归零。
- **成本治理（`cost.maxExecutorInvocations`）**：可配置单个任务累计执行器调用（stage + review + manager + gate 全部角色）的**硬上限**，防 API 配额烧穿。执行器调用前检查 `executorInvocations` 计数，达到上限即转 `needs_fix` + `cost_limit` phase + Human Gate（绝不当作普通失败走重试——重试只会继续烧配额）；用户可 `cbx_continue` 加预算（修改 `.cbx.json` 的 `maxExecutorInvocations` 后续跑）或取消任务。缺省不配置 = 无上限（完全向后兼容）。配置在**执行期实时读取**（改配置即生效，无需重建任务），与 `maxTurns × maxRetries × stages × maxRounds` 的隐含上限互补——后者是预算结构，前者是硬性熔断。
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
- `agent.log.cursor`：`cbx_logs`/Web 增量读时记录上次协商的字节游标，agent.log 被手动截断/重建时自动从尾部重对齐（统一由 `src/log-tail.ts` 提供增量读契约，Web/journal/bridge 三处复用）。

**事件一致性说明**：事件同时写 `events.ndjson`（展示/轮转镜像）与 SQLite `events` 表（**审计权威**）。SQLite 镜像写入失败时不让事件发布失败、也不重试——它会与 ndjson 暂时漂移，属主动降级。镜像失败累计计数经 `/cbx/api/metrics`（`healthz` 只读指标）的 `eventMirrorFailures` 暴露（进程内存态，重启归零），>0 时说明 SSE 回放可能与此 job 的 ndjson 不一致，值得排查。

**审计权威与防篡改**：job 级事件（`logJobEvent` / 执行器调用事件）同时镜像进 SQLite `events` 表（带 `job_id` 列，schema v6）。**执行器（不可信子进程）只有文件系统权限、没有 SQLite 连接，无法写入 events 表**——因此 SQLite 是执行器无法篡改的审计权威；`events.ndjson` 降级为展示/轮转镜像，可被执行器改写。读取面（timeline / 崩溃根因 / 事件增量 / executor 命令展示）**优先读 SQLite**，镜像缺失时回退 ndjson。审计完整性的**展示面**：`cbx_status` 附 `__audit` 验证结果、`cbx_result`/`result.json` 附 `auditIntegrity`、`cbx_list` 与 Web 仪表盘展示 Audit 列（`篡改!` / `✓` / `—`）与详情面板审计状态、`cbx_health` 聚合 `audit.checked/tampered` 计数。已知边界：旧任务（无 SQLite 镜像）无法验证；对抗性执行器若能同时掌握镜像内容（如读 jobDir 的 events.ndjson 但改不了 SQLite）只能伪造 ndjson 造成漂移被检测，无法污染权威。

> **schema 升级注意**：state.sqlite schema 版本已到 **v6**（`jobs.updated_at` 索引 v5 + `events.job_id` v6）。升级自动迁移且幂等；**降级回旧版本会被拒绝运行**（"schema 版本高于当前 cbx"）。升级后旧任务（v6 前创建）无 SQLite 事件镜像，审计验证显示"无法验证"（`cbx_health` 不计入 `audit.checked`），新任务全量镜像。

## 安全说明

- **环境变量继承**：执行器/测试命令的子进程完整继承宿主的 `process.env`（与终端直接运行一致）。这是有意设计——编码 CLI（codebuddy/opencode/omp/cline/qwen）依赖环境中的 API 凭据才能工作，因此不做变量过滤。可选硬化：插件 config 的 `executors.envAllowlist` 可收窄（见「配置」节）；日志落盘边界仍统一脱敏。
- **落盘脱敏**：`agent.log` / `test.log` / `events.ndjson` 在写入边界对常见凭据形状（OpenAI/GitHub/Slack/Google/AWS key、私钥、Bearer token）做正则脱敏（流式跨 chunk 边界保留 16 字节重叠，防 key 被切断漏网）；事件流与遥测 span 中的长字段同时做长度截断，敏感键名（token/password/secret/…）整体替换；`plugin-request.json`（内嵌完整 prompt）在插件宿主读取后立即删除，不留持久副本。
- **测试命令防线**：黑名单在匹配前先归一化（剥引号/反斜杠/`${var}`/`%var%`），拦截 `r\m`、`r""m` 一类拼接绕过；覆盖 `rm -rf`/`del /s`/`find -exec`/`git clean`/`truncate`/`dd`/`shred`/首 token `eval`/PowerShell 全部 `-EncodedCommand` 缩写；创建时与**执行时各验一次**（context.json 是执行器可写文件）。仍属软防线——非隔离任务请运行在受控环境，敏感场景建议 `isolated: true`。
- **进程终止安全**：跨进程 kill 前按 pid 归属校验（见「行为语义」）；Windows 树杀始终走 `taskkill /T /F`（不用会漏掉孙进程的 `child.kill`）；abort 后设硬死线，杀不死的子进程不再让任务永久挂起。
- **路径安全**：jobId 全链路校验（字符集白名单 + 拒绝 `..`/Windows 设备名/尾点段），目录删除与 context 写入共用同一道门；未跟踪符号链接不被跟随。
- **Web 鉴权**：`web.token` 非空时直接使用配置值；为空或缺省时，插件先从首个生效工作区（显式列表 / harness 注册表派生的第一项，见「配置」节）的 `.cbx/web.token` 读取非空值，文件不存在或为空则生成随机 token，并以 `0600` 权限写入该文件，后续未配置显式 token 的启动会复用它。未配置显式 token 时启动日志只打印 token 文件路径，不打印 token 值；浏览器提示从该文件或日志路径取得 token。**token 无法解析时拒绝挂载 Web 路由（fail-closed）**，绝不退化成无鉴权面。浏览器端首次请求数据端点收到 401，页面弹出 token 输入框，经 `POST /cbx/auth` 换取 HttpOnly cookie（SameSite=Strict，HTTPS 下加 Secure；token 不出现在页面源码或 URL）。`/healthz` 与 `/api/metrics` 均为只读，但只有 `/healthz` 公开，`/api/metrics` 仍需鉴权（均不触发保留期清理）。仪表盘带 CSP；SSE 有连接数与背压上限。
- **review stop-gate**：审查执行异常/超时/非零退出/无法解析 VERDICT 时默认 **fail-closed 拦截**（门禁的意义就是拦住行为异常的审查代理）；基础设施错误（如配置读取失败）仍放行以维持 hook 契约。需要旧行为配置 `reviewGate.failOpen: true`。
- **执行器插件**：`executor` 指向工作区内的插件路径时，**默认强制白名单**（fail-closed）——未配置 `plugins.enforce` 或配置为 `true` 时，必须提供 `allowPaths`/`allowSha256`（路径/哈希白名单）之一，插件才被加载；否则创建即报错并给出配置指引。需要旧行为（无白名单也放行）时显式配置 `plugins.enforce=false`（逃生门，会持续告警并在事件流留 `plugin_policy_warning` 审计记录）。

## 开发

```sh
npm install
npm run build        # tsc → lib/
npm run typecheck
npm test             # build + node --test（纯函数单测：校验/pid 归属/审计/证据门/上下文包/存储）
npm run smoke:e2e    # 端到端冒烟：起 dsh profile → 静态面/鉴权/SSE/任务生命周期 21 项断言
```

`npm test` 顶层汇总里的 **`skipped` 是指测试在运行时被「条件性」主动跳过**（`t.skip(...)`），不是失败也不是遗漏——是测试作者写好的**安全护栏**：当环境不满足"安全/有代表性"的运行条件时就跳过，避免误报失败或触碰真实数据。目前有 4 处会按环境命中：

| # | 条件触发的跳过点 | 触发条件 | 意图 |
|---|---|---|---|
| 1-3 | `test/commands-workspace.test.mjs`（3 处） | **当前工作目录已存在 `.cbx/`** 时 | 避免测试在你真实数据上乱动 |
| 4 | `test/scheduler-ownership.test.mjs` | **本机无法创建 Windows junction** 时 | 环境不支持 junction 即跳过该子测试 |

因此在本仓库目录（自带 `.cbx/`）里跑 `npm test` 会看到 `skipped 4`（3 处 cwd 已存在 `.cbx` + 1 处 junction 不可建）。这是预期行为；`pass / fail` 才是有效结果（例如当前为 146 pass / 0 fail）。想让那 3 处真正运行，可换到无 `.cbx/` 的目录跑——但可能又触发其他环境相关的跳过。

### 冒烟测试

本地 profile（`$DSH_HOME/profiles/cbx`）已配置为 `[dsh-base, dsh-web-app, dsh-cbx-orch]`，可 `dsh --profile cbx --port 3180` 启动后访问 `/cbx/`。

无真实编码 CLI 时也可验证全生命周期（create→run→test→done + 取消树级终止）：

```sh
CBX_SMOKE_MOCK=1 bash smoke/e2e.sh
```

`smoke/mock-executor/codebuddy.mjs` 是一个 npm-发布之外的冒烟假执行器，经 `CBX_CODEBUDDY` 注入 `findExecutable`，不依赖 PATH。CI 的 `e2e-mock` job 即用它跑通任务生命周期断言。

## 许可

MIT。引擎部分移植自 [cbx-orch](https://github.com/zerosloney/cbx-orch)（MIT）。
