#!/usr/bin/env bash
# 本机发布：替代已删除的 GitHub Actions 发布 workflow（.github/workflows/publish.yml）。
# 在开发者机器上完成 前置检查 → 升版/打标签 → lint+单测+构建 → 发布物冒烟 → npm publish，
# 不再依赖 v* tag 触发与 NPM_TOKEN（ci.yml 保留，仅跑测试/冒烟）。
#
# 用法（仓库根目录）：
#   npm run release                # 以当前 package.json 版本发布（不升版）
#   npm run release -- patch       # 先升 patch 版本再发布（minor / major 同理）
#
# 前置：
#   - Node >= 22（package.json engines.node）；bash（git-bash / WSL / macOS / Linux）
#   - 已登录 npm：npm whoami 通过（registry 以本机 npm 配置为准，可 .npmrc 指向私有源）
#   - 发布物冒烟（smoke:pack）依赖兄弟仓库并列布局：../dsh-ralph-loop、../dsh-state-graph，
#     缺失时该节跳过并提醒，可事后单独 npm run smoke:pack 验证
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION_ARG="${1:-}"
NEW_VERSION="$(node -p "require('./package.json').version")"
# 发布 registry：默认取本机 npm config；镜像/私有源机器上要发 npmjs 时用
# NPM_PUBLISH_REGISTRY=https://registry.npmjs.org npm run release 覆盖
PUBLISH_REGISTRY="${NPM_PUBLISH_REGISTRY:-$(npm config get registry)}"

step() { echo; echo "== $1 =="; }

step "0. 前置检查（本机发布）"
if [ "$(node -p "Number(process.versions.node.split('.')[0]) >= 22")" != "true" ]; then
  echo "FAIL  需要 Node >= 22（当前 $(node -v)）"
  exit 1
fi
if ! npm whoami --registry "$PUBLISH_REGISTRY" >/dev/null 2>&1; then
  echo "FAIL  未登录 npm（npm whoami 失败）。当前 registry: $PUBLISH_REGISTRY（可用 NPM_PUBLISH_REGISTRY 覆盖）"
  echo "      请先 npm login；或配置 .npmrc 指向私有 registry 后再试。"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "提醒  工作区有未提交改动（$(git status --porcelain | wc -l | tr -d ' ') 项）——建议先提交再发布"
fi
if [ ! -d "$ROOT/../dsh-ralph-loop" ] || [ ! -d "$ROOT/../dsh-state-graph" ]; then
  echo "提醒  兄弟仓库缺失（../dsh-ralph-loop / ../dsh-state-graph）——发布物冒烟将跳过"
  echo "      补齐并列布局后可用 npm run smoke:pack 单独验证发布物"
fi

if [ -n "$VERSION_ARG" ]; then
  case "$VERSION_ARG" in
    patch|minor|major) ;;
    *)
      echo "FAIL  版本参数须为 patch / minor / major（收到: $VERSION_ARG）"
      exit 1
      ;;
  esac
  step "1. 升版（npm version $VERSION_ARG；preversion 钩子自动跑 npm run check）"
  npm version "$VERSION_ARG" --no-git-tag-version
  NEW_VERSION="$(node -p "require('./package.json').version")"
  git add package.json package-lock.json
  if git diff --cached --quiet; then
    echo "提醒  无版本变更可提交"
  else
    git commit -qm "chore: 升版 $NEW_VERSION（本机发布）"
    echo "已提交版本变更"
  fi
  if git tag "v$NEW_VERSION" 2>/dev/null; then
    echo "已打标签 v$NEW_VERSION"
  else
    echo "提醒  标签 v$NEW_VERSION 已存在（沿用）"
  fi
else
  step "1. 不升版（以当前版本 $NEW_VERSION 发布）"
fi

step "2. 检查（lint + 构建 + 单测）"
npm run check

step "3. 发布物冒烟（npm pack → tarball 安装 → better-sqlite3 native binding 验证）"
if [ -d "$ROOT/../dsh-ralph-loop" ] && [ -d "$ROOT/../dsh-state-graph" ]; then
  npm run smoke:pack
else
  echo "跳过（兄弟仓库缺失，见第 0 步提醒）"
fi

step "4. 发布到 npm（registry: $PUBLISH_REGISTRY）"
# prepublishOnly 钩子会再跑一遍 npm run check，裸 npm publish 同样被守卫
npm publish --registry "$PUBLISH_REGISTRY"

step "5. 收尾"
echo "已发布 dsh-cbx-orch@$NEW_VERSION（本机发布完成）"
echo "本地已打标签 v$NEW_VERSION；如需同步远程：git push origin HEAD --tags"
