/** SVG 叠加层标记生成(坐标系 = 原始图像像素,配合 viewBox 自适应缩放) */
import type { AnnotationRecord } from '../../core/types';
import { KIND_META, dist, escapeXml, linePxLength, measureTextWidth, shapeMetrics, valueText, type Pt, type ToolId } from './shared';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createSvgElement(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'ann-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('data-testid', 'annotation-svg');
  return svg;
}

function shortSub(a: AnnotationRecord): string {
  let date = '';
  const d = new Date(a.createdAt);
  if (!Number.isNaN(d.getTime())) {
    const p = (n: number) => String(n).padStart(2, '0');
    date = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return [a.label, a.author, date].filter(Boolean).join(' · ');
}

interface PillLine {
  text: string;
  big?: boolean;
  color?: string;
}

/** 以 (mx,my) 为线段中点,在其上方绘制居中信息牌 */
function midPill(mx: number, my: number, lines: PillLine[], W: number): string {
  const m = shapeMetrics(W);
  const padX = m.font * 0.62;
  const lineH = m.font * 1.4;
  const widths = lines.map((ln) => measureTextWidth(ln.text, ln.big ? m.font * 1.04 : m.font * 0.82));
  const boxW = Math.max(...widths, m.font * 3) + padX * 2;
  const boxH = lineH * lines.length + m.font * 0.5;
  const top = -boxH - m.font * 1.05;
  const rect = `<rect x="${(-boxW / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${(m.font * 0.42).toFixed(2)}" fill="rgba(10,12,16,.85)" stroke="rgba(255,255,255,.16)" stroke-width="${Math.max(1, W * 0.0009).toFixed(2)}"/>`;
  const texts = lines
    .map((ln, i) => {
      const fs = ln.big ? m.font * 1.04 : m.font * 0.82;
      const cy = top + (boxH / lines.length) * (i + 0.5);
      const fill = ln.color ?? (ln.big ? '#f2f5fa' : '#a7aebc');
      const weight = ln.big ? 700 : 500;
      return `<text x="0" y="${cy.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" font-size="${fs.toFixed(1)}" font-weight="${weight}" fill="${fill}" style="font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif">${escapeXml(ln.text)}</text>`;
    })
    .join('');
  return `<g transform="translate(${mx.toFixed(2)} ${my.toFixed(2)})" style="pointer-events:none">${rect}${texts}</g>`;
}

/** 点/备注的左上对齐信息牌 */
function anchorPill(p: Pt, text: string, color: string, W: number): string {
  const m = shapeMetrics(W);
  const fs = m.font * 0.95;
  const padX = m.font * 0.55;
  const boxW = measureTextWidth(text, fs) + padX * 2;
  const boxH = m.font * 1.85;
  const x = p.x + m.dot * 1.9;
  const y = p.y - boxH - m.dot * 1.1;
  return `<g style="pointer-events:none">
    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${(m.font * 0.4).toFixed(2)}" fill="rgba(10,12,16,.85)" stroke="${color}" stroke-width="${Math.max(1, W * 0.0011).toFixed(2)}"/>
    <text x="${(x + padX).toFixed(2)}" y="${(y + boxH / 2).toFixed(2)}" dominant-baseline="middle" font-size="${fs.toFixed(1)}" font-weight="650" fill="#f2f5fa" style="font-family:'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif">${escapeXml(text)}</text>
  </g>`;
}

function handleCircles(annId: string, index: number, p: Pt, color: string, W: number): string {
  const m = shapeMetrics(W);
  return `
    <circle class="ann-handle" data-handle="1" data-ann="${escapeXml(annId)}" data-index="${index}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${m.hit.toFixed(2)}" fill="transparent"></circle>
    <circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(m.dot * 1.25).toFixed(2)}" fill="${color}" stroke="#101216" stroke-width="${Math.max(1.5, m.stroke * 0.5).toFixed(2)}" style="pointer-events:none"></circle>`;
}

export function annotationSvg(a: AnnotationRecord, selected: boolean, mmPerPixel: number | undefined, W: number): string {
  const m = shapeMetrics(W);
  const color = a.color || KIND_META[a.kind].color;
  const cls = `ann-shape ann-kind-${a.kind}${selected ? ' sel' : ''}`;
  const halo = selected
    ? `<g style="pointer-events:none" opacity=".35">` +
      a.points
        .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(m.dot * 2.6).toFixed(1)}" fill="${color}"/>`)
        .join('') +
      `</g>`
    : '';

  if ((a.kind === 'length' || a.kind === 'width' || a.kind === 'scale') && a.points.length >= 2) {
    const [p0, p1] = a.points;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const tk = m.tick;
    const ticks =
      a.kind === 'width' || a.kind === 'scale'
        ? [p0, p1]
            .map(
              (p) =>
                `<line x1="${(p.x - px * tk).toFixed(2)}" y1="${(p.y - py * tk).toFixed(2)}" x2="${(p.x + px * tk).toFixed(2)}" y2="${(p.y + py * tk).toFixed(2)}" stroke="${color}" stroke-width="${Math.max(m.stroke * 0.85, 1.6).toFixed(2)}" stroke-linecap="round" style="pointer-events:none"/>`,
            )
            .join('')
        : '';
    const sub = shortSub(a);
    return `<g class="${cls}" data-ann="${escapeXml(a.id)}" style="--ann-color:${color}">
      ${halo}
      <line class="ann-visible-line" x1="${p0.x.toFixed(2)}" y1="${p0.y.toFixed(2)}" x2="${p1.x.toFixed(2)}" y2="${p1.y.toFixed(2)}" stroke="${color}" stroke-width="${(selected ? m.stroke * 1.6 : m.stroke).toFixed(2)}" stroke-linecap="round"/>
      ${ticks}
      <line x1="${p0.x.toFixed(2)}" y1="${p0.y.toFixed(2)}" x2="${p1.x.toFixed(2)}" y2="${p1.y.toFixed(2)}" stroke="transparent" stroke-width="${m.hit.toFixed(2)}" stroke-linecap="round"/>
      ${midPill((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, [
        { text: `${KIND_META[a.kind].short} ${valueText(a, mmPerPixel)}`, big: true, color },
        ...(sub ? [{ text: sub.length > 46 ? sub.slice(0, 45) + '…' : sub }] : []),
      ], W)}
      ${handleCircles(a.id, 0, p0, color, W)}
      ${handleCircles(a.id, 1, p1, color, W)}
    </g>`;
  }

  // point / note(以及数据不完整的线状标注的兜底判断)
  if (a.kind !== 'point' && a.kind !== 'note') return '';
  const p = a.points[0];
  if (!p) return '';
  const text = a.label?.trim() || KIND_META[a.kind].name;
  return `<g class="${cls}" data-ann="${escapeXml(a.id)}" style="--ann-color:${color}">
    ${halo}
    <circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(m.dot * 1.7).toFixed(2)}" fill="${color}" stroke="rgba(255,255,255,.9)" stroke-width="${Math.max(1.4, m.stroke * 0.55).toFixed(2)}"/>
    ${anchorPill(p, text, color, W)}
    <circle class="ann-handle" data-handle="1" data-ann="${escapeXml(a.id)}" data-index="0" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${m.hit.toFixed(2)}" fill="transparent"></circle>
  </g>`;
}

export function armedSvg(p: Pt, W: number): string {
  const m = shapeMetrics(W);
  return `<g style="pointer-events:none">
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(m.dot * 2.4).toFixed(1)}" fill="none" stroke="#ffffff" stroke-width="${Math.max(1.5, m.stroke * 0.7).toFixed(2)}" stroke-dasharray="${m.dot} ${m.dot * 0.7}"/>
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${m.dot.toFixed(1)}" fill="#ffffff"/>
  </g>`;
}

export function draftSvg(tool: ToolId, p0: Pt, p1: Pt, mmPerPixel: number | undefined, W: number): string {
  const color = KIND_META[tool].color;
  const m = shapeMetrics(W);
  if (tool === 'point' || tool === 'note') {
    return `<g style="pointer-events:none" opacity=".8">
      <circle cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" r="${(m.dot * 1.7).toFixed(1)}" fill="${color}" stroke="#fff" stroke-width="1.5"/>
    </g>`;
  }
  const pxLen = dist(p0, p1);
  const val = mmPerPixel && mmPerPixel > 0 ? `${(pxLen * mmPerPixel).toFixed(2)} mm` : `${pxLen.toFixed(1)} px`;
  return `<g style="pointer-events:none">
    <line x1="${p0.x.toFixed(1)}" y1="${p0.y.toFixed(1)}" x2="${p1.x.toFixed(1)}" y2="${p1.y.toFixed(1)}" stroke="${color}" stroke-width="${m.stroke.toFixed(2)}" stroke-dasharray="${(m.stroke * 3).toFixed(1)} ${(m.stroke * 2).toFixed(1)}" stroke-linecap="round" opacity=".95"/>
    <circle cx="${p0.x.toFixed(1)}" cy="${p0.y.toFixed(1)}" r="${m.dot.toFixed(1)}" fill="${color}"/>
    <circle cx="${p1.x.toFixed(1)}" cy="${p1.y.toFixed(1)}" r="${m.dot.toFixed(1)}" fill="${color}"/>
    ${pxLen > 6 ? midPill((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, [{ text: val, big: true, color }], W) : ''}
  </g>`;
}

/** 供外部(如测量面板)使用的长度计算 */
export function annotationLength(a: AnnotationRecord): number {
  return linePxLength(a);
}
