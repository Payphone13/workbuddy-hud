"use strict";

/**
 * 每日积分：签到状态 + 账户剩余点数
 *
 * 三条铁律（改代码前先读一遍）：
 *   1. 默认关闭。prefs.creditSync 为 false 时，本模块 0 网络请求、0 凭据读取，
 *      连凭据文件都不碰 —— 这是"默认纯本地不联网"承诺的实现方式。
 *   2. 令牌只在内存里。不落盘、不写日志、不进快照（getInfo 是白名单），
 *      进程退出即消失；token 过期或 401 就重新解一次，绝不缓存到磁盘求省事。
 *   3. 失败不等于"未领取"。拿不到凭据/网络失败时 state 是 error，前端显示
 *      "未连接"，绝不能在界面上写成"今日未领取" —— 那会骗人去点一个点不动的按钮。
 *
 * 与上游 CLI 的差别：只做 status + claim 两个最小动作，不碰成长中心
 * （那边会开盲盒、派 Buddy、领任务奖励，属用户没点头的操作）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const { HUD_DIR } = require("./config");
const log = require("./log");

const PREFS_FILE = path.join(HUD_DIR, "prefs.json");
const HELPER_FILE = path.join(__dirname, "auth-helper.js");

/** 客户端冷启动可能要杀软先扫一遍，10 秒是上游验证过的上限 */
const HELPER_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 15000;
/** 余额与签到状态每 30 分钟查一次；跨本地零点再补一次 */
const REFRESH_MS = 30 * 60 * 1000;
/** 决策节拍。真正的活儿由下面的条件决定，不是每分钟都发请求 */
const TICK_MS = 60 * 1000;
/** 启动后等一会儿再查，别和首次渲染抢资源 */
const FIRST_DELAY_MS = 3000;
/** 自动领取失败后的冷却，避免一分钟一次地打接口 */
const CLAIM_COOLDOWN_MS = 5 * 60 * 1000;

/* ---------------- 状态 ---------------- */

const cache = {
  enabled: false,
  autoSignin: false,
  /** disabled | loading | ok | error */
  state: "disabled",
  balanceLeft: null,
  balanceExact: null,
  todayCheckedIn: null,
  todayCredit: null,
  streakDays: null,
  updatedAt: 0,
  stale: false,
  reason: "",
  /** 这份数据是哪天取的，用来判跨零点 */
  day: "",
};

/** 解出来的凭据：只活在这个变量里 */
let cred = null;
/**
 * 正在进行的那一轮请求（refresh 或 claim 共用这一个槽位）。
 * kind 必须一起记：撞车时若只交出一个 Promise，调用方没法判断
 * 手里这个是"刷新结果"还是"领取结果"——两者兑现值形状完全不同。
 */
let inflight = null;
/** "refresh" | "claim"，与 inflight 同时置位、同时清空 */
let inflightKind = null;
let claimAt = 0;
let onChange = () => {};
let timer = null;
let firstTimer = null;

function notify() {
  try {
    onChange();
  } catch (_) {
    /* 推送失败不影响数据本身 */
  }
}

/* ---------------- 读设置 ---------------- */

/**
 * 只读 prefs.json 里本模块关心的两个开关。
 * 700ms 缓存是刻意不要的：一分钟才读一次盘，成本可以忽略，
 * 而"用户刚勾上开关却要等一秒"的体感更差。
 */
function readPrefs() {
  let creditSync = false;
  let autoSignin = false;
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
    if (raw && raw.creditSync === true) creditSync = true;
    if (raw && raw.autoSignin === true) autoSignin = true;
  } catch (_) {
    /* 文件不存在或正在被写：按关闭处理，绝不自作主张联网 */
  }
  return { creditSync, autoSignin: creditSync && autoSignin };
}

/* ---------------- 凭据 ---------------- */

const AUTH_CANDIDATES = [
  path.join("CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
  path.join("CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop-ai.info"),
];

/**
 * 读凭据文件。
 *
 * 客户端刷新 token 时会短暂独占这个文件（Windows 上表现为 EPERM/EBUSY），
 * 所以重试三次。不 sleep 阻塞整个事件循环 —— 后端还有采集和 SSE 要跑，
 * 这里用异步等待。
 */
async function readAuthFile() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const tried = [];
  for (const rel of AUTH_CANDIDATES) {
    const p = path.join(local, rel);
    for (let i = 0; i < 3; i++) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        log.credit("凭据命中：" + p);
        return { data };
      } catch (e) {
        if (e.code === "ENOENT") {
          tried.push(p + "（不存在）");
          break; // 这个候选不存在，换下一个
        }
        if (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES") {
          if (i < 2) {
            log.credit("凭据文件被占用，2 秒后重试：" + p + "（" + e.code + "）");
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          log.credit("凭据文件持续被占用（" + e.code + "）：" + p);
          return { error: "凭据文件被占用" };
        }
        // JSON 解析失败也走这里：客户端写了半截文件时会出现
        log.credit("凭据读取失败（" + (e.code || e.name) + "）：" + p + " → " + e.message);
        tried.push(p + "（" + (e.code || e.name) + "）");
        break;
      }
    }
  }
  log.credit("未找到可用凭据，已尝试：\n  " + tried.join("\n  "));
  return { error: "未找到凭据（客户端可能未登录）" };
}

/** 本机实测 auth.endpoint 是 null，只能靠 domain 判版本，再用官方默认值兜底 */
function pickEdition(auth) {
  const domain = String(auth.domain || "").toLowerCase();
  if (domain === "www.workbuddy.ai") {
    return { exeName: "WorkBuddyAI.exe", endpoint: "https://www.workbuddy.ai" };
  }
  return { exeName: "WorkBuddy.exe", endpoint: "https://copilot.tencent.com" };
}

/* ---------------- 定位客户端主程序 ---------------- */

/**
 * 0.6.4 之前只查三个固定目录：
 *   C:\Program Files\WorkBuddy、C:\Program Files (x86)\WorkBuddy、
 *   %LOCALAPPDATA%\Programs\WorkBuddy
 *
 * 我这边是默认装在 C 盘 Program Files，所以一路顺畅；用户机器只要
 * 装在 D 盘、或安装目录名不是 "WorkBuddy"、或是 per-user 的
 * `%LOCALAPPDATA%\Programs\workbuddy` 小写形态，就直接判"未找到客户端程序"，
 * 界面显示"未连接" —— 而这台机器上 WorkBuddy 明明装得好好的。
 *
 * 0.6.5 改成四层搜索，全部只在首次调用时做一遍，结果进缓存：
 *   1. 环境变量给出的标准安装位（含各盘符）
 *   2. 安装根目录下名字含 workbuddy 的子目录
 *   3. 注册表卸载项里的 InstallLocation / DisplayIcon
 *   4. 全部失败则把尝试过的路径写进日志
 */

let exeCache = null;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

let driveList = null;
/**
 * 只查 C/D/E 三个盘。
 *
 * 不遍历 C..Z：空的读卡器槽或光驱在被 stat 时可能挂起好几秒，
 * 而"客户端装在 F 盘以后"的概率极低 —— 那种情况由注册表那一层兜住。
 * 这个函数只跑一次，结果缓存到进程结束。
 */
function drives() {
  if (driveList) return driveList;
  const out = [];
  for (const c of ["C", "D", "E"]) {
    const d = c + ":\\";
    try {
      if (fs.existsSync(d)) out.push(d);
    } catch (_) {
      /* 空的读卡器槽会抛，跳过 */
    }
  }
  driveList = out;
  return out;
}

function standardPlaces(exeName) {
  const out = [];
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.ProgramW6432,
  ].filter(Boolean);
  for (const r of roots) out.push(path.join(r, "WorkBuddy", exeName));

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  out.push(path.join(local, "Programs", "WorkBuddy", exeName));
  out.push(path.join(local, "WorkBuddy", exeName));

  // 装在别的盘的情况：D:\Program Files\WorkBuddy、D:\WorkBuddy……
  for (const d of drives()) {
    out.push(path.join(d, "Program Files", "WorkBuddy", exeName));
    out.push(path.join(d, "Program Files (x86)", "WorkBuddy", exeName));
    out.push(path.join(d, "Programs", "WorkBuddy", exeName));
    out.push(path.join(d, "WorkBuddy", exeName));
  }
  return dedupe(out);
}

/** 安装根目录下，目录名只要含 workbuddy 就进去看一眼（大小写不限） */
function scanRoots(exeName) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    path.join(local, "Programs"),
  ].filter(Boolean);
  const out = [];
  for (const r of roots) {
    let names = [];
    try {
      names = fs.readdirSync(r);
    } catch (_) {
      continue;
    }
    for (const n of names) {
      if (!/workbuddy/i.test(n)) continue;
      out.push(path.join(r, n, exeName));
    }
  }
  return dedupe(out);
}

/**
 * 读注册表的卸载项。
 * Node 没有 winreg，这里 shell 出去调 reg.exe —— 每个 Windows 都有。
 * 输出在中文系统上是 GBK，用 latin1 接：路径是 ASCII，不会因此变形。
 */
function regPlaces(exeName) {
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const out = [];
  for (const k of keys) {
    let txt = "";
    try {
      const buf = execFileSync("reg", ["query", k, "/s", "/f", "WorkBuddy"], {
        encoding: "buffer",
        timeout: 4000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      txt = buf.toString("latin1");
    } catch (_) {
      continue; // 键不存在或没有匹配项
    }
    for (const m of txt.matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g)) {
      const v = m[1].trim().replace(/^"|"$/g, "");
      if (v) out.push(path.join(v, exeName));
    }
    for (const m of txt.matchAll(/DisplayIcon\s+REG_\w+\s+(.+)/g)) {
      const v = m[1].trim().replace(/^"|"$/g, "").replace(/,\d+$/, "");
      if (/\.exe$/i.test(v)) out.push(v);
    }
  }
  return dedupe(out);
}

/**
 * 最后一道：从正在运行的进程取路径。
 *
 * 覆盖"绿色版 / 解压版 / 改了目录名 / 没有注册表项"这些前面都抓不到的情况。
 * 用户开着面板时客户端必然在运行，所以这条命中率不低。
 * 代价是一次 PowerShell 冷启动（1~2 秒），因此放在最后一层。
 */
function processPlaces(exeName) {
  const procName = exeName.replace(/\.exe$/i, "");
  try {
    const buf = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process -Name '" + procName + "' -ErrorAction SilentlyContinue | " +
          "Select-Object -First 1 -ExpandProperty Path)",
      ],
      {
        encoding: "buffer",
        timeout: 6000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    // PowerShell 的输出带 BOM，路径为 ASCII，用 utf8 读并去空白即可
    const p = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (p && /\.exe$/i.test(p)) return [p];
  } catch (_) {
    /* 没有这个进程，或 PowerShell 不可用 */
  }
  return [];
}

function locateExe(exeName) {
  const tried = [];
  /*
   * 顺序按"命中率 × 代价"排：
   * 前两层是纯 stat/readdir，毫秒级；
   * 进程层要拉一次 PowerShell（1~2 秒），但最可靠 —— 用户开着面板时客户端必然在运行；
   * 注册表层放最后：它依赖安装器写过注册表，绿色版没有，且 reg.exe 可能被安全软件拦截。
   *
   * 必须惰性求值：写成 `[label, list]` 的数组字面量会把四层全部先算一遍，
   * 于是第一层命中时也照样付 PowerShell 与 reg.exe 的代价。实测能拖慢首次刷新 0.5~3 秒。
   */
  const layers = [
    ["常见安装位置", () => standardPlaces(exeName)],
    ["目录名含 workbuddy", () => scanRoots(exeName)],
    ["运行中的进程", () => processPlaces(exeName)],
    ["注册表卸载项", () => regPlaces(exeName)],
  ];
  for (const [label, collect] of layers) {
    for (const p of collect()) {
      if (isFile(p)) {
        log.credit("客户端命中（" + label + "）：" + p);
        return { path: p };
      }
      tried.push(label + " → " + p);
    }
  }
  log.credit(
    "未找到客户端 " + exeName + "，共尝试 " + tried.length + " 个位置：\n  " +
      tried.slice(0, 60).join("\n  ") +
      (tried.length > 60 ? "\n  …还有 " + (tried.length - 60) + " 个" : "")
  );
  return { error: "未找到客户端程序" };
}

/** 结果缓存到进程结束：装完客户端不用重启面板，但也不必每 30 分钟扫一次盘 */
function findExe(exeName) {
  if (exeCache && exeCache.exeName === exeName) return exeCache.result;
  const result = locateExe(exeName);
  // 找不到也缓存，否则每轮刷新都要扫一遍所有盘
  exeCache = { exeName, result };
  return result;
}

function runHelper(exe, request) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(exe, ["-e", fs.readFileSync(HELPER_FILE, "utf8")], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      log.credit("拉起解密进程失败：" + (e && e.message));
      return resolve({ error: "客户端无法启动" });
    }
    log.credit("拉起解密进程 pid=" + (child.pid || "?") + "，exe=" + exe);
    let out = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      log.credit(
        "解密进程结束：" +
          (r.error ? "失败「" + r.error + "」" : "成功") +
          "，耗时 " + (Date.now() - started) + "ms"
      );
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      finish({ error: "解密超时" });
    }, HELPER_TIMEOUT);

    child.stdout.on("data", (d) => {
      if (out.length < 65536) out += d.toString("utf8");
    });
    child.stderr.on("data", () => {}); // 不收集：里面可能带路径，没有排查价值
    child.on("error", (e) =>
      finish({ error: "客户端无法启动" + (e && e.code ? "（" + e.code + "）" : "") })
    );
    child.on("close", () => {
      let reply = null;
      try {
        reply = JSON.parse(out.trim());
      } catch (_) {
        /* 落到下面统一判错 */
      }
      if (!reply) return finish({ error: "解密进程返回异常" });
      if (!reply.ok) {
        const map = {
          RUNTIME_UNAVAILABLE: "客户端未登录",
          KEY_MISMATCH: "客户端版本与凭据不匹配",
          UNSUPPORTED_ENVELOPE: "凭据格式不支持",
          DECRYPT_FAILED: "凭据解不开",
          INVALID_FORMAT: "凭据格式异常",
        };
        return finish({ error: map[reply.reason] || "解密失败" });
      }
      finish({ reply });
    });

    try {
      child.stdin.end(JSON.stringify(request), "utf8");
    } catch (_) {
      finish({ error: "解密进程无法写入" });
    }
  });
}

/**
 * 拿到可用凭据（必要时解一次）。
 *
 * 为什么要缓存：每次解都要拉起一个 195 MB 的客户端进程（实测 150ms，
 * 但不能一天拉 48 次）。按 expiresAt 提前 60 秒失效，过期前一直复用。
 */
async function ensureCredentials() {
  const now = Date.now();
  if (cred && cred.expiresAt - 60000 > now) return cred;

  const a = await readAuthFile();
  if (a.error) throw new Error(a.error);
  const A = (a.data && a.data.auth) || {};
  const ACC = (a.data && a.data.account) || {};

  const uid = String(ACC.uid || "");
  if (!uid) throw new Error("凭据里没有用户标识");
  if (!A.accessToken || !A.accessToken.$wbEncrypted) throw new Error("凭据格式异常");

  const ed = pickEdition(A);
  log.credit(
    "凭据已读到：uid=" + log.mask(uid) +
      " domain=" + (A.domain || "（空）") +
      " → 客户端 " + ed.exeName + "，端点 " + ed.endpoint
  );
  const ex = findExe(ed.exeName);
  if (ex.error) throw new Error(ex.error);

  const dec = await runHelper(ex.path, { version: 1, operation: "decrypt", value: A.accessToken });
  if (dec.error) throw new Error(dec.error);

  const exp = Number(A.expiresAt);
  cred = {
    token: dec.reply.accessToken,
    uid,
    domain: String(A.domain || ""),
    endpoint: String(A.endpoint || ed.endpoint).replace(/\/+$/, ""),
    expiresAt: Number.isFinite(exp) && exp > 0 ? exp : now + 10 * 60 * 1000,
  };
  return cred;
}

/* ---------------- 请求 ---------------- */

function headersFor(c) {
  const h = {
    Accept: "application/json",
    Authorization: "Bearer " + c.token,
    "Content-Type": "application/json",
    "X-User-Id": c.uid,
    "User-Agent": "WorkBuddy",
  };
  // 少了这个头会落到错误租户，实测必带
  if (c.domain) h["X-Domain"] = c.domain;
  return h;
}

/**
 * 发一个 POST。
 * body 传 undefined 表示"不带请求体"（签到两个接口就是这样），
 * 传 "{}" 才是空对象 —— 两者服务端行为不同，别图省事统一。
 */
async function post(url, headers, body) {
  // 日志里只留路径，域名单独记一次就够，避免每行都拖一串前缀
  const where = url.replace(/^https?:\/\/[^/]+/, "");
  const t0 = Date.now();
  const init = { method: "POST", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) };
  if (body !== undefined) init.body = body;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      /* 非 JSON 响应按失败处理，不猜 */
    }
    const code = json && json.code;
    log.net(
      "POST " + where + " → " + res.status +
        "（" + (Date.now() - t0) + "ms）" +
        (code !== undefined && code !== null ? " code=" + code : "") +
        (json === null && text ? " 响应非 JSON，前 120 字符：" + text.slice(0, 120) : "")
    );
    return { status: res.status, json };
  } catch (e) {
    const why = e && e.name === "TimeoutError" ? "超时（" + REQUEST_TIMEOUT + "ms）" : (e && e.message) || "未知";
    log.net("POST " + where + " 失败：" + why + "（" + (Date.now() - t0) + "ms）");
    return { error: "请求超时或网络不通" };
  }
}

function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 数值字段的严格取值：把"字段缺失"和"值确实是 0"分开。
 *
 * JS 里 Number(null)、Number("")、Number(false) 全都等于 0，
 * 所以 `Number.isFinite(Number(v))` 会把"不知道"写成 0 ——
 * 界面上就会少显示一个数字，而不会显示 "—"。
 * 签到类字段的语义是"0 也是一个有意义的答案"，因此必须先排掉空值再转。
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function localDay() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
}

/* ---------------- 业务动作 ---------------- */

/**
 * 查一次签到状态 + 余额。
 *
 * 余额失败不影响签到状态：两个接口互不依赖，一个挂了不该把另一个的结果也丢掉。
 * 有旧数据时保留旧值并标 stale，界面上是"数据可能有点旧"，不是"清零"。
 */
async function refresh() {
  /**
   * 双保险：调度器会先判开关，但 /api/credit/refresh 是公开端点，
   * 理论上可以被直接调用。开关关着时绝不联网 —— 这条检查放在最前面。
   */
  const p = readPrefs();
  if (!p.creditSync) {
    if (cache.state !== "disabled" || cache.enabled) {
      resetToDisabled();
      notify();
    }
    return;
  }
  /**
   * 手动刷新不会经过 tick()，所以这里也要把开关状态落到缓存上。
   * 漏了这一步的后果很微妙：数据明明取到了，getInfo() 却因为
   * cache.enabled 还是 false 而报 "disabled"，界面显示"未开启"。
   */
  cache.enabled = true;
  cache.autoSignin = p.autoSignin;
  if (inflight) return inflight;
  const task = (async () => {
    if (!cache.updatedAt) {
      cache.state = "loading";
      cache.reason = "";
      notify();
    }
    try {
      const c = await ensureCredentials();
      const H = headersFor(c);
      log.credit("开始刷新：端点 " + c.endpoint);

      const st = await post(c.endpoint + "/v2/billing/meter/checkin-activity-status", H);
      if (st.status === 401 || st.status === 403) {
        cred = null; // 令牌作废，下次重新解
        throw new Error("登录已过期，请在客户端重新登录");
      }
      if (st.error) throw new Error(st.error);
      if (!(st.status >= 200 && st.status < 300)) throw new Error("签到接口返回 " + st.status);

      const d = (st.json && st.json.data) || st.json || {};
      cache.todayCheckedIn = d.today_checked_in === true;
      /* 今日积分：字段缺失时退到 daily_credit（上游客户端也是这么兜的），
         两者都没有就留 null，界面显示 "—"，不假装成 0 */
      cache.todayCredit = numOrNull(d.today_credit ?? d.daily_credit);
      cache.streakDays = numOrNull(d.streak_days);

      /* total_credits 是历史累计签到量，不是余额 —— 这里不读它 */

      const rs = await post(c.endpoint + "/billing/meter/get-user-resource-summary", H, "{}");
      if (!rs.error && rs.status >= 200 && rs.status < 300 && rs.json && rs.json.data) {
        const pkgs = Array.isArray(rs.json.data.Packages) ? rs.json.data.Packages : [];
        let left = 0;
        for (const p of pkgs) left += toCount(p.CycleRemainCapacity);
        cache.balanceExact = Math.round(left * 100) / 100;
        // 显示取整用 floor：宁可少报，不能让人以为点数比实际多
        cache.balanceLeft = Math.floor(left);
        cache.stale = false;
      } else if (cache.balanceLeft === null) {
        // 从来没有过余额数据，只能留空
        cache.stale = false;
      } else {
        cache.stale = true; // 有旧值就留着，别闪成""
      }

      cache.state = "ok";
      cache.reason = "";
      cache.updatedAt = Date.now();
      cache.day = localDay();
      log.credit(
        "刷新成功：余额 " + (cache.balanceLeft === null ? "未知" : cache.balanceLeft) +
          "，今日" + (cache.todayCheckedIn ? "已签" : "未签") +
          "，今日积分 " + (cache.todayCredit === null ? "未知" : cache.todayCredit) +
          "，连签 " + (cache.streakDays === null ? "未知" : cache.streakDays) + " 天"
      );
    } catch (e) {
      cache.state = "error";
      cache.reason = (e && e.message) || "查询失败";
      log.credit("刷新失败：" + cache.reason);
      // 有上一次的成功数据就不动它，只把状态标成"这次没更新"
      if (cache.updatedAt) cache.stale = true;
      else {
        cache.balanceLeft = null;
        cache.balanceExact = null;
        cache.todayCheckedIn = null;
      }
    }
    notify();
  })();
  inflight = task;
  inflightKind = "refresh";
  try {
    return await task;
  } finally {
    inflight = null;
    inflightKind = null;
  }
}

/**
 * 领今日积分。
 *
 * 幂等：已领过时服务端返回 HTTP 400 + code 10001（或响应体 null），
 * 这两种都算成功 —— 否则每天第二次点按钮就会报错，用户以为坏了。
 */
async function claim() {
  if (!readPrefs().creditSync) return { ok: false, reason: "积分功能未开启" };
  /**
   * 撞上在飞的请求就明确拒绝，绝不把别人的 Promise 当成自己的结果交出去。
   *
   * 旧写法是 `if (inflight) return inflight;`：若在飞的是 refresh，
   * 它的兑现值是 undefined，claimNow() 里读 r.ok 当场抛 TypeError，
   * 用户只得到一句笼统的"领取失败"，而真实原因只是"后台正在刷新"。
   * 这里按类型给出可读原因，前端会把它显示在提示行里。
   */
  if (inflight) {
    return {
      ok: false,
      reason: inflightKind === "claim" ? "正在领取中，请稍后再试" : "正在刷新中，请稍后再试",
    };
  }
  const task = (async () => {
    try {
      const c = await ensureCredentials();
      const H = headersFor(c);
      const r = await post(c.endpoint + "/v2/billing/meter/daily-checkin", H);
      if (r.error) throw new Error(r.error);
      const code = r.json && r.json.code;
      if (r.status === 401 || r.status === 403) {
        cred = null;
        throw new Error("登录已过期，请在客户端重新登录");
      }
      const already = r.status === 400 && (code === 10001 || String((r.json && r.json.msg) || "").includes("已签"));
      if (!(r.status >= 200 && r.status < 300) && !already) {
        throw new Error("领取失败（" + r.status + "）");
      }
      // 领完立刻把状态改成已领，界面不用等下一轮刷新
      cache.todayCheckedIn = true;
      if (cache.state === "error") {
        cache.state = "ok";
        cache.reason = "";
      }
      cache.updatedAt = Date.now();
      claimAt = Date.now();
      notify();
      log.credit("领取成功（或今日已领，幂等通过）");
      // 余额会变，顺手刷一次；失败也不影响"已领取"这个结论
      setTimeout(() => {
        refresh().catch(() => {});
      }, 800);
      return { ok: true };
    } catch (e) {
      claimAt = Date.now();
      cache.reason = (e && e.message) || "领取失败";
      log.credit("领取失败：" + cache.reason);
      notify();
      return { ok: false, reason: cache.reason };
    }
  })();
  inflight = task;
  inflightKind = "claim";
  try {
    return await task;
  } finally {
    inflight = null;
    inflightKind = null;
  }
}

/* ---------------- 调度 ---------------- */

function resetToDisabled() {
  cache.enabled = false;
  cache.autoSignin = false;
  cache.state = "disabled";
  cache.balanceLeft = null;
  cache.balanceExact = null;
  cache.todayCheckedIn = null;
  cache.todayCredit = null;
  cache.streakDays = null;
  cache.updatedAt = 0;
  cache.stale = false;
  cache.reason = "";
  cache.day = "";
  cred = null; // 关掉就把令牌也丢掉，不留内存里的残留
}

/**
 * 每分钟做一次判断：
 *   · 开关关着 → 什么也不做（连文件都不读第二遍以外的动作都没有）
 *   · 刚打开 / 超过 30 分钟 / 跨了零点 → 查一次
 *   · 已确认今天没领，且开了自动领取 → 领一次（失败有 5 分钟冷却）
 *
 * 刻意不用高频定时器：签到是"一天一次"的事，1.5 秒的渲染循环挂它纯属浪费。
 */
async function tick() {
  const p = readPrefs();
  if (!p.creditSync) {
    if (cache.enabled || cache.state !== "disabled") {
      resetToDisabled();
      notify();
    }
    return;
  }
  const becameOn = !cache.enabled;
  cache.enabled = true;
  cache.autoSignin = p.autoSignin;

  const now = Date.now();
  const needRefresh =
    becameOn || !cache.updatedAt || now - cache.updatedAt > REFRESH_MS || cache.day !== localDay();

  try {
    if (needRefresh) await refresh();
    if (
      cache.state === "ok" &&
      cache.todayCheckedIn === false &&
      p.autoSignin &&
      now - claimAt > CLAIM_COOLDOWN_MS
    ) {
      await claim();
    }
  } catch (_) {
    /* refresh/claim 自己已经把失败写进 state，这里不用再管 */
  }
}

/** 同步给快照用。白名单到字段级别 —— 绝不把响应原文或令牌漏出去。 */
function getInfo() {
  return {
    enabled: cache.enabled,
    autoSignin: cache.autoSignin,
    state: cache.enabled ? cache.state : "disabled",
    balanceLeft: cache.balanceLeft,
    balanceExact: cache.balanceExact,
    todayCheckedIn: cache.todayCheckedIn,
    todayCredit: cache.todayCredit,
    streakDays: cache.streakDays,
    updatedAt: cache.updatedAt,
    stale: cache.stale,
    reason: cache.reason,
  };
}

/** 设置变更后立刻生效，不用等下一分钟 */
function poke() {
  tick().catch(() => {});
}

function start(cb) {
  if (typeof cb === "function") onChange = cb;
  if (timer) return;
  const p = readPrefs();
  log.credit(
    "调度启动：积分同步=" + (p.creditSync ? "开" : "关") +
      "，自动领取=" + (p.autoSignin ? "开" : "关") +
      "，首次查询 " + FIRST_DELAY_MS + "ms 后"
  );
  firstTimer = setTimeout(() => {
    poke();
  }, FIRST_DELAY_MS);
  timer = setInterval(() => {
    poke();
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
  cred = null;
  inflight = null;
  inflightKind = null;
}

/** 手动刷新：不管 30 分钟节流，立刻查一次 */
async function refreshNow() {
  await refresh();
  return getInfo();
}

/** 手动领取：界面上那个"点击补领"走这里 */
async function claimNow() {
  /* claim() 正常都会回对象；这层 || {} 是防御最后一道，
     免得将来某条新分支返回空值又把 TypeError 带回来 */
  const r = (await claim()) || {};
  return { ok: !!r.ok, reason: r.reason || "", creditInfo: getInfo() };
}

module.exports = { start, stop, getInfo, refreshNow, claimNow, poke };
