#!/usr/bin/env bash
# dsh-cbx-orch 端到端冒烟：把手工验证固化为可重复脚本。
# 前置：无——profile 不存在时自动创建（CI 可直接跑）。
# 环境变量：CBX_SMOKE_PORT（默认 3180）、CBX_SMOKE_SKIP_JOB=1（跳过任务生命周期
# 一节，用于无执行器 CLI 的环境，如 CI runner）。
# 用法：npm run smoke:e2e   （或 bash smoke/e2e.sh）
set -u

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_WS="$PLUGIN_DIR/.smoke-ws"
WS_ENC="$(cygpath -m "$SMOKE_WS" 2>/dev/null || echo "$SMOKE_WS")"
PLUGIN_WIN="$(cygpath -m "$PLUGIN_DIR" 2>/dev/null || echo "$PLUGIN_DIR")"
PORT="${CBX_SMOKE_PORT:-3180}"
BASE="http://127.0.0.1:$PORT"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/cbx"
LOG="$SMOKE_WS/dsh-smoke.log"
COOKIE="$(mktemp)"
SSE_OUT="$(mktemp)"

PASS=0; FAIL=0
check() { # name condition...
  local name="$1"; shift
  if "$@"; then echo "PASS  $name"; PASS=$((PASS+1)); else echo "FAIL  $name"; FAIL=$((FAIL+1)); fi
}
# 插件源目录缺 lib/（gitignored、新 checkout）时先 install+build——
# profile 的 file: 目录引用需要构建产物存在。
ensure_built() {
  [ -e "$1/lib/index.js" ] && return 0
  echo "      $(basename "$1") 未构建，install+build"
  (cd "$1" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1) \
    && [ -e "$1/lib/index.js" ]
}
cleanup() {
  local pid
  for p in "$PORT" "$((PORT + 1))"; do
    pid=$(netstat -ano 2>/dev/null | grep ":$p" | grep LISTENING | awk '{print $5}' | head -1)
    [ -n "${pid:-}" ] && taskkill //PID "$pid" //F >/dev/null 2>&1
  done
  rm -f "$COOKIE" "$SSE_OUT"
}
trap cleanup EXIT

echo "== 1. 前置检查（profile 不存在则自动创建，CI 可直接跑） =="
ensure_built "$PLUGIN_DIR" || { echo "FAIL  插件构建失败"; exit 1; }
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  mkdir -p "$PROFILE_DIR"
  cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-cbx",
  "private": true,
  "dependencies": {
    "dsh-cbx-orch": "file:$PLUGIN_WIN"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cbx-orch"]
    }
  }
}
EOF
  cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# 自动生成的冒烟 profile patch：允许冒烟工作区。
- id: cbx-orch-web
  config:
    web:
      workspaces:
        - '$WS_ENC'
EOF
  echo "已创建 profile $PROFILE_DIR"
fi
(cd "$PROFILE_DIR" && npm install --no-audit --no-fund 2>&1 | tail -1)
check "profile 依赖就绪" test -e "$PROFILE_DIR/node_modules/dsh-cbx-orch"
check "冒烟工作区存在" test -e "$SMOKE_WS"
mkdir -p "$SMOKE_WS"
cd "$SMOKE_WS" || exit 2
if [ ! -d .git ]; then
  git init -q && git config user.email smoke@t && git config user.name smoke
  printf 'hello\n' > README.md
fi
printf 'dsh-smoke.log\n.cbx/\n' > .gitignore
git add -A 2>/dev/null; git commit -qm "smoke init" 2>/dev/null
check "工作区是干净 git 仓库" bash -c "[ -z \"\$(git status --porcelain --untracked-files=all -- . ':(exclude).cbx' ':(exclude).cbx/**')\" ]"

echo "== 2. 启动 dsh =="
echo "dsh: $(command -v dsh || echo '未安装!') $(dsh --version 2>/dev/null || true)"
(dsh --profile cbx --port "$PORT" > "$LOG" 2>&1 &)
for i in $(seq 1 30); do
  curl -s -o /dev/null -m 1 "$BASE/cbx/" && break
  sleep 1
done
check "服务启动 /cbx/ 200" curl -s -o /dev/null -m 2 "$BASE/cbx/"
curl -s -o /dev/null -m 2 "$BASE/cbx/" || { echo "--- dsh 启动日志 ---"; cat "$LOG"; }

echo "== 3. 静态面 =="
check "/cbx → 301 到 /cbx/" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' \"$BASE/cbx\")\" = 301 ]"
check "/cbx/ 带 CSP" bash -c "curl -s -D - \"$BASE/cbx/\" -o /dev/null | grep -qi 'content-security-policy: default-src'"
check "style.css 200" curl -s -o /dev/null -m 2 "$BASE/cbx/style.css"
check "app.js 200" curl -s -o /dev/null -m 2 "$BASE/cbx/app.js"
check "healthz 只读指标" bash -c "curl -s \"$BASE/cbx/healthz\" | grep -q 'queueDepth'"
check "数据端点无 token 401" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' \"$BASE/cbx/api/jobs\")\" = 401 ]"

echo "== 4. 鉴权流 =="
TOKEN=""
[ -f .cbx/web.token ] && TOKEN=$(cat .cbx/web.token)
if [ -z "$TOKEN" ]; then echo "FAIL  未生成 web.token"; FAIL=$((FAIL+1)); else PASS=$((PASS+1)); echo "PASS  web.token 已生成"; fi
check "错误 token 401" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST \"$BASE/cbx/auth\" -H 'content-type: application/json' -d '{\"token\":\"wrong\"}')\" = 401 ]"
check "正确 token 换 cookie" bash -c "curl -s -c \"$COOKIE\" -X POST \"$BASE/cbx/auth\" -H 'content-type: application/json' -d \"{\\\"token\\\":\\\"$TOKEN\\\"}\" | grep -q ok"
check "cookie 访问数据端点 200" bash -c "[ \"\$(curl -s -b \"$COOKIE\" -o /dev/null -w '%{http_code}' \"$BASE/cbx/api/jobs\")\" = 200 ]"

echo "== 5. SSE =="
check "events?token= 已拒(401)" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' \"$BASE/cbx/events?token=x\")\" = 401 ]"
( curl -s -N -b "$COOKIE" "$BASE/cbx/events" > "$SSE_OUT" 2>&1 & )
sleep 2
check "cookie 连接收到 connected" bash -c "grep -q '\"type\":\"connected\"' \"$SSE_OUT\""

echo "== 6. 任务生命周期 =="
if [ "${CBX_SMOKE_SKIP_JOB:-0}" = "1" ]; then
  echo "SKIP  （CBX_SMOKE_SKIP_JOB=1：无执行器 CLI 的环境跳过本节）"
else
JOB=$(curl -s -b "$COOKIE" -X POST "$BASE/cbx/api/jobs?workspace=$WS_ENC" \
  -H 'content-type: application/json' \
  -d '{"task":"e2e smoke","review":false,"isolated":true,"test_command":"echo smoke-done","timeout_ms":20000,"max_retries":0}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
check "任务创建返回 job_id" test -n "$JOB"
RAN=0
for i in $(seq 1 8); do
  ST=$(curl -s -b "$COOKIE" "$BASE/cbx/api/jobs/$JOB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  if [ "$ST" = "running" ]; then RAN=1; break; fi
  sleep 1
done
check "任务进入 running(调度器+worker 生效)" test "$RAN" = 1
curl -s -b "$COOKIE" -X POST "$BASE/cbx/api/jobs/$JOB/cancel" > /dev/null
sleep 3
FINAL=$(curl -s -b "$COOKIE" "$BASE/cbx/api/jobs/$JOB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
check "取消后终态 cancelled" test "$FINAL" = "cancelled"
check "事件流已落盘" test -s ".cbx/jobs/$JOB/events.ndjson"
check "worktree 容器已清理" bash -c "[ ! -d \"$PLUGIN_DIR/..smoke-ws.cbx-worktrees\" ]"
check "取消无 cleanup_failed 噪音" bash -c "! grep -q cleanup_failed .cbx/jobs/$JOB/events.ndjson"
fi

echo "== 7. 三插件合体加载（cbx + ralph + state-graph 同场） =="
ALL3_PROFILE="$PROFILE_DIR-all"
RALPH_DIR="$(dirname "$PLUGIN_DIR")/dsh-ralph-loop"
GRAPH_DIR="$(dirname "$PLUGIN_DIR")/dsh-state-graph"
ensure_built "$RALPH_DIR" || echo "WARN  ralph 未构建，跳过其构建检查"
ensure_built "$GRAPH_DIR" || echo "WARN  state-graph 未构建，跳过其构建检查"
# npm 的 file: 依赖在 Windows 上必须用盘符路径（POSIX /d/... 会被解析成 /c/d/... 悬空链接）
CBX_WIN="$(cygpath -m "$PLUGIN_DIR" 2>/dev/null || echo "$PLUGIN_DIR")"
RALPH_WIN="$(cygpath -m "$RALPH_DIR" 2>/dev/null || echo "$RALPH_DIR")"
GRAPH_WIN="$(cygpath -m "$GRAPH_DIR" 2>/dev/null || echo "$GRAPH_DIR")"
PORT2=$((PORT + 1))
LOG_ALL="$SMOKE_WS/dsh-all3.log"
mkdir -p "$ALL3_PROFILE"
cat > "$ALL3_PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-cbx-all",
  "private": true,
  "dependencies": {
    "dsh-cbx-orch": "file:$CBX_WIN",
    "dsh-ralph-loop": "file:$RALPH_WIN",
    "dsh-state-graph": "file:$GRAPH_WIN"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cbx-orch", "dsh-ralph-loop", "dsh-state-graph"]
    }
  }
}
EOF
rm -rf "$ALL3_PROFILE/node_modules" "$ALL3_PROFILE/package-lock.json"
(cd "$ALL3_PROFILE" && npm install --no-audit --no-fund 2>&1 | tail -2)
if [ ! -e "$ALL3_PROFILE/node_modules/dsh-cbx-orch" ]; then
  echo "FAIL  合体 profile 依赖安装失败"; FAIL=$((FAIL+1))
else
  PASS=$((PASS+1)); echo "PASS  合体 profile 依赖就绪"
fi
(cd "$SMOKE_WS" && dsh --profile cbx-all --port "$PORT2" > "$LOG_ALL" 2>&1 &)
for i in $(seq 1 30); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT2/cbx/" >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
check "合体 profile 启动 /cbx/ 200" curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT2/cbx/"
check "合体启动日志无错误" bash -c "! grep -qiE 'error|unhandled|rejection|exception' \"$LOG_ALL\""

echo ""
echo "结果: $PASS 通过 / $FAIL 失败"
if [ "$FAIL" != 0 ]; then
  echo "--- dsh 主日志($LOG) ---"; cat "$LOG" 2>/dev/null
  echo "--- 合体日志($LOG_ALL) ---"; cat "$LOG_ALL" 2>/dev/null
  exit 1
fi
echo "E2E 全部通过"
