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
| `cbx_run` | 创建并排队一个任务（task/executor/test/review/isolated/审批门等） |
| `cbx_status` | 任务状态/阶段/尝试 |
| `cbx_list` | 列出工作区所有任务 |
| `cbx_queue` / `cbx_queue_pause` / `cbx_queue_resume` | 队列查看与暂停/恢复 |
| `cbx_dispatch` | 调度队列（回收死 worker + 启动排队任务） |
| `cbx_continue` | 按 review.md/测试失败返工续跑 |
| `cbx_cancel` | 取消任务并终止执行器进程树 |
| `cbx_retry` | 重试失败任务 |
| `cbx_approve` | 批准等待审批的任务 |
| `cbx_result` / `cbx_artifact` / `cbx_artifacts` / `cbx_logs` | 读 result.json / 任意产物 / 产物列表 / agent.log 增量 |
| `cbx_health` | 队列深度、状态计数、失败/重试、死信（不含任务正文）。**默认只读**；`prune: true` 时才应用保留期清理 |
| `cbx_clean` | forget/purge 任务（含 worktree 清理） |
| `cbx_list_workspaces` | 列出已授权的工作区（不扫描任意 root 或子目录） |
| `cbx_review_gate` | 对未提交改动跑独立审查 |

> 工具参数使用 **snake_case**（如 `timeout_ms` / `max_retries` / `max_turns`）；`.cbx.json` 配置键与 Web/命令层使用 **camelCase**（`timeoutMs` / `maxRetries` / `maxTurns`）。二者仅命名风格不同，语义一一对应。
>
> **输出上限**：`cbx_result` / `cbx_artifact` 的文本输出截断到 64K 字符（保头尾并标注总长）；`cbx_status` / `cbx_cancel` / `cbx_approve` 等返回 state 的工具对超长字符串字段做深截断（8K）。完整内容仍在磁盘工件里，需要时用 `cbx_logs` 增量读取。

## 斜杠命令（`ctx.commands`）

`/cbx-run <task>`、`/cbx-status <job_id>`、`/cbx-continue <job_id> [message]`、`/cbx-cancel <job_id>`、`/cbx-list`、`/cbx-queue [pause|resume]`、`/cbx-result <job_id>`。

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
        workspaces: []        # cbx 工具工作区白名单；空/缺省仅允许 canonical cwd
    - id: cbx-orch-web
      name: 'dsh-cbx-orch/web'
      config:
        web:
          token: ''           # 非空 = 使用配置值；空/缺省 = 读取或生成 <首个工作区>/.cbx/web.token（生成时 0600），无免鉴权模式
          workspaces: []      # ?workspace= 白名单；空 = 当前目录
```

core 的 `workspaces` 是 `cbx_*` 工具的工作区白名单：空或缺省时只允许经 canonical 化后的当前目录；显式列表只授权其中精确的 workspace。路径通过 `realpath` canonicalize（Windows 下折叠路径大小写），越权、缺失路径或非目录都会拒绝。`cbx_list_workspaces` 只列出该白名单中的 workspace，不再扫描任意 root 或子目录。

Web 的 `web.workspaces` 继续作为 Web `?workspace=` 选择的独立 allowlist，但使用相同的 `WorkspacePolicy` 语义（canonicalization、越权/不存在/非目录拒绝）。core 的 `workspaces` 与 Web 的 `web.workspaces` 是两个独立配置，不会自动共享配置值。

### 工作区配置（`.cbx.json`，与 cbx-orch 相同）

`executor`、`testCommand`、`review`、`isolated`、`timeoutMs`、`maxRetries`、`maxTurns`、`maxConcurrent`、`reviewRules`、`approval`、`git`、`reviewGate`（`enabled`、`failOpen`）、`notifications`（webhook/OTLP outbox）、`governance`（retention/redact）、`telemetry`、`ui.token` 等，见 cbx-orch 文档。

## 行为语义

- **重试预算**：`maxRetries` = 首次执行失败后允许的重试次数，总执行次数 = 1 + maxRetries（`maxRetries: 1` 即 2 次执行 + 1 次修复重试）。每个 stage 的预算独立持久化，崩溃重入不重置；用户 resolve Human Gate 或显式 retry 时归零。
- **取消语义**：取消先落盘标记再终止子进程；正在收口的 done 遇到取消标记会改按取消收口（state 与队列条目保持一致）。跨进程清理残留执行器时先校验 pid 归属（记录 spawn 时刻，按平台比对进程实际启动时间），pid 已被系统复用时跳过 kill 并落审计事件——宁可留待人工处理，不误杀无关进程树。
- **审批流**：before_run 审批通过即原子重入队并立即 dispatch；before_complete 审批在 commit 前后各核一次取消标记，证据哈希与 worktree 快照不符则拒绝完成（`completion_evidence_stale`）。
- **基线漂移（v2 指纹）**：脏指纹只统计已跟踪文件的状态与 diff——工作区里的未跟踪 scratch 文件、其他任务留下的产物不再触发误报。旧任务仍按 v1 比对，显式 `refresh_baseline` 时升级到 v2。
- **依赖守卫**：对修改与**新建**依赖声明/锁文件同责（事件中标注「新增」）；执行器静默引入新依赖会被拦截并要求恢复。
- **worktree 自愈**：`git worktree add` 撞到上次崩溃残留的孤儿目录时自动 prune + 清除 + 重试一次，不再永久失败。
- **符号链接**：未跟踪的符号链接/junction 不被跟随——diff 与审计材料记录链接本身而非目标内容，工作区之外的文件不会被吸进任务产物。
- **skipReview**：契约中全部 stage 声明 `skipReview` 时，完成门不再要求 `review.md` 与 `VERDICT: PASS`（job 级 `review: true` 与 stage 级跳过不再互锁死）。

## 数据布局

任务数据默认存工作区 `.cbx/jobs/<job-id>/`（需求、状态、事件流、测试日志、diff、审查报告）+ `.cbx/state.sqlite`（WAL，队列/outbox/事件 seq 的权威存储；jobs 表为状态权威，state.json 为人类可读镜像）。体量控制：

- `agent.log` / `test.log`：内存采集尾部 4MB，磁盘落盘上限 32MB（超限留标记停止写入）。
- `events.ndjson`（job 级与工作区级）/ `telemetry.ndjson`：超 10MB 滚动单代 `.1`。
- `active.pid`：JSON 记录 `{"pid", "startedAt"}`，供取消/重试路径做 pid 归属校验。

## 安全说明

- **环境变量继承**：执行器/测试命令的子进程完整继承宿主的 `process.env`（与终端直接运行一致）。这是有意设计——编码 CLI（codebuddy/opencode/omp/cline/qwen）依赖环境中的 API 凭据才能工作，因此不做变量过滤。
- **落盘脱敏**：`agent.log` / `test.log` / `events.ndjson` 在写入边界对常见凭据形状（OpenAI/GitHub/Slack/Google/AWS key、私钥、Bearer token）做正则脱敏（流式跨 chunk 边界保留 16 字节重叠，防 key 被切断漏网）；事件流与遥测 span 中的长字段同时做长度截断，敏感键名（token/password/secret/…）整体替换；`plugin-request.json`（内嵌完整 prompt）在插件宿主读取后立即删除，不留持久副本。
- **测试命令防线**：黑名单在匹配前先归一化（剥引号/反斜杠/`${var}`/`%var%`），拦截 `r\m`、`r""m` 一类拼接绕过；覆盖 `rm -rf`/`del /s`/`find -exec`/`git clean`/`truncate`/`dd`/`shred`/首 token `eval`/PowerShell 全部 `-EncodedCommand` 缩写；创建时与**执行时各验一次**（context.json 是执行器可写文件）。仍属软防线——非隔离任务请运行在受控环境，敏感场景建议 `isolated: true`。
- **进程终止安全**：跨进程 kill 前按 pid 归属校验（见「行为语义」）；Windows 树杀始终走 `taskkill /T /F`（不用会漏掉孙进程的 `child.kill`）；abort 后设硬死线，杀不死的子进程不再让任务永久挂起。
- **路径安全**：jobId 全链路校验（字符集白名单 + 拒绝 `..`/Windows 设备名/尾点段），目录删除与 context 写入共用同一道门；未跟踪符号链接不被跟随。
- **Web 鉴权**：`web.token` 非空时直接使用配置值；为空或缺省时，插件先从首个配置工作区（未配置时为当前目录）的 `.cbx/web.token` 读取非空值，文件不存在或为空则生成随机 token，并以 `0600` 权限写入该文件，后续未配置显式 token 的启动会复用它。未配置显式 token 时启动日志只打印 token 文件路径，不打印 token 值；浏览器提示从该文件或日志路径取得 token。**token 无法解析时拒绝挂载 Web 路由（fail-closed）**，绝不退化成无鉴权面。浏览器端首次请求数据端点收到 401，页面弹出 token 输入框，经 `POST /cbx/auth` 换取 HttpOnly cookie（SameSite=Strict，HTTPS 下加 Secure；token 不出现在页面源码或 URL）。`/healthz` 与 `/api/metrics` 均为只读，但只有 `/healthz` 公开，`/api/metrics` 仍需鉴权（均不触发保留期清理）。仪表盘带 CSP；SSE 有连接数与背压上限。
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

## 许可

MIT。引擎部分移植自 [cbx-orch](https://github.com/zerosloney/cbx-orch)（MIT）。
