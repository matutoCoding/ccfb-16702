/** WebGPU 设备单例与能力信息 */

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  info: string;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  preferredFormat?: GPUTextureFormat;
}

let ctxPromise: Promise<GpuContext> | null = null;

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

export function getGpuContext(): Promise<GpuContext> {
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    if (!navigator.gpu) throw new Error('当前浏览器不支持 WebGPU,请使用最新版 Chrome/Edge');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未申请到 WebGPU 适配器(可能被禁用或虚拟机无 GPU)');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(
          adapter.limits.maxStorageBufferBindingSize,
          256 * 1024 * 1024,
        ),
      },
    });
    device.addEventListener('uncapturederror', (e) => {
      console.error('[WebGPU uncaptured]', (e as GPUUncapturedErrorEvent).error);
    });
    let info = 'WebGPU GPU';
    try {
      const ai = (adapter as any).info;
      if (ai) info = `${ai.vendor ?? ''} ${ai.architecture ?? ''} ${ai.description ?? ''}`.trim() || info;
    } catch {
      /* ignore */
    }
    return {
      adapter,
      device,
      info,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxBufferSize: device.limits.maxBufferSize,
    };
  })();
  return ctxPromise;
}

/** sRGB 字节 -> 线性 的 256 项查找表(f32) */
export function srgbLut(): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
}
