#!/usr/bin/env node
/**
 * WorkBuddy HUD — hooks 注册器
 *
 * 作用：把本工具的采集脚本注册到 WorkBuddy 的 settings.json，
 *       让 WorkBuddy 在每次会话/工具调用时通知我们。
 *
 * 用法（一般由 setup.js 调用，不需要手敲）：
 *   node tools/install-hooks.js              安装
 *   node tools/install-hooks.js --uninstall  卸载
 *   node tools/install-hooks.js --dry-run    只查看，不写文件
 *
 * 安全设计（对非程序员很重要，逐条说明）：
 *   1. 写入前一定先备份 settings.json 为 .bak.<时间戳>，出错可原样恢复。
 *   2. 只增删"命令里包含 hud-hook.js"的条目，你自己或别的工具配的 hooks 一律不动。
 *   3. PreToolUse / PermissionRequest 是阻塞式事件（要等你点允许/拒绝）。
 *      现在"没人点就一直等"，所以超时给到 3720 秒（62 分钟），比 hook 自身的
 *      3620 秒预算还长一点，保证 hook 总能在 WorkBuddy 掐断之前先给出答复。
 *      面板没开时 hook 400 毫秒内就会静默退出，WorkBuddy 感受不到任何延迟。
 *   4. 任何异常都在写入前抛出，不会留下写了一半的配置。
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER = "hud-hook.js";

/** 运行时目录：hook 脚本副本与事件流都放在用户主目录，移动本项目文件夹也不失效 */
const HUD_DIR = process.env.WB_HUD_DIR || path.join(os.homedir(), ".workbuddy-hud");
const RUNTIME_SCRIPT = path.join(HUD_DIR, "bin", MARKER);
const SOURCE_SCRIPT = path.resolve(__dirname, "..", "hooks", MARKER);
/** 记住首次安装用的 node，之后"修复连接"照抄，绝不从 Electron 进程里反推 */
const ENV_FILE = path.join(HUD_DIR, "env.json");

/** 事件注册表。timeout 单位：秒。 */
const EVENTS = [
  { name: "SessionStart" },
  { name: "UserPromptSubmit" },
  { name: "PreToolUse", matcher: ".*", timeout: 3720 },
  { name: "PostToolUse", matcher: ".*" },
  { name: "PermissionRequest", matcher: ".*", timeout: 3720 },
  { name: "Notification" },
  { name: "Stop" },
  { name: "PreCompact" },
  { name: "SessionEnd" },
];

function resolveSettingsPath() {
  const envDir = process.env.WORKBUDDY_CONFIG_DIR;
  const candidates = [];
  if (envDir) candidates.push(path.join(envDir, "settings.json"));
  candidates.push(path.join(os.homedir(), ".workbuddy", "settings.json"));
  candidates.push(path.join(os.homedir(), ".workbuddy-ai", "settings.json"));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function backup(file) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "");
  const dest = `${file}.bak.${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function isOurs(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.some((h) => typeof h.command === "string" && h.command.includes(MARKER))
  );
}

function stripOurs(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => {
      if (isOurs(g)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return removed;
}

/* ---------------- 解释器定位 ----------------
 * hook 必须由 node.exe 启动，不能是 electron.exe。
 *
 * 踩过的坑：旧代码直接用 process.execPath。在安装器里它是 node.exe（正确），
 * 但从托盘菜单点"修复连接"时进程是 Electron，于是 electron.exe 被写进了配置。
 * 表面上还能跑（Electron 也能执行 .js），实际每个事件都要拉起一整个 Electron
 * 进程，慢几百毫秒，还往 stderr 吐 crashpad 报错 —— 更糟的是自检只看命令里
 * 有没有 hud-hook.js，永远发现不了。
 *
 * 现在的顺序：显式环境变量 → env.json 里记录的路径 → 当前进程（仅当它不是
 * Electron）→ PATH 里的 node → WorkBuddy 自带 node → 裸 "node"。
 */

function isElectronRuntime() {
  return !!process.versions.electron;
}

function isElectronExe(p) {
  const base = path.basename(String(p || "")).toLowerCase();
  return base === "electron.exe" || base === "electron";
}

function usableNode(p) {
  if (!p) return false;
  if (isElectronExe(p)) return false;
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function readEnv() {
  try {
    const raw = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch (_) {
    return {};
  }
}

/** 在 PATH 里按文件名找可执行文件（不调 shell，避免引号与编码问题） */
function fromPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (usableNode(p)) return p;
    }
  }
  return null;
}

/** WorkBuddy 自带 node：~/.workbuddy/binaries/node/versions/<版本>/node.exe */
function workbuddyNode() {
  const base = path.join(os.homedir(), ".workbuddy", "binaries", "node", "versions");
  let dirs = [];
  try {
    dirs = fs.readdirSync(base).sort().reverse();
  } catch (_) {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(base, d, process.platform === "win32" ? "node.exe" : "node");
    if (usableNode(p)) return p;
  }
  return null;
}

/** @returns {{path:string, source:string}} path 可能是裸 "node"（依赖运行时 PATH） */
function locateNode() {
  const explicit = process.env.WB_HUD_NODE;
  if (usableNode(explicit)) return { path: explicit, source: "环境变量 WB_HUD_NODE" };

  const saved = readEnv().nodePath;
  if (usableNode(saved)) return { path: saved, source: "安装时记录（env.json）" };

  if (!isElectronRuntime() && usableNode(process.execPath)) {
    return { path: process.execPath, source: "当前安装进程" };
  }

  const inPath = fromPath("node");
  if (inPath) return { path: inPath, source: "PATH" };

  const bundled = workbuddyNode();
  if (bundled) return { path: bundled, source: "WorkBuddy 自带" };

  return { path: "node", source: "PATH 关键字（未验证）" };
}

function buildCommand(nodePath) {
  const nodeBin = String(nodePath || "node").replace(/\\/g, "/");
  const script = RUNTIME_SCRIPT.replace(/\\/g, "/");
  return `"${nodeBin}" "${script}"`;
}

function deployRuntime() {
  fs.mkdirSync(path.dirname(RUNTIME_SCRIPT), { recursive: true });
  fs.copyFileSync(SOURCE_SCRIPT, RUNTIME_SCRIPT);
  return RUNTIME_SCRIPT;
}

/**
 * 把这次用的 node 记下来，供以后"修复连接"直接沿用。
 * 只有真实验证过的路径才写：裸 "node" 依赖运行时 PATH，写进去反而会
 * 把上一次的好记录覆盖掉。
 */
function writeEnv(node) {
  if (!usableNode(node.path)) return null;
  try {
    fs.mkdirSync(HUD_DIR, { recursive: true });
    const prev = readEnv();
    const payload = {
      nodePath: node.path,
      nodeSource: node.source,
      firstInstalledAt: prev.firstInstalledAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(ENV_FILE, JSON.stringify(payload, null, 2), "utf8");
    return payload;
  } catch (_) {
    return null;
  }
}

function install(options) {
  const opts = options || {};
  const settingsPath = resolveSettingsPath();
  const node = locateNode();
  const command = buildCommand(node.path);
  const settings = readJson(settingsPath);

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  const removed = stripOurs(settings.hooks);

  for (const ev of EVENTS) {
    if (!Array.isArray(settings.hooks[ev.name])) settings.hooks[ev.name] = [];
    const group = { hooks: [{ type: "command", command, timeout: ev.timeout || 10 }] };
    if (ev.matcher) group.matcher = ev.matcher;
    settings.hooks[ev.name].push(group);
  }

  if (opts.dryRun) {
    return {
      dryRun: true,
      settingsPath,
      runtimeScript: RUNTIME_SCRIPT,
      command,
      node: node.path,
      nodeSource: node.source,
      removed,
      events: EVENTS.map((e) => e.name),
    };
  }

  const backupPath = fs.existsSync(settingsPath) ? backup(settingsPath) : null;

  deployRuntime();
  writeEnv(node);

  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  return {
    dryRun: false,
    settingsPath,
    runtimeScript: RUNTIME_SCRIPT,
    backupPath,
    command,
    node: node.path,
    nodeSource: node.source,
    removed,
    events: EVENTS.map((e) => e.name),
  };
}

function uninstall() {
  const settingsPath = resolveSettingsPath();
  if (!fs.existsSync(settingsPath)) return { removed: 0, settingsPath, reason: "配置不存在" };

  const settings = readJson(settingsPath);
  if (!settings.hooks) return { removed: 0, settingsPath, reason: "没有 hooks 段" };

  const removed = stripOurs(settings.hooks);
  if (removed === 0) return { removed: 0, settingsPath, reason: "没有本工具注册的条目" };

  const backupPath = backup(settingsPath);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  return { removed, settingsPath, backupPath };
}

/**
 * 只读自检：不写任何文件，只回答"现在这套连接能不能用"。
 *
 * 用途是启动时自查 —— 配置被 WorkBuddy 升级重置、被别的工具改坏，
 * 或者整个文件夹被拷到另一台电脑（绝对路径失效），都能在这里发现。
 */
/* ---------------- 自检 ---------------- */

/** 从 hook 命令里取解释器路径（命令形如 "C:/node.exe" "C:/…/hud-hook.js"） */
function interpreterOf(command) {
  const s = String(command || "").trim();
  const quoted = s.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  return s.split(/\s+/)[0] || "";
}

/**
 * 已经登记在配置里的解释器还能不能用。
 *
 * 这一条是补上旧的盲区：以前只判断"命令里有没有 hud-hook.js"，
 * 于是命令被写成 electron.exe、或者整个项目搬到另一台电脑导致 node 路径失效，
 * 自检都还报"连接正常"。
 */
function interpreterState(hooks) {
  let raw = "";
  outer: for (const ev of EVENTS) {
    const groups = hooks[ev.name];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isOurs(g)) continue;
      for (const h of g.hooks || []) {
        if (typeof h.command === "string" && h.command.includes(MARKER)) {
          raw = interpreterOf(h.command);
          break outer;
        }
      }
    }
  }

  if (!raw) {
    return { interpreter: "", interpreterOk: false, problem: "配置里没有找到本工具登记的命令" };
  }
  if (isElectronExe(raw)) {
    return {
      interpreter: raw,
      interpreterOk: false,
      problem:
        "钩子现在是被 Electron 启动的，不是 node：每次事件都要拉起一整个 Electron 进程，会明显变慢。点「修复」即可改回 node。",
    };
  }
  const bare = !raw.includes("/") && !raw.includes("\\");
  if (bare) {
    // 依赖运行时 PATH，无法在这里验证，只能提示
    return { interpreter: raw, interpreterOk: true, problem: "", interpreterNote: "使用 PATH 里的 node" };
  }
  if (!usableNode(raw)) {
    return {
      interpreter: raw,
      interpreterOk: false,
      problem: "配置里记录的 node 已经不存在了（换电脑、卸载 Node 或移动过目录），需要重新修复。",
    };
  }
  return { interpreter: raw, interpreterOk: true, problem: "" };
}

function check() {
  const settingsPath = resolveSettingsPath();
  const settings = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
  const hooks =
    settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  const missing = [];
  for (const ev of EVENTS) {
    const groups = hooks[ev.name];
    const ok = Array.isArray(groups) && groups.some((g) => isOurs(g));
    if (!ok) missing.push(ev.name);
  }

  // 运行时副本是否落后于源文件：改了源码却忘了重装，症状和"没注册"一样难查
  let runtimeStale = false;
  try {
    if (!fs.existsSync(RUNTIME_SCRIPT)) {
      runtimeStale = true;
    } else {
      const src = fs.statSync(SOURCE_SCRIPT);
      const run = fs.statSync(RUNTIME_SCRIPT);
      runtimeStale = run.mtimeMs < src.mtimeMs - 1000;
    }
  } catch (_) {
    runtimeStale = true;
  }

  const interp = interpreterState(hooks);

  return {
    ok: missing.length === 0 && !runtimeStale && interp.interpreterOk,
    total: EVENTS.length,
    registered: EVENTS.length - missing.length,
    missing,
    runtimeStale,
    settingsPath,
    interpreter: interp.interpreter,
    interpreterOk: interp.interpreterOk,
    interpreterNote: interp.interpreterNote || "",
    problem: interp.problem || "",
  };
}

module.exports = {
  install,
  uninstall,
  check,
  locateNode,
  resolveSettingsPath,
  HUD_DIR,
  RUNTIME_SCRIPT,
  ENV_FILE,
};

/* ---------------- 命令行入口 ---------------- */

if (require.main === module) {
  // --json：给外壳（Tauri 版）用的机器可读输出。人和脚本各走一路，
  // 外壳不必去解析上面那些中文标签，改文案也不会把外壳弄坏。
  const argv = process.argv.slice(2).filter((a) => a !== "--json");
  const asJson = process.argv.includes("--json");
  const arg = argv[0];
  const emit = (obj) => console.log(JSON.stringify(obj));
  try {
    if (arg === "--check") {
      const r = check();
      if (asJson) {
        emit(r);
        process.exit(r.ok ? 0 : 2);
      }
      console.log(r.ok ? "连接正常" : "连接不完整");
      console.log("  配置文件 : " + r.settingsPath);
      console.log("  已注册   : " + r.registered + " / " + r.total);
      if (r.interpreter) {
        console.log("  启动器   : " + r.interpreter + (r.interpreterOk ? "" : "（不可用）"));
      }
      if (r.missing.length) console.log("  缺失事件 : " + r.missing.join(", "));
      if (r.runtimeStale) console.log("  运行时副本已过期（源文件更新过，需重装）");
      if (r.problem) console.log("  问题     : " + r.problem);
      process.exit(r.ok ? 0 : 2);
    } else if (arg === "--uninstall") {
      const r = uninstall();
      if (asJson) {
        emit(r);
        process.exit(0);
      }
      console.log(r.removed ? `已卸载 ${r.removed} 条 hooks。` : `未做修改：${r.reason}`);
      console.log("  配置文件 : " + r.settingsPath);
      if (r.backupPath) console.log("  备份     : " + r.backupPath);
    } else {
      const r = install({ dryRun: arg === "--dry-run" });
      if (asJson) {
        emit(r);
        process.exit(0);
      }
      const tag = r.dryRun ? "[仅预览，未写入] " : "";
      console.log(tag + "配置文件 : " + r.settingsPath);
      console.log(tag + "运行时副本 : " + r.runtimeScript);
      console.log(tag + "启动器     : " + r.node + "（来源：" + r.nodeSource + "）");
      console.log(tag + "清理旧条目 : " + r.removed);
      console.log(tag + "注册事件   : " + r.events.join(", "));
      console.log(tag + "命令       : " + r.command);
      if (!r.dryRun) console.log("  备份     : " + (r.backupPath || "（原文件不存在）"));
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (asJson) {
      emit({ error: msg });
      process.exit(1);
    }
    console.error("失败：" + msg);
    console.error("配置文件未被修改。");
    process.exit(1);
  }
}
