import { getChunk } from '../db';
import type { ResultRecord } from '../types';

export interface LoadedResultData {
  result: ResultRecord;
  /** 空间布局 paddedW*paddedH*K 的量化系数字节 */
  coeffBytes: Uint8Array;
  /** 空间布局 paddedW*paddedH*4 的法线编码字节 */
  normalBytes: Uint8Array;
  paddedW: number;
  paddedH: number;
  K: number;
  /** 反量化 scale=(max-min)/255, bias=min,索引 tile*K+c */
  tileScale: Float32Array;
  tileBias: Float32Array;
}

/**
 * 读取并 de-tile 结果,拼成空间连续缓冲。
 * 2000² PTM18 系数量化后约 74MB,HSH27 约 110MB。
 */
export async function loadResultData(result: ResultRecord): Promise<LoadedResultData> {
  const T = result.tileSize;
  const { tilesX, tilesY, paddedWidth: pw, paddedHeight: ph, coeffCount: K } = result;
  const coeffBytes = new Uint8Array(pw * ph * K);
  const normalBytes = new Uint8Array(pw * ph * 4);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const t = ty * tilesX + tx;
      const [cc, nc] = await Promise.all([
        getChunk(`${result.coeffPrefix}:t${t}`),
        getChunk(`${result.normalPrefix}:t${t}`),
      ]);
      if (cc) {
        const tile = new Uint8Array(cc.buffer);
        // 逐行拷贝以完成 tile -> 空间 de-tile
        for (let y = 0; y < T; y++) {
          const spatialRow = (ty * T + y) * pw * K + tx * T * K;
          const tileRow = y * T * K;
          coeffBytes.set(tile.subarray(tileRow, tileRow + T * K), spatialRow);
        }
      }
      if (nc) {
        const tile = new Uint8Array(nc.buffer);
        for (let y = 0; y < T; y++) {
          const spatialRow = (ty * T + y) * pw * 4 + tx * T * 4;
          const tileRow = y * T * 4;
          normalBytes.set(tile.subarray(tileRow, tileRow + T * 4), spatialRow);
        }
      }
    }
  }

  const totalTiles = tilesX * tilesY;
  const tileScale = new Float32Array(totalTiles * K);
  const tileBias = new Float32Array(totalTiles * K);
  for (let t = 0; t < totalTiles; t++) {
    for (let c = 0; c < K; c++) {
      const min = result.tileMin[t]?.[c] ?? 0;
      const max = result.tileMax[t]?.[c] ?? 1;
      tileBias[t * K + c] = min;
      tileScale[t * K + c] = (max - min) / 255;
    }
  }

  return { result, coeffBytes, normalBytes, paddedW: pw, paddedH: ph, K, tileScale, tileBias };
}

/** 反量化某个空间像素的第 c 个系数(调试/CPU 导出用) */
export function dequantCoeffAt(data: LoadedResultData, x: number, y: number, c: number): number {
  const { paddedW: pw, K, result } = data;
  const T = result.tileSize;
  const tx = Math.floor(x / T);
  const ty = Math.floor(y / T);
  const tile = ty * result.tilesX + tx;
  const byte = data.coeffBytes[(y * pw + x) * K + c];
  return byte * data.tileScale[tile * K + c] + data.tileBias[tile * K + c];
}

/** 读取解码后的单位法线 */
export function normalAt(data: LoadedResultData, x: number, y: number): [number, number, number] {
  const { paddedW: pw } = data;
  const i = (y * pw + x) * 4;
  return [
    data.normalBytes[i] / 127.5 - 1,
    data.normalBytes[i + 1] / 127.5 - 1,
    data.normalBytes[i + 2] / 127.5 - 1,
  ];
}
