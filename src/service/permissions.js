"use strict";

/**
 * 权限代答中枢：hook 阻塞提问 → 面板点按 → 结果回到 hook。
 *
 * 三条硬规则：
 *   1. 面板没开 / 服务没起 → hook 连不上，直接放行（由 hook 侧处理）。
 *   2. 没人点 → 按设置里的"无人应答策略"处理，默认一直等着（最长 60 分钟），
 *      到点按安全方向**拒绝**，绝不偷偷放行危险操作。
 *   3. 同会话堆积超过上限 → 后来的按安全方向拒绝，避免排队把自己堵住。
 *
 * 放行（pass）的含义是"不表态"，WorkBuddy 仍按它自己的权限规则走；
 * 只有明确"允许/拒绝"才会覆盖它的默认流程。
 */

const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");

const { HUD_DIR } = require("./config");
const { classify } = require("./risk");

const PREFS_FILE = path.join(HUD_DIR, "prefs.json");
const MAX_PENDING = 6;

/**
 * 无人应答策略。键名存进 prefs.gateTimeout。
 *   behavior: 到点怎么处理。"deny" = 安全侧，挡掉这一步；"pass" = 旧行为，交回 WorkBuddy。
 * 默认 hold：不自动放行，一小时无人应答才拒绝。你睡觉时它就一直停在那一格。
 */
const WAIT_POLICY = {
  hold: { ms: 60 * 60 * 1000, behavior: "deny", hint: "一直等着，不会自动放行" },
  deny10: { ms: 10 * 60 * 1000, behavior: "deny", hint: "10 分钟无人应答就拒绝" },
  pass1: { ms: 60 * 1000, behavior: "pass", hint: "1 分钟无人应答就放行（旧行为）" },
};

const DEFAULT_POLICY = "hold";

/** 自检用：把等待时长压到几秒，避免自检要跑一小时（正式运行不会设这个变量） */
const WAIT_OVERRIDE_MS = Number(process.env.WB_HUD_WAIT_MS || 0);

let prefsCache = { at: 0, gate: "risky", permBlock: true, gateTimeout: DEFAULT_POLICY };
let seq = 0;

/** 读取面板设置；prefs.json 由主进程写，这里只读，700ms 缓存够用 */
function readPanelPrefs() {
  const now = Date.now();
  if (now - prefsCache.at < 700) return prefsCache;
  let gate = "risky";
  let permBlock = true;
  let gateTimeout = DEFAULT_POLICY;
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
    if (raw && (raw.gate === "off" || raw.gate === "risky" || raw.gate === "all")) gate = raw.gate;
    if (raw && raw.blocks && raw.blocks.perm === false) permBlock = false;
    if (raw && Object.prototype.hasOwnProperty.call(WAIT_POLICY, raw.gateTimeout)) {
      gateTimeout = raw.gateTimeout;
    }
  } catch (_) {
    /* 文件不存在或正在被写：沿用上一次的值 */
  }
  prefsCache = { at: now, gate, permBlock, gateTimeout };
  return prefsCache;
}

function gateMode() {
  return readPanelPrefs().gate;
}

function waitPolicy() {
  return WAIT_POLICY[readPanelPrefs().gateTimeout] || WAIT_POLICY[DEFAULT_POLICY];
}

function waitPolicyKey() {
  return readPanelPrefs().gateTimeout;
}

/** 调试用自动决策：WB_HUD_AUTO="allow:2000:1" / "deny:1500:1"（毫秒:次数，次数用完后自动失效） */
function autoRule() {
  const raw = String(process.env.WB_HUD_AUTO || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  const behavior = parts[0] === "deny" ? "deny" : "allow";
  const delay = Math.max(0, Number(parts[1] || 1500));
  const count = Number(parts[2] || 1);
  return { behavior, delay, left: count };
}

let auto = autoRule();

class PermissionHub {
  constructor() {
    this.pending = new Map();
    this.onChange = null;
    /** 有新的待确认请求时回调（主进程用它把面板弹出来） */
    this.onAsk = null;
    /** 面板确实无法询问时置 true（正在退出）；此时按安全方向拒绝 */
    this.paused = false;
  }

  /** 面板将要消失（退出）→ 挂起，之后再有请求直接拒绝，不白等 */
  setPaused(v) {
    const next = !!v;
    if (next === this.paused) return;
    this.paused = next;
    this._notify();
  }

  setChangeHandler(fn) {
    this.onChange = fn;
  }

  setAskHandler(fn) {
    this.onAsk = fn;
  }

  _notify() {
    if (typeof this.onChange === "function") {
      try {
        this.onChange();
      } catch (_) {
        /* 通知失败不影响决策 */
      }
    }
  }

  _emitAsk(item) {
    if (typeof this.onAsk === "function") {
      try {
        this.onAsk(item);
      } catch (_) {
        /* 弹窗失败不影响决策 */
      }
    }
  }

  list() {
    const now = Date.now();
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      toolName: p.toolName,
      action: p.action,
      target: p.target,
      why: p.why,
      level: p.level,
      headline: p.headline,
      source: p.source,
      createdAt: p.createdAt,
      waitedMs: Math.max(0, now - p.createdAt),
      remainMs: Math.max(0, p.deadline - now),
      waitMs: p.waitMs,
      timeoutBehavior: p.timeoutBehavior,
    }));
  }

  /**
   * 发起一次询问。
   * @returns {Promise<{behavior:"allow"|"deny"|"pass", reason:string}>}
   */
  ask(req) {
    const prefsNow = readPanelPrefs();

    // 正在退出：没人能点了，按安全侧处理
    if (this.paused) {
      return Promise.resolve({ behavior: "deny", reason: "面板正在关闭，未获得授权，已拒绝" });
    }
    if (prefsNow.gate === "off") {
      return Promise.resolve({ behavior: "pass", reason: "监管模式已关闭" });
    }
    // 你把"确认卡"区块关掉了 → 没有能点的按钮，就别拦，直接放行
    if (!prefsNow.permBlock) {
      return Promise.resolve({ behavior: "pass", reason: "确认卡已隐藏，直接放行" });
    }

    const risk = classify(req.toolName, req.toolInput, req.cwd);
    if (prefsNow.gate === "risky" && risk.level !== "high") {
      return Promise.resolve({ behavior: "pass", reason: "常规操作，不拦" });
    }

    if (this.pending.size >= MAX_PENDING) {
      return Promise.resolve({ behavior: "deny", reason: "待确认太多，为避免混在一起误点，已拒绝这一步" });
    }

    const policy = WAIT_POLICY[prefsNow.gateTimeout] || WAIT_POLICY[DEFAULT_POLICY];
    const waitMs = WAIT_OVERRIDE_MS > 0 ? WAIT_OVERRIDE_MS : policy.ms;
    const id = randomBytes(4).toString("hex");
    seq += 1;

    const item = {
      id,
      seq,
      sessionId: req.sessionId || null,
      toolName: req.toolName || "unknown",
      source: req.source || "PreToolUse",
      action: risk.action,
      target: risk.target,
      why: risk.why,
      level: risk.level,
      headline: risk.headline,
      createdAt: Date.now(),
      waitMs,
      timeoutBehavior: policy.behavior,
      deadline: Date.now() + waitMs,
      resolve: null,
      timer: null,
    };

    const promise = new Promise((resolve) => {
      item.resolve = (behavior, reason) => {
        if (item.timer) clearTimeout(item.timer);
        this.pending.delete(id);
        this._notify();
        resolve({ behavior, reason: reason || "" });
      };
    });

    item.timer = setTimeout(() => {
      const minutes = Math.round(waitMs / 60000);
      const span = minutes >= 1 ? minutes + " 分钟" : Math.round(waitMs / 1000) + " 秒";
      item.resolve(
        policy.behavior,
        policy.behavior === "deny"
          ? "等了 " + span + "没人确认，已按安全策略拒绝这一步"
          : "超过 " + span + "没人确认，已放行"
      );
    }, waitMs);
    if (item.timer.unref) item.timer.unref();

    this.pending.set(id, item);
    this._notify();
    this._emitAsk(item);

    if (auto && auto.left > 0) {
      auto.left -= 1;
      const rule = auto;
      if (auto.left <= 0) auto = null; // 只生效一次，防止测试把后续调用全否掉
      setTimeout(() => item.resolve(rule.behavior, "调试自动" + rule.behavior), rule.delay);
    }

    return promise;
  }

  /** 面板点按 */
  decide(id, behavior) {
    const item = this.pending.get(String(id || ""));
    if (!item) return { ok: false, reason: "这条请求已经处理过或已撤回" };
    if (behavior !== "allow" && behavior !== "deny") return { ok: false, reason: "未知选项" };
    item.resolve(behavior, behavior === "allow" ? "你在面板点了允许" : "你在面板点了拒绝");
    return { ok: true };
  }

  /** 一键处理全部待确认（退出前调用） */
  releaseAll(reason, behavior) {
    const how = behavior === "deny" ? "deny" : "pass";
    for (const item of [...this.pending.values()]) item.resolve(how, reason || "面板已关闭");
  }
}

const hub = new PermissionHub();

module.exports = { hub, gateMode, waitPolicy, waitPolicyKey, WAIT_POLICY };
