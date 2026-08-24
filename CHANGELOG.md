# Changelog

## 0.4.1 (2026-08-24)

Web 仪表盘 UI 全面现代化重构与体验美化（对齐 DeepSeek Harness 极客与开发者工具设计规范）。

### Added & Improved

- **全新视觉设计系统**：
  - 深色太空青蓝渐变背景与微网格质感，容器与面板全量支持 `backdrop-filter: blur(12px)` 毛玻璃效果。
  - 顶栏新增 CBX Orchestrator 专属流线型 Logo、DeepSeek Harness 标签与 LIVE 运行状态呼吸指示灯。
  - 9 个 KPI 状态统计指标卡片配备专属语义 SVG 图标、柔和状态微光顶边与点击过滤动画。
  - 任务列表表格升级为圆角卡片包装，表头质感优化，状态/Review/审计完整性升级为精致现代 Badge 徽章。
  - 任务详情面板阶段流水线支持状态图标（`✓` / `✕` / `•`）与连接箭头高亮；执行器 tab 具备 PID 呼吸指示灯与调用公式卡片。
  - Diff、Test、Review、agent.log 代码与日志区域新增标题工具条与 **📋 一键复制（Copy to Clipboard）** 功能。
  - 实时事件流控制台重构为 macOS/VS Code 风格终端窗口（红黄绿三色圆点装饰、状态流向徽标）。
  - 键盘无障碍与快捷键支持：按 `/` 键快速聚焦新建任务输入框，按 `Esc` 键关闭任务详情面板。

## 0.4.0 (2026-08-24)

本会话的加固与集成轮：全面代码审查（6 子代理深读 + 逐条验证）后的修复、ctx.settings 集成、安全策略指纹。

### ⚠️ Breaking / 行为变化

- **安全策略指纹（防执行器拆闸）**：任务创建时把 `.cbx.json` 的**安全关键字段**（`cost.maxExecutorInvocations` / `plugins` / `reviewGate` / `executors.envAllowlist`）做 sha256 指纹存入 SQLite；执行器调用前重算比对，**指纹漂移即拒绝调用**（`needs_fix` + `policy_drift` phase + Human Gate，fail-closed）。非隔离执行器 cwd=workspace 可中途改写 `.cbx.json` 静默拆闸的场景被拦截。**operator 主动改配置后续跑**（`cbx_continue` 通过 Human Gate，如 `cost_limit` 加预算）自动刷新指纹——显式续跑 = 显式接受当前配置，无需重建任务。旧任务（无指纹字段）跳过校验，完全向后兼容。
- **审计完整性验证口径升级**：`verifyJobAudit` 从「事件数 + event 类型」比对升级为**逐行完整 payload 深度比对** + 「ndjson 必须是 SQLite 镜像的连续尾部子序列」语义——内容篡改（改写任意行/删中间行/伪造追加）被检测；轮转（>10MB 滚 .1）/保留期清理不误报；事件超 5 万条镜像读取截断返回「无法验证」而非误报。
- **review/isolated 配置优先级修正**：`cbx_run` 工具与 `/cbx-run` 命令的 `review`/`isolated` 从「工具参数 > 插件默认」改为「工具参数 > 工作区 `.cbx.json` > 插件默认」——插件默认（schemastery `.default(true)`）不再永久压制工作区配置。

### Added

- **ctx.settings 集成（`src/settings-integration.ts`）**：宿主提供 `ctx.settings` 服务时注册 `cbx` namespace，把插件级默认配置（`executor`/`review`/`isolated`/`carryDirty`/`executors.envAllowlist`）暴露到 harness 设置界面，变更**即时生效**。优先级：工具参数 > 工作区 `.cbx.json` > settings > 插件 config。动态 import `@deepseek-ai/dsh-settings`（新增 optional peerDependency，版本线 0.1.0-rc.6 与现有 dsh 系列对齐）——宿主未装时静默跳过。**范围刻意最小**：不覆盖 `workspaces`（安全白名单）与 web token。
- **Web 层静默失败修复**：`waitForWebServer` 超时打日志 + 30s 延迟重试（不再"2s 没等到就永远不挂载且零诊断"）；`webPluginActive` 改读 `cbxWeb.mounted`（路由真实挂载才判定激活，`/cbx-web` 不再打开 404）。
- **jobs-bridge 重复注册防护**：同一 job 二次 `cbx_continue` 复用既有桥接任务（`existing: true`），终态后 registry 移除可重建——不再双份轮询/通知/cancel。
- **loadState 读失败不误判终止**：后台任务桥与前台镜像区分「真移除（目录/state.json 不存在）」与「瞬时读失败（目录在，重试）」，不再把 SQLite 读失败误报为 killed。
- **日志脱敏边界加固**：`LogRedactor` 首 chunk 延迟写 + TAIL_BYTES 16→64（覆盖最长 PEM 头）+ 流结束 flush——跨 chunk 私钥/PEM 不再漏网。
- **速度档校准只算成功样本延迟**：失败/超时样本的延迟不再污染 `speedTier` 推导（fastest 策略不再首选间歇崩溃的失败执行器）。
- **win32 探测负缓存 TTL**：`resolvedPathCache` 带 TTL（正结果 5 分钟、负结果 30 秒）——运行期新装 CLI 快速可见，不再永久"未安装"。
- **执行器插件主进程崩溃隔离**：`inspectExecutorPlugin` 的 import 包 try/catch——插件顶层 throw 转为可诊断错误而非打挂整个 harness 进程。

### Fixed

- **CSP 与内联样式冲突**：`default-src 'self'` 缺 `style-src 'unsafe-inline'` 导致分布条/进度条/状态圆点内联样式被浏览器丢弃——已补 `style-src 'self' 'unsafe-inline'`。
- **审批取消竞态分支 HTTP 409 映射失效**：`approval.ts` 竞态复检分支改抛 `CbxError("E_INVALID_STATE")`（原裸 `Error` 变 500）。
- **幂等失败清理掩盖原始错误**：`abortIdempotentCreate` 失败不再顶替 `createJob` 真实失败原因（tools/web 各落日志提示）。
- **savePersistedStateCas 非原子**：UPDATE→SELECT→INSERT 三步包单事务——跨进程双首写不再撞 PRIMARY KEY。
- **schema 迁移并发幂等**：全部 `CREATE TABLE/INDEX IF NOT EXISTS` + `INSERT OR IGNORE` + v3/v6 `ALTER TABLE ADD COLUMN` 列存在性检查——并发首开迁移不再报 "table already exists"/"duplicate column name"。
- **raw 子进程路径硬死线**：超时 killTree 后 5s 强制 settle——不可中断 IO 不再让 Promise 永久挂起。
- **LRU/round-robin 闲置分封顶**：60 分钟闲置封顶（原无上限，约 1h 后压过一切健康度罚）。
- **脱敏正则加词边界**：`DEFAULT_REDACT_PATTERNS` 加 `\b`——`sk-xxx` 不再命中更长 base64 子串过度脱敏。
- **策略指纹经续跑刷新**（本条目内 0.4.0 后续修复）：`prepareContinuation` 处理 Human Gate 续跑时同步刷新指纹——`cost_limit` 加预算续跑不再被 `policy_drift` 死锁。
- **残余英文日志/错误消息统一为中文**（web.ts SSE guard、ui.ts tailer 告警）。

### Security

- **审计镜像脱敏不对称修复**：SQLite events 表（审计权威、读取面优先）与 ndjson 共用同一份脱敏 payload——执行器输出回显的凭据不再从权威副本原样读出。
- **插件主进程崩溃隔离**（见 Added）。
- **策略指纹 fail-closed**（见 Breaking）。

### Docs

- README：ctx.settings 集成、安全策略指纹（含续跑刷新）、审计验证口径、日志脱敏边界。
- CHANGELOG：本条目。

## 0.3.0 (2026-08-23)

本会话的加固轮：成本治理、审计权威迁移、storage 拆分、HTTP 边界测试与多项正确性/性能修复。

### ⚠️ Breaking / 行为变化

- **executor 插件默认强制白名单（fail-closed）**：`executor` 指向工作区内的插件路径时，未配置 `plugins.enforce` 或为 `true` 时**必须提供 `allowPaths`/`allowSha256`** 之一，否则创建即报错。旧行为（无白名单也放行）需显式 `plugins.enforce=false`（逃生门，持续告警 + `plugin_policy_warning` 审计事件）。`PluginPolicy` 新增 `defaultEnforce`（runner 侧传入 `true`；`plugin-host.js` 直调路径不受影响）。
- **schema v6（审计权威迁移到 SQLite）**：`events` 表新增 `job_id` 列——job 级事件（`logJobEvent`/执行器调用事件）同时镜像进 SQLite，读取面（timeline/崩溃根因/事件增量/executor 命令）优先读 SQLite（执行器无 SQLite 连接、无法篡改），`events.ndjson` 降级为展示镜像。升级自动迁移；**降级回 v5 会被拒绝**（schema 版本高于当前）。
- **Web approve 业务错误 500 → 409**：已取消/不需要批准/重复批准/Human Gate 缺失等审批状态冲突，从普通 `Error`（HTTP 500）改为 `CbxError("E_INVALID_STATE")`（HTTP 409）。

### Added

- **成本硬闸 `cost.maxExecutorInvocations`**：可配置单个任务累计执行器调用（stage + review + manager + gate 全部角色）上限，达到即转 `needs_fix` + `cost_limit` phase + Human Gate（绝不当作普通失败走重试）。优先级：工具参数 `max_executor_invocations` / Web `max_executor_invocations`（per-job，写入 context）> `.cbx.json` `cost.maxExecutorInvocations`；执行期实时读取。新增 `ExecutorCostLimitError` + `E_COST_LIMIT` 错误码，stage/review/manager/handshake 全角色识别。
- **审计完整性验证（`verifyJobAudit`）**：比对 `events.ndjson` 与 SQLite 镜像（事件数 + 逐行 event/jobId），漂移即判定执行器篡改。`cbx_status` 附 `__audit`；`cbx_result`/result.json 附 `auditIntegrity`；`cbx_health` 聚合 `audit.checked/tampered`；`cbx_list`/Web 仪表盘展示 Audit 列（`篡改!`/`✓`/`—`）+ 详情面板审计状态。
- **`listJobsWithAudit`**（artifacts）：终态 job 富化 `__audit`，供 cbx_list 与 `GET /api/jobs` 共用。
- **`listPersistedStates` 分页**（`limit`/`offset`）+ `jobs.updated_at` 索引（schema v5）。
- **镜像文件去 fsync**：`atomicWriteFile`/`saveJson` 新增 `{ fsync: false }` 选项，镜像类文件（state.json/context.json/result.json/context-pack 等）不再承担每次同步 fsync 写放大（rename 原子性保留）。
- **执行器健康度落盘防抖**（500ms 合并窗口）+ `flushHealthStore`/`resetHealthStore` 清理。
- **Web POST 动作端点测试**（web-actions）：approve/cancel/retry/continue/forget/purge 全覆盖。
- **cbx_logs 事件增量游标语义**：`readEventsIncremental` 优先 SQLite（`jobEventsAfterCursor`），旧任务回退 ndjson 行游标（含增量续读）；修复稀疏 seq 漏事件 bug（`next_offset` 改为已读最后一条 seq，而非 +1）。
- **`storage/` 模块拆分**：原 `storage.ts`（2370 行）按关注点拆为 12 个子模块（io/config/context/locks/db/persist/meta/events/outbox/prune/metrics/lease），`storage.ts` 变 30 行 barrel，对外接口零变化。

### Fixed

- **executor 插件默认 enforce 后 runner 测试适配**：测试插件源统一注入合法 manifest + 工作区白名单（真实插件形态）。
- **`readEventsIncremental` SQLite 游标漏事件**：`next_offset = lastSeq + 1` 在 job 事件稀疏（混在 workspace 全局 seq）时，`seq > lastSeq+1` 会漏掉 `seq == lastSeq+1` 的本 job 事件。改为 `next_offset = 已读最后一条 seq`。
- **`readEventsIncremental` 回退语义**：SQLite 正常但该 job 从未镜像（旧任务）时显式探测回退 ndjson（支持行游标增量续读）；ndjson 文件缺失返回空而非抛错。
- **Web 测试基建**：POST 创建拉起的常驻调度器未清理（Windows SQLite 文件锁 EBUSY）——`stopScheduler` + 连接关闭 + 重试删除。
- **全量测试偶发 300s 超时**（tools-workspace cbx_run 测试）：空文件假执行器被 spawn 失败进入重试循环 + 调度器未停，拖住全量进程。修复：测试用 `approval_before_run: true` 停在门状态（不 spawn 执行器）+ finally `stopScheduler`。连续 4 次全量 285 测试全绿无超时。
- **git-ops 两处死代码**：`snapshotGitBaseline` 的 `statusOk ? stdout : stdout` 冗余（补上 fail-safe 标记）；`trackedDiff` unborn 分支的 `staged+unstaged` 拼接两次（删冗余）。
- **`Date.now()` 被 `now()` 替换误伤**（storage 拆分时）：还原。

### Security

- **审计权威迁移**：job 级事件镜像进 SQLite（执行器子进程无 SQLite 连接，无法篡改）；ndjson 可被不可信执行器改写，但读取面全部走 SQLite，且 `verifyJobAudit`/`auditIntegrity` 检测漂移。
- **`.cbx.json` 可信配置声明**（README）：严格校验未知字段拒绝的语义、降级风险、SSRF 面（webhook/telemetry endpoint）——外部 clone 仓库自带的 `.cbx.json` 应审查后再用。

### Docs

- README：成本治理（`cost.maxExecutorInvocations`）、审计权威与防篡改、`.cbx.json` 可信配置说明、executor 插件默认 enforce。
- CHANGELOG：本条目。

## 0.2.0 (2026-08-22)

自 npm 0.1.0（tag `v0.1.0`）以来的增量。

### Added

- **前台子代理外观层（subagent facade，`src/subagent-facade.ts`）**：把 cbx 委派发布为 harness 子代理镜像会话——Web「任务管理」页的子代理树（前台）里像子代理一样显示卡片，点击可实时查看执行输出（状态迁移 + agent.log 增量镜像）；终态追加摘要后 detach。新增 peerDependency `@deepseek-ai/dsh-session`。
- **路由决策前台可见（委派时刻）**：`cbx_run` 创建时的执行器路由决策（选了谁、是否自动路由/回退、原因）贯穿全部前台通道——后台任务桥的首轮 `job_output` 快照与完成通知、前台子代理镜像的首条消息与终态摘要都显示「已（自动路由到）委派给执行器 X（原因）」。新增共享格式化器 `routeNote()`；`bridgeCbxJob`/`publishCbxFacade` 新增 `router` 选项，无 router 时回落旧行为。
- **`/cbx-run` 显式执行器覆盖**：支持 `--executor <name>` / `--executor=<name>`（任意位置，解析后从任务剔除，也接受插件路径）与前导 `@<name>` 简写（仅命中内置注册名/别名才剥离）；优先级与工具对齐（显式覆盖 > 工作区 config > 插件默认），回复文案统一用 `routeNote()`。新增 `extractExecutorOverride` 导出与单测。

### Docs

- README：执行器覆盖语法、前台通道路由可见性、斜杠命令签名同步；`docs/alignment.md` §4.3 从「暂不做」更新为「已实现（外观层）」。

## 0.1.0

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
- **路由决策前台可见（委派时刻）**：`cbx_run` 创建时的执行器路由决策（选了谁、是否自动路由/回退、原因）现在贯穿全部前台通道——后台任务桥的首轮 `job_output` 快照与完成通知、前台子代理镜像的首条消息与终态摘要都会显示「已（自动路由到）委派给执行器 X（原因）」，不再只在工具渲染文本里可见、也不再等终态才知道选了哪个执行器。新增共享格式化器 `routeNote()`（session-message）；`cbx_run` 经 `bridgeCbxJob`/`publishCbxFacade` 的新 `router` 选项传递（RouteDecision 最小视图），无 router 时回落旧行为（context.json 执行器、无路由行）。
- **`/cbx-run` 支持显式执行器覆盖 + 路由决策同款可见**：斜杠命令此前没有 executor 参数（整行输入都是任务文本）。现在支持 `--executor <name>` / `--executor=<name>`（任意位置，解析后从任务剔除，也接受插件路径）与前导 `@<name>` 简写（仅当命中内置执行器注册名/别名才剥离，不误伤以 @ 开头的普通任务）；优先级与工具对齐（显式覆盖 > 工作区 config > 插件默认）。`/cbx-run` 创建路径同样把路由决策传给桥与外观层（`router` 选项 + facade `executor`），回复文案改用 `routeNote()`（自动路由显示「已自动路由到」，显式指定显示「已委派给」）。新增 `extractExecutorOverride` 导出与单测。

### Fixed

- **`resolveWorktreeWorkspace` 在 POSIX 上失效**：从 worktree 路径反解主工作区时用 `path.resolve(...parentParts, base)` 重建路径，首段空串被锚定到进程 cwd，Linux/macOS 上 `/tmp/...` 变成 `<cwd>/tmp/...`，隔离任务（worktree 内无 jobContext 的进程内调用）无法定位主工作区、工作区级白名单随之失效。改为 `join(path.sep)` 还原父路径后 `resolve`（Windows 多余分隔符由 resolve 归一化，行为不变）。
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
