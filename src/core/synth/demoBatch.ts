import { generateHeightfield, domeLights, type Heightfield } from './heightfield';
import { renderPhoto, meanLuma } from './render';
import { detectExposureLightAware } from '../image/exposure';
import { dbApi, uid } from '../db';
import type { BatchRecord, ImageRecord, LightDir } from '../types';

export interface DemoOptions {
  size?: number;
  photos?: number;
  name?: string;
  artifactName?: string;
  author?: string;
  /** 第二期:在反照率上加新锈蚀斑 */
  rust?: boolean;
  capturedAt?: string;
  seed?: number;
  onProgress?: (done: number, total: number, stage: string) => void;
}

function lightWithAngles(l: { x: number; y: number; z: number }): LightDir {
  return {
    ...l,
    azimuth: (Math.atan2(l.y, l.x) * 180) / Math.PI,
    elevation: (Math.asin(l.z) * 180) / Math.PI,
  };
}

/** 在反照率上叠加几片新生锈蚀(橙红 + 孔雀绿),供两期对比 */
export function addRustPatches(hf: Heightfield, seed = 777) {
  const W = hf.width;
  const H = hf.height;
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const patches = 7;
  for (let p = 0; p < patches; p++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const rad = W * (0.02 + rnd() * 0.05);
    const green = rnd() < 0.4;
    for (let y = Math.max(0, Math.floor(cy - rad * 2)); y < Math.min(H, cy + rad * 2); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad * 2)); x < Math.min(W, cx + rad * 2); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > rad) continue;
        const t = Math.pow(1 - d / rad, 1.6) * (0.55 + 0.45 * rnd());
        const i3 = (y * W + x) * 3;
        if (green) {
          hf.albedo[i3] = hf.albedo[i3] * (1 - t) + 64 * t;
          hf.albedo[i3 + 1] = hf.albedo[i3 + 1] * (1 - t) + 150 * t;
          hf.albedo[i3 + 2] = hf.albedo[i3 + 2] * (1 - t) + 118 * t;
        } else {
          hf.albedo[i3] = hf.albedo[i3] * (1 - t) + 176 * t;
          hf.albedo[i3 + 1] = hf.albedo[i3 + 1] * (1 - t) + 78 * t;
          hf.albedo[i3 + 2] = hf.albedo[i3 + 2] * (1 - t) + 34 * t;
        }
      }
    }
  }
}

function rgbaToJpegBlob(rgba: Uint8ClampedArray, w: number, h: number, quality = 0.93): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))), 'image/jpeg', quality),
  );
}

/** 生成一整组合成多光源照片并写入 IndexedDB,返回 batchId */
export async function createDemoBatch(opts: DemoOptions = {}): Promise<string> {
  const size = opts.size ?? 1280;
  const photoCount = opts.photos ?? 48;
  const onProgress = opts.onProgress;
  onProgress?.(0, photoCount, '生成高度场与真值法线…');
  // 让出一帧让进度渲染
  await new Promise((r) => setTimeout(r, 30));

  const hf = generateHeightfield({ width: size, height: size, seed: opts.seed ?? 20260521 });
  if (opts.rust) addRustPatches(hf);
  const lights = domeLights(photoCount).map(lightWithAngles);

  // 两张曝光不一致(第 5 张偏亮 +0.49EV,第 31 张偏暗 -0.56EV)
  const exposures = new Array(photoCount).fill(1);
  if (photoCount >= 32) {
    exposures[5] = 1.4;
    exposures[31] = 0.68;
  }

  const batchId = uid('batch');
  const author = opts.author ?? '文保研究员';
  const batch: BatchRecord = {
    id: batchId,
    name: opts.name ?? `合成样例 · ${size}² · ${photoCount}灯`,
    artifactName: opts.artifactName ?? '合成刻铭青铜片',
    capturedAt: opts.capturedAt ?? new Date().toISOString().slice(0, 10),
    createdAt: Date.now(),
    author,
    note: '由内置高度场(刻字+凹痕)按已知灯位合成,含两张曝光异常图,可用于精度验收。',
    width: size,
    height: size,
    imageIds: [],
    fileNames: [],
    lights,
    lightsSource: 'known',
    alignments: [],
  };

  const lumas: number[] = [];
  for (let i = 0; i < photoCount; i++) {
    onProgress?.(i, photoCount, `渲染并编码第 ${i + 1}/${photoCount} 张…`);
    // 让进度条有机会绘制
    if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    const rgba = renderPhoto(hf, lights[i], i, { exposures });
    const mean = meanLuma(rgba, 2);
    lumas.push(mean);
    const blob = await rgbaToJpegBlob(rgba, size, size);
    const imageId = uid('img');
    const rec: ImageRecord = {
      id: imageId,
      batchId,
      index: i,
      name: `synth_light_${String(i).padStart(2, '0')}.jpg`,
      width: size,
      height: size,
      type: 'image/jpeg',
      size: blob.size,
      blob,
      meanLuma: mean,
    };
    await dbApi.images.put(rec);
    batch.imageIds.push(imageId);
    batch.fileNames.push(rec.name);
    if (i === 0) {
      batch.thumbnail = await new Promise<string>((resolve) => {
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => {
          const c = document.createElement('canvas');
          const sc = 420 / size;
          c.width = 420;
          c.height = Math.round(size * sc);
          c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.82));
        };
        im.src = url;
      });
    }
  }

  const ids = batch.imageIds;
  batch.exposureFlags = detectExposureLightAware(lumas, lights, ids);
  await dbApi.batches.put(batch);
  onProgress?.(photoCount, photoCount, '完成');
  return batchId;
}
