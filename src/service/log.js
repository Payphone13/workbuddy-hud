/**
 * 服务端日志 —— 写 `service.log`，与外壳的 `hud.log` 落在同一个目录。
 *
 * 为什么要有：0.6.4 出问题只能靠猜。用户机器上"积分显示未连接"，
 * 可能性至少有五种（凭据文件不存在 / 被占用 / 找不到客户端 exe /
 * 客户端未登录 / 接口返回 401），而旧实现只在界面上给一句笼统的"未连接"，
 * 后端连一行记录都不留。0.6.5 起每一条支路都留痕。
 *
 * 目录由外壳通过 `HUD_LOG_DIR` 传进来，保证两边在同一个文件夹里；
 * 独立跑（开发调试）时按 %LOCALAPPDATA% 兜底。
 *
 * 铁律：**不写 token、不写完整请求头、不写凭据文件内容**。
 * 令牌只留前 4 位与长度，够确认"换没换"就停。
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BYTES = 2 * 1024 * 1024;
let cachedDir = null;
let echo = process.env.HUD_LOG_ECHO === "1";

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".probe");
    fs.writeFileSync(probe, "1");
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function dir() {
  if (cachedDir) return cachedDir;
  const candidates = [];
  if (process.env.HUD_LOG_DIR) candidates.push(process.env.HUD_LOG_DIR);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  candidates.push(path.join(local, "workbuddy-hud", "logs"));
  candidates.push(path.join(os.homedir(), ".workbuddy-hud", "logs"));
  for (const c of candidates) {
    if (writable(c)) {
      cachedDir = c;
      return c;
    }
  }
  cachedDir = candidates[candidates.length - 1];
  return cachedDir;
}

function stamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return (
    d.getFullYear() +
    "-" + p(d.getMonth() + 1) +
    "-" + p(d.getDate()) +
    " " + p(d.getHours()) +
    ":" + p(d.getMinutes()) +
    ":" + p(d.getSeconds()) +
    "." + p(d.getMilliseconds(), 3)
  );
}

function roll(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_BYTES) return;
    const old = file + ".1";
    try { fs.unlinkSync(old); } catch (_) {}
    try { fs.renameSync(file, old); } catch (_) {}
  } catch (_) {
    /* 文件还不存在 */
  }
}

function write(tag, msg) {
  const text = msg instanceof Error ? msg.stack || msg.message : String(msg);
  if (echo) console.log("[" + tag + "] " + text);
  try {
    const file = path.join(dir(), "service.log");
    roll(file);
    const now = stamp();
    const body = text
      .split(/\r?\n/)
      .map((line) => now + " [" + tag + "] " + line)
      .join("\n");
    fs.appendFileSync(file, body + "\n", "utf8");
  } catch (_) {
    /* 日志不能反过来把主流程搞挂 */
  }
}

/* 令牌脱敏：只留前 4 位与长度，足以判断"换没换"，不足以还原 */
function mask(secret) {
  const s = String(secret || "");
  if (!s) return "（空）";
  if (s.length <= 8) return "***(" + s.length + ")";
  return s.slice(0, 4) + "…(" + s.length + ")";
}

/** 启动横幅：出问题时这几行就是环境快照 */
function banner(where) {
  write("启动", "===== 服务端日志开始 =====");
  write("启动", "入口 = " + where);
  write("启动", "版本 = " + (process.env.HUD_VERSION || "（未传）"));
  write("启动", "node = " + process.version + "  " + process.platform + "/" + process.arch);
  write("启动", "日志目录 = " + dir());
  write("启动", "用户目录 = " + os.homedir());
  write("启动", "LOCALAPPDATA = " + (process.env.LOCALAPPDATA || "（未设置）"));
}

module.exports = {
  dir,
  info: (msg) => write("信息", msg),
  warn: (msg) => write("注意", msg),
  error: (msg) => write("错误", msg),
  credit: (msg) => write("积分", msg),
  net: (msg) => write("网络", msg),
  mask,
  banner,
};
