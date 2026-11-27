#!/usr/bin/env node
/**
 * WorkBuddy HUD — 采集 + 代答 hook
 *
 * 这个脚本被 WorkBuddy 在每次事件时启动一次，通过 stdin 收一段 JSON。
 *
 * 两种角色：
 *   A. 旁听（默认）：把事件投影成一行写进 events.jsonl，面板据此显示
 *      思考、步骤、状态。这一路径永不输出任何决策，永不阻塞。
 *   B. 代答（仅 PreToolUse / PermissionRequest）：把"要执行什么"发给本地面板，
 *      等用户点"允许 / 拒绝"，再把结论按 WorkBuddy 要求的格式打印到 stdout。
 *
 * 安全约束（对非程序员尤其重要，逐条说明）：
 *   1. 面板没开 → 连不上本地服务 → 立刻退出，WorkBuddy 完全按原样走。
 *   2. 面板开着但没人点 → 一直等（默认最长一小时，可在面板里改）。
 *      到点仍无人应答 → 按安全策略**拒绝**，绝不偷偷放行危险操作。
 *   3. 任何异常（读不到 stdin、JSON 坏、网络错误）→ 一律静默退出，绝不阻断。
 *   4. 只有明确的"允许/拒绝"才写 stdout；"放行"什么都不打印。
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const HUD_DIR = process.env.WB_HUD_DIR || path.join(os.homedir(), ".workbuddy-hud");
const SPOOL = path.join(HUD_DIR, "events.jsonl");
const PORT_FILE = path.join(HUD_DIR, "port.txt");
const PREFS_FILE = path.join(HUD_DIR, "prefs.json");
const DEFAULT_PORT = Number(process.env.WB_HUD_PORT || 47821);

const MAX_FIELD = 2000; // 单字段截断，避免 spool 膨胀
const CONNECT_MS = 400; // 连不上就当我们不存在

/**
 * 等面板答复的上限，跟着面板设置里的"无人应答策略"走。
 * 服务端自己会在策略到点时给答复，这里的预算只比它多一点，
 * 用来兜"服务没响应"这种异常；到点后按安全侧拒绝，不偷偷放行。
 */
const WAIT_MS = { hold: 60 * 60 * 1000, deny10: 10 * 60 * 1000, pass1: 60 * 1000 };
const ASK_MARGIN_MS = 20000;

/** 会阻塞提问的事件；其余事件只旁听 */
const ASKING_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);

let printed = false;

function ensureDir() {
  try {
    fs.mkdirSync(HUD_DIR, { recursive: true });
  } catch (_) {
    /* 目录已存在或权限不足，后续写入会失败但不应影响主流程 */
  }
}

function truncate(value, limit) {
  if (value === null || value === undefined) return null;
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (_) {
      text = String(value);
    }
  }
  if (typeof text !== "string") return null;
  return text.length > limit ? text.slice(0, limit) + "…[truncated]" : text;
}

/**
 * 收集 payload 的键路径，用于确认 WorkBuddy 实际下发字段。
 *
 * 这是排查阶段的临时脚手架，不是运行时需要的信息：
 * 它曾占事件流体积的 21%（3.1MB 里 0.67MB），而面板从来不读它。
 * 现在默认不写；将来要复查字段，设 WB_HUD_DEBUG_KEYS=1 再跑一次即可。
 */
const DEBUG_KEYS = process.env.WB_HUD_DEBUG_KEYS === "1";

function keyShape(obj, depth, prefix, out) {
  if (depth > 2 || obj === null || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const p = prefix ? prefix + "." + key : key;
    out.push(p);
    if (depth < 2) keyShape(obj[key], depth + 1, p, out);
  }
}

function collectKeys(d) {
  const keys = [];
  keyShape(d, 0, "", keys);
  return keys.slice(0, 60);
}

function project(payload) {
  const d = payload && typeof payload === "object" ? payload : {};

  const record = {
    ts: Date.now(),
    event: d.hook_event_name || process.argv[2] || "unknown",
    session_id: d.session_id || null,
    cwd: d.cwd || null,
    transcript_path: d.transcript_path || null,
    permission_mode: d.permission_mode || null,
    tool_name: d.tool_name || null,
    call_id: d.call_id || d.tool_use_id || null,
    notification_type: d.notification_type || null,
    prompt: truncate(d.prompt, MAX_FIELD),
    tool_input: truncate(d.tool_input, MAX_FIELD),
    last_assistant_message: truncate(d.last_assistant_message, MAX_FIELD),
    message: truncate(d.message, 500),
    stop_hook_active: d.stop_hook_active === undefined ? null : !!d.stop_hook_active,
    pid: process.pid,
  };

  if (DEBUG_KEYS) record.keys = collectKeys(d);
  return record;
}

function appendSpool(record) {
  try {
    fs.appendFileSync(SPOOL, JSON.stringify(record) + "\n", "utf8");
  } catch (_) {
    /* 静默失败，绝不阻断 WorkBuddy */
  }
}

function servicePort() {
  try {
    const n = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {
    /* 没写过端口文件 */
  }
  return DEFAULT_PORT;
}

/** 按面板设置算这次最多等多久（毫秒） */
function askBudget() {
  let key = "hold";
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
    if (raw && Object.prototype.hasOwnProperty.call(WAIT_MS, raw.gateTimeout)) key = raw.gateTimeout;
  } catch (_) {
    /* 设置文件读不到：用默认（一小时） */
  }
  return WAIT_MS[key] + ASK_MARGIN_MS;
}

/** 打印决策并退出；只允许打印一次 */
function finish(output) {
  if (printed) return;
  printed = true;

  let text = "";
  if (output) {
    try {
      text = JSON.stringify(output) + "\n";
    } catch (_) {
      text = ""; // 序列化失败就当作"不表态"，不阻断 WorkBuddy
    }
  }

  const done = () => process.exit(0);
  if (!text) {
    done();
    return;
  }

  /**
   * 不能在 write 之后立刻 process.exit。
   * Windows 上 stdout 接的是管道，写入是异步完成的，进程被立刻杀掉会把尾部截掉；
   * 症状是"面板点了允许，WorkBuddy 那边却像没收到决策"，而且只在部分机器上出现。
   * 等 write 的回调（数据已交给管道）再退，同时留一个兜底定时器防止挂死。
   */
  const fallback = setTimeout(done, 800);
  fallback.unref && fallback.unref();
  try {
    process.stdout.write(text, done);
  } catch (_) {
    done();
  }
}

/** 把结论翻译成 WorkBuddy 认的输出格式 */
function buildOutput(eventName, behavior, reason) {
  if (behavior !== "allow" && behavior !== "deny") return null; // pass → 不表态
  const note = reason || (behavior === "allow" ? "你在面板点了允许" : "你在面板点了拒绝");

  if (eventName === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          behavior === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: note },
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: behavior,
      permissionDecisionReason: note,
    },
  };
}

/**
 * 向面板发起询问，等它给结论。
 * 连不上 / 超时 / 任何错误 → 不表态（fail-open）。
 */
function askHud(payload, eventName) {
  const body = JSON.stringify({
    sessionId: payload.session_id || null,
    toolName: payload.tool_name || "",
    toolInput: payload.tool_input || null,
    cwd: payload.cwd || null,
    source: eventName,
  });

  const port = servicePort();
  let settled = false;

  const settle = (behavior, reason) => {
    if (settled) return;
    settled = true;
    finish(buildOutput(eventName, behavior, reason));
  };

  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/api/permission/ask",
      method: "POST",
      agent: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (raw.length < 65536) raw += c;
      });
      res.on("end", () => {
        let out = null;
        try {
          out = JSON.parse(raw);
        } catch (_) {
          settle(null, "");
          return;
        }
        settle(out && out.behavior, out && out.reason);
      });
    }
  );

  // 连接超时：面板没开时几乎立刻失败，这里只是兜底
  const connectTimer = setTimeout(() => {
    try {
      req.destroy();
    } catch (_) {}
    settle(null, "");
  }, CONNECT_MS);
  connectTimer.unref && connectTimer.unref();

  req.on("socket", (socket) => {
    const onConnect = () => clearTimeout(connectTimer);
    if (socket.connecting) socket.once("connect", onConnect);
    else onConnect();
  });

  // 硬超时：正常情况下由服务端在"无人应答策略"到点时答复，这里只是兜底。
  // 到点仍没结论 → 按安全侧拒绝，宁可这一步失败，也不让危险操作自己跑过去。
  const totalTimer = setTimeout(() => {
    try {
      req.destroy();
    } catch (_) {}
    settle("deny", "面板长时间没有回应，已按安全策略拒绝这一步");
  }, askBudget());
  totalTimer.unref && totalTimer.unref();

  req.on("error", () => {
    clearTimeout(connectTimer);
    settle(null, "");
  });

  req.write(body);
  req.end();
}

function handle(payload) {
  const record = project(payload);
  appendSpool(record);

  const eventName = record.event;
  if (!ASKING_EVENTS.has(eventName)) return finish(null);
  if (!record.tool_name) return finish(null);

  askHud(payload, eventName);
}

function main() {
  ensureDir();

  let raw = "";
  let handled = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // 防御超大 payload：超过 1MB 即停止累积
    if (raw.length < 1024 * 1024) raw += chunk;
  });

  process.stdin.on("end", () => {
    if (handled) return;
    handled = true;
    let payload = {};
    try {
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw);
        } catch (_) {
          payload = { _parse_error: true, _raw_head: raw.slice(0, 500) };
        }
      }
      handle(payload);
    } catch (_) {
      finish(null);
    }
  });

  // 兜底：若 stdin 永不关闭，3 秒后按"无 payload"处理（此时不会再有真正的决策等待）
  setTimeout(() => {
    if (handled) return;
    handled = true;
    try {
      handle({});
    } catch (_) {
      finish(null);
    }
  }, 3000);

  process.stdin.on("error", () => {
    handled = true;
    finish(null);
  });
}

main();
