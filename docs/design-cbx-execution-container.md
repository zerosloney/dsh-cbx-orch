# CBX 执行后端接缝 + 容器运行时（`dsh-cbx-container-runtime`）设计文档

- 状态：待执行（已被本设计文档授权给另一个 coding agent 落地）
- 范围：两层改动 —— A) 在 `dsh-cbx-orch` 内新增公开 `ctx.cbx` API 与可插拔执行后端接缝；B) 新增独立插件包 `dsh-cbx-container-runtime` 提供“每个 isolated CBX job 一个容器”的默认非宿主后端。
- 依据：已核实的源码结论（见 §1）。

---

## 1. 背景与依据（已对源码核实）

1. **`ctx.cbx` 没有公开业务 API。** `CbxOrchestrator`（`dsh-cbx-orch/src/index.ts:47`）只有构造器 + 静态 Config；全类 grep `create|enqueue|status|cancel|continue|registerExecutionBackend` 无命中。其他插件无法通过 `ctx.cbx` 组合 CBX，只能调模型工具、`import` 未公开内部文件、或走 CBX 的 executor 文件插件机制。
2. **工具层直连内部函数。** `registerCbxTools`（`tools.ts:282`）注册 **21 个** `cbx_*` 工具（`tools.ts:297–778`），直接调用 `createJob`/`enqueueJob`/`cancelJobState`/`retryQueueJob` 等内部函数。注意：不是 codex 说的 17 个，是 21 个。
3. **执行接缝已集中。** 执行器/测试的宿主进程调用在 `runner.ts` 的 `invokeExecutor(...)`/`runProcess(...)`/`runShell(...)`/`validateTestCommand(...)`；队列与生命周期在 `queue-api.ts`（`enqueueJob`/`cancelJobState`/`retryQueueJob`/`dispatchQueue`/`health`/`acquireScheduler`…）；权威状态在 SQLite（`storage.ts`）。这些是后端接缝要挂载的真实点位。
4. **隔离执行缺口属实。** CBX 现在把 executor/test/git 子进程经 `ctx.subprocess`（`index.ts:77`）跑在宿主进程里，没有容器级隔离。上游 deepseek-harness 已有 `ctx.sandbox`（OS 进程沙箱 bwrap/landlock/seatbelt/Windows-ACL）、`ctx.codeRuntime`（worker-thread 代码沙箱）、`ctx.subprocess`、`ctx.workflowEngine`、`@deepseek-ai/dsh-tool-ralph`、`@deepseek-ai/dsh-e2b`（云端）——**但没有本地 Docker/Podman 容器 runtime**。因此容器 runtime 不是重复发明，而是隔离谱系里缺失的那一格。
5. **不在范围的重叠项**：上游已有 `ctx.workflowEngine` + `dsh-tool-ralph`，故**不做**任何“新的通用状态机/workflow 编排器”，也**不扩散**本地 `dsh-ralph-loop` 的 Ralph 叙事。

---

## 2. 目标与非目标

### 目标
- 让 `ctx.cbx` 成为真正的可组合服务，公开稳定的创建/入队/状态/取消/续跑/注册后端 API。
- 引入 `CbxExecutionBackend` / `CbxExecutionWorld` 抽象，执行（agent 编码 = executor）、测试（test）、审查（review）均可选择后端。
- `dsh-cbx-container-runtime`：一个 isolated CBX job 一个容器，executor/test/review 全程跑在容器内；宿主继续负责 SQLite、队列、审批、Git 快照。
- 保持向后兼容：默认 `host` 后端行为与现在完全一致（无行为回归），容器后端为显式 opt-in。

### 非目标（v1 明确不做）
- 不做全 DSH 的通用远程 execution world（只做 CBX 的容器后端）。
- 不做 Windows Docker Desktop（v1 仅 Linux Docker/Podman；Windows 留 v2）。
- 不做 `ctx.subagents` Provider 包装 CBX 执行器（alignment.md §4.3 已明确保留边界）。
- 不做新的 workflow/state-graph 编排器（上游已有）。
- 不把容器后端设为默认或静默回退宿主。

---

## 3. 架构总览

```
宿主（Host）
├── ctx.cbx（dsh-cbx-orch）：公开 API + 后端注册表 + host 后端
│     ├── create / enqueue / status / cancel / continue / result / artifacts / list
│     └── registerExecutionBackend(name, backend)  → 按 job 选择后端
├── CBX 队列/SQLite/审批/Git 基线（不变）
└── 执行后端（可插拔）
      ├── host（默认，现状）                 → ctx.subprocess 直跑宿主进程
      └── container（dsh-cbx-container-runtime）→ 每个 isolated job 一个 Docker/Podman 容器
```

选后端规则（优先级从高到低）：
1. job 创建参数 `execution.backend`（tools 参数 / `ctx.cbx.create` options）；
2. 工作区 `.cbx.json` 的 `execution.backend`；
3. 默认 `host`。

容器后端只对 `isolated: true` 的 job 生效；`isolated: false` 的任务若指定 container 后端，创建期**拒绝**并给出清晰错误。

---

## 4. 层 A：`ctx.cbx` 公开 API 与后端接缝（改 `dsh-cbx-orch`）

### 4.1 接口签名（新增到核心包，类型放 `src/types.ts` 或新建 `src/execution-backend.ts`）

```ts
/** 一次可执行（agent 编码 / 测试 / 审查）的进程结果，对齐现有 ProcessResult。 */
export interface ProcessResult {
  code: number;
  timedOut: boolean;
  // 可选：调用方把输出写到 host 侧 job 目录的日志文件，shape 由实现决定
}

/** 已准备好的执行 world：固定代表一个 job 的执行环境（默认 = 宿主进程；container 后端 = 一个容器）。 */
export interface CbxExecutionWorld {
  /** 挂载/准备 job 需要的产物（git worktree、artifact、context pack）与运行时校验。 */
  prepare(): Promise<void>;
  /** 在 world 内运行一次 executor（编码 agent），语义对齐 runner.ts invokeExecutor。 */
  runAgent(request: import("./types.js").ExecutorRunRequest): Promise<ProcessResult>;
  /** 在 world 内运行测试命令，语义对齐 runner.ts validateTestCommand + runShell。 */
  runTest(command: string, cwd: string, timeoutMs: number): Promise<ProcessResult>;
  /** 释放 world：kill 容器并确认整棵进程树完全退出。以幂等、可重入实现。 */
  dispose(): Promise<void>;
}

/** 后端工厂：按 job 上下文创建一个执行 world。 */
export interface CbxExecutionBackend {
  readonly name: string;
  /** 校验可用性；不可用必须 throw（fail-fast），禁止静默降级。 */
  available(job: CbxExecutionJobContext): Promise<boolean>;
  createWorld(job: CbxExecutionJobContext, options: CbxExecutionOptions): Promise<CbxExecutionWorld>;
}

/** 传给可插拔后端的 job 最小上下文（宿主对象，非悬浮数据）。 */
export interface CbxExecutionJobContext {
  workspace: string;
  jobId: string;
  directory: string;     // jobDir(workspace, jobId)
  workdir: string;       // git worktree 路径（isolated）或工作区路径
  isolated: boolean;
  keepWorktree: boolean;
  artifactsDir?: string;
  envAllowlist?: readonly string[]; // 显式凭据白名单
}
```

### 4.2 `ctx.cbx` 公开方法（映射到既有内部实现，行为不变）

在 `CbxOrchestrator` 上以实例方法暴露（`index.ts`），内部委托既有模块：

| ctx.cbx 方法 | 委托实现 | 说明 |
|---|---|---|
| `create(options)` | `createJob`（`jobs.ts:48`）| 校验+建 job，返回 `{ jobId, directory }` |
| `enqueue(workspace, jobId, extra?, priority?)` | `enqueueJob`（`queue-api.ts:227`）| 入队并 `ensureScheduler` |
| `status(workspace, jobId)` | `loadState`（`state.ts`）→ 只读快照 | 返回结构化最小 JobState |
| `cancel(workspace, jobId)` | `cancelJobState`（`queue-api.ts:266`）| 原子标记 cancelled + 终止 world |
| `continue(workspace, jobId, extra?)` / `retry(...)` | `retryQueueJob`（`queue-api.ts:279`）| 续跑/重试 |
| `dispatch(workspace)` | `dispatchQueue`（`queue-api.ts:197`）| 派发队列 |
| `health(workspace, opts)` / `queue(workspace)` | `health` / `listQueue`（`queue-api.ts:203/246`）| 只读探针 |
| `subscribe(cb)` | 内部 `publishEvent` 的钩子（`observability.ts`）| 订阅 `job.state_changed` 等，`cbx/*` 事件 |
| `registerExecutionBackend(backend)` | 新增的注册表 | 注册 CbxExecutionBackend |
| `backend(name)` | 新增的注册表 | 按名取后端；预注册 `host` |

要点：
- `subscribe` 用 `ctx.on("cbx/job.state_changed", cb)` 之类，不足时在 `observability.ts` 暴露 on 订阅入口；**不要序列化整个对象**，只透传最小载荷（status/phase/attempt/jobId）。
- 工具层（`tools.ts`）**逐步改为调用 `ctx.cbx` 公开方法**，而不是直连内部函数——但这是纯内部重构，行为必须零回归。至少 `ctx.cbx` 的测试直接覆盖公开方法，工具层迁移可在 Phase 3 完成。

### 4.3 后端接入执行流程（关键：最小侵入）

执行仍由宿主编排（`execution.ts:executeJobLocked` + `stage-runner.ts`），但“在哪个 world 里跑 executor / 跑 test / 跑 review”改为经后端解析：

1. worker 开始执行某 job。
2. `backend = registry.resolve(job)`（默认 `host`）；若为 container 且 `!job.isolated` → throw（fail-fast）。
3. `world = await backend.createWorld(jobCtx, opts)`；失败 → job fail + 原因。
4. `await world.prepare()`。
5. executor 阶段：以 `world.runAgent(...)` 替换 `runner.ts::invokeExecutor` 的宿主 spawn 路径（容器后端在容器内 spawn executor CLI）。
6. test 阶段：以 `world.runTest(validatedCmd, cwd, timeoutMs)` 替换 `runner.ts` 的 host `runShell`。
7. review 阶段：复用 `world.runAgent`（同一容器、同一 world）。
8. `await world.dispose()`（无论成败，走 `finally`）；宿主写结果/证据/state 到 SQLite 不变。

保持 `host` 后端即现状：`CbxExecutionWorld` 的 host 实现内部就是现有的 `ctx.subprocess` 直跑——因此默认路径零回归。

---

## 5. 层 B：`dsh-cbx-container-runtime`（新插件包，独立 git repo）

新目录 `D:\Code\dsh-plugins\dsh-cbx-container-runtime`（与既有插件同构：有自己的 `package.json`/`tsconfig.json`/`src/`/`tests/`，`name: "dsh-cbx-container-runtime"`）。

### 5.1 职责
- 实现 `CbxExecutionBackend`（`name: "container"`），在 `ctx.cbx` 并未运行时也可以独立存在，但**通常**与 `dsh-cbx-orch` 一起挂载。
- 仅在插件挂载且配置启用时向 `ctx.cbx.registerExecutionBackend(...)` 注册。
- 只处理 `isolated: true` 的 job；`isolated: false` → 创建期拒绝。

### 5.2 运行时检测（fail-fast，绝不静默回退）
- 挂载时检测 `docker`（或 `podman`）CLI：`docker version` / `podman version`，并确认 daemon 可达。
- 检测不到 → 插件报错、**不注册** container 后端；job 若指定 container 后端 → 创建期明确报错（`E_BACKEND_UNAVAILABLE`），**禁止回退宿主**。

### 5.3 每 job 一个容器
- 容器实例化：`docker run`（`--rm`-style 由 dispose 处理；配 `--name cbx-<jobId>`）。
- 挂载（`--mount`/`-v`）：
  - git worktree 目录 → 容器内固定挂载点（如 `/work`）；
  - job `artifactsDir`/context pack → `/artifacts`；
  - 宿主与容器保持**只写作业产物**、不直接暴露宿主文件系统其余部分。
- executor/test/review 全部在**同一容器**内顺序执行（同一 world）。
- 宿主侧 `ctx.cbx` 仍在 SQLite/队列/审批/Git 快照上工作；容器只承载“执行 + 测试 + 审查”这条受信任度最低的路径。

### 5.4 容器加固（默认）
- `--network none`（默认禁网；需要网络的 job 显式 opt-in，v1 暂不提供或提供白名单）。
- 非 root 用户（`--user` uid:gid，或镜像内固定非 root）。
- 只读根文件系统（`--read-only` + 仅 `/work`、`/artifacts`、`/tmp` 可写）。
- 资源限额：`--cpus`、`--memory`、`--pids-limit`、磁盘（`--storage-opt size=` 视 runtime 支持，至少限定 workdir 卷配额或文档声明）。
- 超时：`--stop-timeout` 与宿主 per-job `timeoutMs` 双层兜底。
- 凭据：**不继承宿主环境**，显式经 `--env`/`--env-file` 传入 `envAllowlist` 所列变量；未列入的宿主环境一律不进容器。

### 5.5 取消与确定性回收
- 取消：宿主先写 `cancel.requested`（复用现有机制），随后 `docker stop`（宽限）→ `docker kill --signal=KILL` → `docker rm`。
- 回收确认：`docker inspect` 确认容器退出/移除；可配合 `--cidfile` 记录容器 id，dispose 幂等重入。
- 与 `ctx.subprocess` 关系：容器内若无宿主子进程，则容器自身即进程树边界；docker CLI 本身可经 `ctx.subprocess` spawn（获得 tree-scoped 终止）。**不要**在容器里再造一套进程管理，容器即边界。

### 5.6 配置（`.cbx.json` 扩展）
```jsonc
{
  "execution": {
    "backend": "container",        // 或 "host"
    "container": {
      "image": "node:22-bookworm",
      "runtime": "docker",          // docker | podman
      "network": "none",            // v1 仅 none
      "cpus": 2,
      "memory": "4g",
      "pidsLimit": 256,
      "user": "1000:1000",
      "readonlyRootfs": true,
      "envAllowlist": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
    }
  }
}
```
- `loadConfig`（`state.ts`）需扩展读取 `execution.container`，但要 `ctx` 注入读取器（alignment.md §4.1）。
- 未配置 `container` 段 → 使用默认容器镜像/限额；未配置 `execution.backend` → 默认 `host`。

---

## 6. 数据流（容器后端的一轮 job）

```
ctx.cbx.create({ isolated:true, executionBackend:'container', ... })
  → createJob 校验（git/基线/权限/test 命令）+ job 落 SQLite
  → ctx.cbx.enqueue → dispatchQueue → worker 取任务
  → registry.resolve → container backend
      backend.available(ctx) ? 否则 fail-fast(E_BACKEND_UNAVAILABLE)
  → world = createWorld(...) ; world.prepare()   // 启动容器、挂载 worktree/artifacts
  → world.runAgent(executor prompt)              // 容器内编码 CLI
  → world.runTest(validated test command)        // 容器内测试
  → (review 开关) world.runAgent(review prompt)  // 同一容器内独立审查
  → world.dispose()  // 确定性回收容器（幂等）
  → 宿主写结果/证据 → SQLite/队列终态
```

---

## 7. 错误与降级策略

| 场景 | 行为 |
|---|---|
| 无 docker/podman 或 daemon 不可达 | 挂载时不注册；job 指定 container → 创建期报 `E_BACKEND_UNAVAILABLE`，**拒绝**，绝不回退宿主 |
| `isolated:false` + container 后端 | 创建期拒绝（`E_BACKEND_ISOLATION_REQUIRED`） |
| 容器启动失败 | job fail + 原因；`dispose` 兜底回收半启动容器 |
| executor/test 超时 | 容器层 `--stop-timeout` + 宿主 `timeoutMs` 双保险；kill 容器并确认树退出 |
| 取消 | 写取消标记 → docker stop/kill/rm → inspect 确认 |
| workflowEngine 不可用（无关）| 不处理，与本设计解耦 |

---

## 8. 安全模型
- 信任边界：宿主（受信）↔ 容器（非受信）。容器内可执行编码 CLI，但默认禁网、非 root、只读 rootfs、资源限额，故其破坏面被限制在 `/work`/`/artifacts`。
- 凭据最小化：仅 `envAllowlist` 显式变量进容器；绝不继承宿主完整环境。
- 审计：容器生命周期事件（start/run/test/review/dispose）写入 `events.ndjson`（复用 `runner.ts` 的事件写法与脱敏）。

---

## 9. 测试策略

> **重要现状**：`dsh-cbx-orch` 当前工作树**没有任何测试文件**（`src/` 无 spec、无 `tests/` 目录，`git status` 干净）。codex 所称“124 个 CBX 测试”在当前树不存在。因此执行 agent 必须**补写测试**，不能假设已有测试覆盖。

### 单元（无 Docker 也可跑）
- `ctx.cbx` 公开方法存在且委托到正确内部函数（构造后 `instanceof`/方法存在断言；用 stub 后端断言 `runAgent`/`runTest` 被调用）。
- 后端注册表：`registerExecutionBackend`/`backend`/默认 `host`；重复注册/未知名处理。
- `isolated:false` + container → 拒绝逻辑。
- host 后端 world 的 `prepare`/`runAgent`/`runTest`/`dispose` 行为与现状等价（最小冒烟）。

### 集成（`docker` 可用才跑，否则 skip）
- 真实容器端到端：创建一个 isolated job → 容器启动 → 容器内跑一条无害 test → dispose → inspect 确认容器已移除。
- 取消路径：取消时容器被 kill 且 confirm 退出（`docker inspect` 不存在/Exited）。
- 加固断言：`--network none`、非 root uid、`--read-only`（尽力而为/条件跳过）。

### 回归
- `npm run build` 必须通过（类型检查）；`node --test` 跑新增的 cbx-orch 测试。
- 默认 `host` 行为零回归（现有工具/命令冒烟）。

---

## 10. 兼容与迁移
- 新增公开 API 与方法均为**纯增量**，不改既有函数签名、不改 `.cbx.json` 既有字段语义、不改 SQLite schema（除非需要持久化 `executionBackend` 选择，才加一个可选列——v1 建议放 `context.json` job 上下文里，避免 schema 迁移）。
- `tools.ts` 迁移到 `ctx.cbx`：内部重构，不改变 21 个工具的名称/参数/返回值。
- 容器后端 opt-in，未配置即 `host`，部署无感知。

---

## 11. 里程碑
- **Phase 1（dsh-cbx-orch）**：新增 `CbxExecutionBackend`/`CbxExecutionWorld`/注册表；`ctx.cbx` 公开 `create/enqueue/status/cancel/continue/result/artifacts/dispatch/health/queue/subscribe/registerExecutionBackend/backend`；预注册并实现 `host` 后端（现状等价）；工具层可选迁移。**测试**：ctx.cbx API 与注册表单测。验收：`npm run build` 通过、默认行为零回归。
- **Phase 2（dsh-cbx-container-runtime 新包）**：容器后端实现——检测 fail-fast、挂载、隔离加固、dispose/取消回收、配置读取（`.cbx.json` extension + `loadConfig` 注入读取器）。**测试**：Docker 可用时的集成测试。
- **Phase 3**：联调 + 文档（README、更新 `alignment.md` 把“容器 runtime”标为已实施）+ 端到端验证 + 补回 cbx-orch 基础测试。

---

## 12. 验收标准
1. `ctx.cbx` 实例暴露 §4.2 全部方法；有测试断言方法存在且委托正确。
2. `registerExecutionBackend` 能把一个 fake 后端接进执行路径（测试证明 `runAgent`/`runTest` 被该 fake 调用）。
3. 无 docker 时指定 container 后端 → fail-fast 报 `E_BACKEND_UNAVAILABLE`，无静默回退。
4. 有 docker 时，`isolated:true` + container 后端可端到端跑通一个 job（容器内 executor→test→review→dispose），dispose 后 `docker inspect` 确认容器已移除。
5. 默认（未配置 backend）= `host`，行为与改动前一致；`npm run build` 通过。
6. 新增测试在 `dsh-cbx-orch` 与 `dsh-cbx-container-runtime` 两处均通过（Docker 相关按可用性 skip）。

---

## 13. 本设计文档给执行 agent 的任务边界（交付范围）

在 `D:\Code\dsh-plugins\dsh-cbx-orch`（Phase 1/3 的 dsh-cbx-orch 部分）与新建 `D:\Code\dsh-plugins\dsh-cbx-container-runtime`（Phase 2）落地。实现以本文档为准，重点：
- 先做 Phase 1 并保证默认 host 零回归；再 Phase 2 新包；最后 Phase 3 联调与测试补齐。
- **必须补测试**（当前仓库无测试文件），并按 §9 分单元/集成。
- 有 Docker 就验证容器路径；没有就保持集成测试可 skip、并确保 fail-fast 路径有单测。
- 保持现有 `npm run build && node --test` 可过；两处仓库都要过。
