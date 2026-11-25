import type { LightDir } from '../types';

/**
 * 最小线性代数工具:正规方程 + 带部分选主元的高斯消元。
 * 基矩阵很小(<=9 阶),全部 Float64 计算,作为 CPU 参考实现,
 * GPU 端使用同一份伪逆矩阵 P 做逐像素乘法,保证两边数学一致。
 */

/** 求方阵 A(n*n, 行主序) 的逆;奇异时抛错 */
export function invertMatrix(src: Float64Array | number[], n: number): Float64Array {
  const a = Float64Array.from(src);
  const aug = new Float64Array(n * 2 * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) aug[r * 2 * n + c] = a[r * n + c];
    aug[r * 2 * n + n + r] = 1;
  }
  const W = 2 * n;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(aug[col * W + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(aug[r * W + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) throw new Error('矩阵奇异,无法求逆(灯位分布可能共线)');
    if (piv !== col) {
      for (let c = 0; c < W; c++) {
        const t = aug[col * W + c];
        aug[col * W + c] = aug[piv * W + c];
        aug[piv * W + c] = t;
      }
    }
    const pivVal = aug[col * W + col];
    for (let c = 0; c < W; c++) aug[col * W + c] /= pivVal;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r * W + col];
      if (factor === 0) continue;
      for (let c = 0; c < W; c++) {
        aug[r * W + c] -= factor * aug[col * W + c];
      }
    }
  }
  const inv = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) inv[r * n + c] = aug[r * W + n + c];
  }
  return inv;
}

/**
 * 给定 m 个采样灯位和 k 个基函数,构造最小二乘投影矩阵 P(k x m):
 * 系数 c = P · y,其中 y 为 m 个观测。
 * A 为 m x k(A[i,j] = basis_j(light_i)),P = (A'A)^-1 A'。
 */
export function leastSquaresMatrix(
  lights: LightDir[],
  basis: (l: LightDir) => number[],
): { P: Float64Array; k: number; gramInv: Float64Array } {
  const m = lights.length;
  const b0 = basis(lights[0]);
  const k = b0.length;
  const A = new Float64Array(m * k);
  for (let i = 0; i < m; i++) {
    const b = basis(lights[i]);
    if (b.length !== k) throw new Error('基函数维度不一致');
    A.set(b, i * k);
  }
  // G = A'A (k x k)
  const G = new Float64Array(k * k);
  for (let i = 0; i < m; i++) {
    for (let r = 0; r < k; r++) {
      const air = A[i * k + r];
      for (let c = 0; c < k; c++) {
        G[r * k + c] += air * A[i * k + c];
      }
    }
  }
  const Ginv = invertMatrix(G, k);
  // P = Ginv A'  (k x m)
  const P = new Float64Array(k * m);
  for (let r = 0; r < k; r++) {
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let t = 0; t < k; t++) s += Ginv[r * k + t] * A[i * k + t];
      P[r * m + i] = s;
    }
  }
  return { P, k, gramInv: Ginv };
}

/**
 * 解带常数项的光度立体方程 y_i = rho*(n·l_i) + ambient_i?
 * 基 [lx,ly,lz,1],返回 4 x m 投影矩阵,输出 [rhoNx,rhoNy,rhoNz,ambient]。
 */
export function normalProjection(lights: LightDir[]): Float64Array {
  const { P } = leastSquaresMatrix(lights, (l) => [l.x, l.y, l.z, 1]);
  return P;
}

/** 矩阵-向量乘:c(k) = P(k*m) * y(m) */
export function applyProjection(P: Float64Array, k: number, y: ArrayLike<number> | Float32Array): Float64Array {
  const m = y.length;
  const c = new Float64Array(k);
  for (let r = 0; r < k; r++) {
    let s = 0;
    const base = r * m;
    for (let i = 0; i < m; i++) s += P[base + i] * y[i];
    c[r] = s;
  }
  return c;
}

export function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** 角度误差(度) */
export function angleErrorDeg(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}
