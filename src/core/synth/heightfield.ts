import { mulberry32, ValueNoise } from './rng';
import { defaultLayout, type PlacedGlyph } from './strokes';
import type { Vec3 } from '../types';

export interface Heightfield {
  width: number;
  height: number;
  /** 高度(任意单位,约等于像素当量) */
  h: Float32Array;
  /** 真值法线,长度 w*h*3,世界系 x 右 / y 上 / z 指向观察者 */
  normals: Float32Array;
  /** 反照率 sRGB 0..255,w*h*3 */
  albedo: Uint8ClampedArray;
  /** 刻槽/凹坑遮蔽系数 0..1 */
  cavity: Float32Array;
}

/** 8 邻域 chamfer 距离(近似欧氏),mask 中非 0 为笔画中心 */
function chamferDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  d.fill(INF);
  for (let i = 0; i < w * h; i++) if (mask[i]) d[i] = 0;
  const D1 = 1;
  const D2 = Math.SQRT2;
  // forward
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + D1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D2);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D2);
      }
      d[i] = v;
    }
  }
  // backward
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + D1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + D1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D2);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D2);
      }
      d[i] = v;
    }
  }
  return d;
}

function rasterizeGlyphMask(g: PlacedGlyph): { mask: Uint8Array; bw: number; bh: number; ox: number; oy: number } {
  const pad = Math.ceil(g.halfWidth * 1.6) + 2;
  const ox = Math.max(0, Math.floor(g.x) - pad);
  const oy = Math.max(0, Math.floor(g.y) - pad);
  const bw = Math.ceil(g.size) + pad * 2;
  const bh = Math.ceil(g.size) + pad * 2;
  const mask = new Uint8Array(bw * bh);
  const setPx = (x: number, y: number) => {
    const ix = Math.round(x - ox);
    const iy = Math.round(y - oy);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx * dx + dy * dy > 2) continue;
        const px = ix + dx;
        const py = iy + dy;
        if (px >= 0 && px < bw && py >= 0 && py < bh) mask[py * bw + px] = 1;
      }
    }
  };
  for (const stroke of g.glyph.strokes) {
    for (let s = 0; s < stroke.length - 1; s++) {
      const [x0, y0] = stroke[s];
      const [x1, y1] = stroke[s + 1];
      const px0 = g.x + x0 * g.size;
      const py0 = g.y + y0 * g.size;
      const px1 = g.x + x1 * g.size;
      const py1 = g.y + y1 * g.size;
      const len = Math.hypot(px1 - px0, py1 - py0);
      const steps = Math.max(2, Math.ceil(len / 1.5));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        setPx(px0 + (px1 - px0) * t, py0 + (py1 - py0) * t);
      }
    }
  }
  return { mask, bw, bh, ox, oy };
}

export interface GenerateOptions {
  width: number;
  height?: number;
  seed?: number;
  /** 凹坑数量 */
  dents?: number;
  /** 是否生成铜锈反照率 */
  patina?: boolean;
}

export function generateHeightfield(opts: GenerateOptions): Heightfield {
  const W = opts.width;
  const H = opts.height ?? opts.width;
  const seed = opts.seed ?? 20260521;
  const rnd = mulberry32(seed);
  const noise = new ValueNoise(seed);
  const N = W * H;
  const h = new Float32Array(N);
  const cavity = new Float32Array(N);
  const s = Math.min(W, H);

  // 1) 低频起伏 + 中频纹理
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const nx = x / W;
      const ny = y / H;
      let v = 0;
      v += Math.sin(nx * 9.1 + 1.7) * Math.cos(ny * 7.7 + 0.4) * s * 0.0022;
      v += (noise.fbm(x * 0.006, y * 0.006, 4) - 0.5) * s * 0.006;
      v += (noise.fbm(x * 0.03, y * 0.03, 3) - 0.5) * s * 0.0016;
      h[i] = v;
    }
  }

  // 2) 凹坑/磕碰
  const dentCount = opts.dents ?? 52;
  for (let d = 0; d < dentCount; d++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const sigma = s * (0.006 + rnd() * 0.03);
    const depth = s * (0.003 + rnd() * 0.009) * (rnd() < 0.15 ? 2.2 : 1);
    const rad = Math.ceil(sigma * 3);
    const x0 = Math.max(0, Math.floor(cx - rad));
    const x1 = Math.min(W - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const y1 = Math.min(H - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dd = (x - cx) ** 2 + (y - cy) ** 2;
        const g = Math.exp(-dd / (2 * sigma * sigma));
        const i = y * W + x;
        h[i] -= depth * g;
        cavity[i] = Math.max(cavity[i], g * 0.5);
      }
    }
  }

  // 3) 刻字笔画
  const layout = defaultLayout(W, H);
  for (const g of layout) {
    const { mask, bw, bh, ox, oy } = rasterizeGlyphMask(g);
    const dist = chamferDistance(mask, bw, bh);
    for (let yy = 0; yy < bh; yy++) {
      const gy = oy + yy;
      if (gy < 0 || gy >= H) continue;
      for (let xx = 0; xx < bw; xx++) {
        const gx = ox + xx;
        if (gx < 0 || gx >= W) continue;
        const d = dist[yy * bw + xx];
        if (d >= g.halfWidth) continue;
        const t = d / g.halfWidth;
        const profile = Math.pow(Math.max(0, Math.cos((t * Math.PI) / 2)), 1.4);
        const i = gy * W + gx;
        h[i] -= g.depth * profile;
        cavity[i] = Math.max(cavity[i], profile * 0.62);
      }
    }
  }

  // 4) 细颗粒(很小,避免淹没真值)
  for (let i = 0; i < N; i++) {
    h[i] += (rnd() - 0.5) * s * 0.00045;
  }

  // 5) 真值法线 n=(-dh/dx, +dh/dy_row, 1)
  const normals = new Float32Array(N * 3);
  const at = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= W ? W - 1 : x;
    const cy = y < 0 ? 0 : y >= H ? H - 1 : y;
    return h[cy * W + cx];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      let nx = -gx;
      let ny = gy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i3 = (y * W + x) * 3;
      normals[i3] = nx;
      normals[i3 + 1] = ny;
      normals[i3 + 2] = nz;
    }
  }

  // 6) 青铜反照率 + 斑驳 + 孔雀绿锈
  const albedo = new Uint8ClampedArray(N * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const mott = noise.fbm(x * 0.012 + 40, y * 0.012 - 17, 4);
      const fine = noise.fbm(x * 0.09, y * 0.09, 2);
      const patinaMask = noise.fbm(x * 0.006 + 200, y * 0.006 + 99, 5);
      let r = 118 + (mott - 0.5) * 46 + (fine - 0.5) * 18;
      let g = 82 + (mott - 0.5) * 34 + (fine - 0.5) * 14;
      let b = 48 + (mott - 0.5) * 24 + (fine - 0.5) * 10;
      if (patinaMask > 0.62) {
        const t = Math.min(1, (patinaMask - 0.62) / 0.16);
        r = r * (1 - t) + 58 * t;
        g = g * (1 - t) + 116 * t;
        b = b * (1 - t) + 96 * t;
      }
      // 凹处积暗
      const ao = 1 - cavity[i] * 0.45;
      const i3 = i * 3;
      albedo[i3] = r * ao;
      albedo[i3 + 1] = g * ao;
      albedo[i3 + 2] = b * ao;
    }
  }

  return { width: W, height: H, h, normals, albedo, cavity };
}

/** 生成穹顶灯位:3 圈 ×16 盏,方位错开,全部 z>0 */
export function domeLights(count = 48, seed = 7): Vec3[] {
  const rings = [
    { elev: 24, n: Math.floor(count / 3), phase: 0 },
    { elev: 47, n: Math.floor(count / 3), phase: 0.35 },
    { elev: 70, n: count - 2 * Math.floor(count / 3), phase: 0.7 },
  ];
  const out: Vec3[] = [];
  for (const ring of rings) {
    const el = (ring.elev * Math.PI) / 180;
    const z = Math.sin(el);
    const rr = Math.cos(el);
    for (let i = 0; i < ring.n; i++) {
      const phi = ((i + ring.phase) / ring.n) * Math.PI * 2;
      out.push({ x: rr * Math.cos(phi), y: rr * Math.sin(phi), z });
    }
  }
  // 轻微确定性抖动,避免过度规则
  const rnd = mulberry32(seed);
  return out.map((l) => {
    const jx = (rnd() - 0.5) * 0.03;
    const jy = (rnd() - 0.5) * 0.03;
    const v = { x: l.x + jx, y: l.y + jy, z: l.z };
    const len = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  });
}
