import type { LightDir } from '../types';
import { leastSquaresMatrix } from '../math/linalg';
import { basisFor, termsFor } from '../math/basis';
import { robustNormalPixel } from './robustNormal';

export interface CpuFitResult {
  width: number;
  height: number;
  algo: 'ptm' | 'hsh';
  /** 像素主序:pixel * coeffCount + c,coeffCount = k*3 */
  coeffs: Float32Array;
  coeffPerChannel: number;
  /** pixel*4: rhoNx,rhoNy,rhoNz,ambient(luma) */
  normalEq: Float32Array;
  /** 单位法线 pixel*3 */
  normals: Float32Array;
}

const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  v = Math.max(0, v);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * CPU 参考拟合:与 WebGPU compute 着色器使用完全相同的投影矩阵。
 * photos[i] 为 RGBA8(sRGB),长度 w*h*4。
 * gains[i] 为曝光校正增益(1 = 不校正)。
 */
export function cpuFit(
  photos: ArrayLike<Uint8Array | Uint8ClampedArray>,
  width: number,
  height: number,
  lights: LightDir[],
  algo: 'ptm' | 'hsh',
  gains?: Float32Array | number[],
): CpuFitResult {
  const m = lights.length;
  const k = termsFor(algo);
  const { P } = leastSquaresMatrix(lights, basisFor(algo));
  // 法线初值投影矩阵 4 x m(后续 IRLS 截断稳健迭代)
  const { P: Pn } = leastSquaresMatrix(lights, (l) => [l.x, l.y, l.z, 1]);

  const pixels = width * height;
  const coeffCount = k * 3;
  const coeffs = new Float32Array(pixels * coeffCount);
  const normalEq = new Float32Array(pixels * 4);
  const normals = new Float32Array(pixels * 3);

  // 预取每个灯的增益
  const g = new Float64Array(m);
  for (let i = 0; i < m; i++) g[i] = gains ? gains[i] : 1;

  // 按像素累加:c = P * y
  const lr = new Float64Array(m);
  const lg = new Float64Array(m);
  const lb = new Float64Array(m);
  const ly = new Float64Array(m);
  const lrg = new Float64Array(m);
  const lgg = new Float64Array(m);
  const lbg = new Float64Array(m);

  for (let p = 0; p < pixels; p++) {
    for (let i = 0; i < m; i++) {
      const px = photos[i];
      const o = p * 4;
      const gain = g[i];
      const r = SRGB_LIN[px[o]] * gain;
      const gg = SRGB_LIN[px[o + 1]] * gain;
      const b = SRGB_LIN[px[o + 2]] * gain;
      lr[i] = r;
      lg[i] = gg;
      lb[i] = b;
      ly[i] = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      lrg[i] = linearToSrgb(r);
      lgg[i] = linearToSrgb(gg);
      lbg[i] = linearToSrgb(b);
    }
    const po = p * coeffCount;
    for (let c = 0; c < k; c++) {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      const base = c * m;
      for (let i = 0; i < m; i++) {
        const wgt = P[base + i];
        rr += wgt * lrg[i];
        gg += wgt * lgg[i];
        bb += wgt * lbg[i];
      }
      coeffs[po + c] = rr;
      coeffs[po + k + c] = gg;
      coeffs[po + 2 * k + c] = bb;
    }
    const no = p * 4;
    // 稳健 IRLS 法线(镜面/背光/曝光异常离群剔除)
    const { coeff: nc } = robustNormalPixel(lights, ly, Pn, { iterations: 4, keepRatio: 0.7 });
    normalEq[no] = nc[0];
    normalEq[no + 1] = nc[1];
    normalEq[no + 2] = nc[2];
    normalEq[no + 3] = nc[3];
    const len = Math.hypot(nc[0], nc[1], nc[2]) || 1;
    const n3 = p * 3;
    normals[n3] = nc[0] / len;
    normals[n3 + 1] = nc[1] / len;
    normals[n3 + 2] = nc[2] / len;
  }

  return { width, height, algo, coeffs, coeffPerChannel: k, normalEq, normals };
}

export interface AngularStats {
  meanDeg: number;
  medianDeg: number;
  p95Deg: number;
  maxDeg: number;
  /** 参与统计的像素(避开图像边缘) */
  count: number;
}

/** 与真值法线比较角度误差;edge 像素边界跳过 */
export function normalErrorStats(
  fitted: Float32Array,
  truth: Float32Array,
  width: number,
  height: number,
  edge = 2,
): AngularStats {
  const errs: number[] = [];
  let sum = 0;
  let max = 0;
  for (let y = edge; y < height - edge; y++) {
    for (let x = edge; x < width - edge; x++) {
      const p = y * width + x;
      const i3 = p * 3;
      const dot = Math.min(
        1,
        Math.max(-1, fitted[i3] * truth[i3] + fitted[i3 + 1] * truth[i3 + 1] + fitted[i3 + 2] * truth[i3 + 2]),
      );
      const e = (Math.acos(dot) * 180) / Math.PI;
      errs.push(e);
      sum += e;
      if (e > max) max = e;
    }
  }
  errs.sort((a, b) => a - b);
  return {
    meanDeg: sum / errs.length,
    medianDeg: errs[Math.floor(errs.length / 2)],
    p95Deg: errs[Math.floor(errs.length * 0.95)],
    maxDeg: max,
    count: errs.length,
  };
}
