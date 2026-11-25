import { GpuTileFitter } from './gpuFitter';
import { generateHeightfield, domeLights } from '../core/synth/heightfield';
import { renderPhotos } from '../core/synth/render';
import { cpuFit, normalErrorStats } from '../core/fit/cpuFit';
import type { LightDir } from '../core/types';

/** 浏览器控制台可执行:await window.__rti.gpuSelfTest() */
export async function gpuSelfTest(size = 160, photoCount = 24) {
  const hf = generateHeightfield({ width: size, height: size });
  const lights = domeLights(photoCount) as LightDir[];
  const photos = renderPhotos(hf, lights, { seed: 3 });
  const T = size; // 自检 tile 与图同尺寸(size 取 8 的倍数)
  const fitter = await GpuTileFitter.create('ptm', lights, T);
  const tp = T * T;
  const packed = new Uint32Array(tp * photoCount);
  photos.forEach((ph, i) => {
    packed.set(new Uint32Array(ph.buffer), i * tp);
  });
  const out = await fitter.fitTile(packed);
  fitter.destroy();

  const cpu = cpuFit(photos, size, size, lights, 'ptm');
  let maxCoeffDiff = 0;
  let meanCoeffRel = 0;
  for (let i = 0; i < cpu.coeffs.length; i++) {
    const d = Math.abs(out.coeffs[i] - cpu.coeffs[i]);
    maxCoeffDiff = Math.max(maxCoeffDiff, d);
    meanCoeffRel += d / (1 + Math.abs(cpu.coeffs[i]));
  }
  meanCoeffRel /= cpu.coeffs.length;

  // GPU 法线单位化后统计
  const gpuN = new Float32Array(size * size * 3);
  for (let p = 0; p < size * size; p++) {
    const x = out.normalEq[p * 4];
    const y = out.normalEq[p * 4 + 1];
    const z = out.normalEq[p * 4 + 2];
    const l = Math.hypot(x, y, z) || 1;
    gpuN[p * 3] = x / l;
    gpuN[p * 3 + 1] = y / l;
    gpuN[p * 3 + 2] = z / l;
  }
  const gpuErr = normalErrorStats(gpuN, hf.normals, size, size);
  const cpuErr = normalErrorStats(cpu.normals, hf.normals, size, size);
  return {
    webgpu: (await import('./device')).isWebGpuAvailable(),
    maxCoeffDiff,
    meanCoeffRel,
    gpuNormalMeanDeg: gpuErr.meanDeg,
    cpuNormalMeanDeg: cpuErr.meanDeg,
    gpu: gpuErr,
  };
}
