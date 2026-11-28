#!/usr/bin/env bash
# 编译 Tauri 外壳（只在编译机上跑，产物是单个 exe）
#
# 默认直接使用系统 PATH 中的 cargo 与 MSVC 工具链。
# 如果上级目录存在便携工具链（../../_toolchain），则自动加入环境变量。
#
# 用法：bash tauri/build.sh                普通编译
#       bash tauri/build.sh --check        只做 cargo check，快很多
#       bash tauri/build.sh --jobs 8       指定并行编译任务数（覆盖默认）
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

# 兼容本机便携工具链目录（若存在则优先挂载，不存在则使用系统默认环境）
#
# 目录层级不固定：仓库根可能在 AI_Skills/workbuddy-hud，
# 也可能被拆成 AI_Skills/workbuddy-hud/workbuddy-hud-v0.6.x。
# 所以往上找三层，谁先有 _toolchain 用谁。
for up in .. ../.. ../../..; do
  if [ -d "$ROOT/$up/_toolchain" ]; then
    TOOLCHAIN="$(cd "$ROOT/$up/_toolchain" && pwd)"
    break
  fi
done

if [ -n "${TOOLCHAIN:-}" ]; then
  [ -d "$TOOLCHAIN/rustup" ] && export RUSTUP_HOME="$TOOLCHAIN/rustup"
  [ -d "$TOOLCHAIN/cargo" ] && export CARGO_HOME="$TOOLCHAIN/cargo"
  [ -d "$TOOLCHAIN/cargo/bin" ] && export PATH="$TOOLCHAIN/cargo/bin:$PATH"
  MSVC_BIN="$(ls -d "$TOOLCHAIN"/msvc/VC/Tools/MSVC/*/bin/Hostx64/x64 2>/dev/null | head -n 1 || true)"
  [ -n "$MSVC_BIN" ] && export PATH="$MSVC_BIN:$PATH"
fi

# 便携工具链 + release 全量 LTO（opt-level=z / lto=true / codegen-units=1）时，
# 偶发某个 rustc 卡在 Wait 上不再返回：单进程 CPU 停在几秒不动、target 目录
# 十几分钟零写入、cargo 干等，整条编译就此挂起。把并行任务数压到 4，能明显
# 缩小多进程抢 jobserver 令牌的竞争窗口，代价只是"从零全量编译"稍慢。
#
# 只在挂载了便携工具链时生效 —— 别的机器用系统 Rust 编译，不该被无故限速。
# 需要放开时：--jobs 12，或 CARGO_BUILD_JOBS=12 bash tauri/build.sh。
if [ -n "${TOOLCHAIN:-}" ]; then
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
fi

# 中间产物放项目 tmp 里，别污染 C 盘也别进 git
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/tmp/tauri-target}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "[错误] 找不到 cargo，请先安装 Rust 工具链（https://rustup.rs/）" >&2
  exit 1
fi

# 参数解析：允许 --check 与 --jobs 同时出现，顺序随意
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      CHECK=1
      shift
      ;;
    --jobs)
      if [ -z "${2:-}" ]; then
        echo "[错误] --jobs 后面要跟一个数字，例如 --jobs 4" >&2
        exit 1
      fi
      export CARGO_BUILD_JOBS="$2"
      shift 2
      ;;
    --jobs=*)
      export CARGO_BUILD_JOBS="${1#*=}"
      shift
      ;;
    *)
      echo "[错误] 未知参数：$1（可用：--check / --jobs N）" >&2
      exit 1
      ;;
  esac
done

cd "$HERE"

echo "并行任务数：${CARGO_BUILD_JOBS:-自动}${TOOLCHAIN:+（便携工具链）}"

if [ "$CHECK" = "1" ]; then
  exec cargo check
fi

cargo build --release

EXE="$CARGO_TARGET_DIR/release/workbuddy-hud.exe"
if [ -f "$EXE" ]; then
  echo
  echo "编译完成：$EXE"
  ls -l "$EXE" | awk '{printf "  体积：%.2f MB\n", $5/1024/1024}'
  echo "下一步：node tools/build-portable.js --zip"
fi
