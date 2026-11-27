"use strict";

const os = require("os");
const path = require("path");

/** 运行时数据目录（与 tmp 分离，避免清理临时文件后失效） */
const HUD_DIR = process.env.WB_HUD_DIR || path.join(os.homedir(), ".workbuddy-hud");
const SPOOL = path.join(HUD_DIR, "events.jsonl");
/** 服务实际监听的端口（端口被占用时会顺延，hook 靠这个文件对齐） */
const PORT_FILE = path.join(HUD_DIR, "port.txt");

/** WorkBuddy 配置目录：优先环境变量，其次 ~/.workbuddy，最后 ~/.workbuddy-ai */
function resolveWorkBuddyDir() {
  const envDir = process.env.WORKBUDDY_CONFIG_DIR;
  if (envDir) return envDir;
  const legacy = path.join(os.homedir(), ".workbuddy");
  const current = path.join(os.homedir(), ".workbuddy-ai");
  const fs = require("fs");
  if (fs.existsSync(path.join(legacy, "workbuddy.db"))) return legacy;
  if (fs.existsSync(path.join(current, "workbuddy.db"))) return current;
  return legacy;
}

const WB_DIR = resolveWorkBuddyDir();
const PROJECTS_DIR = path.join(WB_DIR, "projects");
const DB_PATH = path.join(WB_DIR, "workbuddy.db");

const HOST = "127.0.0.1";
const PORT = Number(process.env.WB_HUD_PORT || 47821);

/** 各状态的存活时限（毫秒），超时回落 idle */
const TTL = {
  working: 3 * 60 * 1000,
  review: 3 * 60 * 1000,
  thinking: 5 * 60 * 1000,
  waiting: 24 * 60 * 60 * 1000,
  /**
   * 答完了、最后一句是在问你 —— 和"等你确认权限"必须分开。
   *
   * 两者的界面表现几乎一样（都要你看一眼），但性质完全不同：
   * waiting 是 WorkBuddy 弹了窗要你点「仍要执行」，reply 只是它把话说完
   * 并在末尾问了句"要不要继续"。混用一个状态的结果是：面板挂出一张
   * "请到 WorkBuddy 窗口处理"的卡，你去窗口一看，根本没有要批的东西。
   */
  reply: 24 * 60 * 60 * 1000,
  done: 7 * 24 * 60 * 60 * 1000,
  failed: 60 * 60 * 1000,
  idle: 0,
};

/**
 * "WorkBuddy 本体正在问用户"这条记录的存活时限。
 *
 * 为什么要设上限：客户端提问没有配套的结束事件 —— 用户点「拦截」之后，
 * 钩子一个都不发，我们收不到任何"问完了"的信号。只能靠"下一条事件到来"
 * 或这个时限来收摊，否则卡片会一直挂着骗人。
 */
const CLIENT_ASK_TTL = 30 * 60 * 1000;

/** 只读类工具：判为 review（在看），其余判为 working（在改） */
const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "WebFetch", "WebSearch", "NotebookRead",
  "LS", "TodoRead", "ReadNotebook", "list_dir", "read_file",
]);

/** 思考文本保留上限（字符） */
const THINKING_LIMIT = 2000;

module.exports = {
  HUD_DIR,
  SPOOL,
  PORT_FILE,
  WB_DIR,
  PROJECTS_DIR,
  DB_PATH,
  HOST,
  PORT,
  TTL,
  CLIENT_ASK_TTL,
  READ_TOOLS,
  THINKING_LIMIT,
};
