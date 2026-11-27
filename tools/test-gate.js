#!/usr/bin/env node
/**
 * 权限代答自检：不依赖 WorkBuddy，也不打扰当前会话。
 *
 * 做法：在临时目录里起一个真实服务（独立端口），再用真实 hook 脚本
 * 模拟 WorkBuddy 下发事件，逐条验证：
 *   1. 允许 → hook 打印 permissionDecision: allow
 *   2. 拒绝 → hook 打印 permissionDecision: deny
 *   3. 没人理 → 到点按安全策略**拒绝**（默认不再自动放行）
 *   4. 显式选了"1 分钟后放行" → 到点放行、不打印
 *   5. 监管模式关闭 → 立刻放行，不打印
 *   6. 服务没起 → 400ms 内退出，不打印（WorkBuddy 完全不受影响）
 *   7. 常规操作在 risky 模式下不打扰；项目外写入会拦；排队满了按安全侧拒绝
 *
 * 用法：node tools/test-gate.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = 47899;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hud-gate-test-"));

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  — " + detail : ""));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function request(opts, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, agent: false, ...opts },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ code: res.statusCode, json: JSON.parse(raw) });
          } catch (_) {
            resolve({ code: res.statusCode, json: null, raw });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ code: 0, json: null, error: e.code || String(e) }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function env(extra) {
  return { ...process.env, WB_HUD_DIR: TMP, WB_HUD_PORT: String(PORT), ...extra };
}

function writePrefs(gate, gateTimeout) {
  const body = { gate };
  if (gateTimeout) body.gateTimeout = gateTimeout;
  fs.writeFileSync(path.join(TMP, "prefs.json"), JSON.stringify(body), "utf8");
}

/** 起服务，等 health 通 */
async function startServer(envExtra) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "service", "server.js")], {
    cwd: ROOT,
    env: env(envExtra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => console.error("[server]", String(d).trim()));

  for (let i = 0; i < 60; i += 1) {
    const r = await request({ path: "/api/health", method: "GET" });
    if (r.json && r.json.ok) return child;
    await sleep(100);
  }
  throw new Error("服务没能启动");
}

/** 跑一次 hook，返回 {stdout, elapsed} */
function runHook(payload) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, "hooks", "hud-hook.js")], {
      cwd: ROOT,
      env: env(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", () => {});
    child.on("close", () => resolve({ stdout: out.trim(), elapsed: Date.now() - started }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const PAYLOAD = {
  hook_event_name: "PreToolUse",
  session_id: "gate-test",
  cwd: "C:\\Users\\test\\project",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /tmp/demo" },
};

const PERM_PAYLOAD = {
  hook_event_name: "PermissionRequest",
  session_id: "gate-test",
  cwd: "C:\\Users\\test\\project",
  tool_name: "Write",
  tool_input: { file_path: "C:\\Windows\\System32\\drivers\\etc\\hosts", content: "x" },
};

async function pendingId() {
  const r = await request({ path: "/api/state", method: "GET" });
  const list = (r.json && r.json.pending) || [];
  return list.length ? list[0].id : null;
}

async function main() {
  console.log("临时目录：" + TMP);

  writePrefs("all");
  let server = await startServer({ WB_HUD_WAIT_MS: "6000" });

  // 1. 允许
  let p = runHook(PAYLOAD);
  await sleep(600);
  let id = await pendingId();
  check("待确认请求已出现在 /api/state", !!id, id || "没有 pending");
  await request({ path: "/api/permission/decide", method: "POST" }, { id, behavior: "allow" });
  let r = await p;
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) {}
  check(
    "允许 → PreToolUse 决策为 allow",
    !!json && json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision === "allow",
    r.stdout || "(空)"
  );
  check("允许 → 响应够快（<3s）", r.elapsed < 3000, r.elapsed + "ms");

  // 2. 拒绝
  p = runHook(PAYLOAD);
  await sleep(600);
  id = await pendingId();
  await request({ path: "/api/permission/decide", method: "POST" }, { id, behavior: "deny" });
  r = await p;
  json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) {}
  check(
    "拒绝 → PreToolUse 决策为 deny",
    !!json && json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision === "deny",
    r.stdout || "(空)"
  );

  // 3. PermissionRequest 格式
  p = runHook(PERM_PAYLOAD);
  await sleep(600);
  id = await pendingId();
  await request({ path: "/api/permission/decide", method: "POST" }, { id, behavior: "deny" });
  r = await p;
  json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) {}
  check(
    "PermissionRequest → decision.behavior = deny",
    !!json && json.hookSpecificOutput && json.hookSpecificOutput.decision &&
      json.hookSpecificOutput.decision.behavior === "deny",
    r.stdout || "(空)"
  );

  // 4. 没人点 → 按安全策略拒绝（默认行为）
  server.kill();
  await sleep(400);
  writePrefs("all");
  server = await startServer({ WB_HUD_WAIT_MS: "1500" });
  r = await runHook(PAYLOAD);
  json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) {}
  check(
    "没人点 → 到点按安全策略拒绝（不再自动放行）",
    !!json && json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision === "deny",
    r.stdout || "(空)"
  );
  check("超时耗时符合设定（1.5–4s）", r.elapsed >= 1500 && r.elapsed < 4000, r.elapsed + "ms");

  // 4b. 显式选了"放行"策略 → 到点放行、不打印
  server.kill();
  await sleep(400);
  writePrefs("all", "pass1");
  server = await startServer({ WB_HUD_WAIT_MS: "1200" });
  r = await runHook(PAYLOAD);
  check("选了放行策略 → 到点放行且不打印", r.stdout === "", r.stdout || "(空)");

  // 5. 监管模式关闭
  writePrefs("off");
  await sleep(800); // 让服务端的 prefs 缓存过期
  r = await runHook(PAYLOAD);
  check("监管模式关闭 → 不拦截、不打印", r.stdout === "", r.stdout || "(空)");
  check("监管模式关闭 → 立刻返回（<1.2s）", r.elapsed < 1200, r.elapsed + "ms");

  // 6. 服务没起
  server.kill();
  await sleep(300);
  r = await runHook(PAYLOAD);
  check("服务未启动 → hook 静默退出", r.stdout === "", r.stdout || "(空)");
  check("服务未启动 → 400ms 级退出（<1.5s）", r.elapsed < 1500, r.elapsed + "ms");

  // 7. 常规操作在 risky 模式下不该打扰
  writePrefs("risky");
  server = await startServer({ WB_HUD_WAIT_MS: "6000" });
  await sleep(800);
  r = await runHook({
    hook_event_name: "PreToolUse",
    session_id: "gate-test",
    cwd: "C:\\Users\\test\\project",
    tool_name: "Bash",
    tool_input: { command: "git status" },
  });
  check("risky 模式 + 普通命令 → 直接放行（<1.5s）", r.stdout === "" && r.elapsed < 1500, r.elapsed + "ms");

  const outside = runHook({
    hook_event_name: "PreToolUse",
    session_id: "gate-test",
    cwd: "C:\\Users\\test\\project",
    tool_name: "Write",
    tool_input: { file_path: "D:\\其他项目\\notes.txt", content: "x" },
  });
  await sleep(700);
  id = await pendingId();
  check("risky 模式 + 改项目外的文件 → 会拦", !!id, id || "没有 pending");
  if (id) await request({ path: "/api/permission/decide", method: "POST" }, { id, behavior: "allow" });
  await outside;

  server.kill();

  const failed = results.filter((x) => !x.ok);
  console.log("");
  console.log(failed.length ? "有 " + failed.length + " 项不通过：" : "全部 " + results.length + " 项通过");
  for (const f of failed) console.log("  - " + f.name + (f.detail ? "（" + f.detail + "）" : ""));

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("自检失败：" + (err && err.stack ? err.stack : err));
  process.exit(1);
});
