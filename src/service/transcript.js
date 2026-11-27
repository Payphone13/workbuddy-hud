"use strict";

/**
 * transcript 增量读取器
 *
 * 数据源：~/.workbuddy/projects/<proj>/<sessionId>.jsonl
 * 只读新增字节，按行解析，保留半行缓冲。
 *
 * 关注的行类型：
 *   reasoning              → 思考文本（rawContent[].text）
 *   function_call          → 工具调用（callId / name / arguments / stepSeq）
 *   function_call_result   → 工具结果（callId / status）
 *   message (assistant)    → providerData.usage（token 明细）
 */

const fs = require("fs");
const { StringDecoder } = require("string_decoder");

const MAX_LINE = 4 * 1024 * 1024; // 单行上限，超出直接丢弃

/**
 * 首读上限：只从文件尾部取这么多字节。
 * 一次长任务的 .jsonl 能到几 MB 甚至几十 MB，而面板只关心"最后几步、最后几段思考"。
 * 从文件头开始整份读进内存，等于每次面板启动或切换会话都做一次全量解析：
 * 启动瞬间的 CPU 与内存尖峰就是这么来的。
 */
const TAIL_BYTES = 512 * 1024;

/**
 * 规范化 token 用量。
 * WorkBuddy 在 providerData 中提供两套命名：
 *   usage    : { inputTokens, outputTokens, totalTokens, outputTokensDetails:[{reasoning_tokens}] }
 *   rawUsage : { prompt_tokens, completion_tokens, total_tokens, completion_tokens_details, credit, quota }
 */
function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;

  const output = Number(u.outputTokens !== undefined ? u.outputTokens : u.completion_tokens || 0);
  const input = Number(u.inputTokens !== undefined ? u.inputTokens : u.prompt_tokens || 0);
  const total = Number(u.totalTokens !== undefined ? u.totalTokens : u.total_tokens || 0);

  let reasoning = 0;
  if (Array.isArray(u.outputTokensDetails) && u.outputTokensDetails[0]) {
    reasoning = Number(u.outputTokensDetails[0].reasoning_tokens || 0);
  } else if (u.completion_tokens_details) {
    reasoning = Number(u.completion_tokens_details.reasoning_tokens || 0);
  } else if (u.completion_thinking_tokens !== undefined) {
    reasoning = Number(u.completion_thinking_tokens || 0);
  }

  let cached = 0;
  if (Array.isArray(u.inputTokensDetails) && u.inputTokensDetails[0]) {
    cached = Number(u.inputTokensDetails[0].cached_tokens || 0);
  } else if (u.prompt_tokens_details) {
    cached = Number(u.prompt_tokens_details.cached_tokens || 0);
  } else if (u.cached_tokens !== undefined) {
    cached = Number(u.cached_tokens || 0);
  }

  const credit = Number(u.credit || 0);

  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    total: Number.isFinite(total) ? total : 0,
    reasoning: Number.isFinite(reasoning) ? reasoning : 0,
    cached: Number.isFinite(cached) ? cached : 0,
    credit: Number.isFinite(credit) ? credit : 0,
  };
}

class TranscriptReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    /** 下一次读取是不是"第一次"（决定要不要跳到尾部） */
    this.firstRead = true;
    /** 从尾部起读时，第一段可能是半行，需要丢掉 */
    this.skipPartial = false;
  }

  reset(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.firstRead = true;
    this.skipPartial = false;
  }

  _readChunk() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch (_) {
      return null;
    }
    if (stat.size < this.offset) {
      // 文件被截断或替换：从头再来（同样只取尾部）
      this.offset = 0;
      this.buffer = "";
      this.decoder = new StringDecoder("utf8");
      this.firstRead = true;
      this.skipPartial = false;
    }
    if (stat.size === this.offset) return null;

    if (this.firstRead) {
      this.firstRead = false;
      if (stat.size > TAIL_BYTES) {
        this.offset = stat.size - TAIL_BYTES;
        this.skipPartial = true; // 起点几乎必然落在某一行中间
      }
    }

    const length = stat.size - this.offset;
    const buf = Buffer.allocUnsafe(length);
    let fd = null;
    try {
      fd = fs.openSync(this.filePath, "r");
      const read = fs.readSync(fd, buf, 0, length, this.offset);
      this.offset += read;
      let text = this.decoder.write(buf.subarray(0, read));
      if (this.skipPartial) {
        this.skipPartial = false;
        const nl = text.indexOf("\n");
        text = nl >= 0 ? text.slice(nl + 1) : "";
      }
      return text;
    } catch (_) {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  /** 返回自上次调用以来的增量事件 */
  poll() {
    const out = { reasoning: [], calls: [], results: [], usage: null, userPrompt: null };
    const chunk = this._readChunk();
    if (chunk === null) return out;

    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // 最后一段可能不完整

    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) continue;

      let d;
      try {
        d = JSON.parse(line);
      } catch (_) {
        continue;
      }

      switch (d.type) {
        case "reasoning": {
          const parts = Array.isArray(d.rawContent) ? d.rawContent : [];
          const text = parts
            .filter((p) => p && (p.type === "reasoning_text" || p.type === "text"))
            .map((p) => p.text || "")
            .join("")
            .trim();
          if (text) out.reasoning.push(text);
          break;
        }
        case "function_call": {
          const pd = d.providerData || {};
          out.calls.push({
            callId: d.callId || d.id || null,
            name: d.name || "unknown",
            arguments: d.arguments || null,
            stepSeq: pd.stepSeq === undefined ? null : pd.stepSeq,
            ts: d.timestamp || Date.now(),
          });
          break;
        }
        case "function_call_result": {
          out.results.push({
            callId: d.callId || null,
            name: d.name || null,
            status: d.status || null,
            ts: d.timestamp || Date.now(),
          });
          break;
        }
        case "message": {
          if (d.role === "user") {
            const blocks = Array.isArray(d.content) ? d.content : [];
            const text = blocks
              .filter((b) => b && b.type === "input_text")
              .map((b) => b.text || "")
              .join("\n");
            const cleaned = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "").trim();
            if (cleaned) out.userPrompt = cleaned.slice(0, 500);
          } else if (d.role === "assistant") {
            const pd = d.providerData || {};
            const raw = pd.rawUsage || pd.usage;
            if (raw) {
              const normalized = normalizeUsage(raw);
              if (normalized) out.usage = normalized;
            }
          }
          break;
        }
        default:
          break;
      }
    }

    return out;
  }
}

module.exports = { TranscriptReader };
