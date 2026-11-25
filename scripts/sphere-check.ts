/**
 * 黑球 + 高光 + 光源方向反算自检:
 *   npx tsx scripts/sphere-check.ts
 *
 * 合成 400x400:中灰背景 120、圆心 (200,190) r=70 的黑色圆盘、
 * 在 (235,165) 的白色径向高光团,以及几颗盐噪声。验证:
 *   圆心 <=3px、半径 <=4px、高光 <=4px、光源方向与公式期望夹角 <=2°;
 *   并手工验证 lightFromHighlight 的正顶/正右情形。
 */
import {
  detectBlackSphere,
  detectHighlight,
  lightFromHighlight,
} from '../src/core/calib/sphereDetect';

const W = 400;
const H = 400;
const CX = 200;
const CY = 190;
const R = 70;
const HX = 235;
const HY = 165;

function buildImage(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  const SIGMA = 11;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      // 背景 120
      let r = 120;
      let g = 120;
      let b = 120;

      // 黑色圆盘,1px 线性抗锯齿边缘
      const d = Math.hypot(x - CX + 0.0, y - CY + 0.0);
      const cov = Math.max(0, Math.min(1, R + 0.5 - d));
      const sphereV = 10;
      r = r * (1 - cov) + sphereV * cov;
      g = g * (1 - cov) + sphereV * cov;
      b = b * (1 - cov) + sphereV * cov;

      // 白色径向高光团
      const dh = Math.hypot(x - HX, y - HY);
      if (dh < SIGMA * 3) {
        let a = Math.exp(-(dh * dh) / (2 * SIGMA * SIGMA)) * 1.15;
        a = Math.max(0, Math.min(1, a));
        r = r * (1 - a) + 255 * a;
        g = g * (1 - a) + 255 * a;
        b = b * (1 - a) + 255 * a;
      }

      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    }
  }
  // 盐噪声:两颗孤立纯白点(球内),应被“>=2 像素连通块”规则忽略
  const salt = (x: number, y: number): void => {
    const p = (y * W + x) * 4;
    rgba[p] = 255;
    rgba[p + 1] = 255;
    rgba[p + 2] = 255;
  };
  salt(160, 225);
  salt(252, 222);
  // 背景上一颗噪声
  salt(330, 120);
  return rgba;
}

function angleDeg(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
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

  console.log('\n=== sphere-check (400x400) ===\n');
  const rgba = buildImage();

  let t0 = Date.now();
  const circle = detectBlackSphere(rgba, W, H);
  const tSphere = Date.now() - t0;
  console.log(`detectBlackSphere 耗时 ${tSphere} ms ->`, circle);

  check(circle !== null, '检测到黑球');
  if (!circle) throw new Error('未检测到黑球,后续用例无法继续');

  check(Math.abs(circle.cx - CX) <= 3, `圆心 cx 误差 <=3(得到 ${circle.cx.toFixed(2)}, 期望 ${CX})`);
  check(Math.abs(circle.cy - CY) <= 3, `圆心 cy 误差 <=3(得到 ${circle.cy.toFixed(2)}, 期望 ${CY})`);
  check(Math.abs(circle.radius - R) <= 4, `半径误差 <=4(得到 ${circle.radius.toFixed(2)}, 期望 ${R})`);
  check(circle.score > 0.4, `圆形置信度合理 score=${circle.score.toFixed(3)}`);

  t0 = Date.now();
  const hp = detectHighlight(rgba, W, H, circle);
  const tHp = Date.now() - t0;
  console.log(`detectHighlight 耗时 ${tHp} ms ->`, hp);
  check(hp !== null, '检测到高光');
  if (!hp) throw new Error('未检测到高光');

  check(Math.abs(hp.x - HX) <= 4, `高光 x 误差 <=4(得到 ${hp.x.toFixed(2)}, 期望 ${HX})`);
  check(Math.abs(hp.y - HY) <= 4, `高光 y 误差 <=4(得到 ${hp.y.toFixed(2)}, 期望 ${HY})`);

  // 端到端光源方向 vs 由真值坐标按同一公式得到的期望向量
  const lightGot = lightFromHighlight(circle.cx, circle.cy, circle.radius, hp.x, hp.y);
  const lightExpected = lightFromHighlight(CX, CY, R, HX, HY);
  const ang = angleDeg(lightGot, lightExpected);
  console.log(
    `  light got=(${lightGot.x.toFixed(4)},${lightGot.y.toFixed(4)},${lightGot.z.toFixed(
      4,
    )}) expected=(${lightExpected.x.toFixed(4)},${lightExpected.y.toFixed(
      4,
    )},${lightExpected.z.toFixed(4)}) angle=${ang.toFixed(3)}°`,
  );
  check(ang <= 2, `端到端光源方向与公式期望夹角 <=2°(实际 ${ang.toFixed(3)}°)`);

  // 隔离高光位置误差的方向精度:用真值球心 + 检测高光
  const lightHpOnly = lightFromHighlight(CX, CY, R, hp.x, hp.y);
  const angHp = angleDeg(lightHpOnly, lightExpected);
  check(angHp <= 2, `仅高光误差导致的方向偏差 <=2°(实际 ${angHp.toFixed(3)}°)`);

  // ---------- 手工公式用例 ----------
  console.log('\n  -- lightFromHighlight 解析用例 --');
  const center = lightFromHighlight(0, 0, 10, 0, 0);
  check(
    Math.abs(center.x) < 1e-9 && Math.abs(center.y) < 1e-9 && Math.abs(center.z - 1) < 1e-9,
    `球心高光 -> L=(0,0,1)(得到 ${center.x},${center.y},${center.z})`,
  );

  const right = lightFromHighlight(0, 0, 10, 10 / Math.SQRT2, 0);
  check(
    Math.abs(right.x - 1) < 1e-6 && Math.abs(right.y) < 1e-6 && Math.abs(right.z) < 1e-6,
    `正右 r/sqrt2 -> L≈(1,0,0)(得到 ${right.x.toFixed(6)},${right.y.toFixed(6)},${right.z.toFixed(6)})`,
  );

  const below = lightFromHighlight(0, 0, 10, 0, 10 / Math.SQRT2);
  check(
    Math.abs(below.x) < 1e-6 && below.y < -0.999 && Math.abs(below.z) < 1e-6,
    `图像正下 r/sqrt2 -> 世界 L≈(0,-1,0) 验证 y-down 翻号(得到 y=${below.y.toFixed(4)})`,
  );

  // ---------- 负例:均匀亮图不应报球 ----------
  const flat = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    flat[i * 4] = 200;
    flat[i * 4 + 1] = 200;
    flat[i * 4 + 2] = 200;
    flat[i * 4 + 3] = 255;
  }
  check(detectBlackSphere(flat, W, H) === null, '均匀亮背景返回 null');

  console.log(
    `\n${failures.length === 0 ? 'ALL SPHERE CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}\n`,
  );
  if (failures.length > 0) throw new Error(`sphere-check failed: ${failures.length} assertion(s)`);
}

main();
