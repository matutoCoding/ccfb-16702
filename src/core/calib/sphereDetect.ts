/**
 * 黑色反光球检测、球内高光检测,以及“高光 -> 光源方向”反算(纯 TS,无 DOM 依赖)。
 *
 * 图像坐标一律 x 向右、y 向下(与 alignment 模块一致)。光源世界坐标:x 右、y 上、
 * z 指向观察者;因此由图像 y 向下换算世界 y 时需要取负号。
 */

export interface Circle {
  cx: number;
  cy: number;
  radius: number;
  /** 置信度 0..1 */
  score: number;
}

export interface HighlightPoint {
  x: number;
  y: number;
  /** 置信度 0..1 */
  score: number;
}

type RgbaInput = ArrayLike<number> | Uint8Array | Uint8ClampedArray;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function lumaOf(rgba: RgbaInput, idx: number): number {
  const i = idx * 4;
  return LUMA_R * rgba[i] + LUMA_G * rgba[i + 1] + LUMA_B * rgba[i + 2];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 256 桶直方图中位数 */
function medianFromHistogram(hist: Int32Array, total: number): number {
  const half = total / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return 255;
}

interface ComponentStats {
  id: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  perimeter: number;
  score: number;
}

/**
 * 检测画面中的黑色反光球。
 *
 * 流程:长边约 480 的盒滤波灰度网格 -> 自适应暗阈值
 * `thr = min(85, max(约40, medianLuma*0.55))` -> 暗掩膜 4 连通域(BFS)->
 * 按尺寸/长宽比/包围盒填充率/周长圆形度打分选最佳 -> 全分辨率 ROI 暗掩膜
 * 二次裁剪离群点后用包围盒精修圆心与半径。返回全分辨率坐标;不可信时返回 null。
 */
export function detectBlackSphere(
  rgba: ArrayLike<number> | Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
): Circle | null {
  if (!(w >= 8) || !(h >= 8) || rgba.length < w * h * 4) return null;

  const minDim = Math.min(w, h);

  // ---------- 1) 下采样灰度网格(长边 <= 480,盒平均) ----------
  const maxGrid = 480;
  const scale = Math.min(1, maxGrid / Math.max(w, h));
  const gw = Math.max(4, Math.round(w * scale));
  const gh = Math.max(4, Math.round(h * scale));
  const grid = new Uint8Array(gw * gh);
  const hist = new Int32Array(256);

  for (let gy = 0; gy < gh; gy++) {
    const sy0 = Math.floor((gy * h) / gh);
    let sy1 = Math.floor(((gy + 1) * h) / gh);
    if (sy1 <= sy0) sy1 = Math.min(h, sy0 + 1);
    for (let gx = 0; gx < gw; gx++) {
      const sx0 = Math.floor((gx * w) / gw);
      let sx1 = Math.floor(((gx + 1) * w) / gw);
      if (sx1 <= sx0) sx1 = Math.min(w, sx0 + 1);
      let sum = 0;
      let cnt = 0;
      for (let y = sy0; y < sy1; y++) {
        let i = (y * w + sx0) * 4;
        for (let x = sx0; x < sx1; x++) {
          sum += LUMA_R * rgba[i] + LUMA_G * rgba[i + 1] + LUMA_B * rgba[i + 2];
          cnt++;
          i += 4;
        }
      }
      const v = cnt > 0 ? Math.max(0, Math.min(255, Math.round(sum / cnt))) : 0;
      grid[gy * gw + gx] = v;
      hist[v]++;
    }
  }

  // ---------- 2) 自适应暗阈值 ----------
  const median = medianFromHistogram(hist, gw * gh);
  // 40 的下限避免整体偏暗时阈值过低而漏掉球体;给定合成图(背景 120)时 thr=66。
  const thr = Math.min(85, Math.max(40, median * 0.55));

  // ---------- 3) 暗掩膜连通域 ----------
  const mask = new Uint8Array(gw * gh);
  for (let i = 0; i < grid.length; i++) if (grid[i] < thr) mask[i] = 1;

  const labels = new Int32Array(gw * gh); // 0 = 未标记(非掩膜也为 0)
  const comps: ComponentStats[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== 0) continue;
    const id = comps.length + 1;
    let area = 0;
    let minX = gw;
    let maxX = -1;
    let minY = gh;
    let maxY = -1;
    let perimeter = 0;
    labels[start] = id;
    stack.length = 0;
    stack.push(start);

    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % gw;
      const y = (idx / gw) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 4 邻域:统计周长并扩展
      // left
      if (x === 0) perimeter++;
      else {
        const n = idx - 1;
        if (!mask[n]) perimeter++;
        else if (labels[n] === 0) {
          labels[n] = id;
          stack.push(n);
        }
      }
      // right
      if (x === gw - 1) perimeter++;
      else {
        const n = idx + 1;
        if (!mask[n]) perimeter++;
        else if (labels[n] === 0) {
          labels[n] = id;
          stack.push(n);
        }
      }
      // up
      if (y === 0) perimeter++;
      else {
        const n = idx - gw;
        if (!mask[n]) perimeter++;
        else if (labels[n] === 0) {
          labels[n] = id;
          stack.push(n);
        }
      }
      // down
      if (y === gh - 1) perimeter++;
      else {
        const n = idx + gw;
        if (!mask[n]) perimeter++;
        else if (labels[n] === 0) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }

    const cols = Math.max(1, maxX - minX + 1);
    const rows = Math.max(1, maxY - minY + 1);
    const fill = area / (cols * rows);
    // 正圆盘的包围盒填充率约 pi/4 ~= 0.785(小半径像素化时略低)
    const fillScore = clamp01(1 - Math.abs(fill - 0.74) / 0.5);
    const aspect = Math.min(cols, rows) / Math.max(cols, rows);
    const rBox = Math.max(0.5, (maxX - minX + (maxY - minY)) / 4);
    const rArea = Math.sqrt(area / Math.PI);
    const radiusAgree = Math.min(rBox, rArea) / Math.max(rBox, rArea);
    const circularity = Math.min(1, (4 * Math.PI * area) / Math.max(1, perimeter * perimeter));
    const circScore = clamp01((circularity - 0.45) / 0.4);

    const score = clamp01(
      0.28 * fillScore + 0.22 * aspect + 0.2 * radiusAgree + 0.3 * circScore,
    );
    comps.push({ id, area, minX, maxX, minY, maxY, perimeter, score });
  }

  if (comps.length === 0) return null;

  // ---------- 4) 半径尺寸过滤 + 选最佳 ----------
  const fullPerGridX = w / gw;
  const fullPerGridY = h / gh;
  const rMin = 0.03 * minDim;
  const rMax = 0.45 * minDim;

  let best: ComponentStats | null = null;
  let bestRank = -1;
  for (const c of comps) {
    const rGrid = (c.maxX - c.minX + (c.maxY - c.minY)) / 4;
    const rFull = rGrid * (fullPerGridX + fullPerGridY) * 0.5;
    if (!(rFull >= rMin && rFull <= rMax)) continue;
    // 面积极小的噪点直接排除
    if (c.area < 24) continue;
    // 综合排名:形状分为主,适度奖励更大的可信圆盘
    const rank = c.score * (1 + Math.min(0.15, c.area / (gw * gh)));
    if (rank > bestRank) {
      bestRank = rank;
      best = c;
    }
  }
  if (!best || best.score < 0.35) return null;

  // 粗圆心/半径 -> 全分辨率 ROI
  const ccx = ((best.minX + best.maxX + 1) / 2) * fullPerGridX;
  const ccy = ((best.minY + best.maxY + 1) / 2) * fullPerGridY;
  const rGridBest = (best.maxX - best.minX + (best.maxY - best.minY)) / 4;
  const rFullBest = rGridBest * (fullPerGridX + fullPerGridY) * 0.5;

  // ---------- 5) 全分辨率 ROI 包围盒精修(带离群点二次裁剪) ----------
  const margin = Math.max(4, rFullBest * 0.4 + 3);
  const rx0 = Math.max(0, Math.floor(ccx - rFullBest - margin));
  const rx1 = Math.min(w, Math.ceil(ccx + rFullBest + margin));
  const ry0 = Math.max(0, Math.floor(ccy - rFullBest - margin));
  const ry1 = Math.min(h, Math.ceil(ccy + rFullBest + margin));

  const bbox = scanDarkBBox(rgba, w, rx0, ry0, rx1, ry1, thr);
  let cx: number;
  let cy: number;
  let radius: number;
  let refineScore = best.score;

  if (bbox) {
    let fMinX = bbox.minX;
    let fMaxX = bbox.maxX;
    let fMinY = bbox.minY;
    let fMaxY = bbox.maxY;
    let ecx = (fMinX + fMaxX) / 2;
    let ecy = (fMinY + fMaxY) / 2;
    let er = ((fMaxX - fMinX) + (fMaxY - fMinY)) / 4;

    // 第二遍:剔除明显在预估圆盘之外的孤立暗点后重算包围盒
    if (er > 2) {
      const cutR = er * 1.12 + 2;
      const trimmed = scanDarkBBox(rgba, w, rx0, ry0, rx1, ry1, thr, {
        cx: ecx,
        cy: ecy,
        maxDist: cutR,
      });
      if (trimmed && trimmed.count >= Math.max(40, 0.5 * Math.PI * er * er)) {
        fMinX = trimmed.minX;
        fMaxX = trimmed.maxX;
        fMinY = trimmed.minY;
        fMaxY = trimmed.maxY;
        ecx = (fMinX + fMaxX) / 2;
        ecy = (fMinY + fMaxY) / 2;
        er = ((fMaxX - fMinX) + (fMaxY - fMinY)) / 4;
      }
    }
    cx = ecx;
    cy = ecy;
    radius = er;
    // 精修结果合理性:仍在尺寸区间且与粗半径偏差不夸张
    if (
      !(radius >= rMin * 0.8 && radius <= rMax * 1.1) ||
      Math.abs(cx - ccx) > rFullBest * 0.5 ||
      Math.abs(cy - ccy) > rFullBest * 0.5
    ) {
      cx = ccx;
      cy = ccy;
      radius = rFullBest;
      refineScore = best.score * 0.8;
    }
  } else {
    cx = ccx;
    cy = ccy;
    radius = rFullBest;
  }

  radius = Math.max(1, radius);
  return { cx, cy, radius, score: clamp01(refineScore) };
}

interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
}

/** 扫描 ROI 内 luma<thr 的像素包围盒;可选仅统计距 (cx,cy) <= maxDist 的点 */
function scanDarkBBox(
  rgba: RgbaInput,
  srcW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thr: number,
  within?: { cx: number; cy: number; maxDist: number },
): BBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let count = 0;
  const maxD2 = within ? within.maxDist * within.maxDist : Number.POSITIVE_INFINITY;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (lumaOf(rgba, y * srcW + x) >= thr) continue;
      if (within) {
        const dx = x - within.cx;
        const dy = y - within.cy;
        if (dx * dx + dy * dy > maxD2) continue;
      }
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return null;
  return { minX, maxX, minY, maxY, count };
}

/**
 * 在球内(distance < 0.9r)检测镜面高光。
 *
 * 自适应阈值 `max(205, 0.82 * 球内最大亮度)`,取阈值以上最亮的大连通块,
 * 返回亮度加权质心;孤立 1 像素盐点会被丢弃(块至少 2 像素)。
 * 若阈值以上为空,退化为取球内最亮的 0.15% 像素质心。无可用点时返回 null。
 */
export function detectHighlight(
  rgba: ArrayLike<number> | Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  circle: Circle,
): HighlightPoint | null {
  const { cx, cy, radius } = circle;
  if (!(radius > 2)) return null;
  const innerR = radius * 0.9;
  const innerR2 = innerR * innerR;

  const x0 = Math.max(0, Math.floor(cx - innerR) - 1);
  const x1 = Math.min(w, Math.ceil(cx + innerR) + 1);
  const y0 = Math.max(0, Math.floor(cy - innerR) - 1);
  const y1 = Math.min(h, Math.ceil(cy + innerR) + 1);
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  if (x1 <= x0 || y1 <= y0) return null;

  // 第一遍:球内像素数、最大亮度、亮度直方图
  let interiorCount = 0;
  let maxLuma = 0;
  const hist = new Int32Array(256);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy >= innerR2) continue;
      const L = lumaOf(rgba, y * w + x);
      interiorCount++;
      if (L > maxLuma) maxLuma = L;
      hist[Math.max(0, Math.min(255, Math.round(L)))]++;
    }
  }
  if (interiorCount < 4) return null;

  const thr = Math.max(205, 0.82 * maxLuma);

  // 退化方案所需的最亮 0.15% 截止亮度(借助直方图)
  const topK = Math.max(2, Math.ceil(interiorCount * 0.0015));
  let acc = 0;
  let cutoff = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= topK) {
      cutoff = v;
      break;
    }
  }

  // 第二遍:构造阈值候选掩膜,并累计 top% 亮度加权质心
  const cand = new Uint8Array(rw * rh);
  let topW = 0;
  let topWX = 0;
  let topWY = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy >= innerR2) continue;
      const L = lumaOf(rgba, y * w + x);
      const lx = x - x0;
      const ly = y - y0;
      if (L >= thr) cand[ly * rw + lx] = 1;
      const byteL = Math.max(0, Math.min(255, Math.round(L)));
      if (byteL >= cutoff) {
        topW += L;
        topWX += L * x;
        topWY += L * y;
      }
    }
  }

  // 在候选掩膜上做连通域,选总亮度权重最大的块
  const labels = new Int32Array(rw * rh);
  const stack: number[] = [];
  let bestW = 0;
  let bestWX = 0;
  let bestWY = 0;
  let bestCount = 0;
  let bestMean = 0;

  for (let start = 0; start < cand.length; start++) {
    if (!cand[start] || labels[start] !== 0) continue;
    let count = 0;
    let wsum = 0;
    let wx = 0;
    let wy = 0;
    labels[start] = 1;
    stack.length = 0;
    stack.push(start);
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const lx = idx % rw;
      const ly = (idx / rw) | 0;
      const ax = x0 + lx;
      const ay = y0 + ly;
      const L = lumaOf(rgba, ay * w + ax);
      count++;
      wsum += L;
      wx += L * ax;
      wy += L * ay;
      // 4 邻域
      if (lx > 0) {
        const n = idx - 1;
        if (cand[n] && labels[n] === 0) {
          labels[n] = 1;
          stack.push(n);
        }
      }
      if (lx < rw - 1) {
        const n = idx + 1;
        if (cand[n] && labels[n] === 0) {
          labels[n] = 1;
          stack.push(n);
        }
      }
      if (ly > 0) {
        const n = idx - rw;
        if (cand[n] && labels[n] === 0) {
          labels[n] = 1;
          stack.push(n);
        }
      }
      if (ly < rh - 1) {
        const n = idx + rw;
        if (cand[n] && labels[n] === 0) {
          labels[n] = 1;
          stack.push(n);
        }
      }
    }
    // 选“又大又亮”的块:总权重即可(大块总权重必然更高)
    if (count >= 2 && wsum > bestW) {
      bestW = wsum;
      bestWX = wx;
      bestWY = wy;
      bestCount = count;
      bestMean = wsum / count;
    }
  }

  if (bestCount >= 2 && bestW > 0) {
    const score = clamp01(
      0.65 * Math.min(1, bestCount / 24) + 0.35 * Math.min(1, bestMean / 255),
    );
    return { x: bestWX / bestW, y: bestWY / bestW, score };
  }

  // 退化:最亮 0.15% 像素质心
  if (topW > 0) {
    return {
      x: topWX / topW,
      y: topWY / topW,
      score: clamp01(0.35 + 0.4 * Math.min(1, topK / 24) + 0.25 * Math.min(1, maxLuma / 255)),
    };
  }
  return null;
}

/**
 * 由球心、半径与高光点反算光源方向(单位向量)。
 *
 * 正交相机 V=(0,0,1)。把图像偏移归一化并将图像 y-down 翻成世界 y-up:
 * ```
 * dx = (hx-cx)/r,  dyImage = (hy-cy)/r
 * N  = (dx, -dyImage, nz),  nz = sqrt(max(0, 1-dx²-dy²))
 * L  = 2(N·V)N - V = (2 nz dx, -2 nz dyImage, 2 nz² - 1)
 * ```
 * 最后再归一化一次以消除数值误差。
 */
export function lightFromHighlight(
  cx: number,
  cy: number,
  radius: number,
  hx: number,
  hy: number,
): { x: number; y: number; z: number } {
  const r = radius > 1e-6 ? radius : 1;
  const dx = (hx - cx) / r;
  const dyImage = (hy - cy) / r;
  const radial2 = dx * dx + dyImage * dyImage;
  const nz = Math.sqrt(Math.max(0, 1 - radial2));

  let lx = 2 * nz * dx;
  let ly = -2 * nz * dyImage;
  let lz = 2 * nz * nz - 1;

  const len = Math.hypot(lx, ly, lz) || 1;
  lx /= len;
  ly /= len;
  lz /= len;
  return { x: lx, y: ly, z: lz };
}
