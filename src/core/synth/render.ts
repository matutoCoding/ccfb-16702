import type { Heightfield } from './heightfield';
import type { Vec3 } from '../types';
import { mulberry32 } from './rng';

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgbByte(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** albedo 数组 -> 线性化缓冲 的缓存,避免一组灯图重复做 sRGB 转换 */
const LIN_CACHE = new WeakMap<Uint8ClampedArray, Float32Array>();

export interface RenderOptions {
  ambient?: number;
  kd?: number;
  ks?: number;
  shininess?: number;
  /** 每张灯图的曝光倍数 */
  exposures?: number[];
  /** 每张图整体平移(像素),用于检验对齐 */
  shifts?: { x: number; y: number }[];
  noise?: number;
  seed?: number;
}

/** 渲染单张照片(RGBA,sRGB 编码) */
export function renderPhoto(
  hf: Heightfield,
  light: Vec3,
  index: number,
  opts: RenderOptions = {},
): Uint8ClampedArray {
  const { width: W, height: H, normals, albedo } = hf;
  const ambient = opts.ambient ?? 0.17;
  const kd = opts.kd ?? 0.92;
  const ks = opts.ks ?? 0.14;
  const shininess = opts.shininess ?? 46;
  const noiseAmp = opts.noise ?? 2.2;
  // 每张图独立但确定的随机序列
  const rnd = mulberry32((opts.seed ?? 424242) + index * 100003);

  // 线性化反照率(按 albedo 数组缓存,48 张图只算一次)
  let lin = LIN_CACHE.get(albedo);
  if (!lin) {
    lin = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H * 3; i++) lin[i] = srgbToLinear(albedo[i]);
    LIN_CACHE.set(albedo, lin);
  }

  const li = index;
  const expo = opts.exposures?.[li] ?? 1;
  const sx = opts.shifts?.[li]?.x ?? 0;
  const sy = opts.shifts?.[li]?.y ?? 0;
  const out = new Uint8ClampedArray(W * H * 4);
  const hx = light.x;
  const hy = light.y;
  const hz = light.z + 1; // l + v, v=(0,0,1),未归一化,点积后统一除
  const hLen = Math.hypot(hx, hy, hz);
  const hxv = hx / hLen;
  const hyv = hy / hLen;
  const hzv = hz / hLen;

  for (let y = 0; y < H; y++) {
    const syy = y + sy;
    const srcY = syy < 0 ? 0 : syy >= H ? H - 1 : syy | 0;
    for (let x = 0; x < W; x++) {
      const sxx = x + sx;
      const srcX = sxx < 0 ? 0 : sxx >= W ? W - 1 : sxx | 0;
      const si = (srcY * W + srcX) * 3;
      const ni = (y * W + x) * 3;
      const nx = normals[ni];
      const ny = normals[ni + 1];
      const nz = normals[ni + 2];
      let diff = nx * light.x + ny * light.y + nz * light.z;
      if (diff < 0) diff = 0;
      let spec = nx * hxv + ny * hyv + nz * hzv;
      spec = spec > 0 ? Math.pow(spec, shininess) : 0;
      const shade = ambient + kd * diff;
      const r = lin[si] * shade + ks * spec;
      const g = lin[si + 1] * shade + ks * spec;
      const b = lin[si + 2] * shade + ks * spec;
      const oi = (y * W + x) * 4;
      const n = (rnd() - 0.5) * noiseAmp;
      out[oi] = linearToSrgbByte(r * expo) + n;
      out[oi + 1] = linearToSrgbByte(g * expo) + n;
      out[oi + 2] = linearToSrgbByte(b * expo) + n;
      out[oi + 3] = 255;
    }
  }
  return out;
}

/**
 * 用真值法线按已知灯位渲染一组照片(RGBA,sRGB 编码)。
 * 纯 CPU、无 DOM 依赖,Node 验收与浏览器演示共用。
 */
export function renderPhotos(hf: Heightfield, lights: Vec3[], opts: RenderOptions = {}): Uint8ClampedArray[] {
  return lights.map((l, i) => renderPhoto(hf, l, i, opts));
}

/** 计算每张 RGBA 图的平均亮度(0..255) */
export function meanLuma(rgba: Uint8ClampedArray | Uint8Array, step = 1): number {
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4 * step) {
    sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    cnt++;
  }
  return sum / Math.max(1, cnt);
}
