import { dbApi, putChunk, uid, type ChunkRecord } from '../core/db';
import type { FitJobRecord, ResultRecord } from '../core/types';
import { GpuTileFitter } from './gpuFitter';
import { TilePacker } from './tilePacker';
import { termsFor } from '../core/math/basis';
import { detectExposureLightAware, exposureGains } from '../core/image/exposure';

type Listener = (jobs: FitJobRecord[]) => void;

/**
 * 拟合后台队列(单例)。
 * 每个 tile 算完立即量化并写入 IndexedDB chunk,job.doneTiles 同步落盘,
 * 因此关闭/刷新页面后,已完成 tile 不重算,可从断点继续。
 */
class FitQueue {
  private running = new Set<string>();
  private cancelRequested = new Set<string>();
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    dbApi.jobs.list().then((jobs) => this.listeners.forEach((fn) => fn(jobs)));
  }
  isRunning(jobId: string) {
    return this.running.has(jobId);
  }

  requestPause(jobId: string) {
    if (this.running.has(jobId)) this.cancelRequested.add(jobId);
  }

  /** 把异常中断(上次关页面)留下的 running 标记为 paused */
  async resetStaleJobs() {
    const jobs = await dbApi.jobs.list();
    for (const j of jobs) {
      if (j.status === 'running' && !this.running.has(j.id)) {
        j.status = 'paused';
        await dbApi.jobs.put(j);
      }
    }
    this.emit();
  }

  async createJob(batchId: string, algo: 'ptm' | 'hsh', tileSize = 256, correctExposure = true): Promise<FitJobRecord> {
    const batch = await dbApi.batches.get(batchId);
    if (!batch) throw new Error('批次不存在');
    const k = termsFor(algo);
    const coeffCount = k * 3;
    const tilesX = Math.ceil(batch.width / tileSize);
    const tilesY = Math.ceil(batch.height / tileSize);
    const id = uid('job');
    const resultId = uid('res');
    const coeffPrefix = `coeff_${resultId}`;
    const normalPrefix = `normal_${resultId}`;
    const totalTiles = tilesX * tilesY;

    const result: ResultRecord = {
      id: resultId,
      jobId: id,
      batchId,
      algo,
      width: batch.width,
      height: batch.height,
      coeffPerChannel: k,
      coeffCount,
      coeffMin: new Array(coeffCount).fill(Infinity),
      coeffMax: new Array(coeffCount).fill(-Infinity),
      coeffPrefix,
      tileSize,
      tilesX,
      tilesY,
      normalPrefix,
      tileMin: new Array(totalTiles).fill(null).map(() => new Array(coeffCount).fill(0)),
      tileMax: new Array(totalTiles).fill(null).map(() => new Array(coeffCount).fill(1)),
      paddedWidth: tilesX * tileSize,
      paddedHeight: tilesY * tileSize,
      createdAt: Date.now(),
    };
    await dbApi.results.put(result);

    const job: FitJobRecord = {
      id,
      batchId,
      algo,
      status: 'queued',
      tileSize,
      tilesX,
      tilesY,
      doneTiles: [],
      totalPixels: batch.width * batch.height,
      createdAt: Date.now(),
      resultId,
      correctExposure,
    };
    await dbApi.jobs.put(job);
    this.emit();
    return job;
  }

  async startJob(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return;
    const job = await dbApi.jobs.get(jobId);
    if (!job) throw new Error('任务不存在');
    const batch = await dbApi.batches.get(job.batchId);
    if (!batch) throw new Error('批次不存在');
    if (!batch.lights?.length || batch.lights.length !== batch.imageIds.length) {
      throw new Error('灯位缺失或数量与图片不一致,请先完成灯位标定');
    }
    const images = (await dbApi.images.listByBatch(batch.id)).sort((a, b) => a.index - b.index);
    if (images.length !== batch.imageIds.length) throw new Error('图片记录不完整');

    this.running.add(jobId);
    this.cancelRequested.delete(jobId);
    job.status = 'running';
    job.startedAt = job.startedAt ?? Date.now();
    job.error = undefined;
    await dbApi.jobs.put(job);
    this.emit();

    let fitter: GpuTileFitter | null = null;
    const bitmaps: ImageBitmap[] = [];
    let packer: TilePacker | null = null;
    let computeMs = 0;
    let gpuMs = 0;

    try {
      // 解码全部图片
      for (const img of images) {
        bitmaps.push(await createImageBitmap(img.blob));
      }
      const lights = batch.lights;

      // 曝光增益(只对检测出的异常图拉齐)
      let gains = new Float32Array(images.length).fill(1);
      if (job.correctExposure !== false) {
        const lumas = images.map((im) => im.meanLuma);
        const ids = images.map((_, i) => String(i));
        const flags = detectExposureLightAware(lumas, lights, ids);
        if (flags.length) {
          const allGains = exposureGains(lumas);
          for (const f of flags) gains[f.index] = allGains[f.index];
        }
      }

      fitter = await GpuTileFitter.create(job.algo, lights, job.tileSize, gains);
      job.gpu = (await import('../gpu/device')).isWebGpuAvailable() ? 'webgpu' : undefined;
      packer = new TilePacker(job.tileSize);

      const result = await dbApi.results.get(job.resultId!);
      if (!result) throw new Error('结果记录丢失');
      const K = result.coeffCount;
      const T = job.tileSize;
      const tp = T * T;
      const alignByIndex = images.map((im) => batch.alignments?.find((a) => a.imageId === im.id || a.index === im.index));

      const totalTiles = job.tilesX * job.tilesY;
      while (job.doneTiles.length < totalTiles) {
        if (this.cancelRequested.has(jobId)) {
          job.status = 'paused';
          await dbApi.jobs.put(job);
          this.emit();
          return;
        }
        // 选下一个未完成 tile
        const done = new Set(job.doneTiles);
        let t = -1;
        for (let i = 0; i < totalTiles; i++) if (!done.has(i)) { t = i; break; }
        if (t < 0) break;
        const tx = t % job.tilesX;
        const ty = Math.floor(t / job.tilesX);

        const t0 = performance.now();
        const packed = packer.packTile(bitmaps, alignByIndex, tx, ty, batch.width, batch.height);
        const tGpu0 = performance.now();
        const out = await fitter.fitTile(packed);
        gpuMs += performance.now() - tGpu0;

        // ---- 系数量化(tile 内逐系数 min/max → u8) ----
        const coeffBytes = new Uint8Array(tp * K);
        const tMin = new Array(K).fill(Infinity);
        const tMax = new Array(K).fill(-Infinity);
        for (let p = 0; p < tp; p++) {
          const po = p * K;
          for (let c = 0; c < K; c++) {
            const v = out.coeffs[po + c];
            if (v < tMin[c]) tMin[c] = v;
            if (v > tMax[c]) tMax[c] = v;
          }
        }
        for (let c = 0; c < K; c++) {
          if (!isFinite(tMin[c])) { tMin[c] = 0; tMax[c] = 1; }
          if (tMax[c] - tMin[c] < 1e-8) tMax[c] = tMin[c] + 1e-8;
        }
        for (let p = 0; p < tp; p++) {
          const po = p * K;
          for (let c = 0; c < K; c++) {
            const v = out.coeffs[po + c];
            const q = Math.round(((v - tMin[c]) / (tMax[c] - tMin[c])) * 255);
            coeffBytes[po + c] = Math.max(0, Math.min(255, q));
          }
        }
        const coeffChunk: ChunkRecord = {
          id: `${result.coeffPrefix}:t${t}`,
          prefix: result.coeffPrefix,
          tile: t,
          buffer: coeffBytes.buffer as ArrayBuffer,
          kind: 'coeff-u8',
        };
        await putChunk(coeffChunk);

        // ---- 法线编码 RGBA8 ----
        const normalBytes = new Uint8Array(tp * 4);
        for (let p = 0; p < tp; p++) {
          const x = out.normalEq[p * 4];
          const y = out.normalEq[p * 4 + 1];
          const z = out.normalEq[p * 4 + 2];
          const len = Math.hypot(x, y, z) || 1;
          normalBytes[p * 4] = Math.round((x / len) * 127 + 128);
          normalBytes[p * 4 + 1] = Math.round((y / len) * 127 + 128);
          normalBytes[p * 4 + 2] = Math.round((z / len) * 127 + 128);
          normalBytes[p * 4 + 3] = 255;
        }
        await putChunk({
          id: `${result.normalPrefix}:t${t}`,
          prefix: result.normalPrefix,
          tile: t,
          buffer: normalBytes.buffer as ArrayBuffer,
          kind: 'normal-u8',
        });

        result.tileMin[t] = tMin;
        result.tileMax[t] = tMax;
        for (let c = 0; c < K; c++) {
          if (tMin[c] < result.coeffMin[c]) result.coeffMin[c] = tMin[c];
          if (tMax[c] > result.coeffMax[c]) result.coeffMax[c] = tMax[c];
        }
        await dbApi.results.put(result);

        job.doneTiles = [...job.doneTiles, t];
        job.fitMs = Math.round(computeMs + (performance.now() - t0));
        await dbApi.jobs.put(job);
        computeMs += performance.now() - t0;
        this.emit();

        // 让出主线程,保持 UI 响应
        await new Promise((r) => setTimeout(r, 0));
      }

      if (this.cancelRequested.has(jobId)) return;

      // 生成法线预览 PNG
      try {
        const blob = await buildNormalPreview(result);
        result.normalBlob = blob;
        result.thumbnail = await blobToThumbDataUrl(blob, 480);
        await dbApi.results.put(result);
        if (!batch.thumbnail && result.thumbnail) {
          batch.thumbnail = result.thumbnail;
          await dbApi.batches.put(batch);
        }
      } catch (e) {
        console.warn('法线预览生成失败', e);
      }

      job.status = 'done';
      job.finishedAt = Date.now();
      job.elapsedMs = Date.now() - (job.startedAt ?? job.createdAt);
      job.fitMs = Math.round(computeMs);
      result.fitMs = job.fitMs;
      result.gpu = job.gpu;
      await dbApi.results.put(result);
      await dbApi.jobs.put(job);
      this.emit();
    } catch (err) {
      console.error(err);
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
      await dbApi.jobs.put(job);
      this.emit();
    } finally {
      this.running.delete(jobId);
      this.cancelRequested.delete(jobId);
      bitmaps.forEach((b) => {
        try {
          b.close();
        } catch {
          /* ignore */
        }
      });
      fitter?.destroy();
    }
  }
}

export const fitQueue = new FitQueue();

/** 把所有 tile 的法线拼成整图并导出 PNG blob */
export async function buildNormalPreview(result: ResultRecord): Promise<Blob> {
  const { tileSize: T, tilesX, tilesY, width, height, normalPrefix } = result;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = T;
  tileCanvas.height = T;
  const tctx = tileCanvas.getContext('2d')!;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const t = ty * tilesX + tx;
      const chunk = await import('../core/db').then((m) => m.getChunk(`${normalPrefix}:t${t}`));
      if (!chunk) continue;
      const bytes = new Uint8ClampedArray(chunk.buffer);
      const img = new ImageData(bytes, T, T);
      tctx.putImageData(img, 0, 0);
      ctx.drawImage(tileCanvas, tx * T, ty * T);
    }
  }
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png'),
  );
}

export function blobToThumbDataUrl(blob: Blob, maxW = 480): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = url;
  });
}
