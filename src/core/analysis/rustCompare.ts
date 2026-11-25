/**
 * 两期锈蚀变化分析(纯 TypeScript,无 DOM 依赖,可在 node / tsx 下直接测试)。
 *
 * 管线:
 *   1. 中位数亮度全局曝光归一化(两张图各自乘增益到共同中位亮度);
 *   2. 逐像素加权 RGB 色差 + 锈蚀色度指数(橙红新锈 / 绿蓝铜绿)的时间差;
 *   3. 阈值化得到 mask,3x3 开/闭运算去散点;
 *   4. 四邻域连通域(flood fill + label),剔除小斑块,输出 RustRegion;
 *   5. score 可直接交给 drawHeatmapOverlay 生成热力叠加 canvas。
 *
 * 坐标均为输入图像像素坐标,x 向右、y 向下。
 */

import type { RustRegion } from '../types';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface RustAnalysisOptions {
  threshold?: number;
  minRegionPx?: number;
  mmPerPixel?: number;
}

export interface RustMaskResult {
  width: number;
  height: number;
  /** 0/1,经过形态学与小域剔除后的“变化 + 锈蚀样”掩膜 */
  mask: Uint8Array;
  /** 0..1 逐像素变化/锈蚀分数(供热力图) */
  score: Float32Array;
  regions: RustRegion[];
  changedPixels: number;
}

/** 需求指定的默认阈值 */
export const DEFAULT_RUST_THRESHOLD = 0.22;

/** 分数整体增益,把明显斑块推到阈值之上、噪声留在阈值之下 */
const SCORE_GAIN = 1.35;

/** 加权 RGB 距离权重(绿通道视觉权重最高) */
const WR = 0.3;
const WG = 0.55;
const WB = 0.15;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 用 256 格亮度直方图求中位亮度(0..255),避免对百万级数组排序。
 * 忽略完全透明像素。
 */
export function medianLuma(img: RgbaImage): number {
  const { width: w, height: h, data } = img;
  const hist = new Uint32Array(256);
  let count = 0;
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) continue;
    const l = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
    let bin = l | 0;
    if (bin > 255) bin = 255;
    hist[bin]++;
    count++;
  }
  if (count === 0) return 0;
  const need = count >> 1;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= need) return b;
  }
  return 255;
}

/**
 * 锈蚀色度指数,0..1。
 * - 橙红新锈:r 明显大于 g,且 r-(g+b)/2 为强正;
 * - 绿色铜绿:g 明显大于 r,且 g-(r+b)/2 为强正。
 * 青铜底色本身可能带一点橙味,但两期相同时该指数在做时间差后抵消。
 */
export function rustIndex(r: number, g: number, b: number): number {
  // 橙红锈
  let orange = 0;
  if (r > g + 6) {
    const raw = r - (g + b) / 2;
    if (raw > 0) orange = clamp01(raw / 85);
  }
  // 绿铜绿(绿主导;蓝绿矿化时 b 也可能偏高,故只要求 g>r)
  let green = 0;
  if (g > r + 6) {
    const raw = g - (r + b) / 2;
    if (raw > 0) green = clamp01(raw / 60);
  }
  // 蓝铜绿补充:b 主导且 b 明显大于 r
  let blue = 0;
  if (b > r + 10 && b >= g - 12) {
    const raw = b - (r + g) / 2;
    if (raw > 0) blue = clamp01(raw / 70) * 0.9;
  }
  return Math.max(orange, green, blue);
}

/** 3x3 腐蚀:邻域全 1 才为 1(越界按 0 处理) */
function erode3(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < w - 1 ? x + 1 : x;
      let v = 1;
      for (let yy = y0; yy <= y1 && v; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          if (!src[row + xx]) {
            v = 0;
            break;
          }
        }
      }
      dst[y * w + x] = v;
    }
  }
  return dst;
}

/** 3x3 膨胀:邻域任一为 1 即为 1 */
function dilate3(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y;
    const y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x;
      const x1 = x < w - 1 ? x + 1 : x;
      let v = 0;
      for (let yy = y0; yy <= y1 && !v; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          if (src[row + xx]) {
            v = 1;
            break;
          }
        }
      }
      dst[y * w + x] = v;
    }
  }
  return dst;
}

interface ComponentStats {
  count: number;
  sumScore: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 连通域分析 + 小域剔除。
 * 返回最终 mask、保留下来的 regions 与 changedPixels。
 */
function componentsToRegions(
  rawMask: Uint8Array,
  score: Float32Array,
  w: number,
  h: number,
  minRegionPx: number,
  mmPerPixel: number | undefined,
): { mask: Uint8Array; regions: RustRegion[]; changedPixels: number } {
  const n = w * h;
  const labels = new Int32Array(n); // 0 = 未标记/背景
  const comps: ComponentStats[] = [];
  // 单次 flood 使用的定长栈,避免 number[] 扩容抖动
  const stack = new Int32Array(n);

  for (let seed = 0; seed < n; seed++) {
    if (!rawMask[seed] || labels[seed] !== 0) continue;
    const id = comps.length + 1;
    const stats: ComponentStats = {
      count: 0,
      sumScore: 0,
      minX: seed % w,
      minY: (seed / w) | 0,
      maxX: seed % w,
      maxY: (seed / w) | 0,
    };
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = id;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      stats.count++;
      stats.sumScore += score[p];
      if (x < stats.minX) stats.minX = x;
      if (x > stats.maxX) stats.maxX = x;
      if (y < stats.minY) stats.minY = y;
      if (y > stats.maxY) stats.maxY = y;

      // 4 邻域
      if (x > 0) {
        const q = p - 1;
        if (rawMask[q] && labels[q] === 0) {
          labels[q] = id;
          stack[sp++] = q;
        }
      }
      if (x < w - 1) {
        const q = p + 1;
        if (rawMask[q] && labels[q] === 0) {
          labels[q] = id;
          stack[sp++] = q;
        }
      }
      if (y > 0) {
        const q = p - w;
        if (rawMask[q] && labels[q] === 0) {
          labels[q] = id;
          stack[sp++] = q;
        }
      }
      if (y < h - 1) {
        const q = p + w;
        if (rawMask[q] && labels[q] === 0) {
          labels[q] = id;
          stack[sp++] = q;
        }
      }
    }
    comps.push(stats);
  }

  const keep = new Uint8Array(comps.length + 1);
  const regions: RustRegion[] = [];
  comps.forEach((c, idx) => {
    if (c.count < minRegionPx) return;
    const id = idx + 1;
    keep[id] = 1;
    const region: RustRegion = {
      x: c.minX,
      y: c.minY,
      w: c.maxX - c.minX + 1,
      h: c.maxY - c.minY + 1,
      pixels: c.count,
      meanDelta: c.count > 0 ? c.sumScore / c.count : 0,
    };
    if (mmPerPixel && Number.isFinite(mmPerPixel) && mmPerPixel > 0) {
      region.areaMm2 = c.count * mmPerPixel * mmPerPixel;
    }
    regions.push(region);
  });

  // 大区域排在前面,便于 UI 展示
  regions.sort((r1, r2) => r2.pixels - r1.pixels);

  const mask = new Uint8Array(n);
  let changedPixels = 0;
  for (let p = 0; p < n; p++) {
    const id = labels[p];
    if (id > 0 && keep[id]) {
      mask[p] = 1;
      changedPixels++;
    }
  }
  return { mask, regions, changedPixels };
}

export function computeRustChanges(
  a: RgbaImage,
  b: RgbaImage,
  opts: RustAnalysisOptions = {},
): RustMaskResult {
  const w = a.width;
  const h = a.height;
  if (!(w > 0) || !(h > 0) || b.width !== w || b.height !== h) {
    throw new Error(
      `computeRustChanges: 两张图必须为相同的有效尺寸 (a=${a.width}x${a.height}, b=${b.width}x${b.height})`,
    );
  }
  const threshold = opts.threshold ?? DEFAULT_RUST_THRESHOLD;
  const minRegionPx =
    opts.minRegionPx ?? Math.max(24, Math.round(w * h * 0.00008));
  const mmPerPixel = opts.mmPerPixel;

  const da = a.data;
  const db = b.data;
  const n = w * h;
  const score = new Float32Array(n);

  // ---- 1) 中位数曝光归一化增益(共同目标 = 两期中位亮度均值) ----
  const medA = medianLuma(a);
  const medB = medianLuma(b);
  const target = Math.max(8, (medA + medB) / 2);
  const gainA = clamp(target / Math.max(1, medA), 0.5, 2);
  const gainB = clamp(target / Math.max(1, medB), 0.5, 2);

  const rawMask = new Uint8Array(n);

  // ---- 2) 逐像素分数 ----
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    // 透明/越界填充像素不参与比较
    if (da[i + 3] < 128 || db[i + 3] < 128) {
      score[p] = 0;
      continue;
    }
    const ar = clamp255(da[i] * gainA);
    const ag = clamp255(da[i + 1] * gainA);
    const ab = clamp255(da[i + 2] * gainA);
    const br = clamp255(db[i] * gainB);
    const bg = clamp255(db[i + 1] * gainB);
    const bb = clamp255(db[i + 2] * gainB);

    const dr = br - ar;
    const dg = bg - ag;
    const dbc = bb - ab;
    const colorDiff =
      Math.sqrt(WR * dr * dr + WG * dg * dg + WB * dbc * dbc) / 255;

    const riA = rustIndex(ar, ag, ab);
    const riB = rustIndex(br, bg, bb);
    const rustDelta = Math.abs(riB - riA);

    const s = clamp01((0.65 * colorDiff + 0.35 * rustDelta) * SCORE_GAIN);
    score[p] = s;
    if (s >= threshold) rawMask[p] = 1;
  }

  // ---- 3) 3x3 开运算后闭运算,去除孤立散点并弥合小针孔 ----
  const opened = dilate3(erode3(rawMask, w, h), w, h);
  const cleaned = erode3(dilate3(opened, w, h), w, h);

  // ---- 4) 连通域 + 小域剔除 ----
  const { mask, regions, changedPixels } = componentsToRegions(
    cleaned,
    score,
    w,
    h,
    minRegionPx,
    mmPerPixel,
  );

  return { width: w, height: h, mask, score, regions, changedPixels };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** score 热力色带:深蓝 -> 黄 -> 锈红 */
export function heatRamp(t: number): [number, number, number] {
  const x = clamp01(t);
  // stops: 0=(38,92,220), 0.5=(255,209,66), 1=(226,54,38)
  if (x < 0.5) {
    const k = x / 0.5;
    return [
      Math.round(38 + (255 - 38) * k),
      Math.round(92 + (209 - 92) * k),
      Math.round(220 + (66 - 220) * k),
    ];
  }
  const k = (x - 0.5) / 0.5;
  return [
    Math.round(255 + (226 - 255) * k),
    Math.round(209 + (54 - 209) * k),
    Math.round(66 + (38 - 66) * k),
  ];
}

interface HeatPainter {
  createImageData(w: number, h: number): ImageData;
  putImageData(img: ImageData, x: number, y: number): void;
}

function paintHeat(ctx: HeatPainter, score: Float32Array, mask: Uint8Array, w: number, h: number): void {
  const img = ctx.createImageData(w, h);
  const rgba = img.data;
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    const s = score[p] ?? 0;
    if (mask[p]) {
      // 强锈红 alpha ~0.55(140/255)
      rgba[o] = 255;
      rgba[o + 1] = 66;
      rgba[o + 2] = 38;
      const a = 138 + Math.round(30 * clamp01(s));
      rgba[o + 3] = a > 168 ? 168 : a;
    } else if (s > 0.03) {
      const [r, g, b] = heatRamp(s);
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = Math.round(28 + 92 * clamp01(s));
    } else {
      rgba[o + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 生成与输入同尺寸的热力叠加 canvas:
 *  - 非 mask 且 score>0 的像素走蓝->黄->红色带,低透明度;
 *  - mask 像素用强锈红,alpha 约 0.55。
 */
export function drawHeatmapOverlay(
  score: Float32Array,
  mask: Uint8Array,
  w: number,
  h: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D canvas 上下文');
    paintHeat(ctx, score, mask, w, h);
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 OffscreenCanvas 2D 上下文');
    paintHeat(ctx as unknown as HeatPainter, score, mask, w, h);
    return canvas;
  }
  throw new Error('当前环境不支持 canvas,无法生成热力叠加层');
}

/** 供 node/tsx 脚本与外部自检使用的内部 helper 集合 */
export const __test = {
  medianLuma,
  rustIndex,
  heatRamp,
  erode3,
  dilate3,
  DEFAULT_THRESHOLD: DEFAULT_RUST_THRESHOLD,
};
