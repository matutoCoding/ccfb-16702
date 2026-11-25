/** 标注导出:JSON / CSV / 叠加层 PNG(离屏 Canvas,原始分辨率) */
import type { AnnotationRecord, BatchRecord } from '../../core/types';
import {
  KIND_META,
  downloadBlob,
  formatMm,
  linePxLength,
  sanitizeFilename,
  shapeMetrics,
  timestampForFile,
  valueText,
} from './shared';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function annRow(a: AnnotationRecord): (string | number)[] {
  const p0 = a.points[0];
  const p1 = a.points[1];
  return [
    a.id,
    a.kind,
    a.label ?? '',
    p0 ? roundForCsv(p0.x) : '',
    p0 ? roundForCsv(p0.y) : '',
    p1 ? roundForCsv(p1.x) : '',
    p1 ? roundForCsv(p1.y) : '',
    typeof a.valueMm === 'number' ? roundForCsv(a.valueMm) : '',
    a.author ?? '',
    a.createdAt ?? '',
  ];
}

function roundForCsv(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function exportAnnotationsCsv(batch: BatchRecord, anns: AnnotationRecord[]): void {
  const header = ['id', 'kind', 'label', 'x0', 'y0', 'x1', 'y1', 'valueMm', 'author', 'createdAt'];
  const lines = [header.map(csvCell).join(','), ...anns.map((a) => annRow(a).map(csvCell).join(','))];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFilename(batch.name)}_标注_${timestampForFile()}.csv`);
}

export function exportAnnotationsJson(batch: BatchRecord, anns: AnnotationRecord[]): void {
  const payload = {
    app: 'rti-studio',
    version: 1,
    exportedAt: new Date().toISOString(),
    batch: {
      id: batch.id,
      name: batch.name,
      artifactName: batch.artifactName,
      width: batch.width,
      height: batch.height,
      mmPerPixel: batch.mmPerPixel ?? null,
      scaleLabel: batch.scaleLabel ?? null,
    },
    annotations: anns,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFilename(batch.name)}_标注_${timestampForFile()}.json`);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图加载失败'));
    img.src = url;
  });
}

/** 在离屏 canvas 上以原始分辨率绘制底图 + 全部标注,导出 PNG */
export async function exportOverlayPng(opts: {
  batch: BatchRecord;
  imageUrl: string;
  annotations: AnnotationRecord[];
}): Promise<void> {
  const { batch, imageUrl, annotations } = opts;
  const W = batch.width > 0 ? batch.width : 1280;
  const H = batch.height > 0 ? batch.height : 960;
  const img = await loadImage(imageUrl);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');

  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  drawAnnotationsToCanvas(ctx, annotations, W, batch.mmPerPixel);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  if (!blob) throw new Error('PNG 编码失败');
  downloadBlob(blob, `${sanitizeFilename(batch.name)}_叠加标注_${timestampForFile()}.png`);
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Canvas 版标注绘制(与 SVG 视觉保持一致) */
export function drawAnnotationsToCanvas(
  ctx: CanvasRenderingContext2D,
  anns: AnnotationRecord[],
  W: number,
  mmPerPixel?: number,
): void {
  const m = shapeMetrics(W);
  const fontFamily = `"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif`;

  const drawLabelPill = (cx: number, cy: number, lines: { text: string; big?: boolean; color?: string }[]) => {
    const padX = m.font * 0.55;
    const lineH = m.font * 1.35;
    let boxW = 0;
    ctx.textBaseline = 'middle';
    for (const ln of lines) {
      ctx.font = `${ln.big ? 700 : 500} ${ln.big ? m.font * 1.05 : m.font * 0.82}px ${fontFamily}`;
      boxW = Math.max(boxW, ctx.measureText(ln.text).width);
    }
    boxW += padX * 2;
    const boxH = lineH * lines.length + m.font * 0.5;
    const x = cx - boxW / 2;
    const y = cy - boxH - m.font * 1.1;
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,16,.82)';
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = Math.max(1, W * 0.001);
    roundRect(ctx, x, y, boxW, boxH, m.font * 0.4);
    ctx.fill();
    ctx.stroke();
    lines.forEach((ln, i) => {
      ctx.font = `${ln.big ? 700 : 500} ${ln.big ? m.font * 1.05 : m.font * 0.82}px ${fontFamily}`;
      ctx.fillStyle = ln.color ?? (ln.big ? '#f2f5fa' : '#a7aebc');
      const ly = y + m.font * 0.55 + lineH * (i + 0.5);
      ctx.fillText(ln.text, x + padX, ly);
    });
    ctx.restore();
  };

  for (const a of anns) {
    const color = a.color || KIND_META[a.kind].color;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if ((a.kind === 'length' || a.kind === 'width' || a.kind === 'scale') && a.points.length >= 2) {
      const [p0, p1] = a.points;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;

      ctx.strokeStyle = color;
      ctx.lineWidth = m.stroke;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();

      // 端刻度:宽度双刻度 + 比例尺刻度
      if (a.kind === 'width' || a.kind === 'scale') {
        const tk = m.tick;
        ctx.lineWidth = Math.max(m.stroke * 0.8, 1.5);
        for (const p of [p0, p1]) {
          ctx.beginPath();
          ctx.moveTo(p.x - px * tk, p.y - py * tk);
          ctx.lineTo(p.x + px * tk, p.y + py * tk);
          ctx.stroke();
        }
      }

      // 端点
      for (const p of [p0, p1]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, m.dot * 1.15, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, m.stroke * 0.55);
        ctx.strokeStyle = '#101216';
        ctx.stroke();
      }

      const mx = (p0.x + p1.x) / 2;
      const my = (p0.y + p1.y) / 2;
      const val =
        typeof a.valueMm === 'number'
          ? `${formatMm(a.valueMm)} mm`
          : mmPerPixel && mmPerPixel > 0
            ? `${formatMm(linePxLength(a) * mmPerPixel)} mm`
            : `${linePxLength(a).toFixed(1)} px`;
      drawLabelPill(mx, my, [
        { text: `${KIND_META[a.kind].short} ${val}`, big: true, color },
        { text: [a.label, a.author, shortDate(a.createdAt)].filter(Boolean).join(' · ') },
      ]);
    } else if (a.points.length >= 1) {
      const p = a.points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, m.dot * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, m.stroke * 0.6);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.stroke();

      const text = a.label?.trim() || KIND_META[a.kind].name;
      ctx.font = `650 ${m.font}px ${fontFamily}`;
      const tw = ctx.measureText(text).width;
      const padX = m.font * 0.5;
      const boxW = tw + padX * 2;
      const boxH = m.font * 1.9;
      const bx = p.x + m.dot * 1.6;
      const by = p.y - boxH - m.dot * 0.8;
      ctx.fillStyle = 'rgba(10,12,16,.82)';
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, W * 0.0012);
      roundRect(ctx, bx, by, boxW, boxH, m.font * 0.35);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f2f5fa';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + padX, by + boxH / 2);
    }
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
