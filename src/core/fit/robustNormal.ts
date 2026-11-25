import type { LightDir } from '../types';
import { leastSquaresMatrix } from '../math/linalg';

/**
 * 稳健光度立体法线估计。
 *
 * 物理模型:线性亮度 y_i ≈ rho (n·l_i) + A。
 * 污染有两类:
 *  - 镜面高光 / 过曝:残差 y-pred 为大的正值(只可能让像素更亮);
 *  - 陡坡背光:max(0,n·l) 截断造成的系统性偏差。
 *
 * 策略(与 WGSL compute 着色器逐行对应):
 *  1) 普通最小二乘得到初值;
 *  2) 迭代若干次:计算非对称残差分数 score = r>0 ? 2.2r : -r,
 *     排序取最低 keepRatio(默认 0.70)个灯作为内点;
 *  3) 内点再乘可见性权重 smoothstep(n·l),加权解 4x4 正规方程;
 *  4) 重复 4 轮。
 */

export interface RobustOptions {
  iterations?: number;
  keepRatio?: number;
}

/** 解 4x4 对称方程 G c = b(选主元高斯消元) */
export function solve4(G: Float64Array, b: Float64Array): Float64Array {
  const n = 4;
  const M = new Float64Array(4 * 5);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) M[r * 5 + c] = G[r * 4 + c];
    M[r * 5 + 4] = b[r];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col * 5 + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * 5 + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-10) M[col * 5 + col] += 1e-6;
    if (piv !== col) {
      for (let c = 0; c < 5; c++) {
        const t = M[col * 5 + c];
        M[col * 5 + c] = M[piv * 5 + c];
        M[piv * 5 + c] = t;
      }
    }
    const pv = M[col * 5 + col] || 1e-12;
    for (let c = col; c < 5; c++) M[col * 5 + c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * 5 + col];
      if (f === 0) continue;
      for (let c = col; c < 5; c++) M[r * 5 + c] -= f * M[col * 5 + c];
    }
  }
  return new Float64Array([M[4], M[9], M[14], M[19]]);
}

/** 非对称残差分数:正残差(镜面)加倍惩罚 */
export function residualScore(r: number): number {
  return r > 0 ? r * 2.2 : -r;
}

/** 单像素稳健拟合;y 为 m 个线性亮度,P0 为 4xm 最小二乘投影 */
export function robustNormalPixel(
  lights: LightDir[],
  y: ArrayLike<number>,
  P0: Float64Array,
  opts: RobustOptions = {},
): { coeff: Float64Array; inliers: boolean[] } {
  const m = lights.length;
  const iters = opts.iterations ?? 4;
  const keepRatio = opts.keepRatio ?? 0.7;
  let c = new Float64Array(4);
  for (let j = 0; j < 4; j++) {
    let s = 0;
    const base = j * m;
    for (let i = 0; i < m; i++) s += P0[base + i] * y[i];
    c[j] = s;
  }
  const inliers = new Array<boolean>(m).fill(true);
  const scores = new Float64Array(m);
  const sorted = new Float64Array(m);

  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < m; i++) {
      const l = lights[i];
      const pred = c[0] * l.x + c[1] * l.y + c[2] * l.z + c[3];
      scores[i] = residualScore(y[i] - pred);
      sorted[i] = scores[i];
    }
    // 插入排序(灯数 <= 64,CPU/GPU 都便宜)
    for (let i = 1; i < m; i++) {
      const v = sorted[i];
      let j = i - 1;
      while (j >= 0 && sorted[j] > v) {
        sorted[j + 1] = sorted[j];
        j--;
      }
      sorted[j + 1] = v;
    }
    const keepCount = Math.max(8, Math.floor(m * keepRatio));
    const threshold = sorted[Math.min(m - 1, keepCount - 1)];

    const nLen = Math.hypot(c[0], c[1], c[2]) || 1;
    const nx = c[0] / nLen;
    const ny = c[1] / nLen;
    const nz = c[2] / nLen;

    const G = new Float64Array(16);
    const b = new Float64Array(4);
    for (let i = 0; i < m; i++) {
      const l = lights[i];
      const isIn = scores[i] <= threshold + 1e-12;
      inliers[i] = isIn;
      if (!isIn) continue;
      const ndl = nx * l.x + ny * l.y + nz * l.z;
      // 可见性权重:背光/掠射平滑降权
      let w = 1;
      if (ndl < 0.05) w = Math.max(0.05, (ndl + 0.15) / 0.2);
      const a = [l.x, l.y, l.z, 1];
      for (let r = 0; r < 4; r++) {
        b[r] += w * a[r] * y[i];
        for (let cc = 0; cc < 4; cc++) G[r * 4 + cc] += w * a[r] * a[cc];
      }
    }
    c = solve4(G, b);
  }
  return { coeff: c, inliers };
}

/** 批量稳健法线拟合(CPU 参考 / 验收用),luma 为 pixel*m 线性亮度 */
export function fitRobustNormals(
  lights: LightDir[],
  luma: Float32Array | Float64Array,
  width: number,
  height: number,
  opts?: RobustOptions,
): { normals: Float32Array; coeff: Float32Array } {
  const m = lights.length;
  const { P } = leastSquaresMatrix(lights, (l) => [l.x, l.y, l.z, 1]);
  const pixels = width * height;
  const normals = new Float32Array(pixels * 3);
  const coeff = new Float32Array(pixels * 4);
  const y = new Float64Array(m);
  for (let p = 0; p < pixels; p++) {
    for (let i = 0; i < m; i++) y[i] = luma[p * m + i];
    const { coeff: c } = robustNormalPixel(lights, y, P, opts);
    coeff[p * 4] = c[0];
    coeff[p * 4 + 1] = c[1];
    coeff[p * 4 + 2] = c[2];
    coeff[p * 4 + 3] = c[3];
    const len = Math.hypot(c[0], c[1], c[2]) || 1;
    normals[p * 3] = c[0] / len;
    normals[p * 3 + 1] = c[1] / len;
    normals[p * 3 + 2] = c[2] / len;
  }
  return { normals, coeff };
}
