#!/usr/bin/env node
// 冒烟用的 mock 编码 CLI（Node 版）：让无真实执行器（codebuddy/opencode/...）的 CI
// runner 也能跑通任务生命周期（create → run → test → done / cancel）。
//
// 由 smoke/e2e.sh 以 CBX_CODEBUDDY=<abs>/codebuddy.mjs 注入（findExecutable 对 .mjs
// 会用 node 执行），因此在 Linux/Windows/git-bash 下都可靠，不依赖 PATH 或可执行位。
//
// 契约要点（对齐 stage-runner 的 snapshot-diff 守卫）：
//   - exit 0（执行器成功），不超时；
//   - 绝不修改 worktree——stage 完成后的 collectDiff 要求工作区与执行前一致，否则判
//     "执行器篡改工作区"而 stops。handback.md 由编排器写到 job 目录，不在 cwd。
//   - 以 cwd（=worktree）为基准模拟完成后的 stdout 流。
// 特殊标记（嵌在 prompt 里触发分支）：
//   - "__mock_hang__"：长时间占用，供取消路径验证树级终止。
//   - "__mock_fail__"：非零退出，供失败/重试路径验证。
const prompt = process.argv[process.argv.length - 1] ?? "";

if (prompt.includes("__mock_hang__")) {
  // 取消路径：睡够久，期望被 cbx cancel 终止子进程树。
  await new Promise(() => {}); // never resolves
  process.exit(0);
}

if (prompt.includes("__mock_fail__")) {
  console.error("mock: 刻意失败");
  process.exit(1);
}

process.stdout.write('{"type":"stream-json","isThinking":false}\n');
process.stdout.write("mock-codebuddy: completed\n");
process.exit(0);
