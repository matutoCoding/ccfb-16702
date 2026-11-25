/**
 * 纯 buffer 导出器自检(Node + tsx,不依赖 IndexedDB / DOM / WebGPU):
 *   npx tsx scripts/export-check.ts
 *
 * 覆盖:
 *  - buildPtmRgb: 头部文本/分行、scale/bias、总长度、按 (b-bias)*scale 解码精度、
 *    三通道块与 bottom-to-top 行序(首 6 字节 = 底行 y=h-1,x=0)。
 *  - buildRtiHsh: #HSH1.2 头、两段各 9 个 LE float32(A/B)、总长度、
 *    TOP-down + 通道块像素顺序,以及 c ≈ byte*A + 255*B 自洽解码。
 *
 * 退出码:全部通过 0,任一断言失败 1。
 */
import { buildPtmRgb, buildRtiHsh } from '../src/core/export/exporters';

const W = 4;
const H = 3;

// 确定性合成系数:可为负,用来真正考验 bias。
const coeffAt = (x: number, y: number, c: number): number =>
  x * 0.01 + y * 0.02 + c * 0.03 - 0.2;

let passes = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}${extra ? `  -- ${extra}` : ''}`);
  }
}

/** 返回第 n 个(从 1 开始)LF(0x0A)的下标;头结束位置 = 返回值 + 1。 */
function nthLf(buf: Uint8Array, n: number): number {
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/* ================================================================== */
/* PTM_1.2 / PTM_FORMAT_RGB                                            */
/* ================================================================== */

function checkPtm(): void {
  console.log('\n[PTM] buildPtmRgb(4x3, synthetic coeffAt)');
  const ptm = buildPtmRgb(W, H, coeffAt);

  const lf6 = nthLf(ptm, 6);
  check('header contains 6 LF terminators', lf6 >= 0);
  const headerEnd = lf6 + 1;
  const headerText = new TextDecoder().decode(ptm.subarray(0, headerEnd));

  console.log('  ---- PTM header (JSON-escaped) ----');
  console.log(`  ${JSON.stringify(headerText)}`);
  console.log('  ---- PTM header (rendered) ----');
  process_stdout(headerText);

  check(
    'startsWith PTM_1.2\\nPTM_FORMAT_RGB\\n4\\n3\\n',
    headerText.startsWith('PTM_1.2\nPTM_FORMAT_RGB\n4\n3\n'),
    JSON.stringify(headerText.slice(0, 48)),
  );
  check('no NUL inside header', !headerText.includes('\0'));

  const lines = headerText.split('\n');
  const scales = lines[4].trim().split(/\s+/).map(Number);
  const biases = lines[5].trim().split(/\s+/).map(Number);
  check('6 finite scales', scales.length === 6 && scales.every(Number.isFinite), lines[4]);
  check(
    '6 integer biases in [0,255]',
    biases.length === 6 &&
      biases.every((b) => Number.isInteger(b) && b >= 0 && b <= 255),
    lines[5],
  );
  console.log(`  scales = [${scales.map((s) => s.toFixed(6)).join(', ')}]`);
  console.log(`  biases = [${biases.join(', ')}]`);

  const expectedLen = headerEnd + 18 * W * H;
  check(
    `total length = headerLen(${headerEnd}) + 18*4*3 = ${expectedLen}`,
    ptm.length === expectedLen,
    `got ${ptm.length}`,
  );

  // 用头部 scale/bias 对全部 216 个系数量做解码核对。
  let maxErr = 0;
  for (let ch = 0; ch < 3; ch++) {
    for (let y = 0; y < H; y++) {
      const fileRow = H - 1 - y; // bottom-to-top
      for (let x = 0; x < W; x++) {
        for (let j = 0; j < 6; j++) {
          const idx = headerEnd + ch * (W * H * 6) + (fileRow * W + x) * 6 + j;
          const byte = ptm[idx];
          const decoded = (byte - biases[j]) * scales[j];
          const expected = coeffAt(x, y, ch * 6 + j) * 255;
          maxErr = Math.max(maxErr, Math.abs(decoded - expected));
        }
      }
    }
  }
  check(`every decoded coeff within 1.5 C255 (maxErr=${maxErr.toFixed(3)})`, maxErr <= 1.5);

  // 首个 R 块的前 6 字节必须是图像底行 y=H-1,x=0。
  let maxBottomErr = 0;
  let minTopGap = Infinity;
  for (let j = 0; j < 6; j++) {
    const idx = headerEnd + j;
    const decoded = (ptm[idx] - biases[j]) * scales[j];
    const bottom = coeffAt(0, H - 1, j) * 255;
    const top = coeffAt(0, 0, j) * 255;
    maxBottomErr = Math.max(maxBottomErr, Math.abs(decoded - bottom));
    minTopGap = Math.min(minTopGap, Math.abs(decoded - top));
  }
  check(`first 6 R bytes == bottom row y=${H - 1},x=0 (err=${maxBottomErr.toFixed(3)})`, maxBottomErr <= 1.5);
  check('first 6 R bytes are NOT top row (proves Y flip)', minTopGap > 2, `topGap=${minTopGap.toFixed(3)}`);
}

/* ================================================================== */
/* #HSH1.2 universal RTI                                               */
/* ================================================================== */

function checkRti(): void {
  console.log('\n[RTI] buildRtiHsh(4x3, synthetic coeffAt)');
  const rti = buildRtiHsh(W, H, coeffAt);

  const lf4 = nthLf(rti, 4);
  check('header contains 4 LF terminators', lf4 >= 0);
  const headerEnd = lf4 + 1;
  const headerText = new TextDecoder().decode(rti.subarray(0, headerEnd));

  console.log('  ---- RTI header (JSON-escaped) ----');
  console.log(`  ${JSON.stringify(headerText)}`);
  console.log('  ---- RTI header (rendered) ----');
  process_stdout(headerText);

  check(
    'magic + version + dims + basis line',
    headerText.startsWith('#HSH1.2\n3\n4 3 3\n9 2 1\n'),
    JSON.stringify(headerText),
  );

  const expectedLen = headerEnd + 2 * 9 * 4 + 27 * W * H;
  check(
    `total length = headerLen(${headerEnd}) + 2*9*4 + 27*4*3 = ${expectedLen}`,
    rti.length === expectedLen,
    `got ${rti.length}`,
  );

  // 独立计算每术语全局 min/max(原始归一化量纲)。
  const mn = new Array<number>(9).fill(Infinity);
  const mx = new Array<number>(9).fill(-Infinity);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 27; c++) {
        const j = c % 9;
        const v = coeffAt(x, y, c);
        if (v < mn[j]) mn[j] = v;
        if (v > mx[j]) mx[j] = v;
      }
    }
  }

  const view = new DataView(rti.buffer, rti.byteOffset, rti.byteLength);
  const A: number[] = [];
  const B: number[] = [];
  for (let j = 0; j < 9; j++) {
    A.push(view.getFloat32(headerEnd + j * 4, true));
    B.push(view.getFloat32(headerEnd + 36 + j * 4, true));
  }
  console.log(`  A(gscale) = [${A.map((v) => v.toFixed(6)).join(', ')}]`);
  console.log(`  B(gbias)  = [${B.map((v) => v.toFixed(7)).join(', ')}]`);

  let floatOk = true;
  let floatWorst = 0;
  for (let j = 0; j < 9; j++) {
    const range = mx[j] - mn[j];
    const expA = range / 255;
    const expB = mn[j] / 255;
    floatWorst = Math.max(floatWorst, Math.abs(A[j] - expA), Math.abs(B[j] - expB));
    if (!approx(A[j], expA, 1e-6) || !approx(B[j], expB, 1e-6)) floatOk = false;
  }
  check(`LE float32 A=(mx-mn)/255 and B=mn/255 (worstDiff=${floatWorst.toExponential(2)})`, floatOk);

  // 全部 324 个像素系数:c ≈ byte*A + 255*B(Material::Plane 解码)。
  const pixelOffset = headerEnd + 72;
  let maxCoeffErr = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 27; c++) {
        const idx = pixelOffset + (y * W + x) * 27 + c;
        const byte = rti[idx];
        const j = c % 9;
        const decoded = byte * A[j] + 255 * B[j];
        maxCoeffErr = Math.max(maxCoeffErr, Math.abs(decoded - coeffAt(x, y, c)));
      }
    }
  }
  check(`every HSH coeff round-trips within 0.02 (maxErr=${maxCoeffErr.toFixed(5)})`, maxCoeffErr <= 0.02);

  // TOP-down:像素段前 27 字节对应 y=0,x=0,而不是底行。
  let maxTopErr = 0;
  let minBottomGap = Infinity;
  for (let c = 0; c < 27; c++) {
    const byte = rti[pixelOffset + c];
    const j = c % 9;
    const decoded = byte * A[j] + 255 * B[j];
    maxTopErr = Math.max(maxTopErr, Math.abs(decoded - coeffAt(0, 0, c)));
    minBottomGap = Math.min(minBottomGap, Math.abs(decoded - coeffAt(0, H - 1, c)));
  }
  check(`first pixel == TOP row y=0,x=0 (err=${maxTopErr.toFixed(5)})`, maxTopErr <= 0.02);
  check('first pixel is NOT bottom row (TOP-down order)', minBottomGap > 0.01, `gap=${minBottomGap.toFixed(4)}`);

  // 通道块顺序的两个锚点:G term0 在 +9,B term0 在 +18。
  const g0 = rti[pixelOffset + 9] * A[0] + 255 * B[0];
  const b0 = rti[pixelOffset + 18] * A[0] + 255 * B[0];
  check('channel-block anchors G0@+9, B0@+18', approx(g0, coeffAt(0, 0, 9), 0.02) && approx(b0, coeffAt(0, 0, 18), 0.02));
}

/** 原样输出多行头(避免依赖 node 类型的 process.stdout.write 签名)。 */
function process_stdout(text: string): void {
  // console.log 已足够;单独函数仅为让上面的 “rendered header” 语义清晰。
  for (const line of text.split('\n')) {
    if (line.length > 0) console.log(`    | ${line}`);
  }
}

function finish(): void {
  console.log(
    `\n=== export-check: ${passes} passed, ${failures.length} failed ===`,
  );
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f}`);
  }

  // 无 @types/node:经 globalThis 结构化取 process,避免 tsc 报 Cannot find name 'process'。
  const proc = (
    globalThis as unknown as { process?: { exit?: (code: number) => void } }
  ).process;
  const code = failures.length === 0 ? 0 : 1;
  if (proc && typeof proc.exit === 'function') {
    // 稍延迟退出,给 stdout 管道刷新时间,避免最后几行被截断。
    setTimeout(() => {
      try {
        proc.exit?.(code);
      } catch {
        /* ignore */
      }
    }, 50);
  } else if (code !== 0) {
    throw new Error(`export-check failed: ${failures.length} assertion(s)`);
  }
}

checkPtm();
checkRti();
finish();
