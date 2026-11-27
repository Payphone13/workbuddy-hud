"use strict";

/**
 * 风险判定：把"工具名 + 参数"翻译成人话，并判断危险等级。
 *
 * 设计原则（面向非程序员）：
 *   1. 只说结果，不说术语。不写 "PreToolUse"、"shell metacharacter"，
 *      而写"会删掉整个文件夹""会把网上下载的脚本直接运行"。
 *   2. 拿不准就判 normal，绝不因为看不懂就判危险——
 *      误报多的结果是用户干脆关掉整个功能。
 *   3. 全部规则只影响"是否弹出确认卡"，不修改参数、不替换命令。
 */

const path = require("path");

/** 工具名 → 人话动作 */
const ACTION = {
  Bash: "运行一条命令",
  PowerShell: "运行一条 PowerShell 命令",
  Write: "写入一个新文件",
  Edit: "修改一个已有文件",
  MultiEdit: "批量修改一个文件",
  NotebookEdit: "修改一个笔记本文件",
  Read: "读取一个文件",
  Grep: "在文件里搜索文字",
  Glob: "按文件名查找文件",
  WebFetch: "打开一个网页",
  WebSearch: "联网搜索",
  Task: "派一个子任务出去",
  Agent: "派一个子任务出去",
  KillShell: "结束一个后台进程",
};

/** 危险命令特征：命中即判 high */
const DANGER_COMMAND = [
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s/i, why: "会强制删除文件，删掉的通常找不回来" },
  { re: /\b(del|erase)\s+\/[a-z]*[sfq]/i, why: "会强制删除文件，不进回收站" },
  { re: /\b(rd|rmdir)\s+\/s/i, why: "会删掉整个文件夹连同里面所有内容" },
  { re: /remove-item[^\n]*(-recurse|-force)/i, why: "会递归强制删除文件或文件夹" },
  /**
   * 格式化只认"带目标"的写法：format C: / format /fs:ntfs D: / mkfs.ext4 /dev/sdb。
   * 旧规则写作 \b(format|diskpart|mkfs)\b，于是 `npm run format`、`prettier --write`
   * 也会被说成"会格式化磁盘，数据全部丢失" —— 误报多了，用户就把整个功能关了。
   */
  { re: /\bformat\s+([a-z]:|\/[a-z])/i, why: "会格式化磁盘分区，数据全部丢失" },
  { re: /\b(diskpart|mkfs(\.[a-z0-9]+)?)\b/i, why: "会格式化磁盘或改动分区表，数据全部丢失" },
  { re: />\s*\/dev\/(sd|nvme)/i, why: "会直接覆写磁盘" },
  { re: /\breg\s+(add|delete|import)\b/i, why: "会改动 Windows 注册表，可能影响系统启动" },
  // 关机/重启必须出现在命令位置（行首、&& ; | 之后，或 sudo 后面），
  // 否则 `echo reboot`、日志文本里的 shutdown 也会被当成真要重启
  {
    re: /(^|[;&|]\s*|\bsudo\s+)(shutdown|reboot|restart-computer)\b/i,
    why: "会关机或重启电脑",
  },
  { re: /\btaskkill\b[^\n]*\/f/i, why: "会强制结束正在运行的程序" },
  { re: /\b(schtasks|sc\s+(create|delete|config))\b/i, why: "会改动系统计划任务或后台服务" },
  { re: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba)?sh/i, why: "会把网上下载的脚本直接运行，内容你还没看过" },
  { re: /(invoke-webrequest|iwr|invoke-restmethod)[^\n|]*\|\s*(iex|invoke-expression)/i, why: "会把网上下载的脚本直接运行，内容你还没看过" },
  { re: /git\s+push[^\n]*(-f\b|--force)/i, why: "会强制覆盖远端仓库，别人的提交可能被冲掉" },
  { re: /\bnpm\s+publish\b/i, why: "会把代码发布到公共仓库，别人就能下载" },
  { re: /:\(\)\s*\{[^}]*\}\s*;\s*:/, why: "这是一个会拖垮电脑的自复制命令" },
  { re: /\bcipher\s+\/w/i, why: "会擦除磁盘空闲空间，耗时很长且不可中断" },
];

/**
 * 敏感路径：写入这些位置判 high。
 * 系统目录必须从盘符根开始 —— 否则项目里一个名为 windows/ 或 AppData/ 的
 * 普通文件夹也会被说成"Windows 系统目录"。
 */
const SENSITIVE_PATH = [
  { re: /(^|[\\/])\.ssh([\\/]|$)/i, why: "这是 SSH 密钥目录，改错会连不上服务器" },
  { re: /(^|[\\/])\.aws([\\/]|$)/i, why: "这是云账号密钥目录" },
  { re: /(^|[\\/])\.gnupg([\\/]|$)/i, why: "这是加密密钥目录" },
  { re: /^[a-z]:[\\/]windows([\\/]|$)/i, why: "这是 Windows 系统目录" },
  { re: /^[a-z]:[\\/]program files( \(x86\))?([\\/]|$)/i, why: "这是已安装程序的目录" },
  { re: /^[a-z]:[\\/]appdata([\\/]|$)/i, why: "这是其他程序的配置与数据目录" },
  {
    re: /^[a-z]:[\\/]users[\\/][^\\/]+[\\/]appdata([\\/]|$)/i,
    why: "这是其他程序的配置与数据目录",
  },
];

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function clip(text, limit) {
  const s = String(text === undefined || text === null ? "" : text);
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

/** 从参数里抽出"最该给人看的那一句" */
function targetOf(toolName, input) {
  if (!input || typeof input !== "object") return "";
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = input.command || input.script || "";
    return clip(String(cmd).replace(/\s+/g, " ").trim(), 160);
  }
  if (WRITE_TOOLS.has(toolName)) {
    return clip(input.file_path || input.notebook_path || input.path || "", 160);
  }
  if (toolName === "WebFetch") return clip(input.url || "", 160);
  if (toolName === "WebSearch") return clip(input.query || "", 120);
  const pick = input.file_path || input.path || input.pattern || input.query || input.description || "";
  return clip(pick, 120);
}

/** 是否在会话工作目录之内（用于判断"改到项目外面去了"） */
function isOutside(target, cwd) {
  if (!target || !cwd) return false;
  try {
    const base = path.resolve(cwd);
    const resolved = path.resolve(base, target);
    const a = resolved.toLowerCase();
    const b = base.toLowerCase();
    return a !== b && !a.startsWith(b + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * 判定一次工具调用的风险。
 * @returns {{level:"high"|"normal", action:string, target:string, why:string, headline:string}}
 */
function classify(toolName, input, cwd) {
  const name = String(toolName || "unknown");
  const action = ACTION[name] || "调用工具 " + name;
  const target = targetOf(name, input);

  let level = "normal";
  let why = "常规操作，一般不会造成不可恢复的后果";

  if (SHELL_TOOLS.has(name)) {
    const cmd = String((input && (input.command || input.script)) || "");
    for (const rule of DANGER_COMMAND) {
      if (rule.re.test(cmd)) {
        level = "high";
        why = rule.why;
        break;
      }
    }
  }

  if (WRITE_TOOLS.has(name) && level !== "high") {
    for (const rule of SENSITIVE_PATH) {
      if (rule.re.test(target)) {
        level = "high";
        why = rule.why;
        break;
      }
    }
    if (level !== "high" && isOutside(target, cwd)) {
      level = "high";
      why = "要改的文件不在当前项目文件夹里，改错会影响其他东西";
    }
  }

  return {
    level,
    action,
    target,
    why,
    headline: level === "high" ? "这步有风险，需要你点头" : "WorkBuddy 想执行一步操作",
  };
}

module.exports = { classify, ACTION, WRITE_TOOLS, SHELL_TOOLS };
