/**
 * 对齐模块自检:
 *   npx tsx scripts/alignment-check.ts
 *
 * 验证 estimateAlignments 的符号、精度、鲁棒性与性能。
 *
 * 符号核对(见 src/core/image/alignment.ts 顶部):
 *   renderPhotos: out(x) = field(x + sx),故 field(u) = out(u - sx)。
 *   本模块逆映射: aligned(u) = img(u - shiftX)。
 *   参考为 R 时,期望 shift_i = renderShift_i - renderShift_R。
 *
 * 关于 renderPhotos 的一个实现细节(已读 src/core/synth/render.ts 确认):
 *   shifts 只平移了反照率采样 si=(y*W + x+sx)*3,而法线/明暗 ni 仍按输出坐标
 *   (y*W+x)*3 采样。因此在默认强穹顶光(ambient .17 / kd .92)下,平移的反照率
 *   与不动的明暗/刻槽法线互相冲突,不构成严格的全局平移,任何纯平移配准都无法
 *   唯一恢复该 shift。故下面的 renderPhotos-shift 用例采用高环境光、弱方向漫反射,
 *   让 shifts 等价于真正的图像平移;另外再用“整图整体平移”块验证强跨光照鲁棒性。
 */
import { generateHeightfield, domeLights } from '../src/core/synth/heightfield';
import { renderPhotos } from '../src/core/synth/render';
import { estimateAlignments, type RgbaImageLike } from '../src/core/image/alignment';

const SIZE = 360;
const COUNT = 12;

// 已知渲染采样偏移(输出像素 x 读高度场 x+s)
const renderShifts = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: -4, y: 2 },
  { x: 5, y: -3 },
  { x: -6, y: -4 },
  { x: 7, y: 5 },
  { x: 2, y: 6 },
  { x: -3, y: -6 },
  { x: 8, y: 3 },
  { x: -8, y: -2 },
  { x: 4, y: -7 },
  { x: -5, y: 7 },
];

const lumaAt = (d: ArrayLike<number> | Uint8Array | Uint8ClampedArray, i: number): number =>
  0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** 全分辨率重叠区原始亮度 MAD:比较 ref(x,y) 与 img(x-sx,y-sy) */
function residualMad(
  ref: RgbaImageLike,
  img: RgbaImageLike,
  sx: number,
  sy: number,
): number {
  const w = Math.min(ref.width, img.width);
  const h = Math.min(ref.height, img.height);
  const x0 = Math.max(0, sx);
  const x1 = Math.min(w, w + sx);
  const y0 = Math.max(0, sy);
  const y1 = Math.min(h, h + sy);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ri = (y * ref.width + x) * 4;
      const ii = ((y - sy) * img.width + (x - sx)) * 4;
      sum += Math.abs(lumaAt(ref.data, ri) - lumaAt(img.data, ii));
      n++;
    }
  }
  return n > 0 ? sum / n : Number.POSITIVE_INFINITY;
}

/** 整图循环平移:输出 (x,y) = 源 (x+dx, y+dy) wrap,与 renderPhotos 采样语义同号 */
function wrapTranslate(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    const sy = (((y + dy) % h) + h) % h;
    for (let x = 0; x < w; x++) {
      const sx = (((x + dx) % w) + w) % w;
      const si = (sy * w + sx) * 4;
      const oi = (y * w + x) * 4;
      out[oi] = src[si];
      out[oi + 1] = src[si + 1];
      out[oi + 2] = src[si + 2];
      out[oi + 3] = src[si + 3];
    }
  }
  return out;
}

function maxRecoveryError(
  res: ReturnType<typeof estimateAlignments>,
  expected: { x: number; y: number }[],
  refIndex: number,
): number {
  let maxErr = 0;
  for (const r of res) {
    const ex = expected[r.index].x - expected[refIndex].x;
    const ey = expected[r.index].y - expected[refIndex].y;
    maxErr = Math.max(maxErr, Math.abs(r.shiftX - ex), Math.abs(r.shiftY - ey));
  }
  return maxErr;
}

function main(): void {
  const failures: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (cond) console.log(`  PASS  ${msg}`);
    else {
      console.error(`  FAIL  ${msg}`);
      failures.push(msg);
    }
  };

  console.log(`\n=== alignment-check: ${COUNT} photos @ ${SIZE}x${SIZE} ===\n`);

  const tGen = Date.now();
  const hf = generateHeightfield({ width: SIZE, height: SIZE, seed: 20260521 });
  const lights = domeLights(COUNT);
  // 高环境光 + 弱方向漫反射 + 无镜面:规避 renderPhotos 不平移法线的问题,
  // 让 opts.shifts 产生严格的(反照率)整数平移。
  const photos = renderPhotos(hf, lights, {
    shifts: renderShifts,
    seed: 7,
    ambient: 0.86,
    kd: 0.16,
    ks: 0,
  });
  const images: RgbaImageLike[] = photos.map((data) => ({ data, width: SIZE, height: SIZE }));
  console.log(`生成高度场+渲染 ${COUNT} 张(弱方向光): ${Date.now() - tGen} ms`);

  // ---------- A) 默认 refIndex=0:恢复 renderPhotos 采样偏移 ----------
  console.log('\n[A] renderPhotos shifts, refIndex = 0');
  let t0 = Date.now();
  const res0 = estimateAlignments(images);
  const dt0 = Date.now() - t0;
  console.log(`estimateAlignments 耗时: ${dt0} ms(平均 ${(dt0 / COUNT).toFixed(1)} ms/张)`);
  check(res0.length === COUNT, `返回 ${COUNT} 条结果(实际 ${res0.length})`);

  let maxErr = 0;
  for (const r of res0) {
    const ex = renderShifts[r.index].x;
    const ey = renderShifts[r.index].y;
    const err = Math.max(Math.abs(r.shiftX - ex), Math.abs(r.shiftY - ey));
    maxErr = Math.max(maxErr, err);
    if (r.index === 0) continue;

    const baseMad = residualMad(images[0], images[r.index], 0, 0);
    const alignedMad = residualMad(images[0], images[r.index], r.shiftX, r.shiftY);
    const truthMad = residualMad(images[0], images[r.index], ex, ey);

    let neighborMin = Number.POSITIVE_INFINITY;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        neighborMin = Math.min(
          neighborMin,
          residualMad(images[0], images[r.index], r.shiftX + dx, r.shiftY + dy),
        );
      }
    }
    const improved = alignedMad < baseMad * 0.9;
    const nearTruth = alignedMad <= truthMad + 0.6;
    const localBest = alignedMad <= neighborMin + 0.5;

    console.log(
      `  #${String(r.index).padStart(2)} got=(${String(r.shiftX).padStart(3)},${String(
        r.shiftY,
      ).padStart(3)}) exp=(${String(ex).padStart(3)},${String(ey).padStart(3)}) err=${err} ` +
        `score=${r.score.toFixed(4)} MAD base=${baseMad.toFixed(2)} aligned=${alignedMad.toFixed(
          2,
        )} truth=${truthMad.toFixed(2)}`,
    );
    check(err <= 1, `#${r.index} 恢复采样偏移 within 1px(err=${err})`);
    check(improved, `#${r.index} x-shift 逆映射后 MAD 下降(${baseMad.toFixed(1)} -> ${alignedMad.toFixed(1)})`);
    check(nearTruth, `#${r.index} 对齐残差不高于真值偏移(${alignedMad.toFixed(2)} vs ${truthMad.toFixed(2)})`);
    check(localBest, `#${r.index} 返回偏移为 ±1 局部最优`);
  }
  check(maxErr <= 1, `A 组最大误差 <=1px(实际 ${maxErr})`);
  check(res0[0].shiftX === 0 && res0[0].shiftY === 0, '参考图偏移为 (0,0)');
  check(res0.every((r) => r.score >= 0 && r.score <= 1), '所有 score 落在 [0,1]');

  // ---------- B) 非零 refIndex,参考本身 shift 非零:验证相对符号 ----------
  const refIndex = 4;
  console.log(`\n[B] refIndex = ${refIndex}(其 render shift 非零)`);
  const resB = estimateAlignments(images, { refIndex });
  const errB = maxRecoveryError(resB, renderShifts, refIndex);
  for (const r of resB) {
    const ex = renderShifts[r.index].x - renderShifts[refIndex].x;
    const ey = renderShifts[r.index].y - renderShifts[refIndex].y;
    const e = Math.max(Math.abs(r.shiftX - ex), Math.abs(r.shiftY - ey));
    if (e > 1)
      console.error(`  FAIL #${r.index} got=(${r.shiftX},${r.shiftY}) expected=(${ex},${ey})`);
  }
  check(errB <= 1, `非零 refIndex 相对偏移全部 within 1px(maxErr=${errB})`);
  check(
    resB[refIndex].shiftX === 0 && resB[refIndex].shiftY === 0,
    `refIndex=${refIndex} 自身偏移为 (0,0)`,
  );

  // ---------- C) maxShift 约束 ----------
  console.log('\n[C] maxShift = 10');
  const resC = estimateAlignments(images, { maxShift: 10 });
  const cBad = resC.filter((r) => Math.abs(r.shiftX) > 10 || Math.abs(r.shiftY) > 10);
  check(cBad.length === 0, '所有结果满足 |shift| <= maxShift');
  const cErr = maxRecoveryError(resC, renderShifts, 0);
  check(cErr <= 1, `maxShift=10 下仍 within 1px(maxErr=${cErr})`);

  // ---------- D) 强穹顶跨光照 + 整图整体平移(真·平移,最接近实拍) ----------
  console.log('\n[D] 强穹顶跨光照 + 整图整体 wrap 平移(12 张不同灯位)');
  const dramatic = renderPhotos(hf, lights, { seed: 11 }); // 默认强方向光
  const wrapped = dramatic.map((p, i) => wrapTranslate(p, SIZE, SIZE, renderShifts[i].x, renderShifts[i].y));
  const wrapImages: RgbaImageLike[] = wrapped.map((data) => ({ data, width: SIZE, height: SIZE }));
  t0 = Date.now();
  const resD = estimateAlignments(wrapImages);
  console.log(`耗时 ${Date.now() - t0} ms`);
  const errD = maxRecoveryError(resD, renderShifts, 0);
  for (const r of resD) {
    const e = Math.max(
      Math.abs(r.shiftX - renderShifts[r.index].x),
      Math.abs(r.shiftY - renderShifts[r.index].y),
    );
    if (e > 1)
      console.error(
        `  FAIL #${r.index} got=(${r.shiftX},${r.shiftY}) exp=(${renderShifts[r.index].x},${renderShifts[r.index].y})`,
      );
  }
  check(errD <= 1, `跨光照整体平移全部 within 1px(maxErr=${errD})`);

  // ---------- E) 2000x2000 性能/精度(程序化高频纹理 + 整图平移) ----------
  console.log('\n[E] 2000x2000 程序化纹理性能');
  const BIG = 2000;
  const bigBase = new Uint8ClampedArray(BIG * BIG * 4);
  let seed = 123456789;
  const rnd = (): number => {
    // xorshift32,确定性、快
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let y = 0; y < BIG; y++) {
    for (let x = 0; x < BIG; x++) {
      const p = (y * BIG + x) * 4;
      // 低频团块 + 高频颗粒 + 一些直线结构,保证有足够可配准特征
      const blob =
        40 * Math.sin(x * 0.011) * Math.cos(y * 0.013) +
        30 * Math.sin((x + y) * 0.02) +
        22 * Math.sin(x * 0.05) * Math.sin(y * 0.043);
      const grain = (rnd() - 0.5) * 46;
      const stripe = ((x >> 4) % 7 === 0 || (y >> 5) % 11 === 0) ? -34 : 0;
      const v = Math.max(0, Math.min(255, 128 + blob + grain + stripe));
      bigBase[p] = v;
      bigBase[p + 1] = v * 0.92;
      bigBase[p + 2] = v * 0.8;
      bigBase[p + 3] = 255;
    }
  }
  const bigShifts = [
    { x: 0, y: 0 },
    { x: 11, y: -7 },
    { x: -14, y: 9 },
    { x: 18, y: 13 },
    { x: -9, y: -16 },
    { x: 6, y: 19 },
  ];
  const bigImages: RgbaImageLike[] = bigShifts.map((s) => ({
    data: s.x === 0 && s.y === 0 ? bigBase : wrapTranslate(bigBase, BIG, BIG, s.x, s.y),
    width: BIG,
    height: BIG,
  }));
  // 预热一次(不计入)?直接计时整组
  t0 = Date.now();
  const resE = estimateAlignments(bigImages);
  const bigMs = Date.now() - t0;
  const errE = maxRecoveryError(resE, bigShifts, 0);
  console.log(
    `6 张 ${BIG}x${BIG} 总耗时 ${bigMs} ms,平均 ${(bigMs / bigShifts.length).toFixed(0)} ms/张, maxErr=${errE}`,
  );
  check(errE <= 1, `2000px 程序化纹理恢复 within 1px(maxErr=${errE})`);
  check(bigMs / bigShifts.length < 4000, `单张 2000px 对齐 < 4s(实际 ${(bigMs / bigShifts.length).toFixed(0)}ms)`);

  console.log(
    `\n${failures.length === 0 ? 'ALL ALIGNMENT CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}\n`,
  );
  if (failures.length > 0) throw new Error(`alignment-check failed: ${failures.length} assertion(s)`);
}

main();
