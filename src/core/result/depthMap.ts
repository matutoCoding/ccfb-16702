import type { LoadedResultData } from './resultReader';

export interface DepthMap {
  width: number;
  height: number;
  /** 0..1,越大越深(刻槽/凹坑) */
  depth: Float32Array;
}

/**
 * 从编码法线恢复相对高度的快速近似:
 * 梯度 hx=-nx/nz, hy=ny/nz;做左/右/上/下四个方向扫描积分并去均值融合,
 * 抑制单向累积条纹。仅用于深度配色/线稿淡彩;测量宽度不依赖它。
 * 输出长边限制 maxDim。
 */
export function computeDepthMap(data: LoadedResultData, maxDim = 1024): DepthMap {
  const { result, normalBytes, paddedW: pw } = data;
  const W = result.width;
  const H = result.height;
  const scale = Math.min(1, maxDim / Math.max(W, H));
  const dw = Math.max(2, Math.round(W * scale));
  const dh = Math.max(2, Math.round(H * scale));

  const sampleN = (x: number, y: number): [number, number, number] => {
    const sx = Math.min(W - 1, Math.floor(x / scale));
    const sy = Math.min(H - 1, Math.floor(y / scale));
    const i = (sy * pw + sx) * 4;
    return [
      normalBytes[i] / 127.5 - 1,
      normalBytes[i + 1] / 127.5 - 1,
      normalBytes[i + 2] / 127.5 - 1,
    ];
  };

  const gx = new Float32Array(dw * dh);
  const gy = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const [nx, ny, nz] = sampleN(x, y);
      const z = Math.max(0.18, Math.abs(nz));
      gx[y * dw + x] = -nx / z;
      gy[y * dw + x] = ny / z;
    }
  }

  const maps: Float32Array[] = [];
  // 从左
  {
    const h = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      let acc = 0;
      for (let x = 0; x < dw; x++) {
        acc += gx[y * dw + x];
        h[y * dw + x] = acc;
      }
    }
    maps.push(demean(h));
  }
  // 从右
  {
    const h = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      let acc = 0;
      for (let x = dw - 1; x >= 0; x--) {
        acc -= gx[y * dw + x];
        h[y * dw + x] = acc;
      }
    }
    maps.push(demean(h));
  }
  // 从上
  {
    const h = new Float32Array(dw * dh);
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let y = 0; y < dh; y++) {
        acc += gy[y * dw + x];
        h[y * dw + x] = acc;
      }
    }
    maps.push(demean(h));
  }
  // 从下
  {
    const h = new Float32Array(dw * dh);
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let y = dh - 1; y >= 0; y--) {
        acc -= gy[y * dw + x];
        h[y * dw + x] = acc;
      }
    }
    maps.push(demean(h));
  }

  const fused = new Float32Array(dw * dh);
  for (const m of maps) for (let i = 0; i < fused.length; i++) fused[i] += m[i] * 0.25;

  // 轻微平滑
  const smooth = new Float32Array(fused.length);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= dw || yy >= dh) continue;
          s += fused[yy * dw + xx];
          n++;
        }
      }
      smooth[y * dw + x] = s / n;
    }
  }

  // h 越小越深(刻槽 h 为负) -> depth=-h,用 2%/98% 分位稳健归一
  const neg = new Float32Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) neg[i] = -smooth[i];
  const sorted = Float32Array.from(neg).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const range = hi - lo || 1;
  const depth = new Float32Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) {
    depth[i] = Math.max(0, Math.min(1, (neg[i] - lo) / range));
  }
  return { width: dw, height: dh, depth };
}

function demean(a: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  const m = s / a.length;
  for (let i = 0; i < a.length; i++) a[i] -= m;
  return a;
}
