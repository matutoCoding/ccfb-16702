/**
 * 两期对比页用的简易整数平移搜索(纯函数)。
 *
 * 在长边 <= 360 的下采样灰度图上做 ±rangeCoarse 的 MAD 穷举,
 * 把最优粗平移投影回共同分辨率,再在全分辨率灰度上做 ±2 整数精修。
 *
 * 符号与 rustCompare / canvas drawImage 一致:
 *   dx/dy 为 B 相对 A 的逆重映射/drawImage 偏移,
 *   即比较 A(x,y) 与 B(x-dx, y-dy);正值把 B 向右/向下移动对齐。
 */

import type { RgbaImage } from '../../core/analysis/rustCompare';

export interface TranslationShift {
  dx: number;
  dy: number;
  /** 归一化 MAD(0 完全一致,约 [0,1]) */
  mad: number;
}

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
const DOWN_MAX_EDGE = 360;

interface GrayLevel {
  data: Float32Array;
  w: number;
  h: number;
  /** 粗像素 -> 原图(共同分辨率)像素的线性比例 */
  scaleX: number;
  scaleY: number;
}

/** 面积/盒采样灰度下采样(步长盒平均,无热循环分配) */
function downsampleLuma(img: RgbaImage, maxEdge: number): GrayLevel {
  const { width: w, height: h, data } = img;
  const longEdge = Math.max(w, h);
  const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(tw * th);

  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor((y * h) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor((x * w) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / tw));
      let sum = 0;
      let cnt = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        let idx = (yy * w + sx0) * 4;
        for (let xx = sx0; xx < sx1; xx++) {
          // 透明像素按底色黑处理会污染边缘,这里跳过
          if (data[idx + 3] >= 128) {
            sum += LUMA_R * data[idx] + LUMA_G * data[idx + 1] + LUMA_B * data[idx + 2];
            cnt++;
          }
          idx += 4;
        }
      }
      out[y * tw + x] = cnt > 0 ? sum / cnt : 0;
    }
  }
  return { data: out, w: tw, h: th, scaleX: w / tw, scaleY: h / th };
}

function fullLuma(img: RgbaImage): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    out[p] = LUMA_R * d[i] + LUMA_G * d[i + 1] + LUMA_B * d[i + 2] + 0.5;
  }
  return out;
}

/** MAD at inverse shift (sx, sy): compare A(x,y) vs B(x-sx,y-sy) */
function madAt(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  w: number,
  h: number,
  sx: number,
  sy: number,
  step: number,
): number {
  const xLo = Math.max(0, sx);
  const xHi = Math.min(w, w + sx);
  const yLo = Math.max(0, sy);
  const yHi = Math.min(h, h + sy);
  if (xHi - xLo < 8 || yHi - yLo < 8) return Number.POSITIVE_INFINITY;
  const st = step > 1 ? step : 1;
  let sum = 0;
  let n = 0;
  for (let y = yLo; y < yHi; y += st) {
    const aBase = y * w;
    const bBase = (y - sy) * w - sx;
    for (let x = xLo; x < xHi; x += st) {
      sum += Math.abs(a[aBase + x] - b[bBase + x]);
      n++;
    }
  }
  return n > 0 ? sum / n : Number.POSITIVE_INFINITY;
}

/**
 * 搜索 B 相对 A 的最佳整数平移。
 * @param rangeCommonPx 共同分辨率下的最大搜索半径(默认 12)
 */
export function searchTranslation(
  a: RgbaImage,
  b: RgbaImage,
  rangeCommonPx = 12,
): TranslationShift {
  const ca = downsampleLuma(a, DOWN_MAX_EDGE);
  const cb = downsampleLuma(b, DOWN_MAX_EDGE);
  // 两张图同尺寸 → 粗层尺寸一致
  const cw = Math.min(ca.w, cb.w);
  const ch = Math.min(ca.h, cb.h);
  const rangeCoarse = Math.max(
    1,
    Math.round(rangeCommonPx * Math.min(cw / a.width, ch / a.height)),
  );

  let bestCx = 0;
  let bestCy = 0;
  let bestMad = Number.POSITIVE_INFINITY;
  for (let dy = -rangeCoarse; dy <= rangeCoarse; dy++) {
    for (let dx = -rangeCoarse; dx <= rangeCoarse; dx++) {
      const m = madAt(ca.data, cb.data, cw, ch, dx, dy, 1);
      if (m < bestMad) {
        bestMad = m;
        bestCx = dx;
        bestCy = dy;
      }
    }
  }

  // 投影回共同分辨率
  let dx = Math.round(bestCx * ca.scaleX);
  let dy = Math.round(bestCy * ca.scaleY);

  // 全分辨率 ±2 精修(隔 2 列/行采样,点击时一次性计算)
  const fa = fullLuma(a);
  const fb = fullLuma(b);
  const W = a.width;
  const H = a.height;
  let bestFull = madAt(fa, fb, W, H, dx, dy, 2);
  for (let yy = -2; yy <= 2; yy++) {
    for (let xx = -2; xx <= 2; xx++) {
      if (xx === 0 && yy === 0) continue;
      const sx = dx + xx;
      const sy = dy + yy;
      if (Math.abs(sx) > rangeCommonPx + 2 || Math.abs(sy) > rangeCommonPx + 2) continue;
      const m = madAt(fa, fb, W, H, sx, sy, 2);
      if (m < bestFull) {
        bestFull = m;
        dx = sx;
        dy = sy;
      }
    }
  }
  // 中心再用稠密采样拿最终 MAD 展示
  const finalMad = madAt(fa, fb, W, H, dx, dy, 1);
  return { dx, dy, mad: Number.isFinite(finalMad) ? finalMad / 255 : bestFull / 255 };
}
