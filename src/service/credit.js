"use strict";

/**
 * 点数与上下文占用读取器
 *
 * 数据源：~/.workbuddy/workbuddy.db 的 session_usage 表
 *   credit_json : { "<conversationRequestId>": <credit>, ... } 逐轮点数
 *   used / size : 上下文占用 / 窗口上限
 *
 * 安全：
 *   - 只读打开（readOnly），不持有写锁
 *   - 查询失败一律返回 null，由上层沿用上次值，不抛异常打断 UI
 */

const fs = require("fs");
const { DB_PATH } = require("./config");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_) {
  DatabaseSync = null;
}

const CACHE_MS = 1500;
const cache = new Map();

/* ---------------- 只读连接复用 ----------------
 * 面板每 1.5 秒刷新一次，最多 24 个会话轮流读点数。
 * 旧写法是"每次查询都开一个新的只读连接、查完关掉"，
 * 等于每秒十几次打开 SQLite 文件（打开要读文件头、校验 WAL、建页缓存），
 * 白白吃掉 CPU 和磁盘 IO：在机械盘或杀毒软件实时扫描下会明显卡顿。
 *
 * 现在全模块共用一条连接。出错（库被替换、句柄失效）时丢弃并重开一次，
 * 读不到就沿用缓存，绝不因为库忙把面板清空。
 *
 * 已知代价：Windows 上"有人开着文件"会阻止它被改名（实测 EBUSY）。
 * 也就是说面板运行期间，WorkBuddy 若想整体替换 workbuddy.db 会被我们挡住。
 * 这类操作极少（换账号、恢复备份），且面板一退出就释手，因此接受这个代价；
 * 退出路径统一调用 closeDb()，不要留下悬空句柄。
 */
let db = null;
let dbOpenedPath = null;

function getDb() {
  if (!DatabaseSync) return null;
  if (db && dbOpenedPath === DB_PATH) return db;
  closeDb();
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    db.exec("PRAGMA busy_timeout=800");
    dbOpenedPath = DB_PATH;
    return db;
  } catch (_) {
    db = null;
    dbOpenedPath = null;
    return null;
  }
}

function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch (_) {
    /* 已经关了或句柄失效：忽略 */
  }
  db = null;
  dbOpenedPath = null;
}

function sumCredit(jsonText) {
  if (!jsonText) return 0;
  try {
    const obj = JSON.parse(jsonText);
    if (!obj || typeof obj !== "object") return 0;
    let total = 0;
    for (const key of Object.keys(obj)) {
      const v = Number(obj[key]);
      if (Number.isFinite(v)) total += v;
    }
    return Math.round(total * 100) / 100;
  } catch (_) {
    return 0;
  }
}

/** 用共用的只读连接执行一段查询；句柄失效时丢弃重开并重试一次 */
function withDb(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = getDb();
    if (!conn) return null;
    try {
      return fn(conn);
    } catch (err) {
      closeDb();
      if (attempt === 1) throw err;
    }
  }
  return null;
}

function readUsage(sessionId) {
  if (!sessionId) return null;
  if (!DatabaseSync) return null;
  if (!fs.existsSync(DB_PATH)) return null;

  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value;
  try {
    value = withDb((conn) => {
      const usage = conn
        .prepare("SELECT used, size, credit_json, updated_at FROM session_usage WHERE session_id = ?")
        .get(sessionId);

      const session = conn
        .prepare("SELECT title, status, model, permission_mode FROM sessions WHERE id = ?")
        .get(sessionId);

      return {
        credit: usage ? sumCredit(usage.credit_json) : 0,
        used: usage ? Number(usage.used) : 0,
        size: usage ? Number(usage.size) : 0,
        creditUpdatedAt: usage ? Number(usage.updated_at) : 0,
        title: session ? session.title : null,
        status: session ? session.status : null,
        model: session ? session.model : null,
        permissionMode: session ? session.permission_mode : null,
      };
    });
  } catch (_) {
    return hit ? hit.value : null;
  }

  if (!value) return hit ? hit.value : null;
  cache.set(sessionId, { at: Date.now(), value });
  return value;
}

/* ---------------- 任务列表（方案 A 的数据源） ----------------
 * 面板的会话列表以前只来自"事件流里出现过谁"，于是：
 *   - 手工测试用的假 session_id 会凭空出现，显示成"未命名会话"；
 *   - 没有新事件的老任务一个都不显示，看起来像任务丢了。
 * 现在以任务库 sessions 表为准：标题、状态、最近活动时间都从库里来，
 * 面板只负责把"正在跑的那个"的细节叠加上去。
 */

const LIST_CACHE_MS = 3000;
let listCache = { at: 0, rows: [] };

function rowTitle(r) {
  return (r.custom_title && String(r.custom_title).trim()) || (r.title && String(r.title).trim()) || "";
}

/**
 * 这个会话是哪次定时任务跑出来的？
 * WorkBuddy 把任务 id 写进 session_settings.conversationTags.automationId，
 * 这是唯一靠得住的线索（标题会随改名而变，automation_runs.thread_id 是
 * "<任务id>:<时间戳>" 而不是会话 id，对不上）。
 * 手机会话没有这一段，返回 null。
 */
function automationOf(settingsText) {
  if (!settingsText) return null;
  try {
    const s = JSON.parse(settingsText);
    const id = s && s.conversationTags ? s.conversationTags.automationId : null;
    return typeof id === "string" && id ? id : null;
  } catch (_) {
    return null;
  }
}

/**
 * 定时任务 id → 现在叫什么名字。
 * 用任务定义里的名字而不是会话标题，否则你改一次名，同一任务的历史会被
 * 劈成"每日 AI 新闻推送"和"每日新闻推送"两堆。
 */
function automationNames(db) {
  const map = new Map();
  try {
    for (const r of db.prepare("SELECT id, name FROM automations").all()) {
      if (r && r.id) map.set(r.id, (r.name && String(r.name).trim()) || "");
    }
  } catch (_) {
    /* 老版本库没有这张表：折叠退化成按标题分组，不影响列表 */
  }
  return map;
}

function listSessions(limit) {
  if (!DatabaseSync) return [];
  if (!fs.existsSync(DB_PATH)) return [];

  const hit = listCache;
  if (Date.now() - hit.at < LIST_CACHE_MS) return hit.rows.slice(0, limit || undefined);

  const n = Math.max(1, Math.min(Number(limit) || 40, 200));
  let rows = [];
  try {
    /* 共用同一条只读连接；库被替换导致句柄失效时 withDb 会自动重开一次 */
    rows =
      withDb((db) => {
        // 老版本库可能缺列，先按全量查，缺列就退化成最小字段集
        let raw;
        try {
          raw = db
            .prepare(
              "SELECT id, title, custom_title, status, updated_at, last_activity_at, deleted_at, visibility, session_settings " +
                "FROM sessions ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ?"
            )
            .all(n * 3);
        } catch (_) {
          try {
            raw = db
              .prepare(
                "SELECT id, title, custom_title, status, updated_at, last_activity_at, deleted_at, visibility " +
                  "FROM sessions ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ?"
              )
              .all(n * 3);
          } catch (_) {
            raw = db
              .prepare("SELECT id, title, status, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?")
              .all(n * 3);
          }
        }

        const autoNames = automationNames(db);

        const seen = new Set();
        const out = [];
        for (const r of raw) {
          if (!r || !r.id || seen.has(r.id)) continue;
          if (r.deleted_at) continue;
          if (r.visibility && r.visibility !== "visible") continue;
          const title = rowTitle(r);
          if (!title) continue; // 没标题的多半是空壳 / 内部会话，不往你眼前摆
          seen.add(r.id);
          const act = Number(r.last_activity_at || r.updated_at || 0);
          const automationId = automationOf(r.session_settings);
          out.push({
            id: r.id,
            title,
            status: r.status || "completed",
            updatedAt: act,
            // 定时任务跑出来的会话带上任务身份，面板据此把同一任务的多次运行折成一行
            automationId: automationId || null,
            automationName: automationId ? autoNames.get(automationId) || "" : "",
          });
          if (out.length >= 40) break;
        }
        return out;
      }) || [];
  } catch (_) {
    /* 读不到就沿用上一次的结果，不要因为锁冲突把列表清空 */
    return listCache.rows.slice(0, limit || undefined);
  }

  listCache = { at: Date.now(), rows };
  return rows.slice(0, limit || undefined);
}

module.exports = { readUsage, sumCredit, listSessions, closeDb };
