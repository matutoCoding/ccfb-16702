/**
 * 鲁棒平移对齐(纯 TypeScript,无 DOM / 无第三方依赖)。
 *
 * 思路:灰度图金字塔 + 整数域 MAD(平均绝对差)搜索。
 *   1. 盒滤波面积下采样到长边 256 的粗网格,在 ±coarseRange(默认 12 个粗像素)内穷举;
 *   2. 把粗结果投影到长边约 800 的中网格,在其邻域 ±3 个中像素内精修;
 *   3. 再投影回全分辨率,在 ±3 个整像素内做最终整数精修(自适应步长采样以保证大图性能)。
 *
 * 坐标约定(全模块统一为图像坐标:x 向右、y 向下):
 *
 * 【符号约定 — 务必与采样公式一起理解】
 * 返回的 `shiftX/shiftY` 是把该图对齐到参考图所用的**逆重映射平移量(warp / drawImage 偏移)**:
 *
 * ```
 * aligned(x, y) = source(x - shiftX, y - shiftY)
 * ```
 *
 * 等价于 Canvas 的 `ctx.drawImage(img, shiftX, shiftY)`:`shiftX>0` 表示把该图
 * **向右**移动 `shiftX` 像素、`shiftY>0` 表示**向下**移动即可与参考重合。
 *
 * 这与 `renderPhotos` 的 `shifts` 符号一致:渲染正向映射为 `out(x)=field(x + sx)`,
 * 其逆映射正是 `field(u)=out(u - sx)`。因此当参考为 refIndex 时,本模块恢复出
 * `shift_i ≈ renderShifts[i] - renderShifts[ref]`(相对采样偏移)。
 *
 * 注意一个常见的符号歧义:若把“画面内容当前相对参考已经向右偏了 d”这种**前向几何
 * 位移**记为正(内容右移为正),则它与本模块返回值相差一个负号,即 `d = -shiftX`。
 * 本模块以可执行的逆采样公式 `source(x - shiftX, y - shiftY)` 为唯一准绳。
 *
 * `score` 为归一化 MAD(0 表示完全一致;数值为平均绝对亮度差 / 255,范围约 [0,1])。
 */

export interface ShiftResult {
  index: number;
  /** 逆重映射 x 平移:对齐时从源图 (x - shiftX) 采样;正值把图像向右移动对齐 */
  shiftX: number;
  /** 逆重映射 y 平移:对齐时从源图 (y - shiftY) 采样;正值把图像向下移动对齐 */
  shiftY: number;
  /** 归一化 MAD,越小越好,0 为完美一致 */
  score: number;
}

export interface RgbaImageLike {
  data: ArrayLike<number> | Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** 内部灰度金字塔层 */
interface LumaLevel {
  data: Float32Array;
  w: number;
  h: number;
}

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** 粗搜索半径(粗像素),需求指定默认 12 */
const COARSE_RANGE = 12;
/** 中网格局部精修半径(中像素) */
const MEDIUM_RANGE = 3;
/** 全分辨率最终精修半径(整像素) */
const FULL_RANGE = 3;
/** 全分辨率精修时,每次 MAD 评估期望的最大采样点数(超出则按轴抽稀) */
const FULL_TARGET_SAMPLES = 140_000;

/**
 * 盒滤波(面积平均)下采样到指定尺寸。
 * 目标像素对应源图中的一个整数盒区域,取盒内 RGBA 亮度平均,无热循环分配。
 */
function buildLumaLevel(
  img: RgbaImageLike,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
  tw: number,
  th: number,
): LumaLevel {
  const out = new Float32Array(tw * th);
  const data = img.data;
  const srcW = img.width;

  // 预计算每个目标列/行对应的源盒边界,避免在最内层重复 floor
  const x0 = new Int32Array(tw);
  const x1 = new Int32Array(tw);
  for (let j = 0; j < tw; j++) {
    const a = cropX + Math.floor((j * cropW) / tw);
    let b = cropX + Math.floor(((j + 1) * cropW) / tw);
    if (b <= a) b = a + 1;
    x0[j] = Math.max(0, a);
    x1[j] = Math.min(img.width, b);
  }
  const y0 = new Int32Array(th);
  const y1 = new Int32Array(th);
  for (let k = 0; k < th; k++) {
    const a = cropY + Math.floor((k * cropH) / th);
    let b = cropY + Math.floor(((k + 1) * cropH) / th);
    if (b <= a) b = a + 1;
    y0[k] = Math.max(0, a);
    y1[k] = Math.min(img.height, b);
  }

  for (let k = 0; k < th; k++) {
    const ya = y0[k];
    const yb = y1[k];
    for (let j = 0; j < tw; j++) {
      const xa = x0[j];
      const xb = x1[j];
      let sum = 0;
      let cnt = 0;
      for (let y = ya; y < yb; y++) {
        let row = (y * srcW + xa) * 4;
        for (let x = xa; x < xb; x++) {
          sum += LUMA_R * data[row] + LUMA_G * data[row + 1] + LUMA_B * data[row + 2];
          cnt++;
          row += 4;
        }
      }
      out[k * tw + j] = cnt > 0 ? sum / cnt : 0;
    }
  }
  return { data: out, w: tw, h: th };
}

/** 按长边上限构建等比灰度层(大图才缩小,小图保持原尺寸) */
function buildLongEdgeLevel(
  img: RgbaImageLike,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
  maxLongEdge: number,
): LumaLevel {
  const longEdge = Math.max(cropW, cropH);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const tw = Math.max(1, Math.round(cropW * scale));
  const th = Math.max(1, Math.round(cropH * scale));
  return buildLumaLevel(img, cropX, cropY, cropW, cropH, tw, th);
}

/**
 * 由灰度层构造抗光照变化的配准特征:RMS 归一化的 Sobel 梯度幅值。
 *
 * RTI 穹顶灯在不同方位/仰角下,同一表面的明暗甚至刻槽两侧的极性都会改变,
 * 直接对亮度做 MAD 可能被低频光照场带偏(实测低角度掠射光 vs 高位平光时)。
 * 梯度幅值集中在反照率纹理与刻槽边缘等“位置不随灯位改变”的结构上;
 * 再按整层 RMS 归一化以消除曝光/对比度差异。平移正确时两张图的边缘重合,
 * 其 L1 差异(仍是 MAD 形式)最小。边界 1 像素梯度置 0。
 */
function sobelFeature(luma: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  let sumSq = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const tl = luma[i - w - 1];
      const tc = luma[i - w];
      const tr = luma[i - w + 1];
      const ml = luma[i - 1];
      const mr = luma[i + 1];
      const bl = luma[i + w - 1];
      const bc = luma[i + w];
      const br = luma[i + w + 1];
      const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
      const m = Math.sqrt(gx * gx + gy * gy);
      g[i] = m;
      sumSq += m * m;
    }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, w * h)) + 1e-6;
  for (let i = 0; i < g.length; i++) g[i] /= rms;
  return g;
}

/** Uint8 灰度版 Sobel 特征(供全分辨率精修) */
function sobelFeatureU8(luma: Uint8Array, w: number, h: number): Float32Array {
  const f = new Float32Array(w * h);
  for (let i = 0; i < luma.length; i++) f[i] = luma[i];
  return sobelFeature(f, w, h);
}

/**
 * 计算给定逆平移 (sx, sy) 下,参考灰度 A 与待对齐灰度 B 的重叠区 MAD。
 * 比较 A(x,y) 与 B(x - sx, y - sy)。重叠过小返回 Infinity。
 * step 为轴向上的采样步长(1 = 逐像素),用于大图最终精修提速。
 */
function madAt(
  a: Float32Array,
  b: Float32Array,
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
  const width = xHi - xLo;
  const height = yHi - yLo;
  if (width < 8 || height < 8) return Number.POSITIVE_INFINITY;

  // 保证抽稀后仍有足够样本
  const st = step > 1 ? step : 1;
  let sum = 0;
  let n = 0;
  for (let y = yLo; y < yHi; y += st) {
    const aBase = y * w;
    const bBase = (y - sy) * w - sx; // + x 即 B 的下标
    for (let x = xLo; x < xHi; x += st) {
      sum += Math.abs(a[aBase + x] - b[bBase + x]);
      n++;
    }
  }
  return n > 0 ? sum / n : Number.POSITIVE_INFINITY;
}

interface BestShift {
  sx: number;
  sy: number;
  mad: number;
}

/**
 * 在中心 (cx, cy) 周围 ±rx/±ry(整数)范围内搜索使 MAD 最小的逆平移。
 * 热循环内不分配任何对象/数组。
 */
function searchWindow(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  step = 1,
): BestShift {
  let bestSx = cx;
  let bestSy = cy;
  let bestMad = Number.POSITIVE_INFINITY;
  for (let dy = -ry; dy <= ry; dy++) {
    const sy = cy + dy;
    for (let dx = -rx; dx <= rx; dx++) {
      const sx = cx + dx;
      const m = madAt(a, b, w, h, sx, sy, step);
      if (m < bestMad) {
        bestMad = m;
        bestSx = sx;
        bestSy = sy;
      }
    }
  }
  return { sx: bestSx, sy: bestSy, mad: bestMad };
}

/** 全分辨率灰度(仅亮度,每像素 1 字节),供最终 ±3 整像素精修 */
function buildFullLuma(img: RgbaImageLike): Uint8Array {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    out[p] =
      LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2] + 0.5;
  }
  return out;
}

/** Uint8 灰度版 MAD(与 madAt 同符号),用于全分辨率精修 */
function madAtU8(
  a: Uint8Array,
  b: Uint8Array,
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
 * 估计一组照片相对参考图的整数平移。
 *
 * @param images   RGBA 图像数组(浏览器 ImageData / canvas 像素 / 纯数据均可)。
 * @param options.maxShift 全分辨率像素的最大允许平移;不给定时粗搜索默认覆盖
 *                         粗网格 ±12 像素(2000px 图约 ±94 全像素)。
 * @param options.refIndex 参考图下标,默认 0。
 * @returns 与 `images` 同序、等长的结果数组,每项带原始 `index`。
 */
export function estimateAlignments(
  images: RgbaImageLike[],
  options?: { maxShift?: number; refIndex?: number },
): ShiftResult[] {
  const n = images.length;
  if (n === 0) return [];

  let refIndex = options?.refIndex ?? 0;
  if (!Number.isInteger(refIndex) || refIndex < 0 || refIndex >= n) refIndex = 0;

  const maxShiftOpt = options?.maxShift;
  const hasMaxShift =
    typeof maxShiftOpt === 'number' && Number.isFinite(maxShiftOpt) && maxShiftOpt >= 0;

  // 尺寸不一致时,以所有图的最小宽高做居中裁剪;正常情况下尺寸相同。
  let cropW = Number.POSITIVE_INFINITY;
  let cropH = Number.POSITIVE_INFINITY;
  for (const im of images) {
    if (!(im.width > 0) || !(im.height > 0)) {
      return images.map((_, i) => ({ index: i, shiftX: 0, shiftY: 0, score: 1 }));
    }
    cropW = Math.min(cropW, im.width);
    cropH = Math.min(cropH, im.height);
  }
  cropW = Math.max(1, Math.floor(cropW));
  cropH = Math.max(1, Math.floor(cropH));

  const ref = images[refIndex];
  const refCropX = ((ref.width - cropW) / 2) | 0;
  const refCropY = ((ref.height - cropH) / 2) | 0;

  // 参考图金字塔与全分辨率亮度只构建一次
  const refCoarseL = buildLongEdgeLevel(ref, refCropX, refCropY, cropW, cropH, 256);
  const refMediumL = buildLongEdgeLevel(ref, refCropX, refCropY, cropW, cropH, 800);
  const refCoarse = sobelFeature(refCoarseL.data, refCoarseL.w, refCoarseL.h);
  const refMedium = sobelFeature(refMediumL.data, refMediumL.w, refMediumL.h);
  const refFull = buildFullLuma(ref);

  // 全分辨率精修的轴向抽稀步长(大图提速,小图逐像素)
  const fullStep = Math.max(
    1,
    Math.ceil(Math.sqrt((cropW * cropH) / FULL_TARGET_SAMPLES)),
  );

  const results: ShiftResult[] = new Array(n);

  for (let i = 0; i < n; i++) {
    if (i === refIndex) {
      results[i] = { index: i, shiftX: 0, shiftY: 0, score: 0 };
      continue;
    }
    const img = images[i];
    const cropX = ((img.width - cropW) / 2) | 0;
    const cropY = ((img.height - cropH) / 2) | 0;

    // ---- 1) 粗网格穷举(光照归一化梯度特征上的 MAD) ----
    const coarseL = buildLongEdgeLevel(img, cropX, cropY, cropW, cropH, 256);
    const coarse = sobelFeature(coarseL.data, coarseL.w, coarseL.h);
    let coarseR = COARSE_RANGE;
    if (hasMaxShift) {
      // 把全像素 maxShift 换算成粗像素半径,并 +1 吸收取整
      coarseR = Math.max(1, Math.ceil((maxShiftOpt as number) * (coarseL.w / cropW)) + 1);
    }
    // 限制半径以保留至少一半左右的重叠
    const coarseCap = Math.max(1, Math.floor(Math.min(coarseL.w, coarseL.h) * 0.45));
    coarseR = Math.min(coarseR, coarseCap);

    const coarseBest = searchWindow(
      refCoarse,
      coarse,
      coarseL.w,
      coarseL.h,
      0,
      0,
      coarseR,
      coarseR,
      1,
    );

    // ---- 2) 中网格局部精修 ----
    const mediumL = buildLongEdgeLevel(img, cropX, cropY, cropW, cropH, 800);
    const medium = sobelFeature(mediumL.data, mediumL.w, mediumL.h);
    const projMx = Math.round(coarseBest.sx * (mediumL.w / coarseL.w));
    const projMy = Math.round(coarseBest.sy * (mediumL.h / coarseL.h));
    const medBest = searchWindow(
      refMedium,
      medium,
      mediumL.w,
      mediumL.h,
      projMx,
      projMy,
      MEDIUM_RANGE,
      MEDIUM_RANGE,
      1,
    );

    // ---- 3) 全分辨率 ±3 整像素精修(抽稀 MAD) ----
    // 注意:全分辨率亮度按“整图坐标”索引;当各图尺寸相同(常规情形)时裁剪偏移为 0。
    // 若存在居中裁剪,这里把中网格结果投影到裁剪坐标系,并在比较时通过原点偏移修正。
    const projFx = medBest.sx * (cropW / mediumL.w);
    const projFy = medBest.sy * (cropH / mediumL.h);
    let centerFx = Math.round(projFx);
    let centerFy = Math.round(projFy);

    // maxShift 约束(仅约束搜索中心;最终结果还会硬截断)
    if (hasMaxShift) {
      const mxs = maxShiftOpt as number;
      centerFx = Math.max(-mxs, Math.min(mxs, centerFx));
      centerFy = Math.max(-mxs, Math.min(mxs, centerFy));
    }

    // 尺寸相同的快速路径:直接整图坐标比较。
    // 尺寸不同的罕见情形:为保证正确,用裁剪后的全分辨率亮度再比。
    let imgFull: Uint8Array;
    let fullW: number;
    let fullH: number;
    let fRef: Uint8Array;
    if (img.width === ref.width && img.height === ref.height && cropX === 0 && cropY === 0) {
      imgFull = buildFullLuma(img);
      fullW = img.width;
      fullH = img.height;
      fRef = refFull;
    } else {
      imgFull = buildCroppedFullLuma(img, cropX, cropY, cropW, cropH);
      fRef =
        refCropX === 0 && refCropY === 0
          ? refFull
          : buildCroppedFullLuma(ref, refCropX, refCropY, cropW, cropH);
      fullW = cropW;
      fullH = cropH;
    }

    // 全分辨率精修同样在光照归一化梯度特征上进行
    const fRefFeat = sobelFeatureU8(fRef, fullW, fullH);
    const imgFeat = sobelFeatureU8(imgFull, fullW, fullH);
    const fullBest = searchWindow(
      fRefFeat,
      imgFeat,
      fullW,
      fullH,
      centerFx,
      centerFy,
      FULL_RANGE,
      FULL_RANGE,
      fullStep,
    );

    // 若给了 maxShift,对最终整数结果做硬截断
    let shiftX = fullBest.sx;
    let shiftY = fullBest.sy;
    if (hasMaxShift) {
      const mxs = maxShiftOpt as number;
      shiftX = Math.max(-mxs, Math.min(mxs, shiftX));
      shiftY = Math.max(-mxs, Math.min(mxs, shiftY));
    }

    // score 始终用原始亮度的稠密(步长 1)归一化 MAD,含义直观、0 为完全一致
    const scoreMad = madAtU8(fRef, imgFull, fullW, fullH, shiftX, shiftY, 1);
    const finalMad = Number.isFinite(scoreMad) ? scoreMad : 255;

    results[i] = {
      index: i,
      shiftX,
      shiftY,
      score: clamp01(finalMad / 255),
    };
  }

  return results;
}

/** 生成居中裁剪区域的全分辨率亮度 */
function buildCroppedFullLuma(
  img: RgbaImageLike,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
): Uint8Array {
  const out = new Uint8Array(cropW * cropH);
  const data = img.data;
  const srcW = img.width;
  for (let y = 0; y < cropH; y++) {
    const srcRow = (y + cropY) * srcW + cropX;
    let oi = y * cropW;
    for (let x = 0; x < cropW; x++, oi++) {
      const i = (srcRow + x) * 4;
      out[oi] = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2] + 0.5;
    }
  }
  return out;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
