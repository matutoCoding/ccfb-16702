import { getGpuContext, type GpuContext } from './device';
import { RELIGHT_WGSL } from './relightShader';
import type { LoadedResultData } from '../core/result/resultReader';
import type { DepthMap } from '../core/result/depthMap';

export type ViewMode = 'lit' | 'spec' | 'normal' | 'multi' | 'relief' | 'depth';

export interface LightState {
  x: number;
  y: number;
  z: number;
  intensity: number;
}

export interface RenderState {
  mode: ViewMode;
  light: LightState;
  lights: LightState[];
  brightness: number;
  specStrength: number;
  shininess: number;
  lineStrength: number;
}

export const DEFAULT_RENDER_STATE: RenderState = {
  mode: 'lit',
  light: { x: -0.45, y: 0.35, z: 0.82, intensity: 1 },
  lights: [
    { x: -0.5, y: 0.3, z: 0.81, intensity: 0.8 },
    { x: 0.5, y: 0.3, z: 0.81, intensity: 0.8 },
    { x: 0, y: -0.6, z: 0.8, intensity: 0.7 },
    { x: 0, y: 0.55, z: 0.84, intensity: 0.55 },
  ],
  brightness: 1.05,
  specStrength: 0.9,
  shininess: 42,
  lineStrength: 1.15,
};

const MODE_ID: Record<ViewMode, number> = { lit: 0, spec: 1, normal: 2, multi: 3, relief: 4, depth: 5 };

export class RelightRenderer {
  private depthTexture: GPUTexture | null = null;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private uniformArray = new ArrayBuffer(256);
  private disposed = false;

  private constructor(
    private gpu: GpuContext,
    private canvas: HTMLCanvasElement,
    readonly data: LoadedResultData,
    private coeffBuffer: GPUBuffer,
    private normalBuffer: GPUBuffer,
    private scaleBuffer: GPUBuffer,
    private biasBuffer: GPUBuffer,
    private sampler: GPUSampler,
    private layout: GPUBindGroupLayout,
    pipeline: GPURenderPipeline,
  ) {
    this.pipeline = pipeline;
    const { device } = gpu;
    this.uniformBuffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 占位 1x1 深度纹理
    this.depthTexture = device.createTexture({
      size: [1, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.depthTexture }, new Uint8Array([128]), { bytesPerRow: 1 }, [1, 1]);
    this.bindGroup = this.makeBindGroup();
  }

  static async create(canvas: HTMLCanvasElement, data: LoadedResultData): Promise<RelightRenderer> {
    const gpu = await getGpuContext();
    const { device } = gpu;
    const module = device.createShaderModule({ code: RELIGHT_WGSL });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    if (errs.length) throw new Error('重光照着色器编译失败: ' + errs.map((e) => e.message).join('\n'));

    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = await device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: gpu.preferredFormat ?? navigator.gpu!.getPreferredCanvasFormat() }] },
      primitive: { topology: 'triangle-list' },
    });

    const coeffU32 = new Uint32Array(data.coeffBytes.buffer, data.coeffBytes.byteOffset, data.coeffBytes.byteLength / 4);
    const coeffBuffer = device.createBuffer({
      size: coeffU32.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(coeffBuffer, 0, coeffU32);

    const normalU32 = new Uint32Array(data.normalBytes.buffer, data.normalBytes.byteOffset, data.normalBytes.byteLength / 4);
    const normalBuffer = device.createBuffer({
      size: normalU32.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(normalBuffer, 0, normalU32);

    const scaleBuffer = device.createBuffer({ size: data.tileScale.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(scaleBuffer, 0, data.tileScale);
    const biasBuffer = device.createBuffer({ size: data.tileBias.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(biasBuffer, 0, data.tileBias);

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const ctx = canvas.getContext('webgpu') as GPUCanvasContext;
    const format = navigator.gpu!.getPreferredCanvasFormat();
    gpu.preferredFormat = format;
    ctx.configure({ device, format, alphaMode: 'opaque' });

    const r = new RelightRenderer(gpu, canvas, data, coeffBuffer, normalBuffer, scaleBuffer, biasBuffer, sampler, layout, pipeline);
    r.resizeToResult();
    return r;
  }

  resizeToResult(maxBacking = 2200) {
    const { width, height } = this.data.result;
    const scale = Math.min(1, maxBacking / Math.max(width, height));
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
  }

  private makeBindGroup(): GPUBindGroup {
    const { device } = this.gpu;
    return device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.coeffBuffer } },
        { binding: 1, resource: { buffer: this.normalBuffer } },
        { binding: 2, resource: { buffer: this.scaleBuffer } },
        { binding: 3, resource: { buffer: this.biasBuffer } },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
        { binding: 5, resource: this.depthTexture!.createView() },
        { binding: 6, resource: this.sampler },
      ],
    });
  }

  setDepth(depth: DepthMap) {
    const { device } = this.gpu;
    this.depthTexture?.destroy();
    // r8unorm 需要字节数据
    const bytes = new Uint8Array(depth.width * depth.height);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(depth.depth[i] * 255);
    this.depthTexture = device.createTexture({
      size: [depth.width, depth.height],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.depthTexture },
      bytes,
      { bytesPerRow: depth.width, rowsPerImage: depth.height },
      [depth.width, depth.height],
    );
    this.depthSize = [depth.width, depth.height];
    this.bindGroup = this.makeBindGroup();
  }
  private depthSize: [number, number] = [1, 1];

  render(state: RenderState) {
    if (this.disposed) return;
    const { device } = this.gpu;
    const { result, paddedW, paddedH, K } = this.data;
    const buf = this.uniformArray;
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = result.width;
    u32[1] = result.height;
    u32[2] = paddedW;
    u32[3] = paddedH;
    u32[4] = K;
    u32[5] = result.tilesX;
    u32[6] = result.tileSize;
    u32[7] = result.coeffPerChannel;
    u32[8] = MODE_ID[state.mode];
    u32[9] = this.depthSize[0];
    u32[10] = this.depthSize[1];
    u32[11] = this.depthSize[0] === 1 && this.depthSize[1] === 1 ? 0 : 1;
    f32[12] = state.brightness;
    f32[13] = state.specStrength;
    f32[14] = state.shininess;
    f32[15] = state.lineStrength;
    const setLight = (floatIndex: number, l: LightState) => {
      f32[floatIndex] = l.x;
      f32[floatIndex + 1] = l.y;
      f32[floatIndex + 2] = l.z;
      f32[floatIndex + 3] = l.intensity;
    };
    setLight(16, state.light);
    for (let i = 0; i < 4; i++) setLight(20 + i * 4, state.lights[i] ?? { x: 0, y: 0, z: 1, intensity: 0 });
    // tint at 32..35 暂未使用
    f32[32] = 1;
    f32[33] = 1;
    f32[34] = 1;
    f32[35] = 1;
    device.queue.writeBuffer(this.uniformBuffer, 0, u32);

    const encoder = device.createCommandEncoder();
    const ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
    const view = ctx.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0.05, g: 0.055, b: 0.07, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** 导出当前画布 PNG blob */
  async snapshotPng(): Promise<Blob> {
    return await new Promise((resolve, reject) =>
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('截图失败'))), 'image/png'),
    );
  }

  dispose() {
    this.disposed = true;
    this.coeffBuffer.destroy();
    this.normalBuffer.destroy();
    this.scaleBuffer.destroy();
    this.biasBuffer.destroy();
    this.uniformBuffer.destroy();
    this.depthTexture?.destroy();
  }
}
