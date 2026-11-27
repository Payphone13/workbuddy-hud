"use strict";

/**
 * 本地服务：采集 + 聚合 + 推送
 *
 * 端点（仅监听 127.0.0.1）：
 *   GET  /                面板页面
 *   GET  /api/state       当前快照
 *   GET  /api/events      SSE 实时推送
 *   POST /api/permission/ask      hook 阻塞提问，等面板点按或超时
 *   POST /api/permission/decide   面板点按（允许 / 拒绝）
 *   GET  /api/health      健康检查
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const { SPOOL, HOST, PORT, PORT_FILE, PROJECTS_DIR } = require("./config");
const { Store } = require("./store");
const { TranscriptReader } = require("./transcript");
const { readUsage, listSessions } = require("./credit");
const { hub, gateMode, waitPolicy, waitPolicyKey } = require("./permissions");

const store = new Store();
const readers = new Map(); // sessionId -> TranscriptReader
const spoolState = { offset: 0, buffer: "", decoder: new StringDecoder("utf8") };

/** 待确认请求变化时推一次快照，让面板立刻出现确认卡 */
hub.setChangeHandler(() => store.touch());

/**
 * 快照里附带待确认列表 + 任务列表。
 *
 * tasks 来自 WorkBuddy 任务库（sessions 表），是"你真正拥有的任务"；
 * snap.sessions 只是"面板见过事件的会话"。列表以 tasks 为准，
 * 面板的实时细节再叠加上去 —— 这样既不会冒出假会话，也不会漏掉老任务。
 */
function withPending(snap) {
  const pending = hub.list();
  /**
   * 有请求在等你点的时候，把这个会话的状态直接标成"等你确认"。
   *
   * store 只认钩子事件，而面板提问与 PreToolUse 谁先谁后并不固定，
   * 于是会出现"卡片上有按钮，左上角却还是黄色的在跑"。这里用待确认列表
   * 覆盖一次，让灯和卡片说的是同一件事。
   */
  if (pending.length) {
    const waitingIds = new Set(pending.map((p) => p.sessionId).filter(Boolean));
    for (const s of snap.sessions) {
      if (waitingIds.has(s.id) && s.status !== "failed") s.status = "waiting";
    }
  }

  return Object.assign(snap, {
    pending,
    gate: gateMode(),
    gateTimeout: waitPolicyKey(),
    waitHint: waitPolicy().hint,
    tasks: listSessions(24),
  });
}

/* ---------------- spool 采集 ---------------- */

function tailSpool() {
  let stat;
  try {
    stat = fs.statSync(SPOOL);
  } catch (_) {
    return;
  }
  if (stat.size < spoolState.offset) {
    spoolState.offset = 0;
    spoolState.buffer = "";
    spoolState.decoder = new StringDecoder("utf8");
  }
  if (stat.size === spoolState.offset) return;

  const length = stat.size - spoolState.offset;
  const buf = Buffer.allocUnsafe(length);
  let fd = null;
  try {
    fd = fs.openSync(SPOOL, "r");
    const read = fs.readSync(fd, buf, 0, length, spoolState.offset);
    spoolState.offset += read;
    spoolState.buffer += spoolState.decoder.write(buf.subarray(0, read));
  } catch (_) {
    return;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }

  const lines = spoolState.buffer.split("\n");
  spoolState.buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (ev.session_id === "selftest") continue; // 自检数据不入库
    store.applyHook(ev);
  }
}

/* ---------------- transcript 采集 ---------------- */

const projectsDir = PROJECTS_DIR;
const pathGuess = new Map(); // sessionId -> { at, path }

/**
 * 按 sessionId 在 ~/.workbuddy/projects/<项目>/ 下找同名 .jsonl。
 * 只有会话缺 transcript_path 时才走这里，结果缓存 30 秒，避免每 500ms 扫盘。
 */
function guessTranscript(sessionId) {
  const hit = pathGuess.get(sessionId);
  if (hit && Date.now() - hit.at < 30000) return hit.path;
  let found = null;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, dir, sessionId + ".jsonl");
      if (fs.existsSync(file)) {
        found = file;
        break;
      }
    }
  } catch (_) {
    /* 目录不存在（WorkBuddy 还没用过）就放弃 */
  }
  pathGuess.set(sessionId, { at: Date.now(), path: found });
  return found;
}

function pollTranscripts() {
  const snap = store.snapshot();
  for (const s of snap.sessions) {
    let filePath = s.transcriptPath;
    if (!filePath) {
      filePath = guessTranscript(s.id);
      if (!filePath) continue;
      store.setTranscriptPath(s.id, filePath);
    }
    let reader = readers.get(s.id);
    if (!reader) {
      reader = new TranscriptReader(filePath);
      readers.set(s.id, reader);
    } else if (reader.filePath !== filePath) {
      reader.reset(filePath);
    }
    const delta = reader.poll();
    if (
      delta.reasoning.length ||
      delta.calls.length ||
      delta.results.length ||
      delta.usage ||
      delta.userPrompt
    ) {
      store.applyTranscript(s.id, delta);
    }
  }
}

/* ---------------- 用量采集 ---------------- */

function pollUsage() {
  const snap = store.snapshot();
  for (const s of snap.sessions) {
    const usage = readUsage(s.id);
    if (usage) store.applyUsage(s.id, usage);
  }
}

/* ---------------- 启动回放 ---------------- */

function replaySpool() {
  let text;
  try {
    text = fs.readFileSync(SPOOL, "utf8");
  } catch (_) {
    return;
  }
  const lines = text.split("\n").filter(Boolean).slice(-800);
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (ev.session_id === "selftest") continue;
    if (ev.ts && ev.ts < cutoff) continue;
    store.applyHook(ev);
  }
  // 回放后从文件末尾继续
  try {
    spoolState.offset = fs.statSync(SPOOL).size;
  } catch (_) {
    spoolState.offset = 0;
  }
}

/* ---------------- HTTP ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

function serveStatic(req, res) {
  const rawPath = (req.url || "/").split("?")[0];
  let urlPath;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch (_) {
    /**
     * 畸形百分号编码（例如 /%E0%A4%A）会让 decodeURIComponent 直接抛错。
     * 以前这行没包 try：只要有人（或某个扫描器）发一条坏地址，
     * 主进程就抛未捕获异常 —— 面板和权限服务一起停摆。
     * 日志里查不到"为什么面板突然不响应"的根因，就是它。
     */
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("bad request");
    return;
  }
  if (urlPath.indexOf("\0") >= 0) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("bad request");
    return;
  }
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(RENDERER_DIR, rel);
  // 用相对路径判断是否越界，避免 "renderer-evil" 这类同前缀目录混进来
  const inside = path.relative(RENDERER_DIR, file);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const sseClients = new Set();

function broadcast(snap) {
  const payload = "data: " + JSON.stringify(withPending(snap)) + "\n\n";
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

store.subscribe(broadcast);

/** 读取请求体（限 256KB，防止意外灌爆内存） */
function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (raw.length < (limit || 262144)) raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (_) {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

/**
 * 允许面板自己的页面跨源访问。
 *
 * Electron 版把页面也从这个服务拿，同源，本来不需要 CORS。
 * Tauri 版的页面从应用内嵌资源加载（源是 http://tauri.localhost），
 * 数据和 SSE 仍然打这个端口，于是变成跨源请求。
 *
 * 只放行这两个固定来源，不用 *：本机端口上跑着"代答权限"的接口，
 * 任意网页都能读就显得太宽松了。
 */
const PANEL_ORIGINS = new Set(["http://tauri.localhost", "https://tauri.localhost"]);

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (!PANEL_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  const corsOk = applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(corsOk ? 204 : 403).end();
    return;
  }

  if (url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "workbuddy-hud",
        version: 2,
        seq: store.seq,
        clients: sseClients.size,
        gate: gateMode(),
        pending: hub.list().length,
      })
    );
    return;
  }

  if (url === "/api/state") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(withPending(store.snapshot())));
    return;
  }

  if (url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    res.write("data: " + JSON.stringify(withPending(store.snapshot())) + "\n\n");
    sseClients.add(res);
    const timer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (_) {
        clearInterval(timer);
        sseClients.delete(res);
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(timer);
      sseClients.delete(res);
    });
    return;
  }

  /* 只接受本机请求：面板与 hook 都走 127.0.0.1，其他来源一律拒绝 */
  const remote = (req.socket && req.socket.remoteAddress) || "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";

  if (url === "/api/permission/ask" && req.method === "POST") {
    if (!local) {
      sendJson(res, 403, { behavior: "pass", reason: "非本机请求" });
      return;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { behavior: "pass", reason: "请求体不是合法 JSON" });
      return;
    }
    try {
      const result = await hub.ask({
        sessionId: body.sessionId || body.session_id || null,
        toolName: body.toolName || body.tool_name || "",
        toolInput: body.toolInput || body.tool_input || null,
        cwd: body.cwd || null,
        source: body.source || "PreToolUse",
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { behavior: "pass", reason: "内部错误，已放行" });
    }
    return;
  }

  if (url === "/api/permission/decide" && req.method === "POST") {
    if (!local) {
      sendJson(res, 403, { ok: false, reason: "非本机请求" });
      return;
    }
    const body = await readJsonBody(req);
    if (!body) {
      sendJson(res, 400, { ok: false, reason: "请求体不是合法 JSON" });
      return;
    }
    sendJson(res, 200, hub.decide(body.id, body.behavior));
    return;
  }

  serveStatic(req, res);
});

/* ---------------- 启动 / 停止 ---------------- */

const timers = [];

/**
 * 启动服务。
 * @param {number} preferredPort 首选端口，被占用时自动 +1 重试
 * @returns {Promise<{port:number}>}
 */
function start(preferredPort) {
  const basePort = Number(preferredPort || PORT);
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const attempt = (port) => {
      const onError = (err) => {
        if (err && err.code === "EADDRINUSE" && attempts < 10) {
          attempts += 1;
          setTimeout(() => attempt(port + 1), 120);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, HOST, () => {
        server.removeListener("error", onError);
        const actual = server.address().port;
        // 让 hook 知道真实端口（端口被占时服务会顺延，hook 不能只认 47821）
        try {
          fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
          fs.writeFileSync(PORT_FILE, String(actual), "utf8");
        } catch (_) {
          /* 写不了端口文件时 hook 仍会试默认端口 */
        }
        console.log("WorkBuddy HUD 服务已启动：http://" + HOST + ":" + actual);
        console.log("  事件流 : " + SPOOL);
        replaySpool();
        timers.push(setInterval(tailSpool, 300));
        timers.push(setInterval(pollTranscripts, 500));
        timers.push(setInterval(pollUsage, 1500));
        pollUsage();
        resolve({ port: actual });
      });
    };

    attempt(basePort);
  });
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  // 面板关掉就没人能授权了：按安全侧拒绝，绝不默认放行
  hub.releaseAll("面板已关闭，未获得授权，已拒绝", "deny");
  try {
    server.close();
  } catch (_) {
    /* ignore */
  }
  // 共享的只读连接也要还回去，别让句柄跟着进程耗着
  try {
    const { closeDb } = require("./credit");
    closeDb();
  } catch (_) {
    /* ignore */
  }
}

module.exports = { start, stop, store, withPending };

if (require.main === module) {
  start(PORT).catch((err) => {
    console.error("服务启动失败：" + (err && err.message ? err.message : String(err)));
    process.exit(1);
  });
}
