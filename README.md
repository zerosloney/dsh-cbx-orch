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

与 cbx-orch 原版的差异：MCP server、独立 CLI、TUI 在 dsh 内被原生工具/命令/Web 取代，不再移植。任务 worker 改为**进程内调度**（执行器/测试仍是树级可终止的 `ctx.subprocess` 子进程），取消时经 job-runtime 终止活动子进程。

## 安装

作为一个 bundle 包装进某个 profile：

```sh
# 发布后
dsh plugin --profile web add dsh-cbx-orch

# 本地开发（file: 链接）
# 在 $DSH_HOME/profiles/<name>/package.json 加依赖并安装
```

profile 的 `dsh.profile.bundles` 需要包含 `dsh-cbx-orch`（与 `@deepseek-ai/dsh-base` 一起）。core 插件需要 `subprocess`/`tools`/`commands`（base bundle 提供）；web 插件额外需要 `webServer`，只在 web profile 激活。

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
| `cbx_health` | 队列深度、状态计数、失败/重试、死信（不含任务正文） |
| `cbx_clean` | forget/purge 任务（含 worktree 清理） |
| `cbx_list_workspaces` | 扫描根目录下含 `.cbx/` 的工作区 |
| `cbx_review_gate` | 对未提交改动跑独立审查 |

## 斜杠命令（`ctx.commands`）

`/cbx-run <task>`、`/cbx-status <job_id>`、`/cbx-continue <job_id> [message]`、`/cbx-cancel <job_id>`、`/cbx-list`、`/cbx-queue [pause|resume]`、`/cbx-result <job_id>`。

## Web API

挂在 `/cbx` 前缀下（`ctx.webServer`）：

- `GET /cbx/` — 仪表盘 HTML
- `GET /cbx/events` — SSE 实时事件流（Last-Event-ID 回放）
- `GET /cbx/api/workspaces|jobs|queue|healthz|metrics`
- `GET /cbx/api/jobs/<id>[/artifacts|/artifact/<name>|/timeline|/executor|/agent.log]`
- `POST /cbx/api/jobs`（创建）、`/cbx/api/jobs/<id>/approve|cancel|retry|continue|forget|purge`、`/cbx/api/queue/pause|resume`

数据端点鉴权用 `Authorization: Bearer <token>` 或 HttpOnly cookie `cbx_token`；首页与 `/healthz` 开放。

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
    - id: cbx-orch-web
      name: 'dsh-cbx-orch/web'
      config:
        web:
          token: ''           # 数据端点 Bearer token；空 = 不鉴权
          workspaces: []      # ?workspace= 白名单；空 = 当前目录
```

### 工作区配置（`.cbx.json`，与 cbx-orch 相同）

`executor`、`testCommand`、`review`、`isolated`、`timeoutMs`、`maxRetries`、`maxTurns`、`maxConcurrent`、`reviewRules`、`approval`、`git`、`notifications`（webhook/OTLP outbox）、`governance`（retention/redact）、`telemetry`、`ui.token` 等，见 cbx-orch 文档。

## 数据布局

任务数据默认存工作区 `.cbx/jobs/<job-id>/`（需求、状态、事件流、测试日志、diff、审查报告）+ `.cbx/state.sqlite`（WAL，队列/outbox/事件 seq 的权威存储）。

## 开发

```sh
npm install
npm run build        # tsc → lib/
npm run typecheck
```

### 冒烟测试

本地 profile（`$DSH_HOME/profiles/cbx`）已配置为 `[dsh-base, dsh-web-app, dsh-cbx-orch]`，可 `dsh --profile cbx --port 3180` 启动后访问 `/cbx/`。

## 许可

MIT。引擎部分移植自 [cbx-orch](https://github.com/zerosloney/cbx-orch)（MIT）。
