#!/usr/bin/env node
/**
 * 从一个方形的源图生成全部图标（无第三方依赖）
 *
 * 为什么不引 sharp / canvas：这两个都要本地编译，换台电脑装依赖就容易失败，
 * 而这里需要的只是"把大图缩小 + 打包成 ico"，用 zlib 手写足够。
 *
 * 用法：
 *   node tools/make-icons.js                用 assets/logo.png
 *   node tools/make-icons.js <源图.png>      用指定的源图，同时留一份到 assets/logo.png
 *
 * 产物：
 *   assets/logo.png          源图原样保存（以后换图标只改这一个文件）
 *   assets/icon.png          256×256，Electron 窗口图标
 *   assets/tray.png           32×32，Electron 托盘图标
 *   tauri/icons/icon.png     256×256，窗口图标
 *   tauri/icons/tray.png      32×32，托盘图标
 *   tauri/icons/icon.ico      多尺寸（16/24/32/48/64/128/256），编译进 exe
 *
 * 缩小用的是面积平均（每个目标像素按覆盖到的源像素重叠面积加权），
 * 先水平后垂直两趟，并且在缩放前把颜色乘上 alpha，
 * 否则透明边缘会掺进黑色，圆角处出现一圈脏边。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");

/* ---------------- PNG 解码 ---------------- */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("不是 PNG 文件");
  }
  const chunks = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    chunks.push({ type, data });
    p += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 解出 { width, height, rgba }，统一转成 8 位 RGBA */
function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("缺少 IHDR");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];

  if (depth !== 8) throw new Error(`只支持 8 位色深，当前 ${depth} 位`);
  if (interlace !== 0) throw new Error("不支持隔行扫描（interlaced）PNG，请重新导出");
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const palette = chunks.find((c) => c.type === "PLTE");
  const trns = chunks.find((c) => c.type === "tRNS");

  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const bpp = channels; // 8 位深时每像素字节数 = 通道数
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);

  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: v += paeth(a, b, c); break;
        default: throw new Error(`未知的行过滤类型 ${filter}`);
      }
      out[x] = v & 0xff;
    }
    out.copy(pixels, y * stride);
    prev = out;
  }

  // 统一成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) {
      r = pixels[i * 4]; g = pixels[i * 4 + 1]; b = pixels[i * 4 + 2]; a = pixels[i * 4 + 3];
    } else if (colorType === 2) {
      r = pixels[i * 3]; g = pixels[i * 3 + 1]; b = pixels[i * 3 + 2];
    } else if (colorType === 0) {
      r = g = b = pixels[i];
    } else if (colorType === 4) {
      r = g = b = pixels[i * 2]; a = pixels[i * 2 + 1];
    } else {
      const idx = pixels[i];
      if (!palette) throw new Error("索引色 PNG 缺少 PLTE");
      r = palette.data[idx * 3]; g = palette.data[idx * 3 + 1]; b = palette.data[idx * 3 + 2];
      if (trns && idx < trns.data.length) a = trns.data[idx];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }

  return { width, height, rgba };
}

/* ---------------- 面积平均缩放 ---------------- */

/** 每个目标格覆盖到的源格 + 重叠比例 */
function axisWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const out = [];
  for (let i = 0; i < dstLen; i++) {
    const start = i * scale;
    const end = (i + 1) * scale;
    const taps = [];
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      const overlap = Math.min(end, j + 1) - Math.max(start, j);
      if (overlap > 0) taps.push([j, overlap]);
    }
    const total = taps.reduce((t, x) => t + x[1], 0);
    out.push(taps.map(([j, v]) => [j, v / total]));
  }
  return out;
}

function resize(rgba, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Buffer.from(rgba);

  // 先乘 alpha（预乘），透明像素的颜色才不会污染邻居
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = rgba[i * 4 + 3] / 255;
    pre[i * 4] = rgba[i * 4] * a;
    pre[i * 4 + 1] = rgba[i * 4 + 1] * a;
    pre[i * 4 + 2] = rgba[i * 4 + 2] * a;
    pre[i * 4 + 3] = rgba[i * 4 + 3];
  }

  const wx = axisWeights(sw, dw);
  const mid = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sx, w] of wx[x]) {
        const o = (y * sw + sx) * 4;
        r += pre[o] * w; g += pre[o + 1] * w; b += pre[o + 2] * w; a += pre[o + 3] * w;
      }
      const o = (y * dw + x) * 4;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
    }
  }

  const wy = axisWeights(sh, dh);
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sy, w] of wy[y]) {
        const o = (sy * dw + x) * 4;
        r += mid[o] * w; g += mid[o + 1] * w; b += mid[o + 2] * w; a += mid[o + 3] * w;
      }
      const o = (y * dw + x) * 4;
      const alpha = a / 255; // 反预乘
      out[o] = alpha > 0 ? Math.round(Math.min(255, r / alpha)) : 0;
      out[o + 1] = alpha > 0 ? Math.round(Math.min(255, g / alpha)) : 0;
      out[o + 2] = alpha > 0 ? Math.round(Math.min(255, b / alpha)) : 0;
      out[o + 3] = Math.round(Math.min(255, a));
    }
  }
  return out;
}

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const line = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    let best = Infinity;
    let bestFilter = 0;
    let bestLine = null;
    // 五种过滤器各试一遍，取"绝对值之和最小"的一种（PNG 最常用的启发式）
    for (let f = 0; f <= 4; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const cur = rgba[y * stride + x];
        const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
        const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
        const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
        let v;
        switch (f) {
          case 0: v = cur; break;
          case 1: v = cur - a; break;
          case 2: v = cur - b; break;
          case 3: v = cur - ((a + b) >> 1); break;
          default: v = cur - paeth(a, b, c); break;
        }
        v &= 0xff;
        line[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < best) {
        best = sum;
        bestFilter = f;
        bestLine = Buffer.from(line);
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    bestLine.copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO 打包 ---------------- */

/**
 * ICO 里的位图条目用 DIB（BITMAPINFOHEADER + 像素 + 掩码），不是 PNG。
 *
 * 这里踩过一个坑：一开始所有尺寸都塞 PNG，容器格式完全合法，
 * 但 Windows 的图标解码器只接受 256×256 用 PNG，小尺寸必须是 DIB，
 * 否则资源管理器干脆显示成默认的空白程序图标。
 */
function dibEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 高度写两倍：XOR 图 + AND 掩码
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB，不压缩
  header.writeUInt32LE(size * size * 4, 20);

  // 像素：自下而上，BGRA
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }

  // AND 掩码：1 位表示"透明"，每行补齐到 4 字节
  const maskStride = ((size + 31) >> 5) << 2;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      if (rgba[srcRow + x * 4 + 3] < 128) {
        const bit = 7 - (x & 7);
        mask[y * maskStride + (x >> 3)] |= 1 << bit;
      }
    }
  }

  return { size, data: Buffer.concat([header, xor, mask]) };
}

/** Vista 起 256×256 允许直接内嵌 PNG，容器头只有 6 + 16×n 字节 */
function buildIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const heads = [];
  for (const e of entries) {
    const head = Buffer.alloc(16);
    head.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    head.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    head.writeUInt8(0, 2);
    head.writeUInt8(0, 3);
    head.writeUInt16LE(1, 4);
    head.writeUInt16LE(32, 6);
    head.writeUInt32LE(e.data.length, 8);
    head.writeUInt32LE(offset, 12);
    heads.push(head);
    offset += e.data.length;
  }

  return Buffer.concat([dir, ...heads, ...entries.map((e) => e.data)]);
}

/* ---------------- 入口 ---------------- */

function main() {
  const srcArg = process.argv[2];
  const assets = path.join(root, "assets");
  const icons = path.join(root, "tauri", "icons");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(icons, { recursive: true });

  // 源图留一份在 assets/logo.png，以后换图标只需要替换它再跑一次
  const srcFile = path.join(assets, "logo.png");
  if (srcArg) fs.copyFileSync(path.resolve(srcArg), srcFile);
  if (!fs.existsSync(srcFile)) {
    throw new Error(`找不到源图 ${srcFile}，用法：node tools/make-icons.js <源图.png>`);
  }

  const src = decodePng(fs.readFileSync(srcFile));
  if (src.width !== src.height) {
    throw new Error(`源图必须正方形，当前 ${src.width}×${src.height}`);
  }
  console.log(`源图 ${src.width}×${src.height}（${fs.statSync(srcFile).size} 字节）`);

  const cache = new Map();
  const at = (size) => {
    if (!cache.has(size)) {
      cache.set(size, encodePng(size, size, resize(src.rgba, src.width, src.height, size, size)));
    }
    return cache.get(size);
  };

  for (const [file, size] of [
    [path.join(assets, "icon.png"), 256],
    [path.join(assets, "tray.png"), 32],
    [path.join(icons, "icon.png"), 256],
    [path.join(icons, "tray.png"), 32],
  ]) {
    fs.writeFileSync(file, at(size));
    console.log(`  ${path.relative(root, file).padEnd(22)} ${size}×${size}  ${fs.statSync(file).size} 字节`);
  }

  // 小尺寸用 DIB、256 用 PNG：Windows 只认这种组合
  const entries = [16, 24, 32, 48, 64, 128].map((size) =>
    dibEntry(size, resize(src.rgba, src.width, src.height, size, size))
  );
  entries.push({ size: 256, data: at(256) });

  const ico = buildIco(entries);
  const icoFile = path.join(icons, "icon.ico");
  fs.writeFileSync(icoFile, ico);
  console.log(
    `  ${path.relative(root, icoFile).padEnd(22)} ${entries.map((e) => e.size).join("/")}  ${ico.length} 字节`
  );
}

main();
