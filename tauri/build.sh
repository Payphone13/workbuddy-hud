#!/usr/bin/env bash
# 编译 Tauri 外壳（只在编译机上跑，产物是单个 exe）
#
# 默认直接使用系统 PATH 中的 cargo 与 MSVC 工具链。
# 如果上级目录存在便携工具链（../../_toolchain），则自动加入环境变量。
#
# 用法：bash tauri/build.sh            普通编译
#       bash tauri/build.sh --check    只做 cargo check，快很多
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

# 兼容本机便携工具链目录（若存在则优先挂载，不存在则使用系统默认环境）
if [ -d "$HERE/../../_toolchain" ]; then
  TOOLCHAIN="$(cd "$HERE/../../_toolchain" && pwd)"
  [ -d "$TOOLCHAIN/rustup" ] && export RUSTUP_HOME="$TOOLCHAIN/rustup"
  [ -d "$TOOLCHAIN/cargo" ] && export CARGO_HOME="$TOOLCHAIN/cargo"
  [ -d "$TOOLCHAIN/cargo/bin" ] && export PATH="$TOOLCHAIN/cargo/bin:$PATH"
  MSVC_BIN="$(ls -d "$TOOLCHAIN"/msvc/VC/Tools/MSVC/*/bin/Hostx64/x64 2>/dev/null | head -n 1 || true)"
  [ -n "$MSVC_BIN" ] && export PATH="$MSVC_BIN:$PATH"
fi

# 中间产物放项目 tmp 里，别污染 C 盘也别进 git
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/tmp/tauri-target}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "[错误] 找不到 cargo，请先安装 Rust 工具链（https://rustup.rs/）" >&2
  exit 1
fi

cd "$HERE"

if [ "$1" = "--check" ]; then
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
