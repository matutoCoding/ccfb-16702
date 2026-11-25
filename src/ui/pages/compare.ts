/**
 * 两期对比页:同一器物两个时间点批次的代表照片 → 共同分辨率对齐 →
 * 锈蚀/铜绿变化检测、热力叠加、区域列表、记录保存与 PNG/JSON 导出。
 *
 * 约定:
 *  - 所有像素计算都在长边 <=1400 的共同分辨率离屏 canvas 上进行;
 *  - dx/dy 是 B 相对 A 的 drawImage 逆重映射偏移(正值 B 向右/向下);
 *  - 本文件不修改任何既有文件,自定义样式类一律 cmp- 前缀。
 */

import { h, button, badge, toast, confirmDialog, fmtDate } from '../dom';
import { dbApi, uid } from '../../core/db';
import type {
  BatchRecord,
  ComparisonRecord,
  ImageRecord,
  RustRegion,
} from '../../core/types';
import {
  computeRustChanges,
  drawHeatmapOverlay,
  DEFAULT_RUST_THRESHOLD,
} from '../../core/analysis/rustCompare';
import type { RgbaImage, RustMaskResult } from '../../core/analysis/rustCompare';
import { searchTranslation } from '../compare/align';
import type { PageContext } from '../../main';

const MAX_COMMON_EDGE = 1400;
const NUDGE_RANGE = 80;

/* ------------------------------------------------------------------ */
/* 样式(仅注入一次,全部选择器 cmp- 前缀,颜色走全局 CSS 变量)          */
/* ------------------------------------------------------------------ */

const CMP_CSS = `
.cmp-root{display:flex;flex-direction:column;gap:16px;}
.cmp-pick-grid{display:grid;grid-template-columns:minmax(0,1fr) 46px minmax(0,1fr);gap:14px;align-items:end;}
@media (max-width:920px){.cmp-pick-grid{grid-template-columns:1fr;}.cmp-swap-col{justify-content:flex-start !important;padding:0;}}
.cmp-pick-side{display:flex;flex-direction:column;min-width:0;}
.cmp-pick-title{display:flex;align-items:center;gap:9px;margin-bottom:9px;flex-wrap:wrap;}
.cmp-pick-sub{font-size:12px;color:var(--fg-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cmp-swap-col{display:flex;justify-content:center;padding-bottom:2px;}
.cmp-swap{width:42px;height:42px;border-radius:50%;font-size:17px;padding:0;justify-content:center;}
.cmp-layout{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:16px;align-items:start;}
@media (max-width:1180px){.cmp-layout{grid-template-columns:1fr;}}
.cmp-side{display:flex;flex-direction:column;gap:16px;min-width:0;}
.cmp-stage-host{padding:12px;}
.cmp-stage{position:relative;width:100%;border-radius:8px;overflow:hidden;background:var(--bg-canvas);line-height:0;}
.cmp-stage.cmp-split{cursor:ew-resize;touch-action:none;user-select:none;}
.cmp-base{position:relative;display:block;width:100%;height:auto;}
.cmp-layer{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.cmp-divider{position:absolute;top:0;bottom:0;width:2px;background:var(--accent-strong);box-shadow:0 0 12px rgba(0,0,0,.75);left:50%;z-index:6;pointer-events:none;}
.cmp-divider::after{content:'\\21D4';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:32px;height:32px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-weight:800;font-size:14px;box-shadow:var(--shadow);}
.cmp-tag{position:absolute;top:10px;z-index:5;font-size:11.5px;font-weight:700;padding:3px 11px;border-radius:14px;background:rgba(10,12,16,.68);border:1px solid var(--border);color:var(--fg-dim);pointer-events:none;backdrop-filter:blur(4px);line-height:1.5;}
.cmp-tag-a{left:10px;color:var(--blue);}
.cmp-tag-b{right:10px;color:var(--accent-strong);}
.cmp-msg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:360px;padding:30px;text-align:center;color:var(--fg-faint);line-height:1.6;}
.cmp-msg .cmp-msg-ico{font-size:40px;opacity:.6;}
.cmp-msg.cmp-err{color:var(--red);}
.cmp-msg-title{font-weight:650;color:var(--fg-dim);}
.cmp-msg.cmp-err .cmp-msg-title{color:var(--red);}
.cmp-nudge{display:flex;flex-direction:column;gap:11px;margin:4px 0 12px;}
.cmp-nudge-row{display:grid;grid-template-columns:22px 1fr 58px;gap:10px;align-items:center;}
.cmp-axis{font-weight:800;color:var(--accent-strong);font-family:ui-monospace,Consolas,monospace;text-align:center;}
.cmp-num{padding:5px 6px !important;text-align:center;font-size:12.5px;font-variant-numeric:tabular-nums;}
.cmp-btn-row{display:flex;gap:8px;flex-wrap:wrap;}
.cmp-btn-row .btn{flex:1;justify-content:center;}
.cmp-control{margin-bottom:15px;}
.cmp-control:last-child{margin-bottom:0;}
.cmp-control > label.cmp-ctrl-label{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;color:var(--fg-dim);font-weight:600;margin-bottom:7px;}
.cmp-control output{font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--accent-strong);font-weight:700;}
.cmp-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:14px 0 10px;}
.cmp-stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 11px;min-width:0;}
.cmp-stat .v{font-size:18px;font-weight:720;font-variant-numeric:tabular-nums;line-height:1.25;overflow:hidden;text-overflow:ellipsis;}
.cmp-stat .v.good{color:var(--green);}
.cmp-stat .v.warn{color:var(--orange);}
.cmp-stat .k{font-size:11.5px;color:var(--fg-faint);margin-top:3px;white-space:nowrap;}
.cmp-scale-line{font-size:12px;color:var(--fg-dim);margin-bottom:6px;font-variant-numeric:tabular-nums;}
.cmp-calib-hint{font-size:12.5px;line-height:1.6;padding:9px 11px;border-radius:8px;background:color-mix(in srgb,var(--orange) 10%,transparent);border:1px solid color-mix(in srgb,var(--orange) 32%,transparent);color:var(--fg-dim);}
.cmp-calib-hint.cmp-ok{background:color-mix(in srgb,var(--green) 9%,transparent);border-color:color-mix(in srgb,var(--green) 28%,transparent);}
.cmp-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:13px;}
.cmp-actions .btn{justify-content:center;}
.cmp-full{grid-column:1 / -1;}
.cmp-table-wrap{overflow-x:auto;}
.cmp-region-row{cursor:pointer;}
.cmp-region-row.cmp-sel td{background:color-mix(in srgb,var(--accent) 17%,transparent) !important;}
.cmp-idx{font-weight:800;color:var(--accent-strong);}
.cmp-mono{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px;white-space:nowrap;}
.cmp-empty-row td{text-align:center;color:var(--fg-faint);padding:26px 12px !important;font-size:13px;}
.cmp-legend{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--fg-dim);flex-wrap:wrap;}
.cmp-ramp{width:140px;height:10px;border-radius:5px;background:linear-gradient(90deg,rgb(38,92,220),rgb(255,209,66),rgb(226,54,38));border:1px solid var(--border-strong);flex:none;}
.cmp-mask-swatch{width:13px;height:13px;border-radius:3px;background:rgba(255,66,38,.85);display:inline-block;flex:none;}
.cmp-saved-name{font-weight:650;}
.cmp-saved-sub{font-size:11.5px;color:var(--fg-faint);margin-top:2px;}
.cmp-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.cmp-busy{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--accent-strong);}
.cmp-no-batches{max-width:560px;margin:40px auto;}
.cmp-no-batches .cmp-actions{justify-content:center;display:flex;}
`;

const STYLE_ID = 'cmp-compare-page-style';
function ensureCmpStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CMP_CSS;
  document.head.appendChild(style);
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function nextTick(ms = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function renderComparePage(ctx: PageContext): void | (() => void) {
  ensureCmpStyles();

  const host = h('div', { class: 'cmp-root' });
  ctx.root.appendChild(host);

  // ---- 生命周期 / 异步竞态 ----
  let destroyed = false;
  let runToken = 0;
  let debounceTimer: number | undefined;
  let urlA: string | null = null;
  let urlB: string | null = null;

  // ---- 数据 ----
  let batches: BatchRecord[] = [];
  let savedRecs: ComparisonRecord[] = [];
  let aBatch: BatchRecord | null = null;
  let bBatch: BatchRecord | null = null;
  let aImages: ImageRecord[] = [];
  let bImages: ImageRecord[] = [];
  let imgA: HTMLImageElement | null = null;
  let imgB: HTMLImageElement | null = null;

  // ---- 共同分辨率画布 ----
  let commonW = 0;
  let commonH = 0;
  let baseA: HTMLCanvasElement | null = null;
  let baseB: HTMLCanvasElement | null = null;
  let viewB: HTMLCanvasElement | null = null;
  let viewBCtx: CanvasRenderingContext2D | null = null;
  let heatCanvas: HTMLCanvasElement | null = null;
  let regionCanvas: HTMLCanvasElement | null = null;
  let regionCtx: CanvasRenderingContext2D | null = null;
  let layerA: HTMLCanvasElement | null = null;
  let dividerEl: HTMLElement | null = null;
  let stageEl: HTMLElement | null = null;

  // ---- 可调状态 ----
  let dx = 0;
  let dy = 0;
  let threshold = DEFAULT_RUST_THRESHOLD;
  let opacity = 0.82;
  let minRegionPx = 24;
  let effMm: number | undefined;
  let splitPct = 50;
  let mode: 'overlay' | 'split' = 'overlay';
  let result: RustMaskResult | null = null;
  let analyzed = false;
  let selectedRegion = -1;

  // ---- 动态节点引用 ----
  const stageHost = h('div', { class: 'cmp-stage-host' });
  stageHost.appendChild(
    h('div', { class: 'cmp-msg' }, [
      h('span', { class: 'spinner' }),
      h('div', { class: 'cmp-msg-title' }, '正在打开对比工作台…'),
    ]),
  );

  const batchSelA = h('select', { class: 'input' }) as HTMLSelectElement;
  const batchSelB = h('select', { class: 'input' }) as HTMLSelectElement;
  const photoSelA = h('select', { class: 'input' }) as HTMLSelectElement;
  const photoSelB = h('select', { class: 'input' }) as HTMLSelectElement;
  const metaA = h('div', { class: 'cmp-pick-sub' }, '');
  const metaB = h('div', { class: 'cmp-pick-sub' }, '');

  const dxRange = h('input', { type: 'range', min: -NUDGE_RANGE, max: NUDGE_RANGE, step: 1, value: '0' }) as HTMLInputElement;
  const dyRange = dxRange.cloneNode() as HTMLInputElement;
  const dxNum = h('input', { type: 'number', class: 'input cmp-num', min: -NUDGE_RANGE, max: NUDGE_RANGE, step: 1, value: '0' }) as HTMLInputElement;
  const dyNum = h('input', { type: 'number', class: 'input cmp-num', min: -NUDGE_RANGE, max: NUDGE_RANGE, step: 1, value: '0' }) as HTMLInputElement;

  const thRange = h('input', { type: 'range', min: 0.12, max: 0.8, step: 0.01, value: String(threshold) }) as HTMLInputElement;
  const thOut = h('output', {}, threshold.toFixed(2));
  const opRange = h('input', { type: 'range', min: 0.1, max: 1, step: 0.01, value: String(opacity) }) as HTMLInputElement;
  const opOut = h('output', {}, `${Math.round(opacity * 100)}%`);
  const minRegionOut = h('output', {}, `${minRegionPx} px`);

  const changedVal = h('div', { class: 'v' }, '–');
  const regionVal = h('div', { class: 'v' }, '–');
  const areaVal = h('div', { class: 'v' }, '–');
  const scaleLine = h('div', { class: 'cmp-scale-line' }, '');
  const calibHint = h('div', { class: 'cmp-calib-hint' });

  const regionBody = h('tbody') as HTMLTableSectionElement;
  const savedHost = h('div', { class: 'cmp-table-wrap' });
  const madHint = h('div', { class: 'card-hint', style: { marginTop: '8px' } }, '自动对齐在共同分辨率 ±12px 内搜索灰度 MAD。');
  const busyLine = h('span', { class: 'cmp-busy', style: { visibility: 'hidden' } }, [h('span', { class: 'spinner' }), '分析中…']);

  const genLabel = h('span', {}, '生成高亮');
  const genBtn = h(
    'button',
    { class: 'btn btn-primary cmp-full', onClick: () => void runAnalysis(true) },
    [h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, '🛰️'), genLabel],
  ) as HTMLButtonElement;

  const autoBtn = button('自动对齐', { icon: '🎯', onClick: () => void onAutoAlign() });
  const resetShiftBtn = button('平移归零', { variant: 'ghost', onClick: () => resetShift() });
  const saveBtn = button('保存对比记录', { variant: 'primary', onClick: () => void onSaveRecord() });
  const pngBtn = button('导出叠加 PNG', { onClick: () => exportPng() });
  const jsonBtn = button('导出报告 JSON', { onClick: () => exportJson() });

  const modeOverlayBtn = h('button', { type: 'button', class: 'active', onClick: () => setMode('overlay') }, '叠加高亮') as HTMLButtonElement;
  const modeSplitBtn = h('button', { type: 'button', onClick: () => setMode('split') }, 'A/B 拆分') as HTMLButtonElement;

  /* ---------------- 空状态 / 致命错误 ---------------- */

  function renderNoBatches(): HTMLElement {
    return h('div', { class: 'empty cmp-no-batches card' }, [
      h('div', { class: 'ico' }, '🕓'),
      h('h3', {}, '还需要至少两个拍摄批次'),
      h('p', {}, '两期对比需要同一器物在两个时间点各有一个批次(可在设置页生成合成批次)。'),
      h('div', { class: 'cmp-actions', style: { justifyContent: 'center', marginTop: '16px' } }, [
        button('前往拍摄批次导入 / 生成数据', {
          variant: 'primary',
          icon: '📷',
          onClick: () => ctx.navigate('/batches'),
        }),
      ]),
    ]);
  }

  function renderFatal(e: unknown): HTMLElement {
    return h('div', { class: 'empty card' }, [
      h('div', { class: 'ico' }, '⚠️'),
      h('h3', {}, '对比数据加载失败'),
      h('p', {}, e instanceof Error ? e.message : String(e)),
      h('div', { class: 'cmp-actions', style: { justifyContent: 'center' } }, [
        button('前往拍摄批次', { variant: 'primary', onClick: () => ctx.navigate('/batches') }),
      ]),
    ]);
  }

  /* ---------------- 整体布局 ---------------- */

  function buildLayout(): void {
    // 批次下拉
    for (const b of batches) {
      batchSelA.appendChild(h('option', { value: b.id, selected: b.id === aBatch?.id }, `${b.artifactName || b.name}（${fmtDate(b.createdAt).slice(0, 10)}）`));
      batchSelB.appendChild(h('option', { value: b.id, selected: b.id === bBatch?.id }, `${b.artifactName || b.name}（${fmtDate(b.createdAt).slice(0, 10)}）`));
    }
    batchSelA.addEventListener('change', () => {
      const b = batches.find((x) => x.id === batchSelA.value) ?? null;
      if (!b) return;
      aBatch = b;
      updatePickMeta();
      void loadSide('a', b.id);
    });
    batchSelB.addEventListener('change', () => {
      const b = batches.find((x) => x.id === batchSelB.value) ?? null;
      if (!b) return;
      bBatch = b;
      updatePickMeta();
      void loadSide('b', b.id);
    });
    photoSelA.addEventListener('change', () => {
      const rec = aImages.find((i) => i.id === photoSelA.value) ?? null;
      void activateImage('a', rec);
    });
    photoSelB.addEventListener('change', () => {
      const rec = bImages.find((i) => i.id === photoSelB.value) ?? null;
      void activateImage('b', rec);
    });

    const swapBtn = h(
      'button',
      {
        class: 'btn cmp-swap',
        title: '交换 A / B',
        attrs: { 'aria-label': '交换 A / B' },
        onClick: () => void swapSides(),
      },
      '⇄',
    );

    const pickerCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-body' }, [
        h('div', { class: 'cmp-pick-grid' }, [
          h('div', { class: 'cmp-pick-side' }, [
            h('div', { class: 'cmp-pick-title' }, [badge('A · 早期', 'info'), h('span', { class: 'cmp-pick-sub', style: { margin: '0' } }, aBatch?.name ?? '')]),
            metaA,
            h('div', { class: 'field', style: { marginTop: '8px' } }, [h('label', {}, '批次'), batchSelA]),
            h('div', { class: 'field', style: { marginBottom: '0' } }, [h('label', {}, '代表照片(默认第 0 张)'), photoSelA]),
          ]),
          h('div', { class: 'cmp-swap-col' }, [swapBtn]),
          h('div', { class: 'cmp-pick-side' }, [
            h('div', { class: 'cmp-pick-title' }, [badge('B · 近期', 'warn'), h('span', { class: 'cmp-pick-sub', style: { margin: '0' } }, bBatch?.name ?? '')]),
            metaB,
            h('div', { class: 'field', style: { marginTop: '8px' } }, [h('label', {}, '批次'), batchSelB]),
            h('div', { class: 'field', style: { marginBottom: '0' } }, [h('label', {}, '代表照片(默认第 0 张)'), photoSelB]),
          ]),
        ]),
      ]),
    ]);

    // 舞台卡片
    const stageCard = h('section', { class: 'card cmp-stage-card' }, [
      h('header', { class: 'card-head' }, [
        h('h2', {}, '对比画布'),
        h('div', { class: 'spacer', style: { flex: '1' } }),
        busyLine,
        h('div', { class: 'seg', attrs: { role: 'tablist', 'aria-label': '视图模式' } }, [modeOverlayBtn, modeSplitBtn]),
      ]),
      stageHost,
    ]);

    // 区域表
    const regionCard = h('section', { class: 'card mt16' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '变化区域列表'), h('div', { class: 'spacer', style: { flex: '1' } }), h('span', { class: 'card-hint' }, '点击行在画布上定位')]),
      h('div', { class: 'cmp-table-wrap' }, [
        h('table', { class: 'table' }, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', {}, '#'),
              h('th', {}, '包围盒 x,y · w×h'),
              h('th', {}, '像素数'),
              h('th', {}, '面积'),
              h('th', {}, '平均变化'),
            ]),
          ]),
          regionBody,
        ]),
      ]),
    ]);

    const leftCol = h('div', { class: 'cmp-main-col', style: { minWidth: '0' } }, [stageCard, regionCard]);

    // 对齐卡片
    const alignCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, '对齐微调(B 相对 A)')]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'cmp-nudge' }, [
          h('div', { class: 'cmp-nudge-row' }, [h('span', { class: 'cmp-axis' }, 'X'), dxRange, dxNum]),
          h('div', { class: 'cmp-nudge-row' }, [h('span', { class: 'cmp-axis' }, 'Y'), dyRange, dyNum]),
        ]),
        h('div', { class: 'cmp-btn-row' }, [autoBtn, resetShiftBtn]),
        madHint,
      ]),
    ]);

    // 检测 / 显示卡片
    const detectCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, '检测与显示')]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'cmp-control' }, [
          h('label', { class: 'cmp-ctrl-label' }, [h('span', {}, '变化阈值 threshold'), thOut]),
          thRange,
        ]),
        h('div', { class: 'cmp-control' }, [
          h('label', { class: 'cmp-ctrl-label' }, [h('span', {}, '最小区域(自动)'), minRegionOut]),
        ]),
        h('div', { class: 'cmp-control' }, [
          h('label', { class: 'cmp-ctrl-label' }, [h('span', {}, '热力叠加不透明度'), opOut]),
          opRange,
        ]),
        genBtn,
        h('div', { class: 'cmp-legend', style: { marginTop: '14px' } }, [
          h('span', { class: 'cmp-ramp' }),
          h('span', {}, '低 → 高变化'),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, [h('span', { class: 'cmp-mask-swatch' }), '掩膜']),
        ]),
      ]),
    ]);

    // 统计 / 输出卡片
    const outputCard = h('section', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', {}, '统计与输出')]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'cmp-stats' }, [
          h('div', { class: 'cmp-stat' }, [changedVal, h('div', { class: 'k' }, '变化像素')]),
          h('div', { class: 'cmp-stat' }, [regionVal, h('div', { class: 'k' }, '区域数')]),
          h('div', { class: 'cmp-stat' }, [areaVal, h('div', { class: 'k' }, '总锈蚀面积')]),
        ]),
        scaleLine,
        calibHint,
        h('div', { class: 'cmp-actions' }, [
          saveBtn,
          pngBtn,
          jsonBtn,
        ]),
      ]),
    ]);

    const rightCol = h('div', { class: 'cmp-side' }, [alignCard, detectCard, outputCard]);
    const workbench = h('div', { class: 'cmp-layout' }, [leftCol, rightCol]);

    // 已保存记录
    const savedCard = h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '已保存对比记录'), h('div', { class: 'spacer', style: { flex: '1' } }), h('span', { class: 'card-hint' }, '存于本机 IndexedDB')]),
      h('div', { class: 'card-body tight' }, [savedHost]),
    ]);

    host.replaceChildren(pickerCard, workbench, savedCard);

    bindControlEvents();
    updatePickMeta();
    renderSaved();
    renderStatsPlaceholder();
    renderRegionTable();
    updateCalibHint();
  }

  function renderStatsPlaceholder(): void {
    changedVal.textContent = '–';
    regionVal.textContent = '–';
    areaVal.textContent = '–';
    areaVal.className = 'v';
  }

  /* ---------------- 控件事件 ---------------- */

  function bindControlEvents(): void {
    const applyRangeNudge = (axis: 'x' | 'y') => {
      if (axis === 'x') {
        dx = clampNum(Number(dxRange.value) || 0, -NUDGE_RANGE, NUDGE_RANGE);
        dxNum.value = String(dx);
      } else {
        dy = clampNum(Number(dyRange.value) || 0, -NUDGE_RANGE, NUDGE_RANGE);
        dyNum.value = String(dy);
      }
      redrawViewB();
      scheduleRecompute();
    };
    dxRange.addEventListener('input', () => applyRangeNudge('x'));
    dyRange.addEventListener('input', () => applyRangeNudge('y'));

    dxNum.addEventListener('input', () => {
      dx = clampNum(Math.round(Number(dxNum.value) || 0), -NUDGE_RANGE, NUDGE_RANGE);
      dxRange.value = String(dx);
      redrawViewB();
      scheduleRecompute();
    });
    dyNum.addEventListener('input', () => {
      dy = clampNum(Math.round(Number(dyNum.value) || 0), -NUDGE_RANGE, NUDGE_RANGE);
      dyRange.value = String(dy);
      redrawViewB();
      scheduleRecompute();
    });

    thRange.addEventListener('input', () => {
      threshold = Number(thRange.value);
      thOut.textContent = threshold.toFixed(2);
      scheduleRecompute();
    });
    opRange.addEventListener('input', () => {
      opacity = Number(opRange.value);
      opOut.textContent = `${Math.round(opacity * 100)}%`;
      if (heatCanvas) heatCanvas.style.opacity = String(opacity);
    });
  }

  function scheduleRecompute(): void {
    if (!analyzed || destroyed) return;
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      void runAnalysis(false);
    }, 220);
  }

  function updateNudgeUI(): void {
    dxRange.value = String(dx);
    dyRange.value = String(dy);
    dxNum.value = String(dx);
    dyNum.value = String(dy);
  }

  function resetShift(): void {
    dx = 0;
    dy = 0;
    updateNudgeUI();
    redrawViewB();
    if (analyzed) void runAnalysis(false);
  }

  async function swapSides(): Promise<void> {
    const tb = aBatch;
    aBatch = bBatch;
    bBatch = tb;
    if (aBatch) batchSelA.value = aBatch.id;
    if (bBatch) batchSelB.value = bBatch.id;
    dx = 0;
    dy = 0;
    updateNudgeUI();
    updatePickMeta();
    await Promise.all([loadSide('a', aBatch?.id ?? ''), loadSide('b', bBatch?.id ?? '')]);
  }

  function setMode(next: 'overlay' | 'split'): void {
    mode = next;
    modeOverlayBtn.classList.toggle('active', next === 'overlay');
    modeSplitBtn.classList.toggle('active', next === 'split');
    modeOverlayBtn.setAttribute('aria-pressed', String(next === 'overlay'));
    modeSplitBtn.setAttribute('aria-pressed', String(next === 'split'));
    if (!stageEl || !layerA || !dividerEl) return;
    const split = next === 'split';
    stageEl.classList.toggle('cmp-split', split);
    layerA.style.display = split ? 'block' : 'none';
    dividerEl.style.display = split ? 'block' : 'none';
    const tagA = stageEl.querySelector<HTMLElement>('.cmp-tag-a');
    if (tagA) tagA.style.opacity = split ? '1' : '0.35';
    applySplit();
  }

  function applySplit(): void {
    if (layerA) layerA.style.clipPath = `inset(0 ${100 - splitPct}% 0 0)`;
    if (dividerEl) dividerEl.style.left = `${splitPct}%`;
  }

  /* ---------------- 批次元信息 ---------------- */

  function updatePickMeta(): void {
    if (aBatch) {
      metaA.textContent = `${aBatch.artifactName || '未命名器物'} · ${aBatch.width}×${aBatch.height} · ${(aBatch.capturedAt || '').slice(0, 10)} · ${aBatch.imageIds.length} 张光源照`;
    }
    if (bBatch) {
      metaB.textContent = `${bBatch.artifactName || '未命名器物'} · ${bBatch.width}×${bBatch.height} · ${(bBatch.capturedAt || '').slice(0, 10)} · ${bBatch.imageIds.length} 张光源照`;
    }
  }

  function updateCalibHint(): void {
    calibHint.replaceChildren();
    const calibrated = effMm !== undefined;
    calibHint.classList.toggle('cmp-ok', calibrated);
    const targetId = (bBatch?.mmPerPixel ? bBatch.id : aBatch?.id) ?? bBatch?.id ?? '';
    const link = h('a', { href: `#/annotate/${targetId}` }, '前往「测量标注」校准 mm/px →');
    if (calibrated) {
      calibHint.appendChild(h('div', {}, ['✅ 已检测到比例尺,面积以 mm² 输出。 ', link]));
    } else {
      calibHint.appendChild(h('div', {}, ['⚠️ 两个批次均未设置比例尺,暂以像素面积(px²)显示。', h('br'), link]));
    }
  }

  /* ---------------- 照片加载 ---------------- */

  function photoSelectFor(side: 'a' | 'b'): HTMLSelectElement {
    return side === 'a' ? photoSelA : photoSelB;
  }

  function populatePhotoSelect(side: 'a' | 'b', list: ImageRecord[], selectedId: string | null): ImageRecord | null {
    const sel = photoSelectFor(side);
    sel.replaceChildren();
    if (list.length === 0) {
      sel.appendChild(h('option', { value: '' }, '（该批次没有照片）'));
      sel.disabled = true;
      return null;
    }
    sel.disabled = false;
    for (const im of list) {
      sel.appendChild(
        h('option', { value: im.id, selected: im.id === selectedId }, `#${im.index + 1} ${im.name || 'IMG'}`),
      );
    }
    const rec = list.find((i) => i.id === selectedId) ?? list[0] ?? null;
    if (rec) sel.value = rec.id;
    return rec;
  }

  async function loadSide(side: 'a' | 'b', batchId: string, preferredImageId?: string): Promise<void> {
    try {
      const list = (await dbApi.images.listByBatch(batchId)).slice().sort((x, y) => x.index - y.index);
      if (destroyed) return;
      if (side === 'a') aImages = list;
      else bImages = list;
      const preferred = preferredImageId ?? list[0]?.id ?? null;
      const rec = populatePhotoSelect(side, list, preferred);
      await activateImage(side, rec);
    } catch (e) {
      if (!destroyed) {
        toast(`照片列表加载失败:${e instanceof Error ? e.message : String(e)}`, 'err');
        showStageError('照片列表加载失败', e);
      }
    }
  }

  async function activateImage(side: 'a' | 'b', rec: ImageRecord | null): Promise<void> {
    if (!rec) {
      showStageMessage('🖼️', '该批次没有可用照片', '请先在「拍摄批次」中导入或生成照片。');
      return;
    }
    const oldUrl = side === 'a' ? urlA : urlB;
    try {
      const url = URL.createObjectURL(rec.blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = url;
      });
      if (destroyed) {
        URL.revokeObjectURL(url);
        return;
      }
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      if (side === 'a') {
        urlA = url;
        imgA = img;
      } else {
        urlB = url;
        imgB = img;
      }
      if (imgA && imgB) buildStage();
      else showStageMessage('⏳', '正在等待另一期照片加载…');
    } catch (e) {
      toast(`照片「${rec.name}」加载失败`, 'err', 4200);
      const existing = side === 'a' ? imgA : imgB;
      if (!existing) showStageError(`照片「${rec.name}」无法显示`, e);
    }
  }

  /* ---------------- 舞台 / 画布构建 ---------------- */

  function showStageMessage(icon: string, title: string, sub?: string): void {
    stageHost.replaceChildren(
      h('div', { class: 'cmp-msg' }, [
        h('div', { class: 'cmp-msg-ico' }, icon),
        h('div', { class: 'cmp-msg-title' }, title),
        sub ? h('div', {}, sub) : null,
      ]),
    );
  }

  function showStageError(title: string, e: unknown): void {
    stageHost.replaceChildren(
      h('div', { class: 'cmp-msg cmp-err' }, [
        h('div', { class: 'cmp-msg-ico' }, '⚠️'),
        h('div', { class: 'cmp-msg-title' }, title),
        h('div', {}, e instanceof Error ? e.message : String(e)),
      ]),
    );
  }

  function computeCommonSize(): void {
    const bw = aBatch?.width || imgA?.naturalWidth || MAX_COMMON_EDGE;
    const bh = aBatch?.height || imgA?.naturalHeight || 900;
    const longEdge = Math.max(bw, bh);
    const scale = longEdge > MAX_COMMON_EDGE ? MAX_COMMON_EDGE / longEdge : 1;
    commonW = Math.max(1, Math.round(bw * scale));
    commonH = Math.max(1, Math.round(bh * scale));
    minRegionPx = Math.max(24, Math.round(commonW * commonH * 0.00008));
    minRegionOut.textContent = `${minRegionPx} px`;
  }

  function computeScaleInfo(): void {
    const calibratedBatch = bBatch?.mmPerPixel ? bBatch : aBatch?.mmPerPixel ? aBatch : null;
    if (calibratedBatch && calibratedBatch.mmPerPixel && calibratedBatch.width > 0) {
      const fitScale = Math.min(commonW / calibratedBatch.width, commonH / calibratedBatch.height);
      effMm = calibratedBatch.mmPerPixel / Math.max(fitScale, 1e-6);
      scaleLine.textContent = `共同分辨率 ${commonW}×${commonH} · 1 共同像素 ≈ ${effMm.toFixed(4)} mm`;
    } else {
      effMm = undefined;
      scaleLine.textContent = `共同分辨率 ${commonW}×${commonH}(未校准比例尺)`;
    }
    updateCalibHint();
  }

  function drawContain(src: HTMLImageElement): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = commonW;
    c.height = commonH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建离屏 2D 上下文');
    const nw = src.naturalWidth || commonW;
    const nh = src.naturalHeight || commonH;
    const fit = Math.min(commonW / nw, commonH / nh);
    const dw = nw * fit;
    const dh = nh * fit;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (commonW - dw) / 2, (commonH - dh) / 2, dw, dh);
    return c;
  }

  function buildStage(): void {
    if (!imgA || !imgB) return;
    runToken++; // 使旧分析失效
    analyzed = false;
    result = null;
    selectedRegion = -1;
    dx = 0;
    dy = 0;
    updateNudgeUI();

    computeCommonSize();
    computeScaleInfo();

    baseA = drawContain(imgA);
    baseB = drawContain(imgB);

    viewB = document.createElement('canvas');
    viewB.width = commonW;
    viewB.height = commonH;
    viewBCtx = viewB.getContext('2d', { willReadFrequently: true });
    if (!viewBCtx) throw new Error('无法创建 B 视图上下文');
    viewB.className = 'cmp-base';

    heatCanvas = document.createElement('canvas');
    heatCanvas.width = commonW;
    heatCanvas.height = commonH;
    heatCanvas.className = 'cmp-layer';
    heatCanvas.style.opacity = String(opacity);

    regionCanvas = document.createElement('canvas');
    regionCanvas.width = commonW;
    regionCanvas.height = commonH;
    regionCanvas.className = 'cmp-layer';
    regionCtx = regionCanvas.getContext('2d');

    baseA.className = 'cmp-layer';
    layerA = baseA;

    dividerEl = h('div', { class: 'cmp-divider' });
    const tagA = h('span', { class: 'cmp-tag cmp-tag-a' }, '早期 A');
    const tagB = h('span', { class: 'cmp-tag cmp-tag-b' }, '近期 B');

    stageEl = h('div', { class: 'cmp-stage' }, [viewB, baseA, heatCanvas, regionCanvas, tagA, tagB, dividerEl]);
    stageEl.addEventListener('pointerdown', onStagePointerDown);
    stageHost.replaceChildren(stageEl);

    setMode(mode);
    redrawViewB();
    renderStatsPlaceholder();
    renderRegionTable();
    drawRegionOverlay();

    void runAnalysis(true);
  }

  function redrawViewB(): void {
    if (!viewB || !viewBCtx || !baseB) return;
    viewBCtx.clearRect(0, 0, commonW, commonH);
    viewBCtx.drawImage(baseB, dx, dy);
  }

  function onStagePointerDown(e: PointerEvent): void {
    if (mode !== 'split' || !stageEl) return;
    e.preventDefault();
    const el = stageEl;
    const update = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      splitPct = clampNum(((clientX - rect.left) / rect.width) * 100, 0, 100);
      applySplit();
    };
    update(e.clientX);
    const onMove = (ev: PointerEvent) => update(ev.clientX);
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  /* ---------------- 自动对齐 ---------------- */

  function canvasToRgba(c: HTMLCanvasElement): RgbaImage {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法读取画布像素');
    const im = ctx.getImageData(0, 0, c.width, c.height);
    return { width: c.width, height: c.height, data: im.data };
  }

  async function onAutoAlign(): Promise<void> {
    if (!baseA || !baseB) {
      toast('照片尚未加载完成', 'err');
      return;
    }
    const oldLabel = autoBtn.textContent;
    autoBtn.disabled = true;
    autoBtn.textContent = '搜索中…';
    await nextTick(30);
    try {
      const shift = searchTranslation(canvasToRgba(baseA), canvasToRgba(baseB), 12);
      dx = clampNum(shift.dx, -NUDGE_RANGE, NUDGE_RANGE);
      dy = clampNum(shift.dy, -NUDGE_RANGE, NUDGE_RANGE);
      updateNudgeUI();
      redrawViewB();
      madHint.textContent = `最佳平移 dx=${shift.dx}, dy=${shift.dy}(共同分辨率 px) · 归一化 MAD=${shift.mad.toFixed(4)}`;
      toast(`自动对齐完成:(${shift.dx}, ${shift.dy})`, 'ok');
      if (analyzed) await runAnalysis(false);
    } catch (e) {
      toast(`自动对齐失败:${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      autoBtn.disabled = false;
      autoBtn.textContent = oldLabel ?? '自动对齐';
    }
  }

  /* ---------------- 分析 ---------------- */

  function setBusy(busy: boolean): void {
    genBtn.disabled = busy;
    genLabel.textContent = busy ? '分析中…' : analyzed ? '重新生成高亮' : '生成高亮';
    (busyLine as HTMLElement).style.visibility = busy ? 'visible' : 'hidden';
  }

  async function runAnalysis(manual: boolean): Promise<void> {
    if (destroyed) return;
    if (!baseA || !viewB || !viewBCtx || commonW === 0) {
      if (manual) toast('请先选择两期照片', 'err');
      return;
    }
    const my = ++runToken;
    setBusy(true);
    await nextTick(28);
    try {
      redrawViewB();
      const dataA = canvasToRgba(baseA);
      const dataB: RgbaImage = {
        width: commonW,
        height: commonH,
        data: viewBCtx.getImageData(0, 0, commonW, commonH).data,
      };
      const res = computeRustChanges(dataA, dataB, {
        threshold,
        minRegionPx,
        mmPerPixel: effMm,
      });
      if (destroyed || my !== runToken) return;

      result = res;
      analyzed = true;
      selectedRegion = -1;

      if (heatCanvas) {
        const heat = drawHeatmapOverlay(res.score, res.mask, commonW, commonH);
        const hctx = heatCanvas.getContext('2d');
        if (hctx) {
          hctx.clearRect(0, 0, commonW, commonH);
          hctx.drawImage(heat, 0, 0);
        }
      }
      renderStats();
      renderRegionTable();
      drawRegionOverlay();
      if (manual) toast(`检测完成:${res.regions.length} 个区域 / ${res.changedPixels} 变化像素`, 'ok', 2400);
    } catch (e) {
      if (!destroyed && my === runToken) {
        toast(`分析失败:${e instanceof Error ? e.message : String(e)}`, 'err', 5000);
      }
    } finally {
      if (!destroyed && my === runToken) setBusy(false);
    }
  }

  function renderStats(): void {
    if (!result) return;
    changedVal.textContent = result.changedPixels.toLocaleString();
    regionVal.textContent = String(result.regions.length);
    if (effMm && effMm > 0) {
      const mm2 = result.changedPixels * effMm * effMm;
      areaVal.textContent = mm2 >= 100 ? `${(mm2 / 100).toFixed(2)} cm²` : `${mm2.toFixed(2)} mm²`;
      areaVal.className = 'v good';
    } else {
      areaVal.textContent = `${result.changedPixels.toLocaleString()} px²`;
      areaVal.className = 'v warn';
    }
  }

  /* ---------------- 区域表 + 矩形覆盖层 ---------------- */

  function renderRegionTable(): void {
    regionBody.replaceChildren();
    if (!result) {
      regionBody.appendChild(
        h('tr', { class: 'cmp-empty-row' }, [h('td', { attrs: { colspan: 5 } }, '点击「生成高亮」开始分析')]),
      );
      return;
    }
    if (result.regions.length === 0) {
      regionBody.appendChild(
        h('tr', { class: 'cmp-empty-row' }, [h('td', { attrs: { colspan: 5 } }, '未检出显著变化,可适当降低阈值后重试')]),
      );
      return;
    }
    result.regions.forEach((r, i) => {
      const tr = h(
        'tr',
        {
          class: `cmp-region-row${i === selectedRegion ? ' cmp-sel' : ''}`,
          onClick: () => selectRegion(i),
        },
        [
          h('td', {}, h('span', { class: 'cmp-idx' }, `#${i + 1}`)),
          h('td', { class: 'cmp-mono' }, `(${r.x}, ${r.y}) ${r.w}×${r.h}`),
          h('td', { class: 'cmp-mono' }, r.pixels.toLocaleString()),
          h('td', { class: 'cmp-mono' }, r.areaMm2 !== undefined ? `${r.areaMm2.toFixed(2)} mm²` : `${r.pixels} px²`),
          h('td', { class: 'cmp-mono' }, r.meanDelta.toFixed(3)),
        ],
      );
      regionBody.appendChild(tr);
    });
  }

  function selectRegion(i: number): void {
    selectedRegion = i;
    const rows = regionBody.querySelectorAll<HTMLElement>('tr.cmp-region-row');
    rows.forEach((row, idx) => row.classList.toggle('cmp-sel', idx === i));
    drawRegionOverlay();
    stageEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function drawRegionOverlay(): void {
    if (!regionCanvas || !regionCtx || commonW === 0) return;
    const ctx = regionCtx;
    ctx.clearRect(0, 0, commonW, commonH);
    if (!result) return;
    const lw = Math.max(1.2, commonW / 850);
    const fs = Math.max(12, Math.round(commonW / 52));
    ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';

    result.regions.forEach((r: RustRegion, i: number) => {
      const sel = i === selectedRegion;
      ctx.lineWidth = sel ? lw * 2.4 : lw;
      ctx.strokeStyle = sel ? 'rgba(255,211,77,0.98)' : 'rgba(255,96,58,0.92)';
      ctx.fillStyle = sel ? 'rgba(255,211,77,0.16)' : 'rgba(255,80,48,0.07)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));

      // 编号小徽标
      const label = String(i + 1);
      const tw = ctx.measureText(label).width;
      const padX = 6;
      const chipW = tw + padX * 2;
      const chipH = fs + 6;
      let cx = r.x;
      let cy = r.y - chipH - 3;
      if (cy < 0) cy = r.y + 3;
      if (cx + chipW > commonW) cx = commonW - chipW - 2;
      ctx.fillStyle = sel ? 'rgba(120,84,0,0.92)' : 'rgba(150,32,16,0.9)';
      ctx.beginPath();
      const rr = 5;
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(cx, cy, chipW, chipH, rr);
      } else {
        ctx.rect(cx, cy, chipW, chipH);
      }
      ctx.fill();
      ctx.fillStyle = sel ? '#ffe9a3' : '#ffe2d8';
      ctx.fillText(label, cx + padX, cy + chipH / 2 + 0.5);
    });
  }

  /* ---------------- 保存 / 导出 ---------------- */

  function fileBase(): string {
    const name = aBatch?.artifactName || aBatch?.name || 'artifact';
    const ids = `${(aBatch?.id ?? '').slice(-4)}_${(bBatch?.id ?? '').slice(-4)}`;
    return `rust-compare-${name}-${ids}`.replace(/[\\/:*?"<>|\s]+/g, '_');
  }

  async function onSaveRecord(): Promise<void> {
    if (!aBatch || !bBatch) {
      toast('批次尚未就绪', 'err');
      return;
    }
    saveBtn.disabled = true;
    try {
      let overlayBlob: Blob | undefined;
      if (heatCanvas) {
        const hc = heatCanvas;
        const blob = await new Promise<Blob | null>((resolve) => hc.toBlob((b) => resolve(b), 'image/png'));
        if (blob) overlayBlob = blob;
      }
      const rec: ComparisonRecord = {
        id: uid('cmp'),
        name: `${aBatch.artifactName || aBatch.name} 锈蚀对比`,
        batchAId: aBatch.id,
        batchBId: bBatch.id,
        createdAt: new Date().toISOString(),
        threshold,
        regions: result?.regions ?? [],
        overlayBlob,
      };
      await dbApi.comparisons.put(rec);
      savedRecs = await dbApi.comparisons.list();
      renderSaved();
      toast('对比记录已保存到 IndexedDB', 'ok');
    } catch (e) {
      toast(`保存失败:${e instanceof Error ? e.message : String(e)}`, 'err', 4500);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function exportPng(): void {
    if (!viewB || commonW === 0) {
      toast('画布尚未就绪', 'err');
      return;
    }
    try {
      const out = document.createElement('canvas');
      out.width = commonW;
      out.height = commonH;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('无法创建导出上下文');
      ctx.drawImage(viewB, 0, 0);
      if (heatCanvas) ctx.drawImage(heatCanvas, 0, 0);
      if (regionCanvas) ctx.drawImage(regionCanvas, 0, 0);
      out.toBlob((blob) => {
        if (!blob) {
          toast('PNG 导出失败', 'err');
          return;
        }
        downloadBlob(blob, `${fileBase()}.png`);
        toast('叠加 PNG 已导出', 'ok');
      }, 'image/png');
    } catch (e) {
      toast(`导出失败:${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  function exportJson(): void {
    if (!aBatch || !bBatch) {
      toast('批次尚未就绪', 'err');
      return;
    }
    const mm2 = effMm && result ? result.changedPixels * effMm * effMm : undefined;
    const report = {
      type: 'rti-rust-comparison-report',
      app: '文保 RTI Studio',
      exportedAt: new Date().toISOString(),
      name: `${aBatch.artifactName || aBatch.name} 锈蚀对比`,
      batchA: {
        id: aBatch.id,
        name: aBatch.name,
        artifactName: aBatch.artifactName,
        capturedAt: aBatch.capturedAt,
        mmPerPixel: aBatch.mmPerPixel ?? null,
      },
      batchB: {
        id: bBatch.id,
        name: bBatch.name,
        artifactName: bBatch.artifactName,
        capturedAt: bBatch.capturedAt,
        mmPerPixel: bBatch.mmPerPixel ?? null,
      },
      commonResolution: { width: commonW, height: commonH },
      alignment: { dx, dy, frame: 'common-resolution pixels; B drawn at (dx,dy)' },
      threshold,
      minRegionPx,
      mmPerCommonPixel: effMm ?? null,
      stats: result
        ? {
            changedPixels: result.changedPixels,
            regionCount: result.regions.length,
            totalAreaMm2: mm2 ?? null,
          }
        : null,
      regions: result?.regions ?? [],
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${fileBase()}-report.json`);
    toast('报告 JSON 已导出', 'ok');
  }

  /* ---------------- 已保存记录 ---------------- */

  function renderSaved(): void {
    savedHost.replaceChildren();
    const recs = savedRecs.slice().sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
    if (recs.length === 0) {
      savedHost.appendChild(h('div', { class: 'empty', style: { padding: '26px 16px' } }, [
        h('p', { class: 'muted' }, '暂无保存的对比记录。生成高亮后点击「保存对比记录」。'),
      ]));
      return;
    }
    const rows = recs.map((rec) =>
      h('tr', {}, [
        h('td', {}, [
          h('div', { class: 'cmp-saved-name' }, rec.name),
          h('div', { class: 'cmp-saved-sub' }, `${rec.batchAId.slice(-6)} → ${rec.batchBId.slice(-6)} · 阈值 ${rec.threshold.toFixed(2)}`),
        ]),
        h('td', { class: 'cmp-mono' }, fmtDate(rec.createdAt)),
        h('td', { class: 'cmp-mono' }, String(rec.regions?.length ?? 0)),
        h('td', { class: 'actions' }, [
          h(
            'button',
            {
              class: 'btn btn-danger btn-subtle',
              onClick: () => void onDeleteSaved(rec),
            },
            '删除',
          ),
        ]),
      ]),
    );
    savedHost.appendChild(
      h('table', { class: 'table' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, '名称'), h('th', {}, '创建时间'), h('th', {}, '区域'), h('th', { class: 'right' }, '操作')])]),
        h('tbody', {}, rows),
      ]),
    );
  }

  async function onDeleteSaved(rec: ComparisonRecord): Promise<void> {
    const ok = await confirmDialog(`确定删除对比记录「${rec.name}」?此操作不可撤销。`, '删除对比记录');
    if (!ok) return;
    try {
      await dbApi.comparisons.del(rec.id);
      savedRecs = savedRecs.filter((x) => x.id !== rec.id);
      renderSaved();
      toast('对比记录已删除', 'ok');
    } catch (e) {
      toast(`删除失败:${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  /* ---------------- 启动 ---------------- */

  void (async () => {
    try {
      const [allBatches, comparisons] = await Promise.all([
        dbApi.batches.list(),
        dbApi.comparisons.list(),
      ]);
      if (destroyed) return;
      batches = allBatches;
      savedRecs = comparisons;

      if (batches.length < 2) {
        host.replaceChildren(renderNoBatches());
        return;
      }

      const sorted = batches.slice().sort((x, y) => x.createdAt - y.createdAt);
      const paramId = ctx.params.id;
      aBatch = (paramId ? batches.find((b) => b.id === paramId) : undefined) ?? sorted[0];
      bBatch = sorted.find((b) => b.id !== aBatch?.id) ?? sorted[1] ?? sorted[0];

      buildLayout();
      await Promise.all([loadSide('a', aBatch.id), loadSide('b', bBatch.id)]);
    } catch (e) {
      if (!destroyed) host.replaceChildren(renderFatal(e));
    }
  })();

  return () => {
    destroyed = true;
    runToken++;
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    if (urlA) URL.revokeObjectURL(urlA);
    if (urlB) URL.revokeObjectURL(urlB);
  };
}
