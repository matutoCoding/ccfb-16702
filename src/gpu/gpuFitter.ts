import { getGpuContext, type GpuContext } from './device';
import { FIT_WGSL } from './fitShader';
import { leastSquaresMatrix } from '../core/math/linalg';
import { basisFor, termsFor } from '../core/math/basis';
import type { AlgoId, LightDir } from '../core/types';

export interface TileFitOutput {
  /** tilePixels * coeffCount */
  coeffs: Float32Array;
  /** tilePixels * 4 (rhoNx,rhoNy,rhoNz,ambient) */
  normalEq: Float32Array;
}

/**
 * 按 tile 调用的 GPU 拟合器。整个任务生命周期内复用 pipeline/buffer。
 */
export class GpuTileFitter {
  private constructor(
    private gpu: GpuContext,
    private pipeline: GPUComputePipeline,
    private module: GPUShaderModule,
    private layout: GPUBindGroupLayout,
    private algo: AlgoId,
    readonly m: number,
    readonly k: number,
    readonly tile: number,
    private bufs: {
      samples: GPUBuffer;
      pm: GPUBuffer;
      pn: GPUBuffer;
      gains: GPUBuffer;
      lights: GPUBuffer;
      outCoeff: GPUBuffer;
      outNormal: GPUBuffer;
      coeffStage: GPUBuffer;
      normalStage: GPUBuffer;
      params: GPUBuffer;
    },
    private coeffBytes: number,
    private normalBytes: number,
  ) {}

  static async create(
    algo: AlgoId,
    lights: LightDir[],
    tile = 256,
    gains?: Float32Array,
  ): Promise<GpuTileFitter> {
    const gpu = await getGpuContext();
    const { device } = gpu;
    const m = lights.length;
    if (m > 64) throw new Error('单组灯数不能超过 64');
    const k = termsFor(algo);
    const coeffCount = k * 3;
    const tilePixels = tile * tile;

    const { P: Pm } = leastSquaresMatrix(lights, basisFor(algo));
    const { P: Pn } = leastSquaresMatrix(lights, (l) => [l.x, l.y, l.z, 1]);

    const module = device.createShaderModule({ code: FIT_WGSL });
    const compInfo = await module.getCompilationInfo();
    const errors = compInfo.messages.filter((x) => x.type === 'error');
    if (errors.length) {
      throw new Error('拟合着色器编译失败: ' + errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
    }

    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = await device.createComputePipelineAsync({
      layout: pipeLayout,
      compute: { module, entryPoint: 'main' },
    });

    const samplesBytes = tilePixels * m * 4;
    const coeffBytes = tilePixels * coeffCount * 4;
    const normalBytes = tilePixels * 4 * 4;
    const mkStorage = (size: number, mappedAtCreation = false) =>
      device.createBuffer({ size: Math.max(4, size), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation });

    const pmBuf = mkStorage(Pm.byteLength * 0 + Pm.length * 4);
    const Pm32 = Float32Array.from(Pm);
    device.queue.writeBuffer(pmBuf, 0, Pm32);
    const pnBuf = mkStorage(Pn.length * 4);
    const Pn32 = Float32Array.from(Pn);
    device.queue.writeBuffer(pnBuf, 0, Pn32);

    const gainsData = gains ?? new Float32Array(m).fill(1);
    const gainsBuf = mkStorage(m * 4);
    device.queue.writeBuffer(gainsBuf, 0, gainsData as unknown as Float32Array);

    const lightsArr = new Float32Array(m * 4);
    lights.forEach((l, i) => {
      lightsArr[i * 4] = l.x;
      lightsArr[i * 4 + 1] = l.y;
      lightsArr[i * 4 + 2] = l.z;
      lightsArr[i * 4 + 3] = 0;
    });
    const lightsBuf = mkStorage(m * 16);
    device.queue.writeBuffer(lightsBuf, 0, lightsArr);

    const samplesBuf = mkStorage(samplesBytes);
    const outCoeff = device.createBuffer({
      size: coeffBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const outNormal = device.createBuffer({
      size: normalBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const coeffStage = device.createBuffer({
      size: coeffBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const normalStage = device.createBuffer({
      size: normalBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const paramsBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const params = new Uint32Array(8);
    params[0] = m;
    params[1] = k;
    params[2] = coeffCount;
    params[3] = tilePixels;
    params[4] = Math.max(8, Math.floor(m * 0.7));
    params[5] = 4;
    params[6] = tile;
    params[7] = tile;
    device.queue.writeBuffer(paramsBuf, 0, params);

    return new GpuTileFitter(
      gpu,
      pipeline,
      module,
      layout,
      algo,
      m,
      k,
      tile,
      {
        samples: samplesBuf,
        pm: pmBuf,
        pn: pnBuf,
        gains: gainsBuf,
        lights: lightsBuf,
        outCoeff,
        outNormal,
        coeffStage,
        normalStage,
        params: paramsBuf,
      },
      coeffBytes,
      normalBytes,
    );
  }

  async fitTile(packed: Uint32Array): Promise<TileFitOutput> {
    const { device } = this.gpu;
    const tp = this.tile * this.tile;
    if (packed.length !== tp * this.m) {
      throw new Error(`packed 长度 ${packed.length} != ${tp * this.m}`);
    }
    device.queue.writeBuffer(this.bufs.samples, 0, packed as unknown as Uint32Array);

    const bindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.bufs.samples } },
        { binding: 1, resource: { buffer: this.bufs.pm } },
        { binding: 2, resource: { buffer: this.bufs.pn } },
        { binding: 3, resource: { buffer: this.bufs.gains } },
        { binding: 4, resource: { buffer: this.bufs.lights } },
        { binding: 5, resource: { buffer: this.bufs.outCoeff } },
        { binding: 6, resource: { buffer: this.bufs.outNormal } },
        { binding: 7, resource: { buffer: this.bufs.params } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(this.tile / 8, this.tile / 8);
    pass.end();
    enc.copyBufferToBuffer(this.bufs.outCoeff, 0, this.bufs.coeffStage, 0, this.coeffBytes);
    enc.copyBufferToBuffer(this.bufs.outNormal, 0, this.bufs.normalStage, 0, this.normalBytes);
    device.queue.submit([enc.finish()]);

    await Promise.all([
      this.bufs.coeffStage.mapAsync(GPUMapMode.READ),
      this.bufs.normalStage.mapAsync(GPUMapMode.READ),
    ]);
    const coeffs = new Float32Array(this.bufs.coeffStage.getMappedRange()).slice();
    const normalEq = new Float32Array(this.bufs.normalStage.getMappedRange()).slice();
    this.bufs.coeffStage.unmap();
    this.bufs.normalStage.unmap();
    return { coeffs, normalEq };
  }

  destroy() {
    Object.values(this.bufs).forEach((b) => {
      try {
        b.destroy();
      } catch {
        /* ignore */
      }
    });
  }
}
