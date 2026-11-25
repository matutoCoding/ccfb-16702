import type { LightDir } from '../types';

/**
 * 光照拟合基函数。CPU 与 WGSL 着色器必须保持完全一致的定义。
 *  - PTM: 标准二次多项式 [u², v², uv, u, v, 1],u=l.x, v=l.y
 *  - HSH: 二阶半球谐(9 基),采用移位连带勒让德多项式 t=2z-1 + 实方位角项。
 *    因为拟合走最小二乘,基函数的整体归一化常数会被系数吸收,
 *    这里使用未归一化形状,CPU 拟合与 shader 求值用同一公式即可。
 */

export const PTM_TERMS = 6;
export const HSH_TERMS = 9;

export function ptmBasis(l: LightDir | { x: number; y: number; z: number }): number[] {
  const u = l.x;
  const v = l.y;
  return [u * u, v * v, u * v, u, v, 1];
}

/**
 * HSH 9 个基函数(二阶),采用 Relight/CHI 标准半球谐的无奇点笛卡尔形式,
 * 与外部 .rti / info.json 系数配对的运行时权重逐项一致。
 * 参考 cnr-isti-vclab/relight rti.cpp lightWeightsHsh。
 * 灯方向约定:x 右、y 上、z 指向观察者。
 */
export function hshBasis(l: { x: number; y: number; z: number }): number[] {
  const lz = Math.min(1, Math.max(0, l.z));
  const lx = l.x;
  const ly = l.y;
  const sz = Math.sqrt(lz / (1 + lz));
  const k0 = 1 / Math.sqrt(2 * Math.PI);
  const k1 = Math.sqrt(6 / Math.PI);
  const k2 = Math.sqrt(3 / (2 * Math.PI));
  const k4 = Math.sqrt(30 / Math.PI);
  const k6 = Math.sqrt(5 / (2 * Math.PI));
  const z = lz;
  return [
    k0,                                              // w0
    k1 * lx * sz,                                    // w1
    k2 * (2 * z - 1),                                // w2
    k1 * ly * sz,                                    // w3
    -k4 * (lx * lx - ly * ly) * z / (1 + z),         // w4
    k4 * lx * (2 * z - 1) * sz,                      // w5
    k6 * (6 * z * z - 6 * z + 1),                    // w6
    k4 * ly * (2 * z - 1) * sz,                      // w7
    (-2 * k4 * lx * ly * z) / (1 + z),               // w8
  ];
}

export function basisFor(algo: 'ptm' | 'hsh'): (l: LightDir) => number[] {
  return algo === 'ptm' ? ptmBasis : hshBasis;
}

export function termsFor(algo: 'ptm' | 'hsh'): number {
  return algo === 'ptm' ? PTM_TERMS : HSH_TERMS;
}

/**
 * 从 PTM 系数直接解析估计法线(备选/校验路径)。
 * 朗伯项 rho(nx u + ny v + nz sqrt(1-u²-v²)) 关于 u/v 为奇对称,
 * 对称灯位下一次项系数 c3,c4 ≈ rho*nx, rho*ny。
 * 再用系数常数/二次项估计 rho*nz,最后单位化。
 */
export function ptmAnalyticNormal(c: ArrayLike<number>): [number, number, number] {
  const nx = c[3];
  const ny = c[4];
  // 在天顶方向 u=v=0: L(0,0)=c5 ≈ ambient + rho*nz;
  // 二次项在环形平均下与 rho*nz 的 sqrt 展开共同决定,
  // 这里取经验上稳健的 rho 估计:一次项模长 + 常数项正值。
  const rhoXY = Math.hypot(nx, ny);
  let nz = Math.max(0.15, c[5] - 0.15); // 扣除典型环境光
  // 若 rhoXY 很大,用单位法线约束反推 nz 量级
  if (rhoXY > 1e-4) {
    const rho = Math.max(rhoXY, c[5] * 0.9);
    nz = Math.sqrt(Math.max(0.02, rho * rho - rhoXY * rhoXY)) / rhoXY;
    return normalize(nx / rhoXY, ny / rhoXY, nz);
  }
  return normalize(0, 0, 1);
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
