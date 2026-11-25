import type { ImageAlignment } from '../core/types';

/**
 * 把一个 tile 所需的几十张图像素打包成 light-major 的 Uint32(RGBA8)。
 * 对齐平移在此处通过 drawImage 偏移实现,边缘用边界像素复制(clamp)。
 */
export class TilePacker {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  readonly tile: number;

  constructor(tile = 256) {
    this.tile = tile;
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(tile, tile);
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = tile;
      this.canvas.height = tile;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    }
  }

  /**
   * @param bitmaps 与 alignments 同序
   * @param tileX tile 列索引
   * @param tileY tile 行索引
   * @param W,H 全图尺寸
   */
  packTile(
    bitmaps: ImageBitmap[],
    alignments: (ImageAlignment | undefined)[] | undefined,
    tileX: number,
    tileY: number,
    W: number,
    H: number,
  ): Uint32Array {
    const T = this.tile;
    const tp = T * T;
    const m = bitmaps.length;
    const packed = new Uint32Array(tp * m);
    const tx0 = tileX * T;
    const ty0 = tileY * T;
    const ctx = this.ctx as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < m; i++) {
      const bmp = bitmaps[i];
      const sx = alignments?.[i]?.shiftX ?? 0;
      const sy = alignments?.[i]?.shiftY ?? 0;
      ctx.clearRect(0, 0, T, T);
      // 目标全图坐标 X 采样源 X-sx => 图在 tile 内绘制原点 (sx - tx0, sy - ty0)
      ctx.drawImage(bmp, Math.round(sx - tx0), Math.round(sy - ty0));
      const img = ctx.getImageData(0, 0, T, T);
      const data32 = new Uint32Array(img.data.buffer);

      // 有效源像素对应的 tile 内矩形
      const xmin = Math.max(0, Math.round(sx - tx0));
      const xmax = Math.min(T - 1, W - 1 + Math.round(sx - tx0));
      const ymin = Math.max(0, Math.round(sy - ty0));
      const ymax = Math.min(T - 1, H - 1 + Math.round(sy - ty0));
      if (xmax >= xmin && ymax >= ymin) {
        // 列边缘复制(仅有效行)
        for (let y = ymin; y <= ymax; y++) {
          const row = y * T;
          const left = data32[row + xmin];
          const right = data32[row + xmax];
          for (let x = 0; x < xmin; x++) data32[row + x] = left;
          for (let x = xmax + 1; x < T; x++) data32[row + x] = right;
        }
        // 行边缘复制
        for (let y = 0; y < T; y++) {
          const srcY = y < ymin ? ymin : y > ymax ? ymax : y;
          if (srcY === y) continue;
          const dst = y * T;
          const src = srcY * T;
          for (let x = 0; x < T; x++) data32[dst + x] = data32[src + x];
        }
      }
      packed.set(data32, i * tp);
    }
    return packed;
  }
}
