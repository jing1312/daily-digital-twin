#!/usr/bin/env bash
# CLI 冒烟测试：验证的是单元测试覆盖不到的东西 —— 真实进程、真实文件系统、真实退出码。
# 关注三件在本机翻过车的事：
#   1. 没配置 DAILY_TWIN_HOME 时必须失败退出，绝不允许退回仓库目录（B13b / B14）
#   2. init / create / status 必须落在同一个数据库里（B13b）
#   3. 调度器必须默认休眠，需要人手动启用
set -euo pipefail

NODE_FLAGS=(--disable-warning=ExperimentalWarning)
RUNTIME=(node "${NODE_FLAGS[@]}" src/runtime.mjs)
WORK="${RUNNER_TEMP:-/tmp}/daily-twin-smoke-$$"
PRIVATE_HOME="$WORK/home"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

# 中文注释：确保环境里没有残留的 home 变量，否则第一项检查会失去意义。
unset DAILY_TWIN_HOME || true

echo "--- 1. 没有私有目录时必须失败退出 ---"
if "${RUNTIME[@]}" status > "$WORK/no-home.json" 2>&1; then
  echo "FAIL：没有配置私有目录却成功返回，兜底逻辑又回来了"
  cat "$WORK/no-home.json"
  exit 1
fi
grep -q home_not_configured "$WORK/no-home.json"
echo "ok   报错码是 home_not_configured"
test ! -d runtime
test ! -e data/runtime.sqlite
echo "ok   仓库目录里没有生成 runtime/ 或数据库"

echo "--- 2. init 之后 create / status 共用同一个数据库 ---"
"${RUNTIME[@]}" init --home "$PRIVATE_HOME" > "$WORK/init.json"
grep -q '"configWritten": true' "$WORK/init.json"
for directory in data/tasks data/receipts data/screenshots data/cache data/logs config backups; do
  test -d "$PRIVATE_HOME/$directory" || { echo "FAIL：缺少目录 $directory"; exit 1; }
done
echo "ok   7 个私有子目录都建好了"

"${RUNTIME[@]}" create --home "$PRIVATE_HOME" '打开 Biomni' > "$WORK/create.json"
grep -q '"state": "queued"' "$WORK/create.json"
"${RUNTIME[@]}" status --home "$PRIVATE_HOME" > "$WORK/status.json"
grep -q '打开 Biomni' "$WORK/status.json"
echo "ok   create 写入的任务能被 status 读到"

echo "--- 3. 暂停不吃槽位、也不破坏状态（B1 / B2）---"
"${RUNTIME[@]}" pause 1 --home "$PRIVATE_HOME" > "$WORK/pause.json"
grep -q '"paused": true' "$WORK/pause.json"
"${RUNTIME[@]}" status --home "$PRIVATE_HOME" > "$WORK/status2.json"
grep -q '"runnable": 0' "$WORK/status2.json"
grep -q '"open": 1' "$WORK/status2.json"
echo "ok   暂停后 runnable 归零但任务仍然打开"
"${RUNTIME[@]}" resume 1 --home "$PRIVATE_HOME" > /dev/null
echo "ok   resume 成功"

echo "--- 4. 调度器默认休眠 ---"
"${RUNTIME[@]}" scheduler status --home "$PRIVATE_HOME" > "$WORK/scheduler.json"
grep -q '"enabled": false' "$WORK/scheduler.json"
echo "ok   调度器默认 enabled=false"

echo "--- 5. 参数校验必须给出结构化错误，不是裸栈 ---"
if "${RUNTIME[@]}" pause abc --home "$PRIVATE_HOME" > "$WORK/badid.json" 2>&1; then
  echo "FAIL：非法任务编号却成功返回"
  exit 1
fi
grep -q invalid_task_id "$WORK/badid.json"
# 中文注释：默认不许打印调用栈（B13c）。栈只在 DAILY_TWIN_DEBUG=1 时输出。
if grep -q '    at ' "$WORK/badid.json"; then
  echo "FAIL：默认输出里出现了调用栈"
  cat "$WORK/badid.json"
  exit 1
fi
if "${RUNTIME[@]}" frobnicate --home "$PRIVATE_HOME" > "$WORK/badcmd.json" 2>&1; then
  echo "FAIL：未知命令却成功返回"
  exit 1
fi
grep -q unknown_command "$WORK/badcmd.json"
echo "ok   invalid_task_id 与 unknown_command 都是结构化错误"

echo "--- 6. 仓库目录始终保持干净 ---"
test ! -d runtime
test ! -e data/runtime.sqlite
echo "ok   没有任何运行数据泄漏到仓库里"

echo "CLI 冒烟测试全部通过"
