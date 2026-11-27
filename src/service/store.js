"use strict";

/**
 * 会话状态容器与状态机
 *
 * 输入：
 *   - hook 事件（来自 spool）
 *   - transcript 增量（reasoning / function_call / usage）
 *   - 数据库用量（credit / context）
 * 输出：统一快照，供 HTTP/SSE 与 UI 消费。
 */

const { TTL, CLIENT_ASK_TTL, READ_TOOLS, THINKING_LIMIT } = require("./config");

/**
 * 排队顺序 = 该让你先看哪个会话。
 * failed 最优先（出事了）；waiting 是"弹窗在等你点"；reply 只是"它说完在等你回话"，
 * 虽然也要你，但不急，排在真正卡住的 waiting 之后、正在进行的工作之前。
 */
const PRIORITY = ["failed", "waiting", "reply", "working", "review", "thinking", "done", "idle"];

/**
 * "正在进行"的状态。这类状态每次事件都要续期，原因见 _setStatus。
 * done / failed 不在其中：它们是终态，只有真的变了才该重新计时，
 * 否则一次 PostToolUse 就能让"已完成"永远不回落成"空闲"。
 */
const LIVE_STATUS = new Set(["thinking", "working", "review", "waiting"]);

function priorityOf(status) {
  const idx = PRIORITY.indexOf(status);
  return idx === -1 ? PRIORITY.length : idx;
}

function briefArgs(name, argsText) {
  if (!argsText) return "";
  let args = argsText;
  if (typeof argsText === "string") {
    try {
      args = JSON.parse(argsText);
    } catch (_) {
      return argsText.slice(0, 80);
    }
  }
  if (!args || typeof args !== "object") return "";

  const pick =
    args.file_path || args.path || args.command || args.pattern ||
    args.query || args.url || args.description || "";
  const text = String(pick || "");
  return text.length > 80 ? text.slice(0, 80) + "…" : text;
}

/**
 * 从客户端提问的提示语里抠出工具名。
 * 原文形如 "needs your permission to use Bash"，没有结构化字段
 * （tool_name / call_id 都是 null），只能这样取。
 */
function toolFromNotice(message) {
  const m = String(message || "").match(/use\s+([A-Za-z_][\w.-]*)/);
  return m ? m[1] : "";
}

class Store {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
    this.seq = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    this.seq += 1;
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * 只推一次快照，不改任何会话状态。
   * 用于"待确认请求"这类由 server 附带的数据变化：渲染层靠 seq 判断是否需要重画。
   */
  touch() {
    this._emit();
  }

  _ensure(id) {
    if (!id) return null;
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        title: null,
        cwd: null,
        transcriptPath: null,
        permissionMode: null,
        model: null,
        status: "idle",
        statusAt: Date.now(),
        thinking: "",
        thinkingAt: 0,
        pendingReset: false, // 新回合已开始，但新思考还没到：到了就替换旧的
        /**
         * WorkBuddy 本体正在它自己窗口里问"要不要执行"。
         *
         * 关键事实（2026-11-27 用时间戳验证）：客户端的权限弹窗发生在
         * PreToolUse 钩子**之前**。所以面板对这一步永远接不到请求，
         * 只能"看见它在问"并大声提醒，不能代答。
         */
        clientAsk: null,
        steps: [],
        tokens: { out: 0, reasoning: 0, lastInput: 0, lastTotal: 0, cached: 0, lastAt: 0 },
        credit: 0,
        used: 0,
        size: 0,
        userPrompt: null,
        lastEvent: null,
        updatedAt: Date.now(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /**
   * 记录状态与"这一刻它还是这个样子"的时间。
   *
   * 关键点：活动状态即使没变，也要把 statusAt 往后推。
   * 旧写法只在状态**变化**时刷新，于是一串连续的 working 事件里时间戳永远
   * 停在第一次，超过 TTL（working 3 分钟）就被判回 idle —— 表现就是
   * "明明还在跑，面板显示空闲"。这正是必须每次续期的原因。
   */
  _setStatus(s, status, at) {
    /**
     * at 是"这条事件真实发生的时刻"，只有启动回放才会传。
     *
     * 回放时如果用 Date.now()，几小时前的 Stop / 权限提问都会被当成"刚刚发生"：
     * 面板一启动就挂出一张假的"等你确认"卡，你去 WorkBuddy 一看没有这回事。
     * 用事件自带的时间戳，过期的东西自己就按 TTL 落回去了。
     */
    const now = Number(at) > 0 ? Number(at) : Date.now();
    if (s.status !== status) {
      s.status = status;
      s.statusAt = now;
    } else if (LIVE_STATUS.has(status)) {
      s.statusAt = now;
    }
    s.updatedAt = now;
  }

  applyHook(ev) {
    const s = this._ensure(ev.session_id);
    if (!s) return;

    const at = Number(ev.ts) > 0 ? Number(ev.ts) : 0;
    const set = (st) => this._setStatus(s, st, at);

    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.transcript_path) s.transcriptPath = ev.transcript_path;
    if (ev.permission_mode) s.permissionMode = ev.permission_mode;
    s.lastEvent = ev.event;
    if (!at) s.updatedAt = Date.now();

    /**
     * 除"客户端正在问"这一条本身，任何事件都意味着那一问已经过去了：
     * 答完 → 钩子跑起来（PreToolUse/PostToolUse）；拦掉 → 这一轮到此为止（Stop）；
     * 你插了新话 → UserPromptSubmit。所以统一在这里收摊，不必为每种情况单写。
     */
    if (ev.event !== "Notification") s.clientAsk = null;

    switch (ev.event) {
      case "SessionStart":
        set("idle");
        break;

      case "UserPromptSubmit":
        /**
         * 新回合开始。
         *
         * 旧做法是立刻把 thinking / steps 清空 —— 于是每轮刚开始的那十几秒，
         * 面板上只剩一个"思考中"的灯和两片空白，看起来像面板坏了。
         * 现在改成"只打个标记"：上一轮的内容先留着看，等新思考真的到了再替换。
         * 步骤同理，上一轮还在 running 的直接判为完成（它不可能还在跑）。
         */
        s.pendingReset = true;
        for (const st of s.steps) {
          if (st.status === "running") {
            st.status = "done";
            st.endedAt = Date.now();
          }
        }
        s.userPrompt = ev.prompt ? String(ev.prompt).slice(0, 500) : null;
        set("thinking");
        break;

      case "PreToolUse": {
        const name = ev.tool_name || "unknown";
        const callId = ev.call_id || ev.tool_use_id || null;
        if (callId && !s.steps.some((x) => x.callId === callId)) {
          s.steps.push({
            callId,
            name,
            detail: briefArgs(name, ev.tool_input),
            status: "running",
            startedAt: Date.now(),
            endedAt: null,
          });
          if (s.steps.length > 300) s.steps = s.steps.slice(-300);
        }
        set(READ_TOOLS.has(name) ? "review" : "working");
        break;
      }

      case "PostToolUse": {
        const callId = ev.call_id || ev.tool_use_id || null;
        const step = callId ? s.steps.find((x) => x.callId === callId) : null;
        if (step && step.status === "running") {
          step.status = "done";
          step.endedAt = Date.now();
        }
        set("working");
        break;
      }

      case "Notification":
        if (ev.notification_type === "permission_prompt") {
          // 记下"它在问什么" —— 面板要靠这条去提醒你，而不是傻等
          s.clientAsk = {
            at: at || Date.now(),
            tool: toolFromNotice(ev.message),
            message: ev.message ? String(ev.message).slice(0, 200) : "",
          };
          set("waiting");
        }
        break;

      case "PreCompact":
        set("working");
        break;

      case "Stop": {
        const msg = ev.last_assistant_message || "";
        /**
         * 末尾是问号 = 它把话说完、在等你回答。
         *
         * 这里**不能**判成 waiting。waiting 的语义是"WorkBuddy 弹了权限窗、
         * 有人必须在窗口里点「仍要执行」"，渲染层据此挂一张"请到 WorkBuddy
         * 窗口处理"的卡。而"问了你一句"根本不需要去窗口点任何东西，
         * 混用会让面板整晚挂着一张假卡（2026-11-27 用户实际遇到）。
         */
        const asksQuestion = /[?？]\s*$/.test(msg.trim());
        set(asksQuestion ? "reply" : "done");
        break;
      }

      case "SessionEnd":
        set("idle");
        break;

      default:
        break;
    }

    this._emit();
  }

  applyTranscript(sessionId, delta) {
    const s = this._ensure(sessionId);
    if (!s || !delta) return;

    let changed = false;

    if (delta.reasoning && delta.reasoning.length) {
      const joined = delta.reasoning.join("\n\n");

      // 新回合的第一段思考：替换上一轮的，而不是接在它后面
      const base = s.pendingReset ? "" : s.thinking;
      s.pendingReset = false;

      let next = base ? base + "\n\n" + joined : joined;

      /**
       * 超长时按"行边界"截断。
       * 直接 slice(-LIMIT) 会把开头切在句子中间，面板顶部于是永远显示半句话。
       * 丢掉第一行残句后，顶部从完整的一行开始。
       */
      if (next.length > THINKING_LIMIT) {
        let cut = next.slice(-THINKING_LIMIT);
        const nl = cut.indexOf("\n");
        if (nl >= 0 && nl < cut.length - 1) cut = cut.slice(nl + 1);
        next = cut;
      }

      s.thinking = next;
      s.thinkingAt = Date.now();
      // 长思考期间往往一条钩子事件都没有，这里顺手给"思考中"续期
      if (s.status === "thinking") s.statusAt = s.thinkingAt;
      changed = true;
    }

    if (delta.calls && delta.calls.length) {
      for (const c of delta.calls) {
        if (c.callId && s.steps.some((x) => x.callId === c.callId)) continue;
        s.steps.push({
          callId: c.callId,
          name: c.name,
          detail: briefArgs(c.name, c.arguments),
          status: "running",
          startedAt: c.ts || Date.now(),
          endedAt: null,
        });
      }
      if (s.steps.length > 300) s.steps = s.steps.slice(-300);
      changed = true;
    }

    if (delta.results && delta.results.length) {
      for (const r of delta.results) {
        const step = r.callId ? s.steps.find((x) => x.callId === r.callId) : null;
        if (step) {
          step.status = r.status === "error" || r.status === "failed" ? "failed" : "done";
          step.endedAt = r.ts || Date.now();
        }
      }
      changed = true;
    }

    if (delta.usage) {
      const u = delta.usage;
      s.tokens.out += Number(u.output || 0);
      s.tokens.reasoning += Number(u.reasoning || 0);
      s.tokens.lastInput = Number(u.input || 0);
      s.tokens.lastTotal = Number(u.total || 0);
      s.tokens.cached = Number(u.cached || 0);
      s.tokens.lastAt = Date.now();
      changed = true;
    }

    if (delta.userPrompt) {
      s.userPrompt = delta.userPrompt;
      changed = true;
    }

    if (changed) {
      s.updatedAt = Date.now();
      this._emit();
    }
  }

  /**
   * 补上会话记录文件路径。
   * 场景：面板重启后回放事件流时，早期事件已被截断，某些会话（尤其是你手动
   * 固定的那个）拿不到 transcript_path，于是思考与步骤一直是空的。
   * server 端会在磁盘上按 sessionId 找到对应 .jsonl，再回填到这里。
   */
  setTranscriptPath(sessionId, filePath) {
    const s = this._ensure(sessionId);
    if (!s || !filePath || s.transcriptPath === filePath) return;
    s.transcriptPath = filePath;
    s.updatedAt = Date.now();
    this._emit();
  }

  applyUsage(sessionId, usage) {    const s = this._ensure(sessionId);
    if (!s || !usage) return;
    let changed = false;
    for (const key of ["credit", "used", "size"]) {
      if (usage[key] !== undefined && usage[key] !== s[key]) {
        s[key] = usage[key];
        changed = true;
      }
    }
    if (usage.title && usage.title !== s.title) {
      s.title = usage.title;
      changed = true;
    }
    if (usage.permissionMode) s.permissionMode = usage.permissionMode;
    if (usage.model && usage.model !== s.model) {
      s.model = usage.model;
      changed = true;
    }
    if (changed) this._emit();
  }

  /** 应用 TTL，返回当前有效状态 */
  _effectiveStatus(s, now) {
    const limit = TTL[s.status];
    if (!limit) return s.status;
    /**
     * "思考中"还要看最后一段思考是什么时候来的。
     * 模型长时间推理时可能几分钟没有任何钩子事件，只有会话记录在长；
     * 只认 statusAt 会把它误判成空闲。
     */
    const at = s.status === "thinking" ? Math.max(s.statusAt, s.thinkingAt || 0) : s.statusAt;
    if (now - at > limit) return "idle";
    return s.status;
  }

  snapshot() {
    const now = Date.now();
    const list = [];
    for (const s of this.sessions.values()) {
      const status = this._effectiveStatus(s, now);
      list.push({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        transcriptPath: s.transcriptPath,
        status,
        permissionMode: s.permissionMode,
        model: s.model,
        thinking: s.thinking,
        thinkingAt: s.thinkingAt,
        steps: s.steps.slice(-40),
        tokens: { ...s.tokens },
        credit: s.credit,
        used: s.used,
        size: s.size,
        userPrompt: s.userPrompt,
        clientAsk:
          s.clientAsk && now - s.clientAsk.at < CLIENT_ASK_TTL
            ? { ...s.clientAsk, waitedMs: now - s.clientAsk.at }
            : null,
        lastEvent: s.lastEvent,
        updatedAt: s.updatedAt,
      });
    }

    list.sort((a, b) => {
      const p = priorityOf(a.status) - priorityOf(b.status);
      return p !== 0 ? p : b.updatedAt - a.updatedAt;
    });

    return {
      serverTime: now,
      seq: this.seq,
      selected: list[0] || null,
      sessions: list,
    };
  }
}

module.exports = { Store };
