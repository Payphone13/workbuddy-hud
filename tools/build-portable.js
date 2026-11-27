"use strict";

/**
 * 打包成"便携文件夹"：解压后双击 exe 即用，没有安装程序，也不写注册表。
 *
 * 0.6 换了 Tauri 外壳之后，运行时不再是一个 350MB 的 Chromium 目录，
 * 而是"系统自带的 Edge WebView2 + 一个 3.5MB 的 exe"——后端脚本、
 * 钩子脚本、页面全部 include_bytes! 编进 exe 里了。所以这里不再需要
 * 复制任何运行时，只把 exe 和几份说明放到一个文件夹里。
 *
 * 产物结构：
 *   dist/WorkBuddy面板-<版本>-win-x64/
 *     WorkBuddy面板.exe        ← 全部程序都在这里面
 *     使用说明.txt              ← 怎么用、怎么卸，一份看完
 *     卸载.bat                  ← 调 exe --uninstall，摘钩子 + 删数据目录
 *
 * 用法：
 *   node tools/build-portable.js           只组文件夹
 *   node tools/build-portable.js --zip     顺带压成 zip
 *   node tools/build-portable.js --from <exe 路径>   指定已经编译好的 exe
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CONF = path.join(ROOT, "tauri", "tauri.conf.json");
const DEFAULT_EXE = path.join(ROOT, "tmp", "tauri-target", "release", "workbuddy-hud.exe");

const APP_NAME = "WorkBuddy面板";
const EXE_NAME = APP_NAME + ".exe";

/** 跟着 exe 一起发的文件（都在项目根目录） */
const TOP_FILES = ["使用说明.txt", "卸载.bat"];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch (_) {
    return 0;
  }
}

function mb(n) {
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function build() {
  const conf = readJson(CONF);
  const pkg = readJson(path.join(ROOT, "package.json"));
  const version = conf.version;

  if (pkg.version !== version) {
    throw new Error(
      "版本号不一致：tauri/tauri.conf.json 是 " +
        version +
        "，package.json 是 " +
        pkg.version +
        "。两处必须相同，否则面板里显示的版本会和文件名对不上。"
    );
  }

  const src = path.resolve(argValue("--from") || DEFAULT_EXE);
  if (!fs.existsSync(src)) {
    throw new Error(
      "找不到编译好的 exe：" +
        src +
        "\n先编译：bash tauri/build.sh（或按 docs/开发记录.md 里的 cargo 命令），再回来打包。"
    );
  }

  const OUT = path.join(ROOT, "dist", APP_NAME + "-" + version + "-win-x64");
  console.log("清理旧产物…");
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log("放入 exe…");
  fs.copyFileSync(src, path.join(OUT, EXE_NAME));

  let missing = 0;
  for (const name of TOP_FILES) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) {
      console.log("  缺文件：" + name);
      missing++;
      continue;
    }
    fs.copyFileSync(p, path.join(OUT, name));
  }
  if (missing > 0) {
    throw new Error("有 " + missing + " 个随包文件找不到，先补上再打包");
  }

  // 数一下到底几件东西，人肉核对时不用逐个看
  const files = fs.readdirSync(OUT);
  const total = files.reduce((n, f) => n + sizeOf(path.join(OUT, f)), 0);

  console.log("\n完成：" + OUT);
  console.log("  版本：" + version + "（" + conf.identifier + "）");
  console.log("  文件：" + files.length + " 个 —— " + files.join("、"));
  console.log("  体积：" + mb(total));
  console.log("  前提：Windows 10 1809+ / 11，且系统有 WebView2（Win11 自带，Win10 多数已随更新装上）");

  return { dir: OUT, version, total };
}

function zip(dir) {
  const zipPath = dir + ".zip";
  fs.rmSync(zipPath, { force: true });
  console.log("\n压缩中…");
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Compress-Archive -LiteralPath '" +
        dir.replace(/'/g, "''") +
        "' -DestinationPath '" +
        zipPath.replace(/'/g, "''") +
        "' -CompressionLevel Optimal",
    ],
    { stdio: "inherit" }
  );
  console.log("压缩包：" + zipPath + "（" + mb(sizeOf(zipPath)) + "）");
  return zipPath;
}

if (require.main === module) {
  try {
    const r = build();
    if (process.argv.includes("--zip")) zip(r.dir);
  } catch (err) {
    console.error("打包失败：" + ((err && err.message) || err));
    process.exit(1);
  }
}

module.exports = { build, zip };
