import type { ExposureFlag, LightDir } from '../types';

/** 中位数 */
export function median(values: number[] | Float64Array | Float32Array): number {
  const arr = Array.from(values).sort((a, b) => a - b);
  const n = arr.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** sRGB 字节亮度(0..255)近似线性化 */
function lin(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * 根据各图平均亮度检测曝光不一致。
 * 在线性光域求 log2 比值(EV),以中位数为基准;
 * 用 MAD 做稳健阈值,阈值取 max(0.3 EV, 3.5*稳健标准差)。
 */
export function detectExposure(
  lumas: number[],
  imageIds: string[] = lumas.map((_, i) => String(i)),
): ExposureFlag[] {
  if (lumas.length < 3) return [];
  const linear = lumas.map(lin);
  const ref = median(linear);
  const logEv = linear.map((l) => Math.log2(Math.max(1e-6, l / ref)));
  const medEv = median(logEv);
  const deviations = logEv.map((v) => Math.abs(v - medEv));
  const mad = median(deviations) || 0.001;
  const robustSigma = 1.4826 * mad;
  const threshold = Math.max(0.3, 3.5 * robustSigma);
  const flags: ExposureFlag[] = [];
  logEv.forEach((ev, i) => {
    if (Math.abs(ev - medEv) > threshold) {
      flags.push({ imageId: imageIds[i], index: i, evDelta: ev - medEv, meanLuma: lumas[i] });
    }
  });
  return flags;
}

/**
 * 曝光校正增益:在线性光域把每张图的亮度拉齐到全组中位数。
 * 增益限制在 [0.5, 2],避免异常图被过度拉伸。
 */
export function exposureGains(lumas: number[]): Float32Array {
  const linear = lumas.map(lin);
  const ref = median(linear);
  return Float32Array.from(linear.map((l) => Math.min(2, Math.max(0.5, ref / Math.max(1e-6, l)))));
}

/**
 * 灯位感知的曝光异常检测。
 * 画面平均亮度主要随灯的天顶分量 lz 平滑变化;对 log2(linearLuma)
 * 关于 [1,lz,lz²] 做稳健(一轮 IRLS)回归,残差即曝光 EV 偏差。
 * 标定完成后调用,能可靠找出 ±0.3EV 以上的异常灯图。
 */
export function detectExposureLightAware(
  lumas: number[],
  lights: LightDir[],
  imageIds: string[] = lumas.map((_, i) => String(i)),
): ExposureFlag[] {
  const n = lumas.length;
  if (n < 5 || lights.length !== n) return detectExposure(lumas, imageIds);
  const y = lumas.map((l) => Math.log2(Math.max(1e-6, lin(l))));
  // 3x3 正规方程
  const solve = (weights: number[]): number[] => {
    const G = Array.from({ length: 9 }, () => 0);
    const b = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const z = lights[i].z;
      const x = [1, z, z * z];
      const w = weights[i];
      for (let r = 0; r < 3; r++) {
        b[r] += w * x[r] * y[i];
        for (let c = 0; c < 3; c++) G[r * 3 + c] += w * x[r] * x[c];
      }
    }
    // 高斯消元
    const M = [
      [G[0], G[1], G[2], b[0]],
      [G[3], G[4], G[5], b[1]],
      [G[6], G[7], G[8], b[2]],
    ];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      let best = Math.abs(M[col][col]);
      for (let r = col + 1; r < 3; r++) {
        const v = Math.abs(M[r][col]);
        if (v > best) {
          best = v;
          piv = r;
        }
      }
      [M[col], M[piv]] = [M[piv], M[col]];
      const pv = M[col][col] || 1e-9;
      for (let c = col; c < 4; c++) M[col][c] /= pv;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = M[r][col];
        for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
      }
    }
    return [M[0][3], M[1][3], M[2][3]];
  };
  let beta = solve(new Array(n).fill(1));
  let resid = y.map((v, i) => {
    const z = lights[i].z;
    return v - (beta[0] + beta[1] * z + beta[2] * z * z);
  });
  // 一轮稳健加权
  const mad = median(resid.map(Math.abs)) || 0.01;
  const sig = 1.4826 * mad;
  const weights = resid.map((r) => (Math.abs(r) > 2.5 * sig ? (2.5 * sig) / Math.abs(r) : 1));
  beta = solve(weights);
  resid = y.map((v, i) => {
    const z = lights[i].z;
    return v - (beta[0] + beta[1] * z + beta[2] * z * z);
  });
  const medR = median(resid);
  const sigma = Math.max(1.4826 * median(resid.map((r) => Math.abs(r - medR))), 0.008);
  const threshold = Math.max(0.22, 4 * sigma);
  const flags: ExposureFlag[] = [];
  resid.forEach((r, i) => {
    const d = r - medR;
    if (Math.abs(d) > threshold) {
      flags.push({ imageId: imageIds[i], index: i, evDelta: d, meanLuma: lumas[i] });
    }
  });
  return flags;
}
