/** 全局共享类型定义 */

/** 光照方向:右手坐标系,x 向右,y 向上,z 指向镜头/观察者,均为单位向量 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LightDir extends Vec3 {
  /** 方位角(度),x 轴正方向为 0,逆时针朝 y+ */
  azimuth?: number;
  /** 仰角(度),相对 xy 平面;或极角语义由 ui 层换算 */
  elevation?: number;
}

export type AlgoId = 'ptm' | 'hsh';

export interface FitAlgorithmInfo {
  id: AlgoId;
  name: string;
  /** 每通道系数个数 */
  coeffPerChannel: number;
  /** 总通道数(RGB 三通道) */
  channels: 3;
  description: string;
}

export const ALGORITHMS: Record<AlgoId, FitAlgorithmInfo> = {
  ptm: {
    id: 'ptm',
    name: 'PTM 二次多项式',
    coeffPerChannel: 6,
    channels: 3,
    description: '6 系数二次多项式 L=u²/v²/uv/u/v/1,每像素 RGB 共 18 系数',
  },
  hsh: {
    id: 'hsh',
    name: '半球谐 HSH (2 阶)',
    coeffPerChannel: 9,
    channels: 3,
    description: 'Hemispherical Harmonics 二阶 9 基函数,每像素 RGB 共 27 系数',
  },
};

export interface ExposureFlag {
  imageId: string;
  index: number;
  /** 相对中位数的 log2 曝光偏差(EV) */
  evDelta: number;
  meanLuma: number;
}

export interface ImageAlignment {
  imageId: string;
  index: number;
  shiftX: number;
  shiftY: number;
  score: number;
}

export interface SphereCalibration {
  /** 球心(图像像素坐标) */
  cx: number;
  cy: number;
  radius: number;
  /** 每张图高光点(像素坐标),可手动修正 */
  highlights: { x: number; y: number; manual?: boolean }[];
}

export interface BatchRecord {
  id: string;
  name: string;
  artifactName: string;
  capturedAt: string;
  createdAt: number;
  author: string;
  note?: string;
  width: number;
  height: number;
  imageIds: string[];
  /** 与 imageIds 同序的文件名 */
  fileNames: string[];
  lights: LightDir[];
  lightsSource?: 'known' | 'sphere' | 'manual' | 'none';
  sphere?: SphereCalibration | null;
  alignments?: ImageAlignment[];
  exposureFlags?: ExposureFlag[];
  /** 比例尺:mm / 像素 */
  mmPerPixel?: number;
  scaleLabel?: string;
  thumbnail?: string;
}

export interface ImageRecord {
  id: string;
  batchId: string;
  index: number;
  name: string;
  width: number;
  height: number;
  type: string;
  size: number;
  blob: Blob;
  meanLuma: number;
}

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled';

export interface FitJobRecord {
  id: string;
  batchId: string;
  algo: AlgoId;
  status: JobStatus;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  /** 已完成 tile 索引(ty*tilesX+tx) */
  doneTiles: number[];
  totalPixels: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  /** 纯拟合耗时(不含生成数据等) */
  fitMs?: number;
  resultId?: string;
  error?: string;
  /** 量化范围:每个系数量的 min/max,长度 coeffCount */
  coeffMin?: number[];
  coeffMax?: number[];
  coeffCount?: number;
  normalCount?: number;
  gpu?: string;
  /** 拟合前对曝光异常图做增益拉齐 */
  correctExposure?: boolean;
}

export interface ResultRecord {
  id: string;
  jobId: string;
  batchId: string;
  algo: AlgoId;
  width: number;
  height: number;
  coeffPerChannel: number;
  coeffCount: number;
  coeffMin: number[];
  coeffMax: number[];
  /** 量化系数块存储 key 前缀,chunk key = coeffPrefix + ':t' + tile */
  coeffPrefix: string;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  normalPrefix: string;
  /** 每个 tile、每个系数量的最小值(反量化 bias) */
  tileMin: number[][];
  /** 每个 tile、每个系数量的最大值 */
  tileMax: number[][];
  paddedWidth: number;
  paddedHeight: number;
  /** 法线/深度预览图 blob */
  normalBlob?: Blob;
  depthBlob?: Blob;
  thumbnail?: string;
  createdAt: number;
  fitMs?: number;
  gpu?: string;
}

export type AnnotationKind = 'scale' | 'length' | 'width' | 'point' | 'note';

export interface AnnotationRecord {
  id: string;
  targetId: string; // batchId 或 resultId
  targetKind: 'batch' | 'result';
  kind: AnnotationKind;
  author: string;
  createdAt: string;
  /** 图像像素坐标 */
  points: { x: number; y: number }[];
  /** 比例尺标定时的已知毫米数 */
  knownMm?: number;
  /** 测量结果毫米 */
  valueMm?: number;
  label?: string;
  color?: string;
}

export interface ComparisonRecord {
  id: string;
  name: string;
  batchAId: string;
  batchBId: string;
  createdAt: string;
  threshold: number;
  regions?: RustRegion[];
  overlayBlob?: Blob;
}

export interface RustRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: number;
  areaMm2?: number;
  meanDelta: number;
}

export interface SettingsRecord {
  author: string;
  unit: 'mm' | 'cm';
  gpuPreference: 'high-performance' | 'default';
  tileSize: number;
  theme: 'dark' | 'light';
}
