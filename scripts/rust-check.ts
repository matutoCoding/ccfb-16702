/**
 * 锈蚀变化分析自检:
 *   npx tsx scripts/rust-check.ts
 *
 * 合成两张对齐的 200x200 深青铜底图(B 相对 A 有轻微曝光差异与独立噪声),
 * 仅在 B 上绘制两个橙红锈斑 + 一个绿色铜绿斑,验证:
 *   1) 至少检出 2 个连通区域;
 *   2) changedPixels > 100;
 *   3) 噪声底不产生大面积误报;
 *   4) mmPerPixel 会换算出 areaMm2。
 *
 * 失败时 throw(tsx 进程非零退出);不使用 process / node 类型。
 */
import { computeRustChanges, __test } from '../src/core/analysis/rustCompare';
import type { RgbaImage } from '../src/core/analysis/rustCompare';

const W = 200;
const H = 200;

/** 确定性 PRNG,保证自检可重复 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeImage(): RgbaImage {
  return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
}

function paintBase(img: RgbaImage, rnd: () => number, gain: number): void {
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      // 深青铜底色 + 缓慢明暗起伏 + 颗粒噪声
      const grad = 6 * Math.sin(x / 23) + 5 * Math.cos(y / 29);
      const n = (rnd() - 0.5) * 13;
      const base = 58 + grad + n;
      d[p] = Math.max(0, Math.min(255, (base + 16) * gain)); // r 略高,青铜暖底
      d[p + 1] = Math.max(0, Math.min(255, (base + 2) * gain));
      d[p + 2] = Math.max(0, Math.min(255, (base - 14) * gain));
      d[p + 3] = 255;
    }
  }
}

/** 软边色斑:按到圆心距离做 smoothstep 混合 */
function paintBlob(
  img: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number],
): void {
  const d = img.data;
  const rOut = radius + 5;
  for (let y = Math.max(0, cy - rOut); y <= Math.min(H - 1, cy + rOut); y++) {
    for (let x = Math.max(0, cx - rOut); x <= Math.min(W - 1, cx + rOut); x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > rOut) continue;
      let t = Math.max(0, Math.min(1, (rOut - dist) / 6));
      t = t * t * (3 - 2 * t); // smoothstep
      const p = (y * W + x) * 4;
      d[p] = d[p] * (1 - t) + color[0] * t;
      d[p + 1] = d[p + 1] * (1 - t) + color[1] * t;
      d[p + 2] = d[p + 2] * (1 - t) + color[2] * t;
    }
  }
}

function main(): void {
  const rndA = mulberry32(20240521);
  const rndB = mulberry32(987654321);

  const a = makeImage();
  const b = makeImage();
  paintBase(a, rndA, 1.0);
  // B 轻微欠曝一点点,靠中位数归一化抵消;噪声独立
  paintBase(b, rndB, 0.94);

  // 两个橙红新锈斑 + 一个绿色铜绿斑,只画在 B
  paintBlob(b, 58, 66, 15, [214, 86, 32]);
  paintBlob(b, 148, 138, 12, [226, 102, 38]);
  paintBlob(b, 132, 58, 14, [64, 168, 108]);

  const res = computeRustChanges(a, b, { mmPerPixel: 0.1 });

  console.log('threshold =', __test.DEFAULT_THRESHOLD);
  console.log('changedPixels =', res.changedPixels);
  console.log('regions =', res.regions.length);
  for (const r of res.regions) {
    console.log(
      `  # bbox=(${r.x},${r.y},${r.w}x${r.h}) px=${r.pixels} meanDelta=${r.meanDelta.toFixed(3)} areaMm2=${r.areaMm2?.toFixed(2)}`,
    );
  }

  if (res.width !== W || res.height !== H) throw new Error('结果尺寸不正确');
  if (res.regions.length < 2) {
    throw new Error(`期望至少 2 个区域,实际 ${res.regions.length}`);
  }
  if (res.changedPixels <= 100) {
    throw new Error(`期望 changedPixels > 100,实际 ${res.changedPixels}`);
  }

  // 三个斑都应被抓到(允许两个橙斑中任一与绿斑等合并,但最大几个域应覆盖三个中心)
  const centers = [
    { x: 58, y: 66, name: '橙锈1' },
    { x: 148, y: 138, name: '橙锈2' },
    { x: 132, y: 58, name: '绿铜绿' },
  ];
  for (const c of centers) {
    const hit = res.regions.some(
      (r) =>
        c.x >= r.x - 3 &&
        c.x <= r.x + r.w + 3 &&
        c.y >= r.y - 3 &&
        c.y <= r.y + r.h + 3,
    );
    if (!hit) throw new Error(`${c.name} 中心未被任何区域覆盖`);
  }

  // mmPerPixel=0.1 → 每像素 0.01 mm²
  const first = res.regions[0];
  if (!first.areaMm2 || Math.abs(first.areaMm2 - first.pixels * 0.01) > 1e-9) {
    throw new Error('areaMm2 换算不正确');
  }

  // 噪声误报率 sanity:掩膜像素占比不应超过 8%(明显斑块合计约千余像素 / 4 万)
  const ratio = res.changedPixels / (W * H);
  console.log('mask ratio =', ratio.toFixed(4));
  if (ratio > 0.08) throw new Error(`误报面积过大:${(ratio * 100).toFixed(2)}%`);

  // 无变化对照:同一张图与自身比较应当 0 区域
  const same = computeRustChanges(a, a);
  console.log('self-compare changedPixels =', same.changedPixels, 'regions =', same.regions.length);
  if (same.changedPixels !== 0 || same.regions.length !== 0) {
    throw new Error('自比较应当没有变化区域');
  }

  console.log('RUST-CHECK OK');
}

main();
