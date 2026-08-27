#!/usr/bin/env bash
# 发布物冒烟：npm pack 产物完整性 + 从 tarball 安装并真实加载。
# 与 e2e.sh 的区别：依赖全部来自 npm registry（真实分发路径），插件本体来自
# pack 产物而非目录符号链接——验证 files 清单、lib 产物、native 依赖在消费者
# 环境可用。用法：bash smoke/pack.sh（或 npm run smoke:pack）
set -uo pipefail

# npm ≥11.7 EALLOWSCRIPTS：npm script 链会把 allow-scripts 配置透传为
# npm_config_allow_scripts 环境变量，嵌套的项目内 npm install 会直接报错。
# 显式清空该变量再装（门控仍生效：装完检测 binding，缺失走 approve+rebuild 兜底）。
npm_install() { env -u npm_config_allow_scripts npm install --no-audit --no-fund "$@"; }

CBX="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$CBX")"
RALPH="$ROOT/dsh-ralph-loop"
GRAPH="$ROOT/dsh-state-graph"
WORK="$(mktemp -d)"
PORT="${CBX_PACK_PORT:-3190}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/cbx-pack"
WS="$WORK/ws"
LOG="$WORK/dsh-pack.log"

PASS=0; FAIL=0
check() {
  local name="$1"; shift
  if "$@"; then echo "PASS  $name"; PASS=$((PASS+1)); else echo "FAIL  $name"; FAIL=$((FAIL+1)); fi
}
cleanup() {
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":$PORT" | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "${pid:-}" ] && taskkill //PID "$pid" //F >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== 1. 构建并打包 =="
for p in "$CBX" "$RALPH" "$GRAPH"; do
  if [ ! -d "$p" ]; then
    echo "FAIL  依赖兄弟仓库缺失：$p（三仓库并列布局，见 README「发布（本机发布）」节）"
    exit 1
  fi
  # 新 checkout 无 lib/（gitignored）：先 install+build 再 pack
  if [ ! -e "$p/lib/index.js" ]; then
    echo "      $(basename "$p") 未构建，install+build"
    (cd "$p" && npm_install >/dev/null 2>&1 && npm run build >/dev/null 2>&1) \
      || { echo "FAIL  $(basename "$p") 构建失败（$p）"; exit 1; }
  fi
  # tarball 名从 npm pack --json 动态解析（曾硬编码 0.1.0，版本升到 0.2+ 后失效）
  TGZ="$(cd "$p" && npm pack --pack-destination "$WORK" --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);process.stdout.write(a&&a[0]&&a[0].filename?a[0].filename:'')}catch{process.exit(1)}})")" \
    || { echo "FAIL  $(basename "$p") 打包失败（$p）"; exit 1; }
  [ -n "$TGZ" ] || { echo "FAIL  $(basename "$p") 打包无产物（$p）"; exit 1; }
  case "$p" in
    "$CBX")   CBX_TGZ="$WORK/$TGZ" ;;
    "$RALPH") RALPH_TGZ="$WORK/$TGZ" ;;
    "$GRAPH") GRAPH_TGZ="$WORK/$TGZ" ;;
  esac
  echo "      $(basename "$p") → $TGZ"
done
check "三个 tarball 生成" test -f "$CBX_TGZ" -a -f "$RALPH_TGZ" -a -f "$GRAPH_TGZ"

echo "== 2. tarball 内容完整性 =="
check "cbx: lib/cordis.patch.yml/ui 在包内" bash -c \
  "tar -tzf '$CBX_TGZ' | grep -q 'lib/index.js' && tar -tzf '$CBX_TGZ' | grep -q 'cordis.patch.yml' && tar -tzf '$CBX_TGZ' | grep -q 'ui/index.html'"
check "cbx: src/test/smoke 不进包" bash -c \
  "! tar -tzf '$CBX_TGZ' | grep -qE '(^|/)src/|(^|/)test/|(^|/)smoke/'"
check "ralph: lib/cordis.patch.yml 在包内" bash -c \
  "tar -tzf '$RALPH_TGZ' | grep -q 'lib/index.js' && tar -tzf '$RALPH_TGZ' | grep -q 'cordis.patch.yml'"
check "state-graph: lib/cordis.patch.yml 在包内" bash -c \
  "tar -tzf '$GRAPH_TGZ' | grep -q 'lib/index.js' && tar -tzf '$GRAPH_TGZ' | grep -q 'cordis.patch.yml'"

echo "== 3. 从 tarball 安装（依赖走 registry，真实分发路径） =="
mkdir -p "$PROFILE_DIR" "$WS"
WS_WIN="$(cygpath -m "$WS" 2>/dev/null || echo "$WS")"
CBX_TGZ_NPM="$(cygpath -m "$CBX_TGZ" 2>/dev/null || echo "$CBX_TGZ")"
RALPH_TGZ_NPM="$(cygpath -m "$RALPH_TGZ" 2>/dev/null || echo "$RALPH_TGZ")"
GRAPH_TGZ_NPM="$(cygpath -m "$GRAPH_TGZ" 2>/dev/null || echo "$GRAPH_TGZ")"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-cbx-pack",
  "private": true,
  "dependencies": {
    "dsh-cbx-orch": "file:$CBX_TGZ_NPM",
    "dsh-ralph-loop": "file:$RALPH_TGZ_NPM",
    "dsh-state-graph": "file:$GRAPH_TGZ_NPM"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cbx-orch", "dsh-ralph-loop", "dsh-state-graph"]
    }
  }
}
EOF
cat > "$PROFILE_DIR/cordis.patch.yml" <<EOF
# pack 冒烟临时 profile：允许临时工作区。
- id: cbx-orch-web
  config:
    web:
      workspaces:
        - '$WS_WIN'
EOF
rm -rf "$PROFILE_DIR/node_modules" "$PROFILE_DIR/package-lock.json"
if (cd "$PROFILE_DIR" && npm_install 2>&1 | tail -2); then
  PASS=$((PASS+1)); echo "PASS  tarball 安装"
else
  FAIL=$((FAIL+1)); echo "FAIL  tarball 安装"
fi
check "安装产物含三插件" bash -c "test -e '$PROFILE_DIR/node_modules/dsh-cbx-orch' -a -e '$PROFILE_DIR/node_modules/dsh-ralph-loop' -a -e '$PROFILE_DIR/node_modules/dsh-state-graph'"
# npm ≥11.6 的 install-scripts 门控会跳过 better-sqlite3 的 node-gyp 构建——依赖包
# 内声明的 allowScripts 不被认作覆盖（install-scripts ls 报 "not covered"）。
# 检测 binding 缺失并 approve+rebuild 兜底；这也向消费者示范了自救命令。
if [ -d "$PROFILE_DIR/node_modules/better-sqlite3" ] \
  && [ ! -e "$PROFILE_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  echo "      better-sqlite3 构建被门控跳过，执行 approve+rebuild 兜底"
  (cd "$PROFILE_DIR" \
    && { env -u npm_config_allow_scripts npm install-scripts approve better-sqlite3 >/dev/null 2>&1 || true; } \
    && env -u npm_config_allow_scripts npm rebuild better-sqlite3 2>&1 | tail -1)
fi
check "better-sqlite3 native binding 存在" test -e "$PROFILE_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

echo "== 4. 从 tarball 安装产物启动 =="
echo "dsh: $(command -v dsh || echo '未安装!') $(dsh --version 2>/dev/null || true)"
(cd "$WS" && dsh --profile cbx-pack --port "$PORT" > "$LOG" 2>&1 &)
for i in $(seq 1 30); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/cbx/" >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
check "tarball 安装的插件启动 /cbx/ 200" curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/cbx/"
# healthz → persistedMetrics → better-sqlite3 native binding：静态 200 证明不了
# native 模块在消费者环境可用，这一步才算真的验证了分发路径。
check "SQLite native binding 可用（healthz 指标）" bash -c "curl -s -m 5 \"http://127.0.0.1:$PORT/cbx/healthz\" | grep -q queueDepth"
check "启动日志无错误" bash -c "! grep -qiE 'error|unhandled|rejection|exception' \"$LOG\""
if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/cbx/"; then :; else
  echo "--- dsh 启动日志 ---"; cat "$LOG"
fi

echo ""
echo "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" = 0 ] && echo "PACK 冒烟全部通过" || { echo "--- 完整日志($LOG) ---"; cat "$LOG" 2>/dev/null; exit 1; }
