/**
 * 手工定义的刻字笔画(单位方格 0..1,y 向下)。
 * 用折线描述,随后栅格化 + 距离变换生成刻槽高度场。
 * 不依赖系统字体,保证 Node 验收脚本与浏览器生成同一份真值。
 */
export type Polyline = [number, number][];
export interface Glyph {
  char: string;
  strokes: Polyline[];
}

const WEN: Glyph = {
  char: '文',
  strokes: [
    [[0.46, 0.08], [0.55, 0.17]], // 点
    [[0.17, 0.3], [0.83, 0.28]], // 横
    [[0.52, 0.3], [0.44, 0.52], [0.32, 0.72], [0.18, 0.9]], // 撇
    [[0.44, 0.42], [0.58, 0.62], [0.72, 0.78], [0.88, 0.9]], // 捺
  ],
};

const BAO: Glyph = {
  char: '保',
  strokes: [
    // 亻
    [[0.3, 0.1], [0.13, 0.42]],
    [[0.23, 0.34], [0.22, 0.92]],
    // 口
    [[0.42, 0.16], [0.8, 0.16], [0.8, 0.42], [0.42, 0.42], [0.42, 0.16]],
    // 木
    [[0.34, 0.56], [0.9, 0.54]],
    [[0.61, 0.42], [0.6, 0.94]],
    [[0.59, 0.64], [0.46, 0.78], [0.36, 0.88]],
    [[0.63, 0.64], [0.76, 0.78], [0.88, 0.9]],
  ],
};

const YIN: Glyph = {
  char: '印',
  strokes: [
    [[0.2, 0.12], [0.2, 0.88]],
    [[0.2, 0.14], [0.48, 0.14], [0.48, 0.4], [0.2, 0.4]],
    [[0.2, 0.52], [0.46, 0.52], [0.46, 0.86], [0.2, 0.86]],
    [[0.66, 0.1], [0.66, 0.92]],
    [[0.66, 0.12], [0.86, 0.28], [0.86, 0.6], [0.66, 0.72]],
  ],
};

const R: Glyph = {
  char: 'R',
  strokes: [
    [[0.18, 0.08], [0.18, 0.92]],
    [[0.18, 0.08], [0.66, 0.08], [0.74, 0.2], [0.74, 0.4], [0.64, 0.5], [0.18, 0.5]],
    [[0.46, 0.5], [0.82, 0.92]],
  ],
};
const T: Glyph = {
  char: 'T',
  strokes: [
    [[0.06, 0.1], [0.94, 0.1]],
    [[0.5, 0.1], [0.5, 0.92]],
  ],
};
const I: Glyph = {
  char: 'I',
  strokes: [
    [[0.2, 0.1], [0.8, 0.1]],
    [[0.5, 0.1], [0.5, 0.9]],
    [[0.2, 0.9], [0.8, 0.9]],
  ],
};

export const GLYPHS: Record<string, Glyph> = {
  文: WEN,
  保: BAO,
  印: YIN,
  R,
  T,
  I,
};

export interface PlacedGlyph {
  glyph: Glyph;
  /** 左上角像素 */
  x: number;
  y: number;
  size: number;
  /** 刻槽半宽(像素) */
  halfWidth: number;
  depth: number;
}

/** 文保 + RTI 的版面 */
export function defaultLayout(W: number, H: number): PlacedGlyph[] {
  const s = Math.min(W, H);
  const big = s * 0.3;
  const cy = H * 0.16;
  const out: PlacedGlyph[] = [
    { glyph: WEN, x: W * 0.12, y: cy, size: big, halfWidth: s * 0.0085, depth: s * 0.012 },
    { glyph: BAO, x: W * 0.12 + big * 1.12, y: cy, size: big, halfWidth: s * 0.0085, depth: s * 0.012 },
  ];
  const small = s * 0.13;
  const ry = H * 0.62;
  const startX = W * 0.2;
  const gap = small * 1.25;
  [R, T, I].forEach((g, i) => {
    out.push({
      glyph: g,
      x: startX + i * gap,
      y: ry,
      size: small,
      halfWidth: s * 0.005,
      depth: s * 0.008,
    });
  });
  // 一方小印
  out.push({
    glyph: YIN,
    x: W * 0.72,
    y: H * 0.6,
    size: s * 0.16,
    halfWidth: s * 0.006,
    depth: s * 0.01,
  });
  return out;
}
