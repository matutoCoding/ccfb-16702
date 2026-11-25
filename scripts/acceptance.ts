/**
 * 验收脚本(可在 Node 直接运行:npm run accept)
 * 1. 用带刻字/凹痕的高度场按已知灯位合成 48 张图
 * 2. CPU 参考实现拟合 PTM / HSH 并解法线
 * 3. 拟合法线 vs 真值法线,输出平均角度误差(验收线 < 3°)
 * 4. 顺带验证曝光异常检测
 *
 * 浏览器内 2000x2000 / 48 张的 GPU 性能基准在"设置 → 验收基准"里跑。
 */
import { generateHeightfield, domeLights } from '../src/core/synth/heightfield';
import { renderPhotos, meanLuma } from '../src/core/synth/render';
import { cpuFit, normalErrorStats } from '../src/core/fit/cpuFit';
import { detectExposureLightAware, exposureGains } from '../src/core/image/exposure';

function parseArgs() {
  const args = process.argv.slice(2);
  let size = 720;
  let photos = 48;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size') size = Number(args[++i]);
    if (args[i] === '--photos') photos = Number(args[++i]);
  }
  return { size, photos };
}

function fmtStats(name: string, s: ReturnType<typeof normalErrorStats>) {
  console.log(
    `  ${name}: 平均 ${s.meanDeg.toFixed(3)}° | 中位 ${s.medianDeg.toFixed(3)}° | P95 ${s.p95Deg.toFixed(3)}° | 最大 ${s.maxDeg.toFixed(2)}° (n=${s.count})`,
  );
}

async function main() {
  const { size, photos } = parseArgs();
  console.log(`\n=== RTI 拟合精度验收 ${size}x${size}, ${photos} 张 ===\n`);

  const t0 = Date.now();
  const hf = generateHeightfield({ width: size, height: size });
  const lights = domeLights(photos);
  console.log(`高度场+真值法线生成: ${Date.now() - t0} ms`);

  // ---- 干净灯组 ----
  let t = Date.now();
  const clean = renderPhotos(hf, lights, { seed: 1 });
  console.log(`合成 ${photos} 张照片: ${Date.now() - t} ms`);

  t = Date.now();
  const ptm = cpuFit(clean, size, size, lights as any, 'ptm');
  console.log(`PTM CPU 拟合: ${Date.now() - t} ms`);
  const ptmErr = normalErrorStats(ptm.normals, hf.normals, size, size);
  fmtStats('PTM 法线(干净)', ptmErr);

  t = Date.now();
  const hsh = cpuFit(clean, size, size, lights as any, 'hsh');
  console.log(`HSH CPU 拟合: ${Date.now() - t} ms`);
  const hshErr = normalErrorStats(hsh.normals, hf.normals, size, size);
  fmtStats('HSH 法线(干净)', hshErr);

  // ---- 带两张曝光异常的灯组,验证提示 + 校正后精度 ----
  const exposures = new Array(photos).fill(1);
  exposures[5] = 1.4;
  exposures[31] = 0.68;
  const stressed = renderPhotos(hf, lights, { exposures, seed: 1 });
  const lumas = stressed.map((p) => meanLuma(p, 2));
  const flags = detectExposureLightAware(lumas, lights as any);
  console.log(
    `\n曝光检测: 发现 ${flags.length} 张异常 -> ${flags
      .map((f) => `#${f.index}(${f.evDelta >= 0 ? '+' : ''}${f.evDelta.toFixed(2)}EV)`)
      .join(', ')}`,
  );

  // 仅对异常图做亮度拉齐
  const gains = new Float32Array(photos).fill(1);
  const allGains = exposureGains(lumas);
  for (const f of flags) gains[f.index] = allGains[f.index];
  const corrected = cpuFit(stressed, size, size, lights as any, 'ptm', gains);
  const correctedErr = normalErrorStats(corrected.normals, hf.normals, size, size);
  fmtStats('PTM 法线(曝光异常+校正)', correctedErr);

  // 不校正的对照
  const raw = cpuFit(stressed, size, size, lights as any, 'ptm');
  const rawErr = normalErrorStats(raw.normals, hf.normals, size, size);
  fmtStats('PTM 法线(曝光异常不校正)', rawErr);

  console.log('\n=== 结论 ===');
  const pass = ptmErr.meanDeg < 3 && hshErr.meanDeg < 3 && correctedErr.meanDeg < 3;
  console.log(
    `验收线: 平均角度误差 < 3° -> PTM ${ptmErr.meanDeg.toFixed(3)}°, HSH ${hshErr.meanDeg.toFixed(3)}°, 校正组 ${correctedErr.meanDeg.toFixed(3)}°`,
  );
  console.log(pass ? 'PASS ✅' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
