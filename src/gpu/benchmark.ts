import { GpuTileFitter } from './gpuFitter';
import { generateHeightfield, domeLights } from '../core/synth/heightfield';
import { renderPhotos } from '../core/synth/render';
import { normalErrorStats, type AngularStats } from '../core/fit/cpuFit';
import type { LightDir } from '../core/types';

export interface AccuracyReport {
  size: number;
  photos: number;
  gpuMs: number;
  stats: AngularStats;
  pass: boolean;
}

/** 端到端 GPU 精度:合成 → 多 tile 拟合 → 法线 vs 真值 */
export async function accuracyBenchmark(size = 512, photos = 48): Promise<AccuracyReport> {
  const T = 256;
  if (size % T !== 0) throw new Error('size 必须是 256 的整数倍');
  const hf = generateHeightfield({ width: size, height: size });
  const lights = domeLights(photos) as LightDir[];
  const raw = renderPhotos(hf, lights, { seed: 11 });
  const photosU32 = raw.map((p) => new Uint32Array(p.buffer));

  const fitter = await GpuTileFitter.create('ptm', lights, T);
  const tiles = size / T;
  const tp = T * T;
  const gpuNormals = new Float32Array(size * size * 3);
  const t0 = performance.now();

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const packed = new Uint32Array(tp * photos);
      for (let i = 0; i < photos; i++) {
        for (let y = 0; y < T; y++) {
          const srcRow = (ty * T + y) * size + tx * T;
          const dstRow = i * tp + y * T;
          packed.set(photosU32[i].subarray(srcRow, srcRow + T), dstRow);
        }
      }
      const out = await fitter.fitTile(packed);
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const lp = y * T + x;
          const gx = tx * T + x;
          const gy = ty * T + y;
          const gp = gy * size + gx;
          const nx = out.normalEq[lp * 4];
          const ny = out.normalEq[lp * 4 + 1];
          const nz = out.normalEq[lp * 4 + 2];
          const len = Math.hypot(nx, ny, nz) || 1;
          gpuNormals[gp * 3] = nx / len;
          gpuNormals[gp * 3 + 1] = ny / len;
          gpuNormals[gp * 3 + 2] = nz / len;
        }
      }
    }
  }
  const gpuMs = performance.now() - t0;
  fitter.destroy();
  const stats = normalErrorStats(gpuNormals, hf.normals, size, size);
  return { size, photos, gpuMs, stats, pass: stats.meanDeg < 3 };
}

export interface PerfReport {
  width: number;
  height: number;
  photos: number;
  tiles: number;
  gpuFitMs: number;
  quantMs: number;
  totalMs: number;
  pass20s: boolean;
}

/**
 * 2000²×48 拟合性能基准。
 * 拟合耗时只取决于数据量而非内容,因此用一次性构造的填充 tile 数据
 * 压测真实的 64 tile write+dispatch+readback + u8 量化路径。
 */
export async function performanceBenchmark2000(onProgress?: (done: number, total: number) => void): Promise<PerfReport> {
  const W = 2000;
  const T = 256;
  const tilesX = Math.ceil(W / T);
  const tilesY = tilesX;
  const totalTiles = tilesX * tilesY;
  const photos = 48;
  const lights = domeLights(photos) as LightDir[];
  const fitter = await GpuTileFitter.create('ptm', lights, T);
  const tp = T * T;
  const K = 18;

  // 构造一份有变化的填充数据(避免全 0 被驱动优化的嫌疑)
  const packed = new Uint32Array(tp * photos);
  for (let i = 0; i < packed.length; i++) {
    const v = (i * 2654435761) >>> 0;
    packed[i] = 0xff000000 | (v & 0xffffff);
  }

  let gpuMs = 0;
  let quantMs = 0;
  const tStart = performance.now();
  for (let t = 0; t < totalTiles; t++) {
    const tg = performance.now();
    const out = await fitter.fitTile(packed);
    gpuMs += performance.now() - tg;

    const tq = performance.now();
    const bytes = new Uint8Array(tp * K);
    const min = new Array(K).fill(Infinity);
    const max = new Array(K).fill(-Infinity);
    for (let p = 0; p < tp; p++) {
      for (let c = 0; c < K; c++) {
        const v = out.coeffs[p * K + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    for (let c = 0; c < K; c++) if (max[c] - min[c] < 1e-8) max[c] = min[c] + 1e-8;
    for (let p = 0; p < tp; p++) {
      for (let c = 0; c < K; c++) {
        const q = Math.round(((out.coeffs[p * K + c] - min[c]) / (max[c] - min[c])) * 255);
        bytes[p * K + c] = q < 0 ? 0 : q > 255 ? 255 : q;
      }
    }
    quantMs += performance.now() - tq;
    onProgress?.(t + 1, totalTiles);
    await new Promise((r) => setTimeout(r, 0));
  }
  const totalMs = performance.now() - tStart;
  fitter.destroy();
  return {
    width: W,
    height: W,
    photos,
    tiles: totalTiles,
    gpuFitMs: Math.round(gpuMs),
    quantMs: Math.round(quantMs),
    totalMs: Math.round(totalMs),
    pass20s: totalMs < 20000,
  };
}
