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

- `cbx_health` 默认只读（`prune: true` 才应用保留期清理）；`/api/metrics` 同样只读。
- 工具输出上限：`cbx_result`/`cbx_artifact` 截断 64K（保头尾），state 类工具深截断 8K。
- 事件回放 SQLite 化（schema v4 `events` 表 + 双写 + 游标查询），SSE 重连不再整读事件文件。
- context.json schema 迁移基础设施（`dirtyFingerprintVersion` + 带守卫的懒迁移）。
- 日志体量控制：`agent.log`/`test.log` 磁盘 32MB 上限；`events.ndjson`/`telemetry.ndjson` 10MB 单代轮转；SQLite events 随保留期清理 + 孤儿目录回收（1h 宽限）。
- Web：CSP（`default-src 'self'; frame-ancestors 'none'`）、SSE 连接数上限 16 + 背压断开、cookie HTTPS 下自动 `Secure`、token 文件 0600、登录限速成功即清零、工作区白名单归一化去重。
- 依赖守卫覆盖**新建**依赖文件（事件标注「新增」）；worktree 孤儿目录自愈；未跟踪符号链接/junction 不跟随（含 Windows 祖先链检查）。
- 测试与冒烟：30 个单测（node:test）+ 端到端冒烟 `smoke/e2e.sh`（24 断言，含三插件合体加载）+ 发布物冒烟 `smoke/pack.sh`（tarball 安装 + native binding 验证，内置 npm ≥11.6 install-scripts 门控兜底）；CI workflow。
- 设计文档 `docs/alignment.md`：与 harness 原生服务（jobs/schedule/subagents/settings/事件）的边界与互操作决策。

### Fixed

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

### Security

- 测试命令黑名单归一化加固（拼接/引号/变量展开绕过、`find -exec`、`git -C clean`、PowerShell 缩写、首 token `eval`）+ 执行期复验。
- jobId 全链路校验（字符集 + Windows 设备名/尾点段），目录删除与 context 写入同门。
- Web 鉴权 fail-closed：token 无法解析时拒绝挂载路由，绝不退化成无鉴权面。
