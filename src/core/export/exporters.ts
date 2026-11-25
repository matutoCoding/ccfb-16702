/**
 * 标准 RTI / PTM 文件导出器。
 *
 *  - exportPTM:  经典 PTM_1.2 / PTM_FORMAT_RGB(.ptm),每术语全局共享 scale/bias。
 *  - exportRTI:  Relight universal `#HSH1.2`(.rti),9 个全局 float scale + 9 个 float bias。
 *
 * 另导出两个不依赖 IndexedDB / DOM 的纯 buffer 构造器,供 node + tsx 自检:
 * buildPtmRgb / buildRtiHsh 只通过 coeffAt 回调取系数。
 *
 * 系数布局(与 cpuFit.ts / fitShader.ts 的 outCoeff[p*K + ch*k + term] 一致):
 *   c = channel * termsPerChannel + term
 *   PTM k=6: R 0..5, G 6..11, B 12..17
 *   HSH k=9: R 0..8, G 9..17, B 18..26
 * 系数为 gamma 域归一化值(约 0..1,允许略超/为负)。
 */
import { HSH_TERMS, PTM_TERMS } from '../math/basis';
import { loadResultData } from '../result/resultReader';
import type { ResultRecord } from '../types';

const CHANNELS = 3;
const PTM_COEFF_COUNT = PTM_TERMS * CHANNELS; // 18
const HSH_COEFF_COUNT = HSH_TERMS * CHANNELS; // 27

/** 小于该量纲范围即视为“平项”,避免 -mn/range 除零产生 Infinity/NaN。 */
const FLAT_RANGE_EPS = 1e-9;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 对应 byte = clamp(round(v), 0, 255)。 */
function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

function isFlat(range: number): boolean {
  return !(range > FLAT_RANGE_EPS);
}

/**
 * PTM 头部使用的每术语(三通道共享)scale / 整数 bias。
 * 入参 mn/mx 已经是传统 C255 量纲(coeff * 255)。
 *   scale = (mx-mn)/255
 *   bias  = clamp(round(-255*mn/(mx-mn)), 0, 255)
 * 解码:C255 = (unsignedByte - bias) * scale。
 */
function ptmScaleBias(mn: ArrayLike<number>, mx: ArrayLike<number>): {
  scale: number[];
  bias: number[];
} {
  const n = mn.length;
  const scale = new Array<number>(n);
  const bias = new Array<number>(n);
  for (let j = 0; j < n; j++) {
    const range = mx[j] - mn[j];
    scale[j] = range / 255;
    bias[j] = isFlat(range)
      ? 0
      : Math.max(0, Math.min(255, Math.round((-255 * mn[j]) / range)));
  }
  return { scale, bias };
}

function ptmHeaderBytes(
  width: number,
  height: number,
  scale: ArrayLike<number>,
  bias: ArrayLike<number>,
): Uint8Array {
  // width / height 各自单独一行;scale 6 个浮点、bias 6 个整数,空格分隔、无行尾空格。
  const biasInts: string[] = [];
  for (let i = 0; i < bias.length; i++) biasInts.push(String(Math.round(bias[i])));
  const scaleStrs: string[] = [];
  for (let i = 0; i < scale.length; i++) scaleStrs.push(String(scale[i]));

  const text =
    `PTM_1.2\n` +
    `PTM_FORMAT_RGB\n` +
    `${width}\n` +
    `${height}\n` +
    `${scaleStrs.join(' ')}\n` +
    `${biasInts.join(' ')}\n`; // 最后一个 LF 之后立即是二进制,无 NUL。
  return new TextEncoder().encode(text);
}

/** 分配 PTM 文件并写入 ASCII 头,返回整块 buffer 与二进制起始偏移。 */
function allocPtm(
  width: number,
  height: number,
  mn: ArrayLike<number>,
  mx: ArrayLike<number>,
): { out: Uint8Array; headerLength: number; scale: number[]; bias: number[] } {
  const { scale, bias } = ptmScaleBias(mn, mx);
  const header = ptmHeaderBytes(width, height, scale, bias);
  const out = new Uint8Array(header.length + PTM_COEFF_COUNT * width * height);
  out.set(header, 0);
  return { out, headerLength: header.length, scale, bias };
}

/* ------------------------------------------------------------------ */
/* PTM_FORMAT_RGB 纯 buffer 构造器                                     */
/* ------------------------------------------------------------------ */

/**
 * 构造 PTM_1.2 / PTM_FORMAT_RGB 文件字节。
 *
 * coeffAt(x, y, c0to17) 返回 gamma 域归一化系数,c = term + channel*6:
 *   R term0..5 = c 0..5,G = 6..11,B = 12..17。
 *
 * 二进制布局:三个通道块(R/G/B),每块 w*h*6 字节;块内行 BOTTOM-TO-TOP
 * (文件第 0 行 = 图像底行 y=height-1),x 从左到右,每像素 6 字节术语顺序
 * [u², v², uv, u, v, 1]。总长 = 头字节数 + 18*w*h。
 */
export function buildPtmRgb(
  width: number,
  height: number,
  coeffAt: (x: number, y: number, c0to17: number) => number,
): Uint8Array {
  const mn = new Array<number>(PTM_TERMS).fill(Infinity);
  const mx = new Array<number>(PTM_TERMS).fill(-Infinity);

  // Pass 1:每个术语跨 R/G/B 三通道的全局 min/max(C255 量纲)。
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        for (let j = 0; j < PTM_TERMS; j++) {
          const c = ch * PTM_TERMS + j;
          const v = coeffAt(x, y, c) * 255;
          if (v < mn[j]) mn[j] = v;
          if (v > mx[j]) mx[j] = v;
        }
      }
    }
  }

  const { out, headerLength } = allocPtm(width, height, mn, mx);

  // Pass 2:按文件布局顺序写字节(chunk/channel 外层,行自底向上)。
  let o = headerLength;
  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) {
        for (let j = 0; j < PTM_TERMS; j++) {
          const c = ch * PTM_TERMS + j;
          const c255 = coeffAt(x, y, c) * 255;
          const range = mx[j] - mn[j];
          out[o++] = isFlat(range) ? 0 : clampByte((255 * (c255 - mn[j])) / range);
        }
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* HSH universal #HSH1.2                                              */
/* ------------------------------------------------------------------ */

/*
 * 已核对的 #HSH1.2 universal 布局(来源 cnr-isti-vclab/relight master):
 *   - 写入端 RtiBuilder::saveUniversal(),src/cli/rtibuilder.cpp 约 1258-1296、1329-1337 行
 *     https://raw.githubusercontent.com/cnr-isti-vclab/relight/master/src/cli/rtibuilder.cpp
 *   - 读取端 LRti::loadHSH(),src/legacy_rti.cpp 约 262-351 行
 *     https://raw.githubusercontent.com/cnr-isti-vclab/relight/master/src/legacy_rti.cpp
 *   - 量化约定 Material::Plane,src/material.h 11-27 行
 *
 * 结论:
 *   ASCII 头(均 LF):
 *     "#HSH1.2\n" "3\n" "{w} {h} 3\n" "9 2 1\n"
 *   随后是两段各 9 个、小端 float32(每术语一个,跨 R/G/B 共享):
 *     gscale[j] = (max-min)/255   (= A)
 *     gbias [j] = min/255         (= B)
 *   再后是 W*H*27 个像素字节,行 TOP-DOWN(读取端 loadHSH 读入文件行 y 后放到
 *   内部 Y=h-1-y,即文件首行对应图像顶行);每像素按通道块排列:
 *     R t0..t8, G t0..t8, B t0..t8
 *   文件内索引 = floatEnd + (y*w+x)*27 + ch*9 + term。
 *
 * 数值语义说明(存在一处历史表述差异):
 *   按 Material::Plane 的 quantize/dequantize 代数,若 min/max 与 coeff 同量纲,
 *   byte = clamp(round(255*(c-min)/(max-min))),且 c ≈ byte*gscale + 255*gbias
 *   (因为 gscale=range/255、gbias=min/255)。legacy_rti.cpp 的 loadHSH 则把第二
 *   段读作 bias 并以 -bias/scale 折叠、注释写 “c*scale+bias”,不同下游对该浮点
 *   偏移是否乘 255 的表述不一。但本导出的头部 / 浮点个数与取值 / 字节顺序严格等于
 *   已核实的 saveUniversal 产物;若无法访问上游,这也是任务约定的回退方案。
 */

function rtiHeaderBytes(width: number, height: number): Uint8Array {
  const text = `#HSH1.2\n3\n${width} ${height} 3\n9 2 1\n`;
  return new TextEncoder().encode(text);
}

/** 分配 HSH 文件、写头与两段 LE float32,返回整块 buffer 与像素段起始偏移。 */
function allocRtiHsh(
  width: number,
  height: number,
  mn: ArrayLike<number>,
  mx: ArrayLike<number>,
): { out: Uint8Array; pixelOffset: number; a: number[]; b: number[] } {
  const a = new Array<number>(HSH_TERMS);
  const b = new Array<number>(HSH_TERMS);
  for (let j = 0; j < HSH_TERMS; j++) {
    const range = mx[j] - mn[j];
    a[j] = range / 255;
    b[j] = mn[j] / 255;
  }

  const header = rtiHeaderBytes(width, height);
  const floatBytes = 2 * HSH_TERMS * 4; // 9 + 9 个 float32
  const out = new Uint8Array(header.length + floatBytes + HSH_COEFF_COUNT * width * height);
  out.set(header, 0);

  const view = new DataView(out.buffer);
  let o = header.length;
  for (let j = 0; j < HSH_TERMS; j++) {
    view.setFloat32(o, a[j], true); // little-endian
    o += 4;
  }
  for (let j = 0; j < HSH_TERMS; j++) {
    view.setFloat32(o, b[j], true);
    o += 4;
  }
  // o === header.length + 72 === pixelOffset
  return { out, pixelOffset: o, a, b };
}

/**
 * 构造 #HSH1.2 universal .rti 文件字节。
 *
 * coeffAt(x, y, c0to26) 返回 gamma 域归一化系数,c = term + channel*9:
 * R 0..8,G 9..17,B 18..26。min/max 直接在该系数量纲上按术语跨通道统计。
 */
export function buildRtiHsh(
  width: number,
  height: number,
  coeffAt: (x: number, y: number, c0to26: number) => number,
): Uint8Array {
  const mn = new Array<number>(HSH_TERMS).fill(Infinity);
  const mx = new Array<number>(HSH_TERMS).fill(-Infinity);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        for (let j = 0; j < HSH_TERMS; j++) {
          const c = ch * HSH_TERMS + j;
          const v = coeffAt(x, y, c);
          if (v < mn[j]) mn[j] = v;
          if (v > mx[j]) mx[j] = v;
        }
      }
    }
  }

  const { out, pixelOffset } = allocRtiHsh(width, height, mn, mx);

  // TOP-down 行,像素内 c 与文件字节偏移一致(pixel*27 + c)。
  let o = pixelOffset;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < HSH_COEFF_COUNT; c++) {
        const j = c % HSH_TERMS;
        const v = coeffAt(x, y, c);
        const range = mx[j] - mn[j];
        out[o++] = isFlat(range) ? 0 : clampByte((255 * (v - mn[j])) / range);
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 从 LoadedResultData 直接导出(热循环不走 coeffAt 回调)               */
/* ------------------------------------------------------------------ */

/**
 * 导出 PTM_FORMAT_RGB。要求 result.algo === 'ptm'。
 * 直接遍历 loadResultData 拼好的空间系数缓冲,避免每系数回调开销。
 */
export async function exportPTM(result: ResultRecord): Promise<Blob> {
  if (result.algo !== 'ptm') {
    throw new Error('PTM 导出需要 PTM 拟合结果');
  }

  const data = await loadResultData(result);
  const width = result.width;
  const height = result.height;
  const { paddedW: pw, K, coeffBytes, tileScale, tileBias } = data;
  const T = result.tileSize;
  const tilesX = result.tilesX;

  const mn = new Array<number>(PTM_TERMS).fill(Infinity);
  const mx = new Array<number>(PTM_TERMS).fill(-Infinity);

  // Pass 1:逐 tile 反量化并统计每术语跨通道 min/max(C255)。
  for (let y = 0; y < height; y++) {
    const ty = Math.floor(y / T);
    const pixelRow = y * pw;
    for (let x = 0; x < width; x++) {
      const tile = ty * tilesX + Math.floor(x / T);
      const ti = tile * K;
      const pi = (pixelRow + x) * K;
      for (let ch = 0; ch < CHANNELS; ch++) {
        for (let j = 0; j < PTM_TERMS; j++) {
          const c = ch * PTM_TERMS + j;
          const c255 = (coeffBytes[pi + c] * tileScale[ti + c] + tileBias[ti + c]) * 255;
          if (c255 < mn[j]) mn[j] = c255;
          if (c255 > mx[j]) mx[j] = c255;
        }
      }
    }
  }

  const { out, headerLength } = allocPtm(width, height, mn, mx);

  // Pass 2:按 PTM 文件布局写三通道块,行 bottom-to-top。
  let o = headerLength;
  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let y = height - 1; y >= 0; y--) {
      const ty = Math.floor(y / T);
      const pixelRow = y * pw;
      for (let x = 0; x < width; x++) {
        const tile = ty * tilesX + Math.floor(x / T);
        const ti = tile * K;
        const pi = (pixelRow + x) * K;
        for (let j = 0; j < PTM_TERMS; j++) {
          const c = ch * PTM_TERMS + j;
          const c255 = (coeffBytes[pi + c] * tileScale[ti + c] + tileBias[ti + c]) * 255;
          const range = mx[j] - mn[j];
          out[o++] = isFlat(range) ? 0 : clampByte((255 * (c255 - mn[j])) / range);
        }
      }
    }
  }

  // out 由 new Uint8Array(精确长度) 新建,byteOffset=0 且 buffer 等长;
  // 传底层 ArrayBuffer 以兼容 TS 5.7+ 泛型 TypedArray 与 BlobPart 的类型约束。
  return new Blob([out.buffer as ArrayBuffer], { type: 'application/octet-stream' });
}

/**
 * 导出 Relight universal `#HSH1.2`。要求 result.algo === 'hsh'。
 * 浮点 A/B 与字节均在 gamma 归一化系数量纲上统计。
 */
export async function exportRTI(result: ResultRecord): Promise<Blob> {
  if (result.algo !== 'hsh') {
    throw new Error('RTI(HSH) 导出需要 HSH 拟合结果');
  }

  const data = await loadResultData(result);
  const width = result.width;
  const height = result.height;
  const { paddedW: pw, K, coeffBytes, tileScale, tileBias } = data;
  const T = result.tileSize;
  const tilesX = result.tilesX;

  const mn = new Array<number>(HSH_TERMS).fill(Infinity);
  const mx = new Array<number>(HSH_TERMS).fill(-Infinity);

  // Pass 1:每术语跨通道全局 min/max(归一化量纲)。
  for (let y = 0; y < height; y++) {
    const ty = Math.floor(y / T);
    const pixelRow = y * pw;
    for (let x = 0; x < width; x++) {
      const tile = ty * tilesX + Math.floor(x / T);
      const ti = tile * K;
      const pi = (pixelRow + x) * K;
      for (let ch = 0; ch < CHANNELS; ch++) {
        for (let j = 0; j < HSH_TERMS; j++) {
          const c = ch * HSH_TERMS + j;
          const v = coeffBytes[pi + c] * tileScale[ti + c] + tileBias[ti + c];
          if (v < mn[j]) mn[j] = v;
          if (v > mx[j]) mx[j] = v;
        }
      }
    }
  }

  const { out, pixelOffset } = allocRtiHsh(width, height, mn, mx);

  // Pass 2:TOP-down、像素连续 27 字节(通道块顺序)。
  let o = pixelOffset;
  for (let y = 0; y < height; y++) {
    const ty = Math.floor(y / T);
    const pixelRow = y * pw;
    for (let x = 0; x < width; x++) {
      const tile = ty * tilesX + Math.floor(x / T);
      const ti = tile * K;
      const pi = (pixelRow + x) * K;
      for (let c = 0; c < HSH_COEFF_COUNT; c++) {
        const j = c % HSH_TERMS;
        const v = coeffBytes[pi + c] * tileScale[ti + c] + tileBias[ti + c];
        const range = mx[j] - mn[j];
        out[o++] = isFlat(range) ? 0 : clampByte((255 * (v - mn[j])) / range);
      }
    }
  }

  // out 由 new Uint8Array(精确长度) 新建,byteOffset=0 且 buffer 等长;
  // 传底层 ArrayBuffer 以兼容 TS 5.7+ 泛型 TypedArray 与 BlobPart 的类型约束。
  return new Blob([out.buffer as ArrayBuffer], { type: 'application/octet-stream' });
}

/* ------------------------------------------------------------------ */
/* 浏览器下载                                                          */
/* ------------------------------------------------------------------ */

/**
 * 触发浏览器下载。Node / 无 DOM 环境下为空操作(但模块导入本身不依赖 DOM)。
 * 创建 object URL、挂一个 <a download> 并 click,稍后 revoke。
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return;
    if (typeof URL.createObjectURL !== 'function') return;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 4000);
  } catch {
    /* 非 DOM 或下载被拦截时静默:此函数在 node 中本就不必工作。 */
  }
}
