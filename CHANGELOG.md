# Changelog

## Unreleased (0.1.0)

首次发布前的完整加固轮（安全审计 + 六轮修复 + 工程化）。

### ⚠️ Breaking / 行为变化

- **review stop-gate 默认 fail-closed**：审查执行异常/超时/非零退出/无法解析 VERDICT 一律拦截（旧行为为 fail-open 放行）。需要旧行为配置 `.cbx.json` 的 `reviewGate.failOpen: true`。
- **`maxRetries` 语义修正**：总执行次数 = 1 + maxRetries（`maxRetries: 1` 从实际 3 次执行改为 2 次；`maxRetries: 0` 不再被强制至少重试一次）。旧任务按创建时持久化的预算执行。
- **SSE `/cbx/events` 不再接受 URL query token**（会泄漏进浏览器历史/代理日志）。使用 Bearer header 或 `POST /cbx/auth` 换取的 HttpOnly cookie。
- **脏指纹 v2**：基线漂移检测不再统计未跟踪文件内容——工作区里的 scratch 文件不再触发非隔离任务的"脏漂移"误报。旧任务在"已跟踪改动为空"时自动懒迁移（`context_schema_migrated` 事件），否则保持 v1 语义直到显式 `refresh_baseline`。
- **队列条目新增 `needs_fix` 状态**：`needs_fix`/`review_failed` 的任务不再在队列视图里显示为 `failed`（API 消费者注意新枚举值）。
- **Web 挂载路径修正**：仪表盘挂在 `/cbx` 前缀下，`/cbx` 无尾斜杠访问 301 到 `/cbx/`，页面资源与 API 全部相对路径引用。

### Added

- **执行器路由（本机 agent CLI 检测 + 路由）**：`cbx_run`/`/cbx-run`/Web 创建接口在创建任务前探测本机已安装的编码 agent CLI（codebuddy/opencode/omp/cline/qwen）。`executor` 未指定/`"auto"` 时自动选偏好顺序第一个已安装；显式指定但未安装时自动回退到可用 CLI 并注明（`executor_preference` 工具参数 / `.cbx.json` 的 `executorPreference` 可调顺序）；本机一个 CLI 都没有时创建即报错并列出安装指引。`probeAllExecutors` 带短 TTL 缓存与 `resetExecutorProbeCache`。
- **新增 `cbx_executors` 工具**：探测/列出本机可执行的编码 agent CLI 及其 envVar 覆盖来源（env/path/none）。
- **委派处理消息流入当前会话**：`cbx_watch` 现在累计状态迁移 + agent.log 尾部（处理消息）并在终态一并返回（`include_log`/`max_log_chars`/`since` 可调）；会话后台任务（jobs-bridge）的完成通知与终态摘要附带 agent.log 处理消息尾部（截断到 8K，完整内容在磁盘）；运行期 `job_output` 可增量读到 agent.log 尾部。
- `cbx_health` 默认只读（`prune: true` 才应用保留期清理）；`/api/metrics` 同样只读。
- 工具输出上限：`cbx_result`/`cbx_artifact` 截断 64K（保头尾），state 类工具深截断 8K。
- 事件回放 SQLite 化（schema v4 `events` 表 + 双写 + 游标查询），SSE 重连不再整读事件文件。
- context.json schema 迁移基础设施（`dirtyFingerprintVersion` + 带守卫的懒迁移）。
- 日志体量控制：`agent.log`/`test.log` 磁盘 32MB 上限；`events.ndjson`/`telemetry.ndjson` 10MB 单代轮转；SQLite events 随保留期清理 + 孤儿目录回收（1h 宽限）。
- Web：CSP（`default-src 'self'; frame-ancestors 'none'`）、SSE 连接数上限 16 + 背压断开、cookie HTTPS 下自动 `Secure`、token 文件 0600、登录限速成功即清零、工作区白名单归一化去重。
- 依赖守卫覆盖**新建**依赖文件（事件标注「新增」）；worktree 孤儿目录自愈；未跟踪符号链接/junction 不跟随（含 Windows 祖先链检查）。
- 测试与冒烟：30 个单测（node:test）+ 端到端冒烟 `smoke/e2e.sh`（24 断言，含三插件合体加载）+ 发布物冒烟 `smoke/pack.sh`（tarball 安装 + native binding 验证，内置 npm ≥11.6 install-scripts 门控兜底）；CI workflow（含 `e2e-mock` job，用 `smoke/mock-executor` 假执行器跑通任务生命周期）。
- **会话内后台任务桥**：`cbx_run`/`cbx_continue`/`/cbx-run`/`/cbx-continue` 在 harness 提供 `ctx.jobs` 时，把委派注册为 `kind: "cbx"` 的原生后台任务——当前会话可实时看到执行进度与最终输出（`job_output`/`job_wait`/`job_kill` 工具可用，完成后有完成通知），`job_kill` 幂等转发为 `cbx_cancel`；桥不可用时静默退化为旧行为（cbx job 照常运行，只是不在会话内显示）。详见 `docs/alignment.md` §4.2 与 `src/jobs-bridge.ts`。
- **任务清单直接显示在当前会话**：`cbx_run`/`cbx_continue` 提交响应、`/cbx-run`/`/cbx-continue` 回复、会话后台任务的 `job_output` 首轮快照与完成通知，都直接附上当前工作区**全量任务清单表格**（Job ID/Status/Phase/Attempt/Updated），不用再单独调 `cbx_list`/`/cbx-list` 或开仪表盘才能看到编排全局。统一走新的共享格式化器 `src/format.ts`（`formatTaskList`），`cbx_list` 渲染亦复用之。
- **新增 `/cbx-web [workspace]` 斜杠命令**：解析当前工作区（或显式 workspace，受白名单约束）后给出 cbx 仪表盘链接并尝试在系统默认浏览器打开（Windows `start` / macOS `open` / Linux `xdg-open`）；从 `ctx.webServer` 读取实际端口构造绝对 URL，未加载 `cbx-orch-web` 的 headless profile 会提示。浏览器唤起是 best-effort，失败回落为输出可点击链接。
- 设计文档 `docs/alignment.md`：与 harness 原生服务（jobs/schedule/subagents/settings/事件）的边界与互操作决策。

### Fixed

- **工具返回值的 JSON 无损性**：`cbx_*` 工具输出统一经 `clampJson` 剔除 `undefined` 与非有限数（NaN/±Infinity）——`JSON.stringify` 会把这些值丢成 `null` 或整键丢弃，导致 harness 拒绝整个工具返回值（`cbx_run`/`cbx_executors` 等报错）。剔除集中在共享函数一处，所有工具一次性受益。
- **隔离任务 + 脏基线（委派改进）**：`isolated=true` 且工作区有未提交内容时，此前任务带病入队、执行期才因 `dirty_baseline` 崩溃。现在**创建即报错**并列出三种补救（先提交/stash、`carryDirty: true`、或 `isolated: false`），省去无谓的崩溃循环。新增 **`carryDirty`** 选项（工具参数 `carry_dirty`，`.cbx.json`/插件配置 `carryDirty`）：置真后创建时把未提交改动（已跟踪 diff + 未跟踪文件）带进隔离 worktree，让隔离任务也能对"进行中的工作"安全执行（不污染主工作区、也无需先提交）——覆盖"审查/继续未提交改动"场景。`execution` 的隔离脏基线门同时改为在 `carryDirty` 时放行。
- **Web 仪表盘默认工作区改为跟随 harness 工作区注册表**：`/cbx/` 默认显示 `ctx.workspaceRegistry`（harness GUI 中打开过的工作区/会话目录），`?workspace=` 可在其中切换；注册表不可用/为空时回落进程 cwd。此前 Web 层只默认进程 cwd，导致「会话目录里用 `/cbx-run` 创建的 job 在仪表盘上完全不可见，显式选择该目录还被 400 拒绝」。
- **默认工作区跟随目录委派**（行为变更）：`cbx_*` 工具与 `/cbx-*` 命令在未显式传 `workspace` 时，默认工作区从「harness 进程 cwd」改为「当前 agent 会话的 `header.cwd`（目录委派时设定的工作目录）」，回落 `process.cwd()`。空配置（`workspaces: []`）时委派到哪个目录就在哪个目录跑 cbx；显式配置白名单时仍精确匹配列表，会话 cwd 不在列表内同样拒绝并提示配置位置。
- **"无提示"诊断补齐**：原本只写进 `events.ndjson`、队列只留笼统错误的根因现在直接可见——`isolated=true` 但工作区不是 Git 仓库时，`cbx_run`/Web 创建接口**创建即报错**并给出修复建议（`git init` 或 `isolated: false`），不再让任务带病入队、崩溃 4 次后才以"worker 反复无法恢复"收场；已入队的任务熔断失败时，队列错误会携带最近一条 `worker_crash` 的真实原因。工作区授权被拒时，报错会列出**当前允许的工作区**并指明配置位置（profile `cordis.patch.yml` 的 `config.workspaces` / `config.web.workspaces`）。
- **仪表盘在 harness 挂载模式下完全不可用**（根相对路径资源全部 404）。
- **无校验 PID 树杀**：跨进程清理残留执行器前按平台校验 pid 归属（spawn 时刻比对），pid 复用时跳过 kill 落审计事件；Windows 树杀始终走 `taskkill /T /F`。
- **卡死 worker 的 run.lock 永久死锁**：进程内死 worker 即刻回收（注册表注销即判死）；事件循环阻塞的僵尸由调度器接管（取消标记 + 终止句柄 + 强制释放本进程锁）。
- **取消窗口漏杀子进程**（spawn 前检查 job 取消信号、注册后补竞态终止、标记先于 abort 写入）；abort 后硬死线防止杀不死的子进程把任务永久挂起。
- **before_run 审批的"永不调度"断层**：审批通过的状态回 queued 与队列条目重新激活同一事务落盘并立即 dispatch。
- **skipReview 完成门死锁**：全部 stage 声明 skipReview 时不再要求 `review.md`/`VERDICT: PASS`。
- **崩溃续跑整链重放**：链式任务按持久化 stage 报告跳过已完成 stage。
- jobs 表并发写按 CAS 乐观锁收敛（非终态写不再整 blob 盲覆盖、终态不再被回退/复活）。
- 队列 blob / legacy 导入 / `queue_state` 种子的并发竞态与损坏容错；文件锁获取/释放两条死锁路径；`closeDatabaseConnections` 与并发连接的泄漏竞态。
- `finish()`/审批的取消竞态（commit 前后双复核）；重试预算 off-by-one；超时误判（abort 瞬间正常退出不再误报）；`attemptExtra` 跨 stage 泄漏；needs_fix 队列语义。
- review stop-gate 的主工作区篡改检测保持 fail-closed；worktree 清理 Windows 瞬态句柄重试。
- 跨工作区同名任务在 job-runtime 注册表串扰（复合键）；校验错误码化（Web 回 400 而非 500）；租约拒绝按错误码判定。
- `plugin-request.json`（内嵌完整 prompt）用后即删；遥测 span 双层脱敏（键名 + 凭据形状）；投递死信剥 endpoint userinfo。
- 全部 git 调用异步化（不再阻塞事件循环）；HMR 下 provider/调度器/定时器/连接的属主化与接管。
- **常驻调度器不再向 `process.cwd()` 无谓落 `.cbx`**：插件启动只在**显式配置**的工作区预拉常驻调度器（崩溃重启后无需等下一次入队即可续跑遗留任务）；空配置（`workspaces: []`，工作区跟随委派目录动态解析）时不再预拉 `process.cwd()` 的调度器——否则会在启动目录创建 `.cbx/`（设备启动目录被污染，且空配置下 `process.cwd()` 并非真实任务目录，预拉不回收任何遗留任务）。这些目录的调度器仍在入队/派发时经 `ensureScheduler` 按需拉起，同样会回收死 worker 并续跑遗留任务。
- **测试基建修复（Windows 既有 flake）**：`npm test` 全量并行时共享进程 cwd，部分测试有意探测 `process.cwd()` 回落并在共享 cwd 创建 `.cbx`，导致 `commands-workspace` 的 cwd 守卫测试误报。修复：`tools-workspace` 的 cwd 回落探测改在临时 cwd 内进行（不污染仓库 cwd）；`commands-workspace` 在 dispose 前删除委派目录改用 `rmRetry`（每轮重关连接 + 退避重试，消除 Windows 瞬态句柄 EBUSY）。全量 `node --test` 恢复全绿且运行后仓库 cwd 不再残留 `.cbx`。

### Security

- 测试命令黑名单归一化加固（拼接/引号/变量展开绕过、`find -exec`、`git -C clean`、PowerShell 缩写、首 token `eval`）+ 执行期复验。
- jobId 全链路校验（字符集 + Windows 设备名/尾点段），目录删除与 context 写入同门。
- Web 鉴权 fail-closed：token 无法解析时拒绝挂载路由，绝不退化成无鉴权面。
