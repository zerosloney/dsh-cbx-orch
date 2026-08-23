/**
 * storage barrel —— 对外统一从 ./storage.js 导入（外部 import 不变）。
 *
 * 关注点已按模块拆分（依赖方向：io → config/context/locks → db → persist/meta/
 * events/outbox/prune/metrics/lease）：
 *   io.ts      —— 原子写 / JSON 读写 / 进程探测 / now / isMissing
 *   config.ts  —— .cbx.json 严格校验 + 凭据脱敏
 *   context.ts —— context.json schema 校验与读写
 *   locks.ts   —— 文件锁 / 队列锁 / 常量时间比较
 *   db.ts      —— SQLite 连接管理 + schema 迁移 + legacy 导入
 *   persist.ts —— 任务状态与队列的 SQLite 持久化（CAS / 终态双写 / 审批重入队）
 *   meta.ts    —— metadata 键值 + 事件 seq 分配
 *   events.ts  —— 事件表写入/查询（审计权威）+ verifyJobAudit
 *   outbox.ts  —— 投递 outbox（webhook/OTLP）+ 失败审计
 *   prune.ts   —— 保留期清理 + 孤儿目录回收 + peekQueueBlob
 *   metrics.ts —— 健康指标聚合
 *   lease.ts   —— 常驻调度器租约（跨进程互斥）
 */
export * from "./storage/io.js";
export * from "./storage/config.js";
export * from "./storage/context.js";
export * from "./storage/locks.js";
export * from "./storage/db.js";
export * from "./storage/persist.js";
export * from "./storage/meta.js";
export * from "./storage/events.js";
export * from "./storage/outbox.js";
export * from "./storage/prune.js";
export * from "./storage/metrics.js";
export * from "./storage/lease.js";
