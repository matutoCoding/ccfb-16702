/**
 * 测量标注页的共享类型、元数据、几何/格式化工具与样式注入。
 * 所有标注点均以“原始图像像素坐标”存储。
 */
import type { AnnotationKind, AnnotationRecord, BatchRecord } from '../../core/types';

export interface Pt {
  x: number;
  y: number;
}

export type LineTool = 'scale' | 'length' | 'width';
export type ToolId = AnnotationKind;

export interface ToolMeta {
  id: ToolId;
  name: string;
  icon: string;
  color: string;
  hint: string;
}

/** 各类型的视觉与文案元数据(颜色使用固定 hex,SVG / Canvas 导出共用) */
export const KIND_META: Record<AnnotationKind, { name: string; short: string; icon: string; color: string }> = {
  scale: { name: '比例尺标定', short: '比例尺', icon: '📐', color: '#56c8d8' },
  length: { name: '长度', short: '长度', icon: '📏', color: '#e0bd76' },
  width: { name: '刻痕宽度', short: '宽度', icon: '↔', color: '#e8964f' },
  point: { name: '点标注', short: '点', icon: '📍', color: '#58c98b' },
  note: { name: '文字备注', short: '备注', icon: '📝', color: '#b48cf0' },
};

export const TOOLS: ToolMeta[] = [
  { id: 'scale', ...KIND_META.scale, hint: '在已知实际长度的参照物上按住拖动画一条线,松开后输入其毫米数完成标定。' },
  { id: 'length', ...KIND_META.length, hint: '按住拖动绘制长度测量线;也可以先点起点、再点终点。' },
  { id: 'width', ...KIND_META.width, hint: '拖动绘制刻痕宽度测量线(橙色双端刻度)。' },
  { id: 'point', ...KIND_META.point, hint: '在图像上单击放置点标注,并填写名称。' },
  { id: 'note', ...KIND_META.note, hint: '在图像上单击要备注的位置,输入文字备注。' },
];

export function toolHint(id: ToolId): string {
  return TOOLS.find((t) => t.id === id)?.hint ?? '';
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function roundPt(p: Pt): Pt {
  return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
}

export function linePxLength(a: AnnotationRecord): number {
  if (a.points.length < 2) return 0;
  return dist(a.points[0], a.points[1]);
}

export function formatMm(v: number): string {
  if (!Number.isFinite(v)) return '--';
  if (Math.abs(v) >= 100) return v.toFixed(1);
  return v.toFixed(2);
}

/** 标注的主数值文案 */
export function valueText(a: AnnotationRecord, mmPerPixel?: number): string {
  if (a.kind === 'point') return '点位';
  if (a.kind === 'note') return '备注';
  if (typeof a.valueMm === 'number' && Number.isFinite(a.valueMm)) {
    return a.kind === 'scale' ? `${formatMm(a.valueMm)} mm(基准)` : `${formatMm(a.valueMm)} mm`;
  }
  const px = linePxLength(a);
  if (mmPerPixel && mmPerPixel > 0) return `${formatMm(px * mmPerPixel)} mm`;
  return `${px.toFixed(1)} px`;
}

/** 列表中展示的完整标题(类型 + 数值) */
export function titleText(a: AnnotationRecord, mmPerPixel?: number): string {
  return `${KIND_META[a.kind].short} · ${valueText(a, mmPerPixel)}`;
}

export function isCalibrated(batch: BatchRecord | null | undefined): boolean {
  return !!batch?.mmPerPixel && batch.mmPerPixel > 0;
}

/** 文件名安全化 */
export function sanitizeFilename(name: string): string {
  const cleaned = (name || 'batch').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'batch';
}

export function timestampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给下载触发留出时间后回收
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function escapeXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 估算文本宽度(用户单位),CJK 按全宽计 */
export function measureTextWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0) ?? 0;
    w += code >= 0x2e80 ? fontSize : fontSize * 0.58;
  }
  return w;
}

/** 依据图像分辨率推导标注图形的尺寸(图像像素单位),保证导出 PNG 比例协调 */
export function shapeMetrics(W: number): { stroke: number; hit: number; dot: number; font: number; tick: number } {
  const base = W > 0 ? W : 1000;
  return {
    stroke: Math.max(2, base * 0.0026),
    hit: Math.max(16, base * 0.022),
    dot: Math.max(4.5, base * 0.006),
    font: Math.max(12, base * 0.017),
    tick: Math.max(7, base * 0.014),
  };
}

let stylesInjected = false;

/** 注入标注页专属样式(只注入一次),统一 ann- 前缀 */
export function injectAnnotateStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'ann-styles';
  style.textContent = `
.ann-root { display: flex; flex-direction: column; gap: 14px; }
.ann-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 11px 14px; }
.ann-head .ann-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.ann-head .spacer { flex: 1; }
.ann-batch-select { width: auto; min-width: 220px; max-width: 320px; padding: 7px 10px; }
.ann-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.ann-left { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.ann-right { min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.ann-stage { padding: 14px !important; }
.ann-frame { position: relative; line-height: 0; border-radius: 4px; box-shadow: 0 10px 44px rgba(0,0,0,.55); }
.ann-img { display: block; width: 100%; height: 100%; border-radius: 4px; user-select: none; -webkit-user-drag: none; }
.ann-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; touch-action: none; user-select: none; }
.ann-svg.tool-line { cursor: crosshair; }
.ann-svg.tool-marker { cursor: copy; }
.ann-shape { cursor: pointer; }
.ann-shape .ann-handle { cursor: grab; }
.ann-shape .ann-handle:active { cursor: grabbing; }
.ann-shape.sel .ann-visible-line { filter: drop-shadow(0 0 5px currentColor); }
.ann-tool-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.ann-tool-grid .ann-tool-btn { justify-content: flex-start; padding: 9px 11px; font-size: 13px; }
.ann-tool-grid .ann-tool-btn.wide { grid-column: 1 / -1; }
.ann-tool-ico { width: 20px; text-align: center; flex: none; font-size: 15px; }
.ann-tool-hint { font-size: 12px; color: var(--fg-faint); line-height: 1.6; margin: 10px 0 0; min-height: 36px; }
.ann-calib-badges { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 11px; }
.ann-manual { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
.ann-manual .field { margin-bottom: 0; }
.ann-measure { margin-top: 13px; padding: 13px 14px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.ann-measure .ann-mv { font-size: 27px; font-weight: 750; font-variant-numeric: tabular-nums; line-height: 1.15; color: var(--accent-strong); word-break: break-all; }
.ann-measure .ann-ms { font-size: 12px; color: var(--fg-faint); margin-top: 5px; font-variant-numeric: tabular-nums; }
.ann-list-wrap { max-height: 340px; overflow: auto; padding-right: 2px; }
.annotation-item { cursor: pointer; transition: border-color .15s, background .15s; }
.annotation-item:hover { border-color: var(--border-strong); }
.annotation-item.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, var(--bg)); }
.ann-kind-ico { width: 26px; height: 26px; flex: none; display: grid; place-items: center; border-radius: 7px; font-size: 14px; background: var(--bg-elev2); }
.ann-del { flex: none; }
.ann-export-grid { display: flex; flex-direction: column; gap: 8px; }
.ann-thumb-card .card-body { padding: 10px 12px 4px; }
.ann-chooser-head { margin-bottom: 16px; }
.ann-chooser-head h2 { font-size: 18px; margin-bottom: 6px; }
.ann-chooser-head p { color: var(--fg-dim); font-size: 13px; margin: 0; }
.ann-batch-card { cursor: pointer; }
.ann-batch-card .ann-bc-foot { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 5px; }
.ann-batch-card .ann-bc-name { font-weight: 680; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ann-batch-card .ann-bc-row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--fg-faint); }
.ann-bc-thumb { height: 150px; }
.ann-bc-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ann-form-err { color: var(--red); font-size: 12.5px; min-height: 16px; margin-top: 6px; }
.ann-loading { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 80px 0; color: var(--fg-dim); }
.ann-coords b { color: var(--fg-dim); font-weight: 600; }
.ann-view-seg { min-width: 150px; }
.ann-mini-link { background: none; border: 0; color: var(--blue); cursor: pointer; font-size: 12px; padding: 0; text-decoration: underline; }
.ann-danger-text { color: var(--red); }
@media (max-width: 560px) {
  .ann-tool-grid { grid-template-columns: 1fr; }
  .ann-batch-select { max-width: none; width: 100%; }
}
`;
  document.head.appendChild(style);
}
