"use strict";

/**
 * 渲染层：把服务端的快照画成面板，并处理设置。
 *
 * 两种运行方式：
 *   - Electron 内：通过 window.hud（preload 暴露）读写真实设置、调整窗口高度
 *   - 浏览器预览：退化为 localStorage，快捷键与置顶不生效（不报错）
 */

const $ = (id) => document.getElementById(id);

const bridge = window.hud || null;

const DEFAULT_PREFS = {
  stepCount: 6,
  thinkingLines: 6,
  blocks: { thinking: true, steps: true, metrics: true, credit: true, model: true, perm: true },
  shortcut: "Control+Alt+W",
  alwaysOnTop: true,
  manualHeight: false,
  pinnedSession: "",
  gate: "risky", // off | risky | all
  gateTimeout: "hold", // hold | deny10 | pass1
  logAsk: "ask", // ask = 退出前弹一次确认；never = 直接退
  creditSync: false, // 需联网；关着时后端不读凭据、不发任何请求
  autoSignin: false, // 每日自动领取 100 积分，仅在 creditSync 开启时生效
};

/** 状态 → 文案与解释。颜色在 CSS 里按状态类名绑定。 */
const STATUS_META = {
  idle: { label: "空闲", hint: "没有活跃会话" },
  thinking: { label: "思考中", hint: "模型在推理，不需要你操作" },
  working: { label: "执行中", hint: "正在执行工具，不需要你操作" },
  review: { label: "读取中", hint: "正在读文件或搜索，不需要你操作" },
  waiting: { label: "等你确认", hint: "WorkBuddy 弹了权限窗，要你在它的窗口里点允许或拦截" },
  reply: { label: "等你回话", hint: "这一轮已经答完，最后一句是在问你 —— 直接回它就行，没有要点的按钮" },
  done: { label: "已完成", hint: "本轮结束，可以看结果" },
  failed: { label: "出错", hint: "工具或请求失败" },
};

const STEP_MARK = { done: "✓", running: "▶", failed: "✕", pending: "○" };

/* ---------------- 状态灯 ----------------
 * 用内联 SVG 画圆：viewBox 固定 8×8，外层盒子怎么被挤，圆都只是等比缩小，
 * 画不出椭圆（这是它相对 div + border-radius 的唯一意义）。
 */
const DOT_SVG =
  '<svg viewBox="0 0 8 8" aria-hidden="true" focusable="false"><circle cx="4" cy="4" r="4"></circle></svg>';

function makeDot(cls) {
  const d = document.createElement("i");
  d.className = "dot " + (cls || "idle");
  d.innerHTML = DOT_SVG;
  return d;
}

/** 给页面上静态写死的圆点补上 SVG（图例里那五个） */
function hydrateDots() {
  for (const d of document.querySelectorAll(".dot")) {
    if (!d.firstElementChild) d.innerHTML = DOT_SVG;
  }
}

const el = {
  app: $("app"),
  dot: $("dot"),
  status: $("status"),
  model: $("model"),
  title: $("title"),
  scroll: $("scroll"),
  content: $("content"),
  thinking: $("thinking"),
  thinkAt: $("think-at"),
  steps: $("steps"),
  stepCount: $("step-count"),
  credit: $("m-credit"),
  token: $("m-token"),
  tokenSub: $("m-token-sub"),
  ctx: $("m-ctx"),
  bar: $("m-bar"),
  perm: $("perm"),
  permTitle: $("perm-title"),
  permRisk: $("perm-risk"),
  permText: $("perm-text"),
  permTarget: $("perm-target"),
  permCopy: $("btn-perm-copy"),
  permLeft: $("perm-left"),
  permActions: $("perm-actions"),
  permNote: $("perm-note"),
  meta: $("meta"),
  conn: $("conn"),
  connText: $("conn-text"),
  fold: $("btn-fold"),
  close: $("btn-close"),
  settings: $("btn-settings"),
  allow: $("btn-allow"),
  deny: $("btn-deny"),

  sessBtn: $("btn-sess"),
  sessLabel: $("sess-label"),
  sessMenu: $("sess-menu"),
  sessList: $("sess-list"),

  blkThinking: $("blk-thinking"),
  blkSteps: $("blk-steps"),
  blkMetrics: $("blk-metrics"),
  blkCredit: $("blk-credit"),
  creditLeft: $("credit-left"),
  creditSignin: $("credit-signin"),
  creditTip: $("credit-tip"),
  creditWhy: $("credit-why"),
  creditRefresh: $("credit-refresh"),
  creditClaim: $("credit-claim"),
  setCreditSync: $("set-credit-sync"),
  setAutoSignin: $("set-auto-signin"),
  creditMsg: $("credit-msg"),

  sheet: $("sheet"),
  sheetClose: $("sheet-close"),
  setSteps: $("set-steps"),
  setLines: $("set-lines"),
  valSteps: $("val-steps"),
  valLines: $("val-lines"),
  chkThinking: $("blk-thinking-c"),
  chkSteps: $("blk-steps-c"),
  chkMetrics: $("blk-metrics-c"),
  chkCredit: $("blk-credit-c"),
  chkModel: $("blk-model-c"),
  chkPerm: $("blk-perm-c"),
  setOnTop: $("set-ontop"),
  btnKey: $("btn-key"),
  keyMsg: $("key-msg"),
  btnAutoHeight: $("btn-autoheight"),
  autoMsg: $("autoheight-msg"),
  btnReset: $("btn-reset"),
  setGate: $("set-gate"),
  gateMsg: $("gate-msg"),
  permBlockMsg: $("perm-block-msg"),
  setWait: $("set-timeout"),
  setLogAsk: $("set-logask"),
  valLogSize: $("val-logsize"),
  btnClearLog: $("btn-clear-log"),
  logMsg: $("log-msg"),
  diagPath: $("diag-path"),
  valDiagSize: $("val-diag-size"),
  btnDiagOpen: $("btn-diag-open"),
  btnDiagClear: $("btn-diag-clear"),
};

let prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
let shortcutError = null;

let lastSeq = -1;
let cached = null;
let lastThinking = null;
let currentModel = "";

/* ---------------- 小工具 ---------------- */

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(1) + "万";
  return String(Math.round(v));
}

function fmtK(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1000) return Math.round(v / 1000) + "k";
  return String(Math.round(v));
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  // 再往上就不该用小时了：老任务显示"336 小时前"，没人愿意心算那是几天
  const d = Math.round(s / 86400);
  if (d < 7) return d + " 天前";
  if (d < 30) return Math.round(d / 7) + " 周前";
  if (d < 365) return Math.round(d / 30) + " 个月前";
  return Math.round(d / 365) + " 年前";
}

function prettyAccel(a) {
  if (!a) return "未设置";
  return a.replace(/Control/g, "Ctrl").replace(/Super/g, "Win");
}

/* ---------------- 设置：应用与存盘 ---------------- */

function applyPrefs(patch) {
  if (!patch) return;

  const beforeSteps = prefs.stepCount;
  const beforeBlocks = JSON.stringify(prefs.blocks);
  const beforePin = prefs.pinnedSession;

  if (patch.stepCount !== undefined) {
    prefs.stepCount = clampInt(patch.stepCount, 1, 10, prefs.stepCount);
  }
  if (patch.thinkingLines !== undefined) {
    prefs.thinkingLines = clampInt(patch.thinkingLines, 2, 10, prefs.thinkingLines);
  }
  if (patch.blocks && typeof patch.blocks === "object") {
    for (const k of Object.keys(DEFAULT_PREFS.blocks)) {
      if (typeof patch.blocks[k] === "boolean") prefs.blocks[k] = patch.blocks[k];
    }
  }
  if (typeof patch.alwaysOnTop === "boolean") prefs.alwaysOnTop = patch.alwaysOnTop;
  if (typeof patch.manualHeight === "boolean") prefs.manualHeight = patch.manualHeight;
  if (typeof patch.shortcut === "string") prefs.shortcut = patch.shortcut;
  if (typeof patch.pinnedSession === "string") prefs.pinnedSession = patch.pinnedSession;
  if (patch.gate === "off" || patch.gate === "risky" || patch.gate === "all") prefs.gate = patch.gate;
  if (patch.gateTimeout === "hold" || patch.gateTimeout === "deny10" || patch.gateTimeout === "pass1") {
    prefs.gateTimeout = patch.gateTimeout;
  }
  if (typeof patch.creditSync === "boolean") prefs.creditSync = patch.creditSync;
  if (typeof patch.autoSignin === "boolean") prefs.autoSignin = patch.autoSignin;
  if (patch.shortcutError !== undefined) shortcutError = patch.shortcutError;

  applyPrefsToDom();
  syncSettingsUI();
  scheduleMeasure();

  // 只有影响列表内容的变化才重绘，避免拖滑块时列表闪烁
  if (
    cached &&
    (beforeSteps !== prefs.stepCount ||
      beforeBlocks !== JSON.stringify(prefs.blocks) ||
      beforePin !== prefs.pinnedSession)
  ) {
    lastSeq = -1;
    render(cached);
  }
}

/** 把设置落到 DOM：区块显隐、思考区最大高度 */
function applyPrefsToDom() {
  el.blkThinking.classList.toggle("off", !prefs.blocks.thinking);
  el.blkSteps.classList.toggle("off", !prefs.blocks.steps);
  el.blkMetrics.classList.toggle("off", !prefs.blocks.metrics);
  el.blkCredit.classList.toggle("off", !prefs.blocks.credit);
  el.perm.classList.toggle("off", !prefs.blocks.perm);

  updateModelChip(currentModel);
  layoutThinking();
}

function updateModelChip(name) {
  currentModel = name || "";
  el.model.textContent = currentModel || "";
  el.model.title = currentModel || "";
  el.model.classList.toggle("off", !prefs.blocks.model || !currentModel);
}

function syncSettingsUI() {
  if (!el.sheet) return;

  if (document.activeElement !== el.setSteps) {
    el.setSteps.value = String(prefs.stepCount);
  }
  el.valSteps.textContent = String(prefs.stepCount);

  if (document.activeElement !== el.setLines) {
    el.setLines.value = String(prefs.thinkingLines);
  }
  el.valLines.textContent = String(prefs.thinkingLines);

  el.chkThinking.checked = !!prefs.blocks.thinking;
  el.chkSteps.checked = !!prefs.blocks.steps;
  el.chkMetrics.checked = !!prefs.blocks.metrics;
  el.chkCredit.checked = !!prefs.blocks.credit;
  el.chkModel.checked = !!prefs.blocks.model;
  el.chkPerm.checked = !!prefs.blocks.perm;

  el.setOnTop.checked = !!prefs.alwaysOnTop;

  if (el.setCreditSync) el.setCreditSync.checked = !!prefs.creditSync;
  if (el.setAutoSignin) {
    el.setAutoSignin.checked = !!prefs.autoSignin;
    // 总开关关着时，"自动领取"没有意义 —— 置灰而不是偷偷生效
    el.setAutoSignin.disabled = !prefs.creditSync;
  }
  if (el.creditMsg) {
    el.creditMsg.className = "msg explain";
    el.creditMsg.textContent = prefs.creditSync
      ? "已开启：面板会直连 WorkBuddy 官方接口查余额与签到，凭据只在内存里用，不落盘、不上传。"
      : "默认关闭：关着时面板不联网、也不读登录凭据。开启后只直连 WorkBuddy 官方接口查余额和签到，凭据只在内存里用一下，不落盘、不上传。自动领取只在你开着开关、且当天确实还没领时才动手。";
  }

  // 高度模式：手动拖过就明说，否则用户不知道为什么内容变短窗口不变
  if (el.autoMsg) {
    if (prefs.manualHeight) {
      el.autoMsg.textContent =
        "当前：手动高度（你拖过一次）。内容再变化窗口也不会自己动了，点上面的按钮交还给自适应。";
      el.autoMsg.className = "hint warn";
    } else {
      el.autoMsg.textContent =
        "当前：自适应。显示哪些区块，窗口就有多高；手动拖过一次后会自动切换到手动模式。";
      el.autoMsg.className = "msg explain";
    }
  }
  if (document.activeElement !== el.setGate) el.setGate.value = prefs.gate;
  if (el.setWait && document.activeElement !== el.setWait) el.setWait.value = prefs.gateTimeout;
  if (el.setLogAsk) el.setLogAsk.checked = prefs.logAsk !== "never";
  renderGateHint();

  // 录制中不要覆盖按钮上的"按下组合键…"
  if (!recording) el.btnKey.textContent = prettyAccel(prefs.shortcut);

  if (shortcutError) setMsg(shortcutError, false);
}

let saveTimer = null;

/** 本地立即生效，落盘延后 100ms 合并（拖滑块时不会疯狂写盘） */
function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 100);
}

/**
 * 立刻落盘，不等 100ms 防抖。
 *
 * 积分开关必须走这条：后端是"读文件判断开没开"的，
 * 如果我这边刚勾上就去请求刷新，而文件还是旧的 false，
 * 后端会老老实实回一句"未开启"，看起来像开关没生效。
 */
async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await flushSave();
}

async function flushSave() {
  saveTimer = null;
  const payload = {
    stepCount: prefs.stepCount,
    thinkingLines: prefs.thinkingLines,
    blocks: { ...prefs.blocks },
    alwaysOnTop: prefs.alwaysOnTop,
    pinnedSession: prefs.pinnedSession || "",
    gate: prefs.gate,
    gateTimeout: prefs.gateTimeout,
    logAsk: prefs.logAsk,
    creditSync: !!prefs.creditSync,
    autoSignin: !!prefs.autoSignin,
  };

  if (bridge && bridge.prefs && typeof bridge.prefs.set === "function") {
    try {
      const saved = await bridge.prefs.set(payload);
      // 主进程会做范围校验并回传最终值，以它为准
      if (saved) applyPrefs(saved);
    } catch (_) {
      /* 主进程不在，忽略 */
    }
    return;
  }

  try {
    localStorage.setItem("hud-prefs", JSON.stringify(prefs));
  } catch (_) {
    /* 浏览器隐私模式，忽略 */
  }
}

/* ---------------- 高度自适应 ---------------- */

let measureRaf = null;
let measureTimer = null;
let lastSentHeight = 0;

function scheduleMeasure() {
  if (measureRaf) return;

  measureRaf = requestAnimationFrame(() => {
    measureRaf = null;
    measureNow();
  });

  /**
   * 兜底：窗口刚创建、尚未合成或处于后台时，requestAnimationFrame 会被节流甚至不执行，
   * 导致"启动后面板高度停在旧值、不跟随内容收缩"。这里用一个普通定时器保证至少测一次。
   */
  clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    measureTimer = null;
    if (measureRaf) {
      cancelAnimationFrame(measureRaf);
      measureRaf = null;
    }
    measureNow();
  }, 120);
}

function measureNow() {
  if (!bridge || typeof bridge.autoHeight !== "function") return;
  if (el.app.classList.contains("folded")) return;
  if (!el.sheet.classList.contains("hidden")) return; // 设置打开时不动窗口

  const hd = document.querySelector(".hd");
  const ft = document.querySelector(".ft");
  if (!hd || !ft || !el.content) return;

  const natural = Math.ceil(hd.offsetHeight + el.content.offsetHeight + ft.offsetHeight + 2);
  if (Math.abs(natural - lastSentHeight) <= 1) return;

  lastSentHeight = natural;
  bridge.autoHeight(natural);
}

/* ---------------- 思考区：文本清洗与按行裁剪 ----------------
 * 两个问题都在这里解决：
 *   1. 模型输出里夹着大量连续空行（块与块拼接还会再加空行），一行空行就是 18px 浪费。
 *   2. 用 max-height 时容器高度不等于整数行，滚动到底部会露出半行字。
 * 做法：先把空行压到"最多一个"，再用固定行高把容器裁成 N 行的整数倍。
 */

let thinkFollow = true; // true = 跟着最新内容滚到底；你手动往上翻时自动变 false

/**
 * 按段落渲染，而不是把整段文本塞进一个 pre-wrap 节点。
 * 原因：pre-wrap 里一个空行就占满一整行（18px），6 行的窗口里出现 2–3 个空行，
 * 真正的内容只剩一半。按段落拆开后，段与段之间只留 3px，空行不再占位。
 */
function renderThinking(text) {
  const n = el.thinking;
  if (!text) {
    n.textContent = "暂无思考内容";
    n.classList.add("empty");
    return;
  }

  const paras = String(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t\u00a0]+$/gm, "").trim())
    .filter(Boolean);

  if (!paras.length) {
    n.textContent = "暂无思考内容";
    n.classList.add("empty");
    return;
  }

  n.classList.remove("empty");
  n.innerHTML = "";
  for (const p of paras) {
    const d = document.createElement("div");
    d.className = "tp";
    d.textContent = p;
    n.appendChild(d);
  }
}

function thinkLineHeight() {
  const v = parseFloat(getComputedStyle(el.thinking).lineHeight);
  return Number.isFinite(v) && v > 0 ? v : 18;
}

/**
 * 容器高度 = min(内容自然高度, 设定行数 × 行高)。
 * 因为文本每行都是整数倍行高，容器也是整数倍，滚到底部时顶部正好落在行边界，
 * 不会再出现"第一行只露出下半截"。
 */
function layoutThinking() {
  const n = el.thinking;
  if (!n) return;

  // 区块被隐藏时量不出真实高度，等重新显示再量（勾选变化会再次调用本函数）
  if (!n.offsetParent) return;

  const lh = thinkLineHeight();
  const maxH = Math.round(prefs.thinkingLines * lh);

  n.style.height = "auto";
  const natural = n.scrollHeight;
  const h = Math.min(natural, maxH);
  n.style.height = Math.max(lh, h) + "px";

  if (thinkFollow) n.scrollTop = n.scrollHeight - n.clientHeight;
  updateThinkingFade();
}

/** 内容超出设定行数、且不在底部时，底部做渐隐提示 */
function updateThinkingFade() {
  const n = el.thinking;
  if (!n) return;
  const over = n.scrollHeight > n.clientHeight + 2;
  const atBottom = n.scrollTop + n.clientHeight >= n.scrollHeight - 4;
  const atTop = n.scrollTop <= 2;
  n.classList.toggle("overflow", over && !atBottom);
  n.classList.toggle("overflow-up", over && !atTop);
}

/* ---------------- 会话选择 ----------------
 * 两个会话同时跑时，服务端按"谁刚动过谁在前"排序，面板会跟着来回跳。
 * 这里允许锁定一个会话；锁定的会话消失后自动解除，退回跟随。
 */

function findPinned(snap) {
  if (!prefs.pinnedSession) return null;
  return (snap.sessions || []).find((x) => x.id === prefs.pinnedSession) || null;
}

/** 被固定、但在事件流里没有实时数据的老任务（还没活动，或被 WorkBuddy 重启过） */
function findPinnedTask(snap) {
  if (!prefs.pinnedSession) return null;
  const list = Array.isArray(snap.tasks) ? snap.tasks : [];
  return list.find((t) => t.id === prefs.pinnedSession) || null;
}

function pickSession(snap) {
  const hit = findPinned(snap);
  if (hit) return hit;

  if (prefs.pinnedSession) {
    // 任务还在库里、只是当前没活动：别解除锁定，交给 renderTaskOnly 显示"空闲"
    if (findPinnedTask(snap)) return null;
    // 锁定目标真的不存在了（任务被删 / 换库）：退回自动跟随
    prefs.pinnedSession = "";
    queueSave();
  }
  return snap.selected || null;
}

/**
 * 任务列表的数据源。
 * 优先用服务端从任务库读来的 tasks；万一读不到库，退回事件流里的会话，
 * 至少不会变成空列表。
 */
function taskRows(snap) {
  const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
  if (tasks.length) return tasks;
  return (snap.sessions || []).map((x) => ({
    id: x.id,
    title: x.title || x.userPrompt || "未命名会话",
    status: x.status,
    updatedAt: x.updatedAt,
  }));
}

const MAX_TASKS = 12;

/** 已展开的定时任务组（按任务 id）。只在本次运行内有效，重启回到收起 */
const openGroups = new Set();

/** 绝对时间 MM-DD HH:mm：同一任务几次运行标题一模一样，只能靠时间区分 */
function fmtAbs(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 任务库里的状态值（completed / working …）翻成人话 */
function statusText(s) {
  const m = {
    completed: "已完成",
    working: "进行中",
    running: "进行中",
    waiting: "等确认",
    review: "读取中",
    failed: "出错",
    idle: "空闲",
  };
  return m[s] || "";
}

/** 一条记录（可能是单条，也可能是定时任务的一组）用哪个状态点 */
function rowDotStatus(t, live) {
  if (live && live.status) return live.status;
  return t.status === "completed" ? "done" : "idle";
}

/**
 * 把"同一定时任务的多次运行"折成一组。
 * 分组靠任务 id，不靠标题 —— 你改过名，旧运行还叫「每日 AI 新闻推送」，
 * 按标题分会劈成两堆，看着像两个任务。
 * 顺序沿用 taskRows 的时间倒序：一组落在它最近一次运行的位置上。
 */
function groupTasks(list) {
  const out = [];
  const byAuto = new Map();
  for (const t of list) {
    const aid = t.automationId || "";
    if (!aid) {
      out.push({ key: t.id, automationId: "", title: t.title, items: [t], latest: t });
      continue;
    }
    let g = byAuto.get(aid);
    if (!g) {
      g = {
        key: "auto:" + aid,
        automationId: aid,
        // 组标题用任务"现在"的名字，所以改名不会让历史分裂
        title: String(t.automationName || "").trim() || t.title,
        items: [],
        latest: t,
      };
      byAuto.set(aid, g);
      out.push(g);
    }
    g.items.push(t);
  }
  return out;
}

function makeSessRow(t, live, curId, opts) {
  const auto = !t;
  const child = !!(opts && opts.child);
  const row = document.createElement("div");
  row.className = "sess-item" + (child ? " child" : "");
  const on = auto ? !prefs.pinnedSession : prefs.pinnedSession === t.id;
  if (on) row.classList.add("on");

  row.appendChild(makeDot(auto ? "idle" : rowDotStatus(t, live)));

  const label = document.createElement("span");
  label.className = "t";
  // 子行同名同标题，改用"哪一次"来区分：绝对时间
  label.textContent = auto ? "自动跟随（最活跃的）" : child ? fmtAbs(t.updatedAt) : t.title;
  if (!auto && !live) {
    row.classList.add("stale");
    label.title = t.title + "（当前没有活动，只有任务库里的记录）";
  } else {
    label.title = auto ? label.textContent : child ? t.title + " · " + fmtAbs(t.updatedAt) : label.textContent;
  }

  const tm = document.createElement("span");
  tm.className = "tm";
  tm.textContent = auto
    ? ""
    : child
      ? statusText((live && live.status) || t.status)
      : timeAgo(t.updatedAt);

  row.append(label, tm);
  row.addEventListener("click", (e) => {
    // 列表会被整块重建，冒泡到 document 时 e.target 已经脱离文档，
    // 会被误判成"点了菜单外面"而把菜单关掉
    e.stopPropagation();
    if (child) {
      // 点子行 = 固定这一条具体运行
      prefs.pinnedSession = t.id;
    } else {
      prefs.pinnedSession = auto ? "" : t.id;
    }
    thinkFollow = true; // 切会话后从头看最新的
    queueSave();
    closeSessMenu();
    lastSeq = -1;
    if (cached) render(cached);
    lastSentHeight = 0;
    scheduleMeasure();
  });
  return row;
}

/**
 * 定时任务的一组：平时一行「每日新闻推送 · 共 4 次」。
 * 点标题只展开/收起明细，不会误把某个具体运行固定住；
 * 要固定某一次，得展开后点子行。
 */
function makeGroupRow(g, liveMap, curId) {
  const row = document.createElement("div");
  row.className = "sess-item group";

  const holdsCurrent = !!curId && g.items.some((t) => t.id === curId);
  const open = openGroups.has(g.automationId) || holdsCurrent;
  if (open) row.classList.add("open");
  if (holdsCurrent) row.classList.add("holds");

  const live = liveMap.get(g.latest.id) || null;
  row.appendChild(makeDot(rowDotStatus(g.latest, live)));

  const label = document.createElement("span");
  label.className = "t";
  label.textContent = g.title;
  label.title =
    g.title +
    " · 这是同一个定时任务的 " +
    g.items.length +
    " 次运行（点标题" +
    (open ? "收起" : "展开") +
    "明细）";

  const cnt = document.createElement("span");
  cnt.className = "cnt";
  cnt.textContent = (open ? "▾ " : "▸ ") + "共 " + g.items.length + " 次";

  const tm = document.createElement("span");
  tm.className = "tm";
  tm.textContent = timeAgo(g.latest.updatedAt);

  row.append(label, cnt, tm);
  row.addEventListener("click", (e) => {
    // 同上：展开会重建列表，先掐断冒泡，否则菜单会被自己关掉
    e.stopPropagation();
    if (openGroups.has(g.automationId)) openGroups.delete(g.automationId);
    else openGroups.add(g.automationId);
    if (cached) renderSessMenu(cached);
    lastSentHeight = 0;
    scheduleMeasure();
  });
  return row;
}

function renderSessMenu(snap) {
  const all = taskRows(snap);
  const liveMap = new Map((snap.sessions || []).map((x) => [x.id, x]));
  // 同一定时任务跑出来的会话折成一行，不然跑十次就占十行
  const groups = groupTasks(all);

  const cur0 = pickSession(snap);
  // 固定在"没有实时数据的老任务"上时 cur 为 null，但序号仍应指向那个任务
  const curId = cur0 ? cur0.id : prefs.pinnedSession || "";

  // 只列最近 12 行（一组算一行）；当前固定的那条若排在 12 名之外，
  // 把它所在的整组补到末尾 —— 否则一选就从列表里"消失"
  let shown = groups.slice(0, MAX_TASKS);
  if (curId && !shown.some((g) => g.items.some((t) => t.id === curId))) {
    const extra = groups.find((g) => g.items.some((t) => t.id === curId));
    if (extra) shown = shown.concat([extra]);
  }

  // 只有一个任务、且它只有一次运行时不需要切换器；一个任务跑了多次仍要能展开看
  if (shown.length === 0 || (shown.length === 1 && shown[0].items.length <= 1)) {
    el.sessBtn.classList.add("hidden");
    if (!el.sessMenu.classList.contains("hidden")) closeSessMenu();
    return;
  }
  el.sessBtn.classList.remove("hidden");

  const idx = curId ? shown.findIndex((g) => g.items.some((t) => t.id === curId)) : -1;
  el.sessLabel.textContent = (idx >= 0 ? idx + 1 : 1) + "/" + shown.length;
  el.sessBtn.classList.toggle("pinned", !!prefs.pinnedSession);
  el.sessBtn.title = prefs.pinnedSession
    ? "已固定观察这个任务（点开可切换或恢复自动跟随）"
    : "正在自动跟随最活跃的任务（点开可固定一个）";

  if (el.sessMenu.classList.contains("hidden")) return;

  el.sessList.innerHTML = "";
  el.sessList.appendChild(makeSessRow(null, null, curId));

  for (const g of shown) {
    if (!g.automationId) {
      el.sessList.appendChild(makeSessRow(g.items[0], liveMap.get(g.items[0].id) || null, curId));
      continue;
    }

    el.sessList.appendChild(makeGroupRow(g, liveMap, curId));
    // 固定项在组里时强制展开，否则你根本看不到自己在看哪一次
    const holdsCurrent = !!curId && g.items.some((t) => t.id === curId);
    if (openGroups.has(g.automationId) || holdsCurrent) {
      for (const t of g.items) {
        el.sessList.appendChild(makeSessRow(t, liveMap.get(t.id) || null, curId, { child: true }));
      }
    }
  }
}

function openSessMenu() {
  if (el.sessBtn.classList.contains("hidden")) return;
  el.sessMenu.classList.remove("hidden");
  const row = document.querySelector(".title-row");
  if (row) {
    const r = row.getBoundingClientRect();
    el.sessMenu.style.top = Math.round(r.bottom + 4) + "px";
  }
  if (cached) renderSessMenu(cached);
}

function closeSessMenu() {
  if (el.sessMenu.classList.contains("hidden")) return;
  el.sessMenu.classList.add("hidden");
  lastSentHeight = 0;
  scheduleMeasure();
}

/* ---------------- 渲染 ---------------- */

/**
 * 固定在某个任务上，但这个任务当前没有实时活动（已完成 / 被重启过）。
 * 这时不能拿别的会话数据糊上去，就老实显示它的标题与状态。
 */
function renderTaskOnly(t) {
  el.dot.className = "dot idle";
  el.dot.title = "这个任务当前没有活动";
  el.status.className = "status s-idle";
  el.status.textContent = STATUS_META.idle.label;
  el.title.textContent = t.title;
  updateModelChip("");

  renderThinking(
    "这个任务当前没有正在进行的动作。面板只显示「正在跑」的细节，历史内容请到 WorkBuddy 里看。"
  );
  el.thinkAt.textContent = timeAgo(t.updatedAt);
  lastThinking = null;
  layoutThinking();

  el.stepCount.textContent = "";
  el.steps.innerHTML = "";
  el.credit.textContent = "—";
  el.token.textContent = "—";
  el.tokenSub.textContent = "";
  el.ctx.textContent = "—";
  el.bar.style.width = "0%";
  el.bar.className = "bar-fill";

  /**
   * 有待确认的请求时不能把卡片藏掉。
   * 你可能正固定在一条历史任务上看它的细节，而另一个会话在等你点「允许」；
   * 以前这里无条件隐藏，等于让 WorkBuddy 在后台一直干等一个看不见的按钮。
   */
  if (cached && Array.isArray(cached.pending) && cached.pending.length) {
    renderPerm(null, cached, []);
  } else {
    el.perm.classList.add("hidden");
    stopPendingTicker();
    hadPending = false;
    pendingId = null;
  }

  el.meta.textContent =
    "任务 " + String(t.id).slice(0, 8) + " · " + (t.status === "completed" ? "已完成" : "无活动");

  requestAnimationFrame(updateThinkingFade);
  scheduleMeasure();
}

function render(snap) {
  if (!snap) return;
  cached = snap;

  // 积分与"看哪个会话"无关，任何分支都要刷一遍
  renderCredit(snap.creditInfo);

  // 先决定"看谁"：固定的实时会话 → 固定的老任务 → 服务端选中的会话 → 全空闲
  const picked = pickSession(snap);
  const pinnedTask = picked ? null : findPinnedTask(snap);

  if (!picked && !pinnedTask) {
    renderSessMenu(snap);
    el.status.className = "status s-idle";
    el.status.textContent = STATUS_META.idle.label;
    el.dot.className = "dot idle";
    el.dot.title = STATUS_META.idle.hint;
    el.title.textContent = "等待 WorkBuddy 活动…";
    updateModelChip("");
    // 没有任何会话在跑，但可能仍有排队中的确认请求（例如刚切换视图）：
    // 这种情况下卡片必须留着，否则请求只能等超时被拒
    if (cached && Array.isArray(cached.pending) && cached.pending.length) {
      renderPerm(null, cached, []);
    } else {
      el.perm.classList.add("hidden");
    }
    /*
     * 这条分支以前直接 return，不重新量高度：
     * 任务一结束、会话列表清空，窗口就停在最后一次的高个子状态，
     * 留下半屏空白。空闲也是一种布局，得跟着量。
     */
    scheduleMeasure();
    return;
  }

  if (snap.seq === lastSeq) return;
  lastSeq = snap.seq;

  renderSessMenu(snap);

  if (!picked) {
    renderTaskOnly(pinnedTask);
    return;
  }

  const s = picked;
  const meta = STATUS_META[s.status] || { label: s.status, hint: "" };

  el.dot.className = "dot " + s.status;
  el.dot.title = meta.hint;
  el.status.className = "status s-" + s.status;
  el.status.textContent = meta.label;

  el.title.textContent = s.title || s.userPrompt || "未命名会话";
  updateModelChip(s.model || "");

  // 思考
  if (s.thinking) {
    if (s.thinking !== lastThinking) {
      renderThinking(s.thinking);
      lastThinking = s.thinking;
      layoutThinking(); // 文本变了才重新裁剪，避免每帧强制重排
    }
    el.thinkAt.textContent = timeAgo(s.thinkingAt);
  } else {
    renderThinking("");
    el.thinkAt.textContent = "";
    lastThinking = null;
    layoutThinking();
  }

  // 步骤（只画最近 N 条，N 由设置决定）
  const steps = s.steps || [];
  // 计数只统计"看得见的这几条"，否则跨回合累积后会出现 39/40 这种和列表对不上的数字
  const shown = steps.slice(-prefs.stepCount);
  const doneShown = shown.filter((x) => x.status === "done").length;
  el.stepCount.textContent = shown.length ? doneShown + " / " + shown.length : "";

  el.steps.innerHTML = "";
  for (const st of shown) {
    const li = document.createElement("li");
    li.className = st.status;

    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = STEP_MARK[st.status] || "○";

    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = st.name;

    const dt = document.createElement("span");
    dt.className = "dt";
    dt.textContent = st.detail || "";

    li.append(mark, nm, dt);
    el.steps.appendChild(li);
  }

  // 指标
  el.credit.textContent = Number(s.credit || 0).toFixed(2);
  el.token.textContent = fmtNum(s.tokens ? s.tokens.out : 0);
  el.tokenSub.textContent = "思考 " + fmtNum(s.tokens ? s.tokens.reasoning : 0);

  const pct = s.size ? Math.min(100, (s.used / s.size) * 100) : 0;
  el.ctx.textContent = pct.toFixed(0) + "%";
  el.bar.style.width = pct + "%";
  el.bar.className = "bar-fill" + (pct >= 85 ? " err" : pct >= 60 ? " warn" : "");

  // 确认卡：有待确认请求就出按钮；只是"等待中"则只说明情况
  renderPerm(s, snap, steps);

  el.meta.textContent =
    "会话 " + String(s.id).slice(0, 8) + " · 上下文 " + fmtK(s.used) + " / " + fmtK(s.size);

  requestAnimationFrame(updateThinkingFade);
  scheduleMeasure();
}

/* ---------------- 确认卡（权限代答） ---------------- */

let pendingId = null;
let pendingSince = 0;
let pendingTimer = null;
/**
 * 当前这张卡对应的等待参数。
 * 以前把 waitMs/deny 写在 tick 的闭包里，而计时器只在第一次创建 ——
 * 第二条请求排队时，倒计时仍按第一条的参数走（第一条"一直等"，第二条
 * 实际 10 分钟就拒，界面却显示还有 50 分钟）。
 */
let pendingParams = { waitMs: 0, deny: true };
let hadPending = false;
let decideBusy = false;

/** 取"当前该显示的那一条"：优先本会话，其次最新的一条 */
function currentPending(snap, sessionId) {
  const list = Array.isArray(snap && snap.pending) ? snap.pending : [];
  if (!list.length) return null;
  if (sessionId) {
    const mine = list.filter((p) => p.sessionId === sessionId);
    if (mine.length) return mine[mine.length - 1];
  }
  return list[list.length - 1];
}

function stopPendingTicker() {
  if (pendingTimer) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
}

/** 秒 → 3 分 12 秒 / 56 秒 */
function fmtWait(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return sec + " 秒";
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return min + " 分" + (rest ? " " + rest + " 秒" : "");
  return Math.floor(min / 60) + " 小时 " + (min % 60) + " 分";
}

/** 秒 → 56:48（紧凑，给"还剩"用） */
function fmtClock(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const mm = String(m).padStart(2, "0");
  const s2 = String(ss).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + s2 : m + ":" + s2;
}

/**
 * 卡片上显示"已等多久 + 还剩多久"。
 *
 * 上限不是我们爱设的：WorkBuddy 要求钩子必须在时限内返回，否则整条会话挂死。
 * 所以「一直等着」的真实含义是"最长 60 分钟，到点按拒绝处理"。
 * 这里把剩余时间显示出来，让你一眼知道还有多少余量，而不是被倒计时催着点。
 */
function startPendingTicker(since, item) {
  pendingSince = since;
  // 每次渲染都把参数更新到"正在显示的这条请求"，计时器本身复用
  pendingParams = {
    waitMs: item && Number(item.waitMs) ? Number(item.waitMs) : 0,
    deny: !item || item.timeoutBehavior !== "pass",
  };

  const tick = () => {
    const { waitMs, deny } = pendingParams;
    let txt = "已等待 " + fmtWait((Date.now() - pendingSince) / 1000);
    if (waitMs > 0) {
      const left = (pendingSince + waitMs - Date.now()) / 1000;
      if (left > 0.5) {
        txt += " · 还剩 " + fmtClock(left) + (deny ? " 后拒绝" : " 后放行");
      } else {
        txt += deny ? " · 正在按拒绝处理…" : " · 正在放行…";
      }
    }
    el.permLeft.textContent = txt;
  };

  tick();
  if (pendingTimer) return;
  pendingTimer = setInterval(tick, 1000);
}

/**
 * 提醒：WorkBuddy 本体在它自己窗口里问用户。
 *
 * 为什么面板帮不上忙：这一问发生在 PreToolUse 钩子之前（时间戳可证），
 * 请求根本到不了面板，所以只能"喊你"，不能"替你答"。
 * 一次提问只喊一次 —— 以"会话 + 提问时刻"去重，重绘多少次都不会连响。
 */
let lastAlertKey = "";

function alertClientAsk(s, ca) {
  const key = s.id + ":" + ca.at;
  if (key === lastAlertKey) return;
  lastAlertKey = key;

  /**
   * 只让一处发声。
   * 以前这里响两声、主进程又调 shell.beep() 响一声，叠成 2–3 声，
   * 在安静的房间里相当刺耳。现在由页面负责发声，
   * 并把"已经响过"告诉主进程；页面发不出声（音量合成器/自动播放策略）
   * 时主进程才补一声，既不会重响，也不会变成静默。
   */
  const played = beep();
  if (bridge && typeof bridge.alert === "function") {
    bridge.alert({
      title: "WorkBuddy 在等你点头",
      body:
        (ca.tool ? "它要使用 " + ca.tool + "。" : "") +
        "请到 WorkBuddy 窗口点「仍要执行」或「拦截」。",
      soundPlayed: played,
    });
  }
}

/** 两声短提示音。不依赖任何音频文件；返回是否真的排上了音，供主进程决定要不要补一声 */
let audioCtx = null;

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (audioCtx.state !== "running" && audioCtx.state !== "suspended") return false;

    const t0 = audioCtx.currentTime;
    [0, 0.18].forEach((off, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = i ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, t0 + off);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + off);
      osc.stop(t0 + off + 0.2);
    });
    return true;
  } catch (_) {
    return false; // 交给主进程补一声
  }
}

function renderPerm(s, snap, steps) {
  if (!prefs.blocks.perm) {
    el.perm.classList.add("hidden");
    stopPendingTicker();
    pendingId = null;
    hadPending = false;
    return;
  }

  const p = currentPending(snap, s && s.id);

  if (p) {
    if (!hadPending) {
      hadPending = true;
      // 折叠着的时候先展开，否则你只看到状态灯，找不到按钮
      if (el.app.classList.contains("folded") && bridge && typeof bridge.fold === "function") {
        bridge.fold(false);
      }
      /**
       * 把卡片滚进可视范围。
       * 这里刻意不用 smooth 动画：动画进行中你在按钮上按下、抬手时元素已经移位，
       * 浏览器就判定"按下的和抬起的不在同一个元素"，click 不触发 —— 表现就是按钮点不动。
       */
      setTimeout(() => {
        try {
          el.perm.scrollIntoView({ block: "nearest" });
        } catch (_) {
          /* 老内核不支持，忽略 */
        }
      }, 60);
    }
    pendingId = p.id;
    el.perm.classList.remove("hidden");
    el.perm.classList.toggle("high", p.level === "high");
    el.permTitle.textContent = p.headline || "WorkBuddy 想执行一步操作";
    el.permRisk.classList.toggle("hidden", p.level !== "high");
    el.permText.textContent = p.action + (p.why ? "：" + p.why : "");
    el.permTarget.textContent = p.target || "";
    el.permTarget.classList.toggle("hidden", !p.target);
    if (el.permCopy) {
      el.permCopy.classList.toggle("hidden", !p.target);
      el.permCopy.textContent = "复制";
    }

    el.permActions.classList.remove("hidden");
    el.allow.disabled = decideBusy;
    el.deny.disabled = decideBusy;

    const since = p.createdAt || Date.now() - Number(p.waitedMs || 0);
    startPendingTicker(since, p);

    const extra = (snap.pending || []).length - 1;
    const tail = {
      hold: "不点它就一直等（上限 60 分钟，到点按拒绝处理）。",
      deny10: "不点的话 10 分钟后会自动拒绝这一步。",
      pass1: "不点的话 1 分钟后会自动放行（旧行为）。",
    }[prefs.gateTimeout] || "不点它就一直等（上限 60 分钟，到点按拒绝处理）。";

    el.permNote.textContent =
      "点「允许」这一步才执行，点「拒绝」就中止这一步。" +
      (extra > 0 ? "（另有 " + extra + " 个请求在排队）" : "") +
      tail;
    return;
  }

  hadPending = false;
  pendingId = null;
  stopPendingTicker();

  /**
   * WorkBuddy 本体正在它自己的窗口里问。
   * 面板这边没有可点的东西 —— 硬摆两个按钮只会让你点了没反应。
   * 所以这张卡的全部作用就是：说清"去哪点"，并且响一声、弹个气泡。
   */
  const ca = s && s.clientAsk;
  if (ca) {
    if (el.app.classList.contains("folded") && bridge && typeof bridge.fold === "function") {
      bridge.fold(false);
    }

    el.perm.classList.remove("hidden");
    el.perm.classList.remove("high");
    el.permTitle.textContent = "WorkBuddy 在等你点头";
    el.permRisk.classList.add("hidden");
    el.permText.textContent = ca.tool
      ? "它要使用 " + ca.tool + "，这一问发生在面板之前，所以面板上没有按钮可点。"
      : "它在自己的窗口里问你要不要执行下一步，这一问面板接不到。";
    el.permTarget.classList.add("hidden");
    if (el.permCopy) el.permCopy.classList.add("hidden");
    el.permActions.classList.add("hidden");
    el.permNote.textContent =
      "请到 WorkBuddy 窗口点「仍要执行」或「拦截」。你答完这张卡会自己消失。" +
      (ca.waitedMs > 5000 ? "（已等 " + fmtWait(ca.waitedMs / 1000) + "）" : "");

    alertClientAsk(s, ca);
    return;
  }

  if (s && s.status === "waiting") {
    // 没有可点的请求：说明 WorkBuddy 是在它自己的窗口里等
    const last = steps && steps.length ? steps[steps.length - 1] : null;
    el.perm.classList.remove("hidden");
    el.perm.classList.remove("high");
    el.permTitle.textContent = "WorkBuddy 在等你回应";
    el.permRisk.classList.add("hidden");
    el.permText.textContent = last
      ? "这一步：" + last.name + (last.detail ? " · " + last.detail : "")
      : "请到 WorkBuddy 窗口里回答。";
    el.permTarget.classList.add("hidden");
    if (el.permCopy) el.permCopy.classList.add("hidden");
    // 没有可点的事，就别摆两个按钮在那儿 —— 点了没反应，只会以为程序坏了
    el.permActions.classList.add("hidden");
    el.permNote.textContent = "这里没有需要你点的东西，请到 WorkBuddy 窗口处理。";
    return;
  }

  el.perm.classList.add("hidden");
}

function renderGateHint() {
  if (!el.gateMsg) return;
  /**
   * 这里要说实话：确认卡不是"只是不显示"。
   * 服务端拿到 blocks.perm=false 就直接放行 —— 没有卡片就没人能点「允许」，
   * 拦下来只会把请求永远挂在半空。所以关掉它等于把监管模式作废，
   * 必须在界面上讲明白，否则非程序员会以为只是隐藏了一个区块。
   */
  const noCard = !prefs.blocks.perm;

  const map = {
    off: "完全不拦。WorkBuddy 想做什么就做什么，确认卡只显示状态。",
    risky: "只有删文件、改注册表、改系统目录、从网上直接运行脚本这类操作才会弹卡。日常工作不打扰你。",
    all: "每一次工具调用都弹卡，连读文件也要你点头。适合你想盯紧每一步的时候。",
  };
  el.gateMsg.textContent = noCard
    ? "注意：确认卡已被关掉，所以现在实际上不拦截任何操作，下面选的监管模式暂时不起作用。要恢复拦截，请到「显示区块」把确认卡重新勾上。"
    : map[prefs.gate] || map.risky;

  if (el.permBlockMsg) {
    if (noCard) {
      el.permBlockMsg.className = "hint warn";
      el.permBlockMsg.textContent =
        "已关掉：面板不再弹确认卡，也不再拦截任何操作（等于把监管模式作废）。";
    } else {
      el.permBlockMsg.className = "hint";
      el.permBlockMsg.textContent =
        "关掉这一项等于关闭拦截：没有卡片就没人能点「允许」，面板只能全部放行。";
    }
  }

  /*
   * 这里原来还有一段"无人应答会怎样/退出后会怎样"的说明文字。
   * 0.6.4 按用户要求删掉：下拉框里的选项本身已经把结果写清楚了，
   * 再配两段解释只是把设置面板撑长。
   */
}

/** 把结论送回本地服务；失败要让按钮恢复可点，不能把界面锁死 */
async function decide(behavior) {
  if (decideBusy) return;
  if (!pendingId) {
    el.permLeft.textContent = "这条已经处理过了";
    return;
  }

  const id = pendingId;
  decideBusy = true;
  el.allow.disabled = true;
  el.deny.disabled = true;
  el.permLeft.textContent = behavior === "allow" ? "已允许，正在恢复…" : "已拒绝，正在恢复…";

  let ok = false;
  try {
    const res = await fetch("/api/permission/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, behavior }),
    });
    const data = await res.json().catch(() => null);
    ok = !!(data && data.ok);
    if (!ok) el.permLeft.textContent = "这条已经过期了，等下一次提示";
  } catch (_) {
    el.permLeft.textContent = "没能送到面板服务，请再点一次";
  }

  setTimeout(() => {
    decideBusy = false;
    if (!ok) {
      // 没送出去：把按钮放回可点状态，让你重试
      el.allow.disabled = false;
      el.deny.disabled = false;
    }
    if (cached) {
      lastSeq = -1;
      render(cached);
    }
  }, ok ? 250 : 600);
}

el.allow.addEventListener("click", () => decide("allow"));
el.deny.addEventListener("click", () => decide("deny"));

/**
 * 复制确认卡里要执行的内容。
 * 面板只有 400px 宽，长命令即便放开高度也会滚动，手工拖选又容易被
 * 窗口拖动打断 —— 一个按钮比让人跟鼠标较劲更实在。
 */
if (el.permCopy) {
  el.permCopy.addEventListener("click", async () => {
    const text = el.permTarget ? el.permTarget.textContent : "";
    if (!text) return;
    let done = false;
    // 首选主进程：面板常常没有焦点，浏览器剪贴板 API 会直接拒绝
    try {
      if (bridge && typeof bridge.copyText === "function") {
        done = (await bridge.copyText(text)) === true;
      }
    } catch (_) {
      done = false;
    }
    try {
      if (!done && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (_) {
      /* 权限被拒时走下面的兜底 */
    }
    if (!done) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        done = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (_) {
        done = false;
      }
    }
    el.permCopy.textContent = done ? "已复制" : "复制失败";
    setTimeout(() => {
      el.permCopy.textContent = "复制";
    }, 1200);
  });
}

if (el.setGate) {
  el.setGate.addEventListener("change", () => {
    prefs.gate = el.setGate.value;
    renderGateHint();
    queueSave();
  });
}

if (el.setWait) {
  el.setWait.addEventListener("change", () => {
    prefs.gateTimeout = el.setWait.value;
    renderGateHint();
    queueSave();
  });
}

/* ---------------- 记录：查体积 / 手动清 ---------------- */

/** 体积只有主进程知道（页面碰不到文件系统），开设置面板时问一次 */
async function refreshLogSize() {
  if (!el.valLogSize) return;
  if (!bridge || !bridge.logs) return;
  try {
    const r = await bridge.logs.info();
    el.valLogSize.textContent = r && r.text ? r.text : "—";
  } catch (_) {
    el.valLogSize.textContent = "—";
  }
}

if (el.setLogAsk) {
  el.setLogAsk.addEventListener("change", () => {
    // 关掉 = 以后点退出直接退，不再弹确认；随时可以在这里开回来
    prefs.logAsk = el.setLogAsk.checked ? "ask" : "never";
    queueSave();
  });
}

if (el.btnClearLog) {
  el.btnClearLog.addEventListener("click", async () => {
    if (!bridge || !bridge.logs) return;
    el.btnClearLog.disabled = true;
    try {
      const r = await bridge.logs.clear();
      if (el.valLogSize) el.valLogSize.textContent = r && r.text ? r.text : "—";
      if (el.logMsg) {
        el.logMsg.textContent =
          r && r.ok
            ? "已清空。之后产生的新记录会从零开始攒。"
            : "这次没清成（文件正被写入），退出时还会再试一次。";
      }
    } catch (_) {
      if (el.logMsg) el.logMsg.textContent = "清空失败，稍后再点一次。";
    } finally {
      el.btnClearLog.disabled = false;
    }
  });
}

/* ---------------- 诊断日志（0.6.5） ----------------
 * 外壳 hud.log + 后端 service.log，落在 exe 同级 logs\ 目录。
 * 用户把这两份发过来就能定位"积分未连接""窗口高度不对"这类问题。
 */

let diagInfo = null;

function renderDiag(extra) {
  if (!el.diagPath) return;
  if (!diagInfo) {
    el.diagPath.textContent = "读取中…";
    return;
  }
  el.diagPath.textContent =
    "外壳 " + (diagInfo.hudText || "0 B") +
    " · 后端 " + (diagInfo.serviceText || "0 B") + "\n" +
    (diagInfo.dir || "（取不到路径）") +
    (extra ? "\n" + extra : "");
  if (el.valDiagSize) el.valDiagSize.textContent = diagInfo.totalText || "—";
}

async function refreshDiag() {
  if (!bridge || !bridge.diag) {
    if (el.diagPath) el.diagPath.textContent = "当前外壳不支持诊断日志（需 0.6.5 及以上）";
    return;
  }
  try {
    diagInfo = await bridge.diag.info();
  } catch (_) {
    diagInfo = null;
    if (el.diagPath) el.diagPath.textContent = "读取日志信息失败。";
    return;
  }
  renderDiag();
}

if (el.btnDiagOpen) {
  el.btnDiagOpen.addEventListener("click", async () => {
    if (!bridge || !bridge.diag) return;
    let ok = false;
    try {
      ok = await bridge.diag.open();
    } catch (_) {
      ok = false;
    }
    renderDiag(ok ? "" : "打不开文件夹，请按上面的路径自己找");
  });
}

if (el.btnDiagClear) {
  el.btnDiagClear.addEventListener("click", async () => {
    if (!bridge || !bridge.diag) return;
    el.btnDiagClear.disabled = true;
    try {
      const r = await bridge.diag.clear();
      await refreshDiag();
      renderDiag(r && r.ok ? "已清空，之后产生的新日志会从零开始" : "清空失败（文件可能正被写入），稍后再试");
    } catch (_) {
      renderDiag("清空失败，稍后再试");
    } finally {
      el.btnDiagClear.disabled = false;
    }
  });
}

/* ---------------- 积分 ----------------
 * 数据来自后端快照的 creditInfo（字段白名单），四态：
 *   未开启 / 查询中 / 未连接（或这次没更新） / 正常
 *
 * 最重要的一条：**失败绝不能说成"未领取"**。
 * 拿不到数据就老实写"未连接"，否则你会去点一个注定失败的按钮，
 * 还以为今天真没领到，白等一天。
 */

function fmtCount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("zh-CN") : "—";
}

/** 正在领取时锁住重绘：否则一次快照推送就把"领取中…"盖回"未领取"，看起来像没点上 */
let creditBusy = false;
/** 当前是否允许点那一格补领（由 renderCredit 决定，点击处只读这个） */
let creditCanClaim = false;

function renderCredit(info) {
  if (!el.blkCredit || !el.creditLeft) return;
  if (creditBusy) return;
  const c = info || { enabled: false, state: "disabled" };

  el.creditLeft.classList.remove("pending", "ok", "wait", "err");
  el.creditSignin.classList.remove("pending", "ok", "wait", "err");
  el.creditClaim.classList.remove("can-claim");
  el.creditClaim.setAttribute("aria-disabled", "true");
  creditCanClaim = false;
  el.creditClaim.title = "";
  // 每次重绘先收起来，只在下面明确需要时展开
  if (el.creditWhy) el.creditWhy.classList.add("hidden");

  /* 1) 开关没开：两格空着，并说明去哪儿开 */
  if (!c.enabled || c.state === "disabled") {
    el.creditLeft.textContent = "—";
    el.creditSignin.textContent = "—";
    el.creditLeft.classList.add("pending");
    el.creditSignin.classList.add("pending");
    el.creditTip.textContent = "未开启";
    el.creditTip.className = "muted";
    el.creditRefresh.classList.add("hidden");
    const t = "在设置里勾选「查询积分余额与签到状态」后才显示";
    el.creditLeft.title = t;
    el.creditSignin.title = t;
    return;
  }

  el.creditRefresh.classList.remove("hidden");

  /* 2) 第一次查询还没回来 */
  if (c.state === "loading") {
    el.creditLeft.textContent = "…";
    el.creditSignin.textContent = "…";
    el.creditLeft.classList.add("pending");
    el.creditSignin.classList.add("pending");
    el.creditTip.textContent = "查询中";
    el.creditTip.className = "muted";
    el.creditLeft.title = "正在读取余额与签到状态";
    el.creditSignin.title = el.creditLeft.title;
    return;
  }

  const hasData = c.balanceLeft !== null || c.todayCheckedIn !== null;

  /* 3) 从来没成功过：未连接。这里的措辞尤其重要 —— 不能写"未领取" */
  if (!hasData) {
    el.creditLeft.textContent = "—";
    el.creditSignin.textContent = "—";
    el.creditLeft.classList.add("err");
    el.creditSignin.classList.add("err");
    el.creditTip.textContent = "未连接";
    el.creditTip.className = "muted";
    const why = c.reason || "拿不到数据，请确认 WorkBuddy 已登录";
    el.creditLeft.title = why;
    el.creditSignin.title = why;
    // 0.6.5：原因直接摊在下面一行，不用悬停才看得到
    if (el.creditWhy) {
      el.creditWhy.textContent = why;
      el.creditWhy.classList.remove("hidden");
    }
    return;
  }

  /* 4) 有数据：余额 + 签到状态 */
  el.creditLeft.textContent = c.balanceLeft === null ? "—" : fmtCount(c.balanceLeft);
  el.creditLeft.title =
    c.balanceExact !== null && Number(c.balanceExact) !== Number(c.balanceLeft)
      ? "剩余总点数（精确 " + c.balanceExact + "，显示取整）"
      : "剩余总点数";

  if (c.todayCheckedIn === true) {
    el.creditSignin.textContent = "● 已领取" + (c.todayCredit ? " +" + c.todayCredit : "");
    el.creditSignin.classList.add("ok");
    el.creditSignin.title =
      "今天领过了" +
      (c.streakDays ? "，已连续 " + c.streakDays + " 天" : "") +
      "。明天 0 点后可再领。";
  } else if (c.todayCheckedIn === false) {
    el.creditSignin.textContent = "○ 未领取";
    el.creditSignin.classList.add("wait");
    el.creditSignin.title = c.autoSignin
      ? "已开启自动领取，面板会自己补上；也可以点这里立刻领。"
      : "点这里立刻领取今日的 100 积分。";
    if (c.state !== "error") {
      creditCanClaim = true;
      el.creditClaim.setAttribute("aria-disabled", "false");
      el.creditClaim.classList.add("can-claim");
      el.creditClaim.title = "点一下领取今日 100 积分";
    }
  } else {
    el.creditSignin.textContent = "—";
    el.creditSignin.classList.add("err");
  }

  /* 右上角：多久之前的数据。失败或过期就明说，别让人以为是最新的 */
  if (c.state === "error" || c.stale) {
    el.creditTip.textContent = "未更新";
    el.creditTip.className = "muted wait-text";
    el.creditTip.title = c.reason || "这次没取到新数据，显示的是上一次的结果";
    // 有旧数据时不必重复报错，但"为什么没更新"要看得见
    if (c.state === "error" && el.creditWhy && c.reason) {
      el.creditWhy.textContent = "上次更新失败：" + c.reason + "（下面显示的是上一次的数据）";
      el.creditWhy.classList.remove("hidden");
    }
  } else {
    el.creditTip.textContent = timeAgo(c.updatedAt);
    el.creditTip.className = "muted";
    el.creditTip.title = "余额每 30 分钟更新一次";
  }
}

/** 手动刷新 / 手动补领：两头都只打本机端点，令牌永远不出后端 */
async function postLocal(url) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return await res.json();
  } catch (_) {
    return null;
  }
}

if (el.creditRefresh) {
  el.creditRefresh.addEventListener("click", async () => {
    if (el.creditRefresh.disabled) return;
    el.creditRefresh.disabled = true;
    el.creditRefresh.textContent = "…";
    try {
      const r = await postLocal("/api/credit/refresh");
      if (r && r.creditInfo) renderCredit(r.creditInfo);
      else if (r && r.ok === false) el.creditTip.textContent = "刷新失败";
    } finally {
      el.creditRefresh.disabled = false;
      el.creditRefresh.textContent = "刷新";
    }
  });
}

if (el.creditClaim) {
  const doClaim = async () => {
    if (!creditCanClaim || creditBusy) return;
    creditBusy = true;
    creditCanClaim = false;
    el.creditClaim.classList.remove("can-claim");
    el.creditClaim.setAttribute("aria-disabled", "true");
    const before = el.creditSignin.textContent;
    el.creditSignin.textContent = "领取中…";
    let r = null;
    try {
      r = await postLocal("/api/credit/claim");
    } catch (_) {
      r = null;
    }
    creditBusy = false;
    if (r && r.creditInfo) {
      renderCredit(r.creditInfo);
    } else {
      el.creditSignin.textContent = before;
      el.creditTip.textContent = "领取失败";
    }
    if (r && r.ok === false) {
      // 失败要看得见：说清原因，不能静默装作已领
      el.creditTip.textContent = "领取失败";
      el.creditTip.title = r.reason || "稍后再试";
    }
  };

  el.creditClaim.addEventListener("click", doClaim);
  // 键盘也能用：它是 role=button 的 tabindex 元素
  el.creditClaim.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      doClaim();
    }
  });
}

/* ---------------- 连接 ---------------- */

/**
 * 连接灯三态。以前只有"绿/红"两色且没有文字，
 * 网络抖一下整个灯变红、你必须悬停才知道发生了什么。
 * 现在：断开先宽限 5 秒显示"重连中"，5 秒后仍没恢复才算"已断开"。
 */
let connTimer = null;

function setConn(state, label) {
  if (!el.conn) return;
  el.conn.className = "conn" + (state === "ok" ? "" : " " + state);
  el.connText.textContent = label;
  el.conn.title =
    state === "ok"
      ? "已连接：本地服务在线，数据实时刷新"
      : state === "off"
        ? "已断开：重连多次失败，面板停在上一次的数据上"
        : "重连中：连接断了一下，正在自动重试";
}

function connect() {
  setConn("wait", "连接中");
  const es = new EventSource("/api/events");
  es.onopen = () => {
    if (connTimer) {
      clearTimeout(connTimer);
      connTimer = null;
    }
    setConn("ok", "已连接");
  };
  es.onmessage = (e) => {
    try {
      render(JSON.parse(e.data));
    } catch (_) {
      /* ignore */
    }
  };
  es.onerror = () => {
    if (el.conn.classList.contains("off")) return;
    setConn("wait", "重连中");
    if (connTimer) return;
    connTimer = setTimeout(() => {
      connTimer = null;
      setConn("off", "已断开");
    }, 5000);
  };
}

/* ---------------- 窗口交互 ---------------- */

/**
 * @param {boolean} folded 是否折叠
 * @param {boolean} notify 是否通知主进程调整窗口高度（托盘触发时为 false，避免回环）
 */
function setFolded(folded, notify) {
  el.app.classList.toggle("folded", folded);
  el.fold.textContent = folded ? "+" : "—";
  el.fold.title = folded ? "展开" : "折叠";
  if (notify !== false && bridge && typeof bridge.fold === "function") {
    bridge.fold(folded);
  }
  if (!folded) {
    lastSentHeight = 0;
    scheduleMeasure();
    // 折叠期间思考区被 display:none，高度算不准，展开后重算一次
    setTimeout(() => {
      thinkFollow = true;
      layoutThinking();
      lastSentHeight = 0;
      scheduleMeasure();
    }, 80);
  }
}

el.fold.addEventListener("click", () => {
  setFolded(!el.app.classList.contains("folded"), true);
});

el.close.addEventListener("click", () => {
  if (bridge && typeof bridge.hide === "function") bridge.hide();
});

el.sessBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (el.sessMenu.classList.contains("hidden")) openSessMenu();
  else closeSessMenu();
});

// 点面板空白处或按 Esc 收起会话列表
document.addEventListener("click", (e) => {
  if (el.sessMenu.classList.contains("hidden")) return;
  if (el.sessMenu.contains(e.target) || el.sessBtn.contains(e.target)) return;
  closeSessMenu();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.sessMenu.classList.contains("hidden")) {
    closeSessMenu();
  }
});

el.thinking.addEventListener("scroll", () => {
  const n = el.thinking;
  // 你在往上翻看历史时，不要被新内容拽回底部
  thinkFollow = n.scrollTop + n.clientHeight >= n.scrollHeight - 4;
  updateThinkingFade();
});

/* ---------------- 设置浮层 ---------------- */

function setMsg(text, ok) {
  if (!el.keyMsg) return;
  el.keyMsg.textContent = text || "";
  el.keyMsg.className = "msg" + (ok ? " ok" : "");
}

function openSheet() {
  // 折叠状态下点齿轮：先展开再开设置，否则设置会被压在 44px 里
  if (el.app.classList.contains("folded")) {
    setFolded(false, true);
    setTimeout(() => {
      if (bridge && typeof bridge.sheet === "function") bridge.sheet(true);
    }, 280);
  } else if (bridge && typeof bridge.sheet === "function") {
    bridge.sheet(true);
  }

  el.sheet.classList.remove("hidden");
  syncSettingsUI();
  refreshLogSize();
  refreshDiag();
  setMsg("", true);
}

function closeSheet() {
  if (recording) cancelRecording("");
  el.sheet.classList.add("hidden");
  if (bridge && typeof bridge.sheet === "function") bridge.sheet(false);
  lastSentHeight = 0;
  scheduleMeasure();
}

el.settings.addEventListener("click", openSheet);
el.sheetClose.addEventListener("click", closeSheet);

// 滑块：拖动即时生效
el.setSteps.addEventListener("input", () => {
  const v = clampInt(el.setSteps.value, 1, 10, prefs.stepCount);
  el.valSteps.textContent = String(v);
  prefs.stepCount = v;
  if (cached) {
    lastSeq = -1;
    render(cached);
  }
  queueSave();
});

el.setLines.addEventListener("input", () => {
  const v = clampInt(el.setLines.value, 2, 10, prefs.thinkingLines);
  el.valLines.textContent = String(v);
  prefs.thinkingLines = v;
  applyPrefsToDom();
  queueSave();
});

// 区块勾选
function bindBlockCheckbox(node, key) {
  node.addEventListener("change", () => {
    prefs.blocks[key] = node.checked;
    applyPrefsToDom();
    /**
     * 取消"确认卡"会连带改变监管的实际效果（不再拦截），
     * 必须当场把说明文字刷新成警告，不能等下次打开设置才变。
     */
    renderGateHint();
    queueSave();
  });
}
bindBlockCheckbox(el.chkThinking, "thinking");
bindBlockCheckbox(el.chkSteps, "steps");
bindBlockCheckbox(el.chkMetrics, "metrics");
bindBlockCheckbox(el.chkCredit, "credit");
bindBlockCheckbox(el.chkModel, "model");
bindBlockCheckbox(el.chkPerm, "perm");

/**
 * 积分总开关。勾上就立刻查一次，不让人干等调度的一分钟节拍。
 *
 * 顺序很重要：先 saveNow 把开关写进 prefs.json，再请求刷新。
 * 反过来的话后端读到的还是旧的 false，会直接回"未开启"。
 */
if (el.setCreditSync) {
  el.setCreditSync.addEventListener("change", async () => {
    prefs.creditSync = el.setCreditSync.checked;
    if (!prefs.creditSync) prefs.autoSignin = false; // 总开关关了，子开关不该还亮着
    syncSettingsUI();
    await saveNow();
    const r = await postLocal("/api/credit/refresh");
    if (r && r.creditInfo) renderCredit(r.creditInfo);
  });
}

if (el.setAutoSignin) {
  el.setAutoSignin.addEventListener("change", async () => {
    prefs.autoSignin = el.setAutoSignin.checked;
    await saveNow();
    // 刚打开自动领取：后台那次 tick 最多一分钟，这里推它一下
    const r = await postLocal("/api/credit/refresh");
    if (r && r.creditInfo) renderCredit(r.creditInfo);
  });
}

// 置顶
el.setOnTop.addEventListener("change", () => {
  prefs.alwaysOnTop = el.setOnTop.checked;
  queueSave();
});

// 恢复自适应高度
el.btnAutoHeight.addEventListener("click", async () => {
  prefs.manualHeight = false;
  lastSentHeight = 0;
  if (bridge && bridge.prefs) {
    try {
      const p = await bridge.prefs.set({ manualHeight: false });
      if (p) applyPrefs(p);
    } catch (_) {
      /* ignore */
    }
  }
  scheduleMeasure();
  setMsg("已恢复：窗口高度会跟随内容自动变化", true);
});

// 恢复默认
el.btnReset.addEventListener("click", async () => {
  if (bridge && bridge.prefs && typeof bridge.prefs.reset === "function") {
    try {
      const p = await bridge.prefs.reset();
      applyPrefs(p);
      setMsg("已恢复默认设置", true);
      lastSentHeight = 0;
      scheduleMeasure();
      return;
    } catch (_) {
      /* 落到下面走本地默认 */
    }
  }
  applyPrefs(JSON.parse(JSON.stringify(DEFAULT_PREFS)));
  queueSave();
  setMsg("已恢复默认设置", true);
});

/* ---------------- 快捷键录制 ---------------- */

let recording = false;

async function startRecording() {
  if (!bridge || typeof bridge.setShortcut !== "function") {
    setMsg("浏览器预览模式无法设置全局快捷键，请在桌面面板里改", false);
    return;
  }
  if (recording) return;

  recording = true;
  el.btnKey.classList.add("recording");
  el.btnKey.textContent = "按下组合键…";
  setMsg("按 Esc 取消；按 Backspace 清空（不设快捷键）", true);

  // 先让主进程放开全局热键，否则你按下的那一刻面板就被自己藏起来了
  if (typeof bridge.suspendShortcut === "function") {
    try {
      await bridge.suspendShortcut();
    } catch (_) {
      /* 老版本没有这个通道，退回直接用 */
    }
  }
  if (!recording) return;

  window.addEventListener("keydown", onRecordKey, true);
}

/** 提交后调用：不再监听，但保留主进程刚注册好的新快捷键 */
function stopRecording() {
  recording = false;
  window.removeEventListener("keydown", onRecordKey, true);
  el.btnKey.classList.remove("recording");
  el.btnKey.textContent = prettyAccel(prefs.shortcut);
}

/** 放弃录制：把原来的快捷键还回去 */
async function cancelRecording(msg) {
  if (!recording) return;
  recording = false;
  window.removeEventListener("keydown", onRecordKey, true);
  el.btnKey.classList.remove("recording");
  el.btnKey.textContent = prettyAccel(prefs.shortcut);

  if (bridge && typeof bridge.resumeShortcut === "function") {
    try {
      await bridge.resumeShortcut();
    } catch (_) {
      /* ignore */
    }
  }
  if (msg) setMsg(msg, true);
}

function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  const k = e.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") return null;

  let key = null;
  if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
  else {
    const map = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Enter: "Return",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Insert: "Insert",
      ",": "Comma",
      ".": "Period",
      "/": "Slash",
      ";": "Semicolon",
      "'": "Quote",
      "[": "BracketLeft",
      "]": "BracketRight",
      "\\": "Backslash",
      "-": "Minus",
      "=": "Plus",
      "`": "Backquote",
    };
    key = map[k] || null;
  }

  if (!key) return null;
  if (!mods.length) {
    return { error: "必须和 Ctrl / Alt / Shift 之一组合，否则会抢走正常打字" };
  }
  return { accel: mods.concat(key).join("+") };
}

async function commitShortcut(acc) {
  if (!bridge || typeof bridge.setShortcut !== "function") return;
  let res = null;
  try {
    res = await bridge.setShortcut(acc);
  } catch (err) {
    res = { ok: false, shortcut: prefs.shortcut, error: String(err && err.message ? err.message : err) };
  }

  stopRecording();

  if (res && res.ok) {
    prefs.shortcut = res.shortcut || "";
    shortcutError = null;
    el.btnKey.textContent = prettyAccel(prefs.shortcut);
    setMsg(prefs.shortcut ? "已生效：" + prettyAccel(prefs.shortcut) : "已清空，不再有全局快捷键", true);
  } else {
    if (res && typeof res.shortcut === "string") prefs.shortcut = res.shortcut;
    shortcutError = res ? res.error : "设置失败";
    el.btnKey.textContent = prettyAccel(prefs.shortcut);
    setMsg(shortcutError || "设置失败", false);
  }
}

function onRecordKey(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    cancelRecording("已取消，快捷键未改动");
    return;
  }

  if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    commitShortcut("");
    return;
  }

  const r = accelFromEvent(e);
  if (!r) return; // 只按了修饰键，继续等
  if (r.error) {
    setMsg(r.error, false);
    return;
  }
  commitShortcut(r.accel);
}

el.btnKey.addEventListener("click", () => {
  if (recording) cancelRecording("已取消，快捷键未改动");
  else startRecording();
});

// 窗口失去焦点时放弃录制，避免热键一直处于注销状态
window.addEventListener("blur", () => {
  if (recording) cancelRecording("窗口失焦，已取消");
});

/* ---------------- 主进程推送 ---------------- */

if (bridge) {
  if (typeof bridge.onFolded === "function") {
    bridge.onFolded((folded) => setFolded(folded, false));
  }

  if (typeof bridge.onNotice === "function") {
    bridge.onNotice((msg) => {
      el.meta.textContent = msg;
      setTimeout(() => {
        if (cached) {
          lastSeq = -1;
          render(cached);
        }
      }, 7000);
    });
  }

  if (typeof bridge.onPrefs === "function") {
    bridge.onPrefs((p) => applyPrefs(p));
  }

  if (typeof bridge.onRemeasure === "function") {
    bridge.onRemeasure(() => {
      lastSentHeight = 0;
      scheduleMeasure();
    });
  }

  if (typeof bridge.onOpenSettings === "function") {
    bridge.onOpenSettings(() => openSheet());
  }
}

/* ---------------- 观察内容高度 ---------------- */

if (typeof ResizeObserver === "function" && el.content) {
  const ro = new ResizeObserver(() => scheduleMeasure());
  ro.observe(el.content);
}

// 仅刷新时间文本，避免整表重绘
setInterval(() => {
  if (cached && cached.selected && cached.selected.thinking) {
    el.thinkAt.textContent = timeAgo(cached.selected.thinkingAt);
  }
}, 15000);

/* ---------------- 启动 ---------------- */

(async function boot() {
  if (bridge && bridge.prefs && typeof bridge.prefs.get === "function") {
    try {
      const p = await bridge.prefs.get();
      if (p) applyPrefs(p);
    } catch (_) {
      applyPrefs(DEFAULT_PREFS);
    }
  } else {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem("hud-prefs") || "null");
    } catch (_) {
      stored = null;
    }
    applyPrefs(stored || DEFAULT_PREFS);
  }

  hydrateDots(); // 图例里那几个写死的圆点也换成 SVG
  renderCredit(null); // 首帧先摆"未开启"，真实状态等第一份快照
  connect();
  lastSentHeight = 0;
  scheduleMeasure();

  // 页面刚加载时内容往往是空的，等首屏数据到位再强制量一次
  setTimeout(() => {
    lastSentHeight = 0;
    scheduleMeasure();
  }, 1000);
})();
