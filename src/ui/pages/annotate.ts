import { h, clear, button, badge, toast, fmtDate, confirmDialog } from '../dom';
import type { PageContext } from '../../main';
import { dbApi, uid } from '../../core/db';
import type { AnnotationRecord, BatchRecord, ImageRecord, ResultRecord, SettingsRecord } from '../../core/types';
import {
  KIND_META,
  TOOLS,
  dist,
  formatMm,
  injectAnnotateStyles,
  isCalibrated,
  linePxLength,
  roundPt,
  titleText,
  toolHint,
  type Pt,
  type ToolId,
} from '../annotation/shared';
import { knownMmDialog, promptModal, type PromptDialog } from '../annotation/dialogs';
import { exportAnnotationsCsv, exportAnnotationsJson, exportOverlayPng } from '../annotation/exporters';
import { annotationSvg, armedSvg, createSvgElement, draftSvg } from '../annotation/svgView';

const MIN_LINE_PX = 4;

/** dom.badge 的 tone 不含 accent,这里用等价的 badge-accent 样式 */
function accentBadge(text: string): HTMLElement {
  return h('span', { class: 'badge badge-accent' }, text);
}

type Interaction =
  | { mode: 'draw'; p0: Pt; p1: Pt; moved: boolean }
  | { mode: 'handle'; annId: string; index: number };

interface PageState {
  batches: BatchRecord[];
  batch: BatchRecord | null;
  images: ImageRecord[];
  imageUrls: string[];
  annotations: AnnotationRecord[];
  results: ResultRecord[];
  author: string;
  tool: ToolId;
  selectedId: string | null;
  lastMeasureId: string | null;
  imageIndex: number;
  viewMode: 'original' | 'normal';
  normalUrl: string | null;
  W: number;
  H: number;
}

interface Refs {
  stage?: HTMLElement;
  frame?: HTMLElement;
  img?: HTMLImageElement;
  svg?: SVGSVGElement;
  coords?: HTMLElement;
  hint?: HTMLElement;
  list?: HTMLElement;
  measureValue?: HTMLElement;
  measureSub?: HTMLElement;
  calibBadges?: HTMLElement;
  mmppInput?: HTMLInputElement;
}

export function renderAnnotatePage(ctx: PageContext): void | (() => void) {
  injectAnnotateStyles();

  let disposed = false;
  const urlSet = new Set<string>();
  const trackUrl = (blob: Blob): string => {
    const u = URL.createObjectURL(blob);
    urlSet.add(u);
    return u;
  };

  const state: PageState = {
    batches: [],
    batch: null,
    images: [],
    imageUrls: [],
    annotations: [],
    results: [],
    author: '研究员',
    tool: 'length',
    selectedId: null,
    lastMeasureId: null,
    imageIndex: 0,
    viewMode: 'original',
    normalUrl: null,
    W: 0,
    H: 0,
  };
  const refs: Refs = {};
  let armed: Pt | null = null;
  let interaction: Interaction | null = null;
  let activeDialog: PromptDialog | null = null;
  const resizeObserver = new ResizeObserver(() => fitFrame());

  // ---------- 初始骨架 ----------
  clear(ctx.root);
  ctx.root.appendChild(renderLoading());

  void init();

  window.addEventListener('pointermove', onWinPointerMove);
  window.addEventListener('pointerup', onWinPointerUp);
  window.addEventListener('pointercancel', onWinPointerUp);
  window.addEventListener('keydown', onKeyDown);

  return function cleanup() {
    disposed = true;
    window.removeEventListener('pointermove', onWinPointerMove);
    window.removeEventListener('pointerup', onWinPointerUp);
    window.removeEventListener('pointercancel', onWinPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    resizeObserver.disconnect();
    try {
      activeDialog?.close();
    } catch {
      /* ignore */
    }
    urlSet.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    });
    urlSet.clear();
  };

  // ============================================================
  // 数据初始化 / 路由参数解析
  // ============================================================
  async function init(): Promise<void> {
    try {
      const [batches, settingsRaw] = await Promise.all([dbApi.batches.list(), dbApi.settings.get()]);
      if (disposed) return;
      state.batches = batches.sort((a, b) => b.createdAt - a.createdAt);
      // db.ts 的 kvGet 实际返回 { id, value } 包装,这里同时兼容包装/扁平/默认三种形态
      const settings = settingsRaw as unknown as SettingsRecord | { value?: SettingsRecord } | undefined;
      const s: SettingsRecord | undefined =
        settings && typeof settings === 'object' && 'value' in settings && settings.value ? settings.value : (settings as SettingsRecord | undefined);
      state.author = s?.author?.trim() || '研究员';

      let targetBatchId: string | undefined;
      let notice: string | undefined;
      const routeId = ctx.params.id;
      if (routeId) {
        const result = await dbApi.results.get(routeId).catch(() => undefined);
        if (result) {
          targetBatchId = result.batchId;
        } else {
          const batch = await dbApi.batches.get(routeId).catch(() => undefined);
          if (batch) targetBatchId = batch.id;
          else notice = '未找到对应的批次或拟合结果,请从下面的列表中选择一个批次。';
        }
      }
      if (disposed) return;

      if (!targetBatchId) {
        renderChooser(notice);
        return;
      }
      await openBatch(targetBatchId);
    } catch (err) {
      if (!disposed) renderFatal(err);
    }
  }

  async function openBatch(batchId: string): Promise<void> {
    const batch = await dbApi.batches.get(batchId).catch(() => undefined);
    if (disposed) return;
    if (!batch) {
      renderChooser('批次不存在或已被删除,请重新选择。');
      return;
    }
    state.batch = batch;

    const [images, anns, results] = await Promise.all([
      dbApi.images.listByBatch(batchId).catch(() => [] as ImageRecord[]),
      dbApi.annotations.listByTarget(batchId).catch(() => [] as AnnotationRecord[]),
      dbApi.results.listByBatch(batchId).catch(() => [] as ResultRecord[]),
    ]);
    if (disposed) return;

    state.images = images.sort((a, b) => a.index - b.index);
    state.imageUrls = state.images.map((im) => (im.blob instanceof Blob ? trackUrl(im.blob) : ''));
    state.annotations = anns.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    state.results = results;
    const normalBlob = results.find((r) => r.normalBlob instanceof Blob)?.normalBlob ?? null;
    state.normalUrl = normalBlob instanceof Blob ? trackUrl(normalBlob) : null;
    state.W = batch.width > 0 ? batch.width : state.images[0]?.width ?? 0;
    state.H = batch.height > 0 ? batch.height : state.images[0]?.height ?? 0;
    state.imageIndex = 0;
    state.viewMode = 'original';
    state.selectedId = null;
    state.lastMeasureId = null;
    armed = null;
    interaction = null;
    buildWorkbench();
  }

  // ============================================================
  // 通用视图
  // ============================================================
  function renderLoading(): HTMLElement {
    return h('div', { class: 'ann-loading' }, [h('span', { class: 'spinner' }), h('div', {}, '正在加载测量标注工作台…')]);
  }

  function renderFatal(err: unknown): void {
    clear(ctx.root);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.root.appendChild(
      h('div', { class: 'empty', dataset: { testid: 'annotate-error' } }, [
        h('div', { class: 'ico' }, '⚠️'),
        h('h3', {}, '标注工作台加载失败'),
        h('p', {}, msg || '未知错误'),
        h('div', { class: 'mt16' }, [
          button('重试', {
            variant: 'primary',
            onClick: () => {
              clear(ctx.root);
              ctx.root.appendChild(renderLoading());
              void init();
            },
          }),
        ]),
      ]),
    );
  }

  function renderChooser(notice?: string): void {
    clear(ctx.root);
    resizeObserver.disconnect();

    if (state.batches.length === 0) {
      ctx.root.appendChild(
        h('div', { class: 'empty', dataset: { testid: 'batch-empty' } }, [
          h('div', { class: 'ico' }, '📏'),
          h('h3', {}, '还没有可标注的批次'),
          h('p', {}, '请先导入多光源照片创建拍摄批次,再进行比例尺标定与测量标注。'),
          notice ? h('p', { class: 'text-warn' }, notice) : null,
          h('div', { class: 'mt16' }, [
            button('去导入批次', {
              variant: 'primary',
              icon: '📷',
              onClick: () => ctx.navigate('#/batches'),
            }),
          ]),
        ]),
      );
      return;
    }

    const grid = h(
      'div',
      { class: 'batch-grid', dataset: { testid: 'batch-chooser' } },
      state.batches.map((b) => {
        const thumb = typeof b.thumbnail === 'string' && b.thumbnail
          ? h('div', { class: 'batch-thumb ann-bc-thumb' }, [h('img', { src: b.thumbnail, alt: b.name })])
          : h('div', { class: 'batch-thumb ann-bc-thumb' }, [h('div', { class: 'ph' }, '📷')]);
        return h(
          'section',
          {
            class: 'card batch-card ann-batch-card',
            dataset: { testid: 'batch-card', id: b.id },
            onClick: () => ctx.navigate(`#/annotate/${encodeURIComponent(b.id)}`),
          },
          [
            thumb,
            h('div', { class: 'ann-bc-foot' }, [
              h('div', { class: 'ann-bc-name', title: b.name }, b.name),
              h('div', { class: 'ann-bc-row' }, [h('span', {}, b.artifactName || '未命名器物'), h('span', {}, `${b.imageIds?.length ?? 0} 张`)]),
              h('div', { class: 'ann-bc-row' }, [
                h('span', {}, `${b.width || '?'}×${b.height || '?'}`),
                isCalibrated(b) ? h('span', { class: 'text-good' }, b.scaleLabel || '已标定') : h('span', { class: 'text-dim' }, '未标定'),
              ]),
            ]),
          ],
        );
      }),
    );

    const chooserSelect = h(
      'select',
      {
        class: 'input',
        style: { maxWidth: '420px' },
        dataset: { testid: 'chooser-select' },
        attrs: { 'aria-label': '选择标注批次' },
        onChange: (e: Event) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (v) ctx.navigate(`#/annotate/${encodeURIComponent(v)}`);
        },
      },
      [
        h('option', { value: '' }, `共 ${state.batches.length} 个批次,请选择…`),
        ...state.batches.map((b) => h('option', { value: b.id }, b.name)),
      ],
    ) as HTMLSelectElement;

    ctx.root.appendChild(
      h('div', { class: 'ann-root' }, [
        h('div', { class: 'ann-chooser-head' }, [
          h('h2', {}, '选择标注批次'),
          h('p', {}, '选择一个拍摄批次进入测量标注;比例尺、测量线与备注都会保存在该批次上。'),
          h('div', { class: 'ann-chooser-select mt12' }, [chooserSelect]),
          notice ? h('div', { class: 'mt8' }, [badge(notice, 'warn')]) : null,
        ]),
        grid,
      ]),
    );
  }

  // ============================================================
  // 工作台整体渲染
  // ============================================================
  function rerender(): void {
    if (disposed) return;
    if (!state.batch) {
      renderChooser();
      return;
    }
    buildWorkbench();
  }

  function buildWorkbench(): void {
    const batch = state.batch;
    if (!batch) {
      renderChooser();
      return;
    }

    // 重置 refs
    refs.stage = undefined;
    refs.frame = undefined;
    refs.img = undefined;
    refs.svg = undefined;
    refs.coords = undefined;
    refs.hint = undefined;
    refs.list = undefined;
    refs.measureValue = undefined;
    refs.measureSub = undefined;
    refs.calibBadges = undefined;
    refs.mmppInput = undefined;
    resizeObserver.disconnect();

    clear(ctx.root);

    const wrap = h('div', { class: 'ann-root', dataset: { testid: 'annotate-page' } }, [
      buildHead(batch),
      h('div', { class: 'workbench annotate' }, [buildLeft(batch), buildRight(batch)]),
    ]);
    ctx.root.appendChild(wrap);

    if (refs.stage) resizeObserver.observe(refs.stage);
    fitFrame();
    requestAnimationFrame(() => fitFrame());
    paintOverlay();
    paintList();
    paintCalib();
    paintMeasure();
  }

  function buildHead(batch: BatchRecord): HTMLElement {
    const select = h(
      'select',
      {
        class: 'input ann-batch-select',
        dataset: { testid: 'batch-select' },
        attrs: { 'aria-label': '切换批次' },
        onChange: (e: Event) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          if (v && v !== batch.id) ctx.navigate(`#/annotate/${encodeURIComponent(v)}`);
        },
      },
      state.batches.map((b) =>
        h('option', { value: b.id, selected: b.id === batch.id ? true : undefined }, `${b.name}（${b.imageIds?.length ?? 0} 张）`),
      ),
    ) as HTMLSelectElement;

    const headCount = state.annotations.length ? accentBadge(`${state.annotations.length} 条标注`) : null;
    if (headCount) headCount.dataset.testid = 'head-ann-count';

    const headChildren: (Node | string | null)[] = [
      h('span', { class: 'ann-title' }, ['📏 ', batch.name]),
      select,
      h('div', { class: 'ann-meta' }, [
        badge(`${batch.width || '?'}×${batch.height || '?'} px`, 'info'),
        badge(`${state.images.length} 张照片`, 'muted'),
        headCount,
      ]),
      h('div', { class: 'spacer' }),
    ];

    if (state.normalUrl) {
      headChildren.push(
        h('div', { class: 'seg ann-view-seg', dataset: { testid: 'view-seg' } }, [
          h(
            'button',
            {
              class: state.viewMode === 'original' ? 'active' : '',
              onClick: () => {
                state.viewMode = 'original';
                rerender();
              },
            },
            '原图',
          ),
          h(
            'button',
            {
              class: state.viewMode === 'normal' ? 'active' : '',
              onClick: () => {
                state.viewMode = 'normal';
                rerender();
              },
            },
            '法线图',
          ),
        ]),
      );
    }

    return h('div', { class: 'card ann-head' }, headChildren);
  }

  function currentImageUrl(): string | null {
    if (state.viewMode === 'normal') return state.normalUrl;
    return state.imageUrls[state.imageIndex] ?? null;
  }

  function buildLeft(batch: BatchRecord): HTMLElement {
    const url = currentImageUrl();

    let stage: HTMLElement;
    if (!url) {
      stage = h('div', { class: 'stage ann-stage', dataset: { testid: 'annotation-stage' } }, [
        h('div', { class: 'empty' }, [
          h('div', { class: 'ico' }, '🖼️'),
          h('h3', {}, '该批次还没有可标注的照片'),
          h('p', {}, '请先到「拍摄批次」页导入照片,再回来进行测量标注。'),
          h('div', { class: 'mt12' }, [
            button('去导入照片', { variant: 'primary', onClick: () => ctx.navigate('#/batches') }),
          ]),
        ]),
      ]);
      refs.stage = stage;
    } else {
      const img = h('img', {
        class: 'ann-img',
        alt: `${batch.name} 标注底图`,
        src: url,
        draggable: false,
        dataset: { testid: 'base-image' },
      }) as HTMLImageElement;
      img.addEventListener('load', () => {
        if ((!state.W || !state.H) && img.naturalWidth > 0) {
          state.W = img.naturalWidth;
          state.H = img.naturalHeight;
          refs.svg?.setAttribute('viewBox', `0 0 ${state.W} ${state.H}`);
        }
        fitFrame();
      });

      const svg = createSvgElement();
      if (state.W > 0 && state.H > 0) svg.setAttribute('viewBox', `0 0 ${state.W} ${state.H}`);
      svg.classList.add(state.tool === 'point' || state.tool === 'note' ? 'tool-marker' : 'tool-line');
      svg.addEventListener('pointerdown', onSvgPointerDown);

      const frame = h('div', { class: 'ann-frame', dataset: { testid: 'annotation-frame' } }, [img, svg]);
      const coords = h('div', { class: 'stage-coords ann-coords' }, 'x: --   y: --');
      const hint = h('div', { class: 'stage-hint', dataset: { testid: 'tool-hint' } }, toolHint(state.tool));

      const stageEl = h(
        'div',
        { class: 'stage ann-stage', dataset: { testid: 'annotation-stage' } },
        [frame, coords, hint],
      );
      refs.stage = stageEl;
      stage = stageEl;
      refs.frame = frame;
      refs.img = img;
      refs.svg = svg;
      refs.coords = coords;
      refs.hint = hint;
    }

    // 缩略图条
    let thumbCard: HTMLElement | null = null;
    if (state.images.length > 0 && state.viewMode === 'original') {
      const strip = h(
        'div',
        { class: 'thumb-strip', dataset: { testid: 'thumb-strip' } },
        state.images.map((im, i) =>
          h(
            'div',
            {
              class: `thumb${i === state.imageIndex ? ' sel' : ''}`,
              dataset: { testid: 'thumb', id: im.id, index: i },
              title: im.name,
              onClick: () => {
                if (state.imageIndex === i) return;
                state.imageIndex = i;
                state.viewMode = 'original';
                rerender();
              },
            },
            [h('img', { src: state.imageUrls[i], alt: im.name, loading: 'lazy' }), h('span', { class: 'idx' }, String(i + 1))],
          ),
        ),
      );
      thumbCard = h('section', { class: 'card ann-thumb-card' }, [h('div', { class: 'card-body' }, [strip])]);
    }

    return h('div', { class: 'ann-left' }, [
      h('section', { class: 'card stage-card' }, [stage]),
      thumbCard,
    ]);
  }

  function buildRight(batch: BatchRecord): HTMLElement {
    // ---- 工具 ----
    const toolCard = h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '标注工具')]),
      h('div', { class: 'card-body' }, [
        h(
          'div',
          { class: 'tool-vertical' },
          TOOLS.map((t) => {
            const btnEl = button(`${t.icon}  ${t.name}`, {
              variant: state.tool === t.id ? 'primary' : undefined,
              title: t.hint,
              onClick: () => selectTool(t.id),
            });
            btnEl.classList.add('tool-btn', 'ann-tool-btn');
            if (state.tool === t.id) btnEl.classList.add('active');
            btnEl.dataset.tool = t.id;
            btnEl.dataset.testid = `tool-${t.id}`;
            return btnEl;
          }),
        ),
        h('p', { class: 'ann-tool-hint' }, toolHint(state.tool)),
      ]),
    ]);

    // ---- 比例尺与测量值 ----
    const calibBadges = h('div', { class: 'ann-calib-badges', dataset: { testid: 'calib-badges' } });
    refs.calibBadges = calibBadges;

    const mmppInput = h('input', {
      class: 'input mono',
      type: 'number',
      step: 'any',
      min: '0',
      placeholder: '例如 0.05',
      dataset: { testid: 'calib-mmpp-input' },
    }) as HTMLInputElement;
    if (batch.mmPerPixel && batch.mmPerPixel > 0) mmppInput.placeholder = `当前 ${batch.mmPerPixel.toFixed(5)}`;
    refs.mmppInput = mmppInput;

    const applyManual = () => {
      const v = Number(mmppInput.value);
      if (mmppInput.value.trim() === '' || !Number.isFinite(v) || v <= 0) {
        toast('请输入大于 0 的 mm/px 数值', 'err');
        return;
      }
      batch.mmPerPixel = v;
      batch.scaleLabel = `比例尺 1px=${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}mm`;
      void dbApi.batches
        .put(batch)
        .then(() => recomputeAllMeasurements(v))
        .then(() => reloadAnnotations())
        .then(() => {
          toast('手动标定已应用到本批次全部测量', 'ok');
          paintCalib();
        })
        .catch(() => toast('标定保存失败', 'err'));
    };

    const measureValue = h('div', { class: 'ann-mv', dataset: { testid: 'measure-value' } }, '--');
    const measureSub = h('div', { class: 'ann-ms', dataset: { testid: 'measure-sub' } }, '绘制或选择一条测量线');
    refs.measureValue = measureValue;
    refs.measureSub = measureSub;

    const calibCard = h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '比例尺与测量')]),
      h('div', { class: 'card-body' }, [
        calibBadges,
        h('div', { class: 'ann-manual' }, [
          h('div', { class: 'field' }, [
            h('label', {}, '手动标定 mm/px'),
            mmppInput,
          ]),
          button('应用', { variant: 'subtle', onClick: applyManual }),
        ]),
        h('div', { class: 'pill-row mt8' }, [
          h(
            'button',
            {
              class: 'ann-mini-link',
              dataset: { testid: 'calib-clear' },
              onClick: () => {
                if (!isCalibrated(batch)) {
                  toast('当前尚未标定', 'info');
                  return;
                }
                batch.mmPerPixel = undefined;
                batch.scaleLabel = undefined;
                void dbApi.batches
                  .put(batch)
                  .then(() => recomputeAllMeasurements(null))
                  .then(() => reloadAnnotations())
                  .then(() => {
                    toast('已清除比例尺标定,测量改为像素显示', 'ok');
                    paintCalib();
                  })
                  .catch(() => toast('保存失败', 'err'));
              },
            },
            '清除标定',
          ),
          h('span', { class: 'text-dim', style: { fontSize: '12px' } }, '或使用「比例尺标定」工具拖线并输入已知长度'),
        ]),
        h('div', { class: 'ann-measure' }, [measureValue, measureSub]),
      ]),
    ]);

    // ---- 标注列表 ----
    const list = h('div', { class: 'annotation-list ann-list-wrap', dataset: { testid: 'annotation-list' } });
    refs.list = list;
    const countBadge = badge(String(state.annotations.length), state.annotations.length ? 'info' : 'muted');

    const listCard = h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [
        h('h2', {}, '标注列表'),
        countBadge,
        h('div', { class: 'spacer' }),
        state.annotations.length
          ? h(
              'button',
              {
                class: 'ann-mini-link ann-danger-text',
                dataset: { testid: 'annotation-clear-all' },
                onClick: (e: MouseEvent) => {
                  e.stopPropagation();
                  void clearAllAnnotations();
                },
              },
              '清空',
            )
          : null,
      ]),
      h('div', { class: 'card-body' }, [list]),
    ]);

    // ---- 导出 ----
    const jsonBtn = button('导出标注 JSON', { icon: '🧾', onClick: () => exportJson() });
    jsonBtn.dataset.testid = 'export-json';
    const csvBtn = button('导出 CSV', { icon: '📊', onClick: () => exportCsv() });
    csvBtn.dataset.testid = 'export-csv';
    const pngBtn = button('导出叠加图 PNG', { variant: 'primary', icon: '🖼️', onClick: () => void exportPng() });
    pngBtn.dataset.testid = 'export-png';

    const exportCard = h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '导出')]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'ann-export-grid' }, [
          jsonBtn,
          csvBtn,
          pngBtn,
          h('p', { class: 'card-hint', style: { marginTop: '4px' } }, 'PNG 以原始图像分辨率绘制底图与全部标注;文件名包含批次名称。'),
        ]),
      ]),
    ]);

    return h('div', { class: 'ann-right' }, [toolCard, calibCard, listCard, exportCard]);
  }

  function selectTool(tool: ToolId): void {
    state.tool = tool;
    armed = null;
    interaction = null;
    // 局部切换按钮高亮,避免整体重绘导致刚点击的按钮被移除
    ctx.root.querySelectorAll<HTMLButtonElement>('.ann-tool-btn').forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('active', on);
      b.classList.toggle('btn-primary', on);
    });
    if (refs.hint) refs.hint.textContent = toolHint(tool);
    if (refs.svg) {
      const marker = tool === 'point' || tool === 'note';
      refs.svg.classList.toggle('tool-marker', marker);
      refs.svg.classList.toggle('tool-line', !marker);
    }
    paintOverlay();
  }

  // ============================================================
  // 绘制 / 列表 / 标定 / 测量 局部刷新
  // ============================================================
  function fitFrame(): void {
    const stage = refs.stage;
    const frame = refs.frame;
    if (!stage || !frame) return;
    const W = state.W;
    const H = state.H;
    if (!W || !H) return;
    const aw = stage.clientWidth;
    const ah = stage.clientHeight;
    if (aw <= 40 || ah <= 40) return;
    const pad = 30;
    const scale = Math.max(0.02, Math.min((aw - pad * 2) / W, (ah - pad * 2) / H));
    frame.style.width = `${Math.max(20, Math.floor(W * scale))}px`;
    frame.style.height = `${Math.max(20, Math.floor(H * scale))}px`;
  }

  function paintOverlay(): void {
    const svg = refs.svg;
    if (!svg || !state.batch || state.W <= 0) return;
    const mpp = state.batch.mmPerPixel;
    // 透明背景矩形,保证空白区域的指针事件也落在 SVG 子树内
    let html = `<rect x="0" y="0" width="${state.W}" height="${state.H}" fill="transparent" data-bg="1"></rect>`;
    html += state.annotations
      .map((a) => annotationSvg(a, a.id === state.selectedId, mpp, state.W))
      .join('');
    if (armed) html += armedSvg(armed, state.W);
    const it = interaction;
    if (it && it.mode === 'draw') html += draftSvg(state.tool, it.p0, it.p1, mpp, state.W);
    svg.innerHTML = html;
  }

  function paintList(): void {
    const list = refs.list;
    if (!list || !state.batch) return;
    clear(list);
    const mpp = state.batch.mmPerPixel;

    if (state.annotations.length === 0) {
      list.appendChild(h('div', { class: 'card-hint', style: { padding: '14px 4px', textAlign: 'center' } }, '暂无标注 — 选择上方工具后在图像上拖动或单击开始。'));
      return;
    }

    for (const a of state.annotations) {
      const meta = KIND_META[a.kind];
      const color = a.color || meta.color;
      const selected = a.id === state.selectedId;
      const item = h(
        'div',
        {
          class: `annotation-item${selected ? ' sel' : ''}`,
          dataset: { testid: 'annotation-item', id: a.id },
          onClick: () => {
            state.selectedId = a.id;
            paintList();
            paintOverlay();
            paintMeasure();
          },
        },
        [
          h('span', { class: 'ann-kind-ico', style: { color, border: `1px solid ${color}66` } }, meta.icon),
          h('div', { class: 'ai-main' }, [
            h('div', { class: 'ai-title' }, titleText(a, mpp)),
            h('div', { class: 'ai-sub' }, `${a.label ? a.label + ' · ' : ''}${a.author} · ${fmtDate(a.createdAt)}`),
          ]),
          h(
            'button',
            {
              class: 'icon-btn ann-del',
              dataset: { testid: 'annotation-delete' },
              title: '删除该标注',
              attrs: { 'aria-label': '删除标注' },
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                void deleteAnnotation(a);
              },
            },
            '🗑',
          ),
        ],
      );
      list.appendChild(item);
    }
  }

  function paintCalib(): void {
    const el = refs.calibBadges;
    const batch = state.batch;
    if (!el || !batch) return;
    clear(el);
    const mpp = batch.mmPerPixel;
    if (mpp && mpp > 0) {
      el.appendChild(badge(`已标定 1px=${mpp < 0.01 ? mpp.toFixed(5) : mpp.toFixed(4)} mm`, 'ok'));
      if (batch.scaleLabel) el.appendChild(accentBadge(batch.scaleLabel));
    } else {
      el.appendChild(badge('未标定 · 仅像素值', 'warn'));
    }
  }

  function paintMeasure(): void {
    const vEl = refs.measureValue;
    const sEl = refs.measureSub;
    if (!vEl || !sEl || !state.batch) return;
    const mpp = state.batch.mmPerPixel;
    const ann =
      state.annotations.find((a) => a.id === state.selectedId) ??
      state.annotations.find((a) => a.id === state.lastMeasureId) ??
      null;

    if (!ann) {
      vEl.textContent = '--';
      sEl.textContent = '绘制或选择一条测量线';
      return;
    }

    if (ann.kind === 'point' || ann.kind === 'note') {
      vEl.textContent = ann.label || KIND_META[ann.kind].name;
      sEl.textContent = `${KIND_META[ann.kind].name} · 坐标 ${ann.points[0] ? `${ann.points[0].x.toFixed(1)}, ${ann.points[0].y.toFixed(1)}` : '--'}`;
      return;
    }

    const px = linePxLength(ann);
    if (typeof ann.valueMm === 'number' && Number.isFinite(ann.valueMm)) {
      vEl.textContent = `${formatMm(ann.valueMm)} mm`;
    } else if (mpp && mpp > 0) {
      vEl.textContent = `${formatMm(px * mpp)} mm`;
    } else {
      vEl.textContent = `${px.toFixed(1)} px`;
    }
    sEl.textContent = `像素长度 ${px.toFixed(1)} px${mpp && mpp > 0 ? ` · 1px=${mpp.toFixed(5)}mm` : ' · 未标定'} · ${KIND_META[ann.kind].short}`;
  }

  async function reloadAnnotations(): Promise<void> {
    if (!state.batch) return;
    try {
      state.annotations = (await dbApi.annotations.listByTarget(state.batch.id)).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    } catch {
      /* 保留内存状态 */
    }
    paintList();
    paintOverlay();
    paintMeasure();
    const headBadgeHost = ctx.root.querySelector('.ann-head .ann-meta');
    if (headBadgeHost) {
      const old = headBadgeHost.querySelector('[data-testid="head-ann-count"]');
      if (old) old.remove();
      if (state.annotations.length) {
        const b = accentBadge(`${state.annotations.length} 条标注`);
        b.dataset.testid = 'head-ann-count';
        headBadgeHost.appendChild(b);
      }
    }
  }

  // ============================================================
  // 标注增删
  // ============================================================
  async function deleteAnnotation(ann: AnnotationRecord): Promise<void> {
    try {
      await dbApi.annotations.del(ann.id);
      toast('标注已删除', 'ok', 1600);
    } catch {
      toast('删除失败,请重试', 'err');
      return;
    }
    if (state.selectedId === ann.id) state.selectedId = null;
    if (state.lastMeasureId === ann.id) state.lastMeasureId = null;
    await reloadAnnotations();
  }

  async function clearAllAnnotations(): Promise<void> {
    const n = state.annotations.length;
    const ok = await confirmDialog(`确定删除当前批次的全部 ${n} 条标注吗?此操作不可恢复。`, '清空全部标注');
    if (!ok || disposed) return;
    try {
      await Promise.all(state.annotations.map((a) => dbApi.annotations.del(a.id).catch(() => undefined)));
      state.selectedId = null;
      state.lastMeasureId = null;
      toast('已清空全部标注', 'ok');
      await reloadAnnotations();
    } catch {
      toast('清空失败', 'err');
    }
  }

  async function persistNew(ann: AnnotationRecord): Promise<boolean> {
    try {
      await dbApi.annotations.put(ann);
      return true;
    } catch {
      toast('标注保存失败(IndexedDB)', 'err');
      return false;
    }
  }

  /** 标定变化后,按新的 mm/px 重算并持久化全部长度/刻痕宽度测量 */
  async function recomputeAllMeasurements(mmPerPixel: number | null): Promise<void> {
    if (!state.batch) return;
    const jobs: Promise<unknown>[] = [];
    for (const a of state.annotations) {
      if ((a.kind === 'length' || a.kind === 'width') && a.points.length >= 2) {
        if (mmPerPixel && mmPerPixel > 0) a.valueMm = linePxLength(a) * mmPerPixel;
        else a.valueMm = undefined;
        jobs.push(dbApi.annotations.put(a).catch(() => undefined));
      }
    }
    await Promise.all(jobs);
  }

  async function createLineAnnotation(tool: 'scale' | 'length' | 'width', p0Raw: Pt, p1Raw: Pt): Promise<void> {
    const batch = state.batch;
    if (!batch) return;
    const p0 = roundPt(p0Raw);
    const p1 = roundPt(p1Raw);
    const pxLen = dist(p0, p1);

    const ann: AnnotationRecord = {
      id: uid('ann'),
      targetId: batch.id,
      targetKind: 'batch',
      kind: tool,
      author: state.author,
      createdAt: new Date().toISOString(),
      points: [p0, p1],
      color: KIND_META[tool].color,
    };

    if (tool === 'scale') {
      const dlg = knownMmDialog(pxLen);
      activeDialog = dlg;
      const raw = await dlg.result;
      activeDialog = null;
      if (disposed || raw === null) {
        paintOverlay();
        return;
      }
      const knownMm = Number(raw);
      const mmPerPixel = knownMm / pxLen;
      ann.knownMm = knownMm;
      ann.valueMm = knownMm;
      ann.label = `比例尺 ${knownMm} mm`;
      batch.mmPerPixel = mmPerPixel;
      batch.scaleLabel = `比例尺 ${knownMm}mm`;

      const saved = await persistNew(ann);
      if (!saved) return;
      try {
        await dbApi.batches.put(batch);
      } catch {
        toast('比例尺保存失败', 'err');
      }
      // 新标定应用到既有全部测量
      await recomputeAllMeasurements(mmPerPixel);
      state.selectedId = ann.id;
      state.lastMeasureId = ann.id;
      toast(`标定完成:1 px ≈ ${mmPerPixel.toFixed(5)} mm,已应用于本批次全部测量`, 'ok', 4200);
      await reloadAnnotations();
      paintCalib();
      return;
    }

    const mpp = batch.mmPerPixel;
    if (mpp && mpp > 0) ann.valueMm = pxLen * mpp;
    ann.label = tool === 'width' ? '刻痕宽度测量' : '长度测量';

    state.selectedId = ann.id;
    state.lastMeasureId = ann.id;
    const saved = await persistNew(ann);
    if (!saved) return;
    if (!(mpp && mpp > 0)) {
      toast('已保存像素长度;当前未标定比例尺,可用「比例尺标定」工具校准后换算毫米', 'info', 4600);
    } else {
      toast(`${KIND_META[tool].short}已保存:${formatMm(ann.valueMm ?? 0)} mm`, 'ok', 2000);
    }
    await reloadAnnotations();
  }

  async function createMarkerAnnotation(tool: 'point' | 'note', pRaw: Pt): Promise<void> {
    const batch = state.batch;
    if (!batch) return;
    const p = roundPt(pRaw);

    let label: string | null;
    if (tool === 'point') {
      const dlg = promptModal({
        title: '点标注',
        label: '标注名称 / 描述(可留空)',
        placeholder: '例如:锈蚀点 A',
        confirmText: '确定',
      });
      activeDialog = dlg;
      label = await dlg.result;
      activeDialog = null;
    } else {
      const dlg = promptModal({
        title: '文字备注',
        label: '备注内容(可留空)',
        placeholder: '记录该处观察…',
        multiline: true,
        confirmText: '确定',
      });
      activeDialog = dlg;
      label = await dlg.result;
      activeDialog = null;
    }

    if (disposed || label === null) {
      paintOverlay();
      return;
    }

    const ann: AnnotationRecord = {
      id: uid('ann'),
      targetId: batch.id,
      targetKind: 'batch',
      kind: tool,
      author: state.author,
      createdAt: new Date().toISOString(),
      points: [p],
      color: KIND_META[tool].color,
      label: label.trim() || KIND_META[tool].name,
    };
    state.selectedId = ann.id;
    state.lastMeasureId = ann.id;
    const saved = await persistNew(ann);
    if (!saved) return;
    toast(tool === 'point' ? '点标注已保存' : '备注已保存', 'ok', 1800);
    await reloadAnnotations();
  }

  // ============================================================
  // 端点拖动
  // ============================================================
  function recomputeAnnValues(ann: AnnotationRecord): void {
    if (ann.points.length < 2) return;
    const px = linePxLength(ann);
    const mpp = state.batch?.mmPerPixel;
    if (ann.kind === 'scale') {
      if (typeof ann.knownMm === 'number' && px > 0) {
        ann.valueMm = ann.knownMm;
        if (state.batch) state.batch.mmPerPixel = ann.knownMm / px;
      }
    } else if (mpp && mpp > 0) {
      ann.valueMm = px * mpp;
    } else {
      ann.valueMm = undefined;
    }
  }

  async function persistHandleDrag(annId: string): Promise<void> {
    const ann = state.annotations.find((a) => a.id === annId);
    if (!ann) return;
    recomputeAnnValues(ann);
    try {
      await dbApi.annotations.put(ann);
      if (ann.kind === 'scale' && state.batch && typeof state.batch.mmPerPixel === 'number') {
        state.batch.scaleLabel = `比例尺 ${ann.knownMm ?? ''}mm`.trim();
        await dbApi.batches.put(state.batch);
      }
    } catch {
      toast('端点调整保存失败', 'err');
    }
    paintCalib();
    paintList();
    paintMeasure();
  }

  // ============================================================
  // 指针 / 键盘交互
  // ============================================================
  function eventToPixels(e: { clientX: number; clientY: number }): Pt {
    const svg = refs.svg;
    const W = state.W || 1;
    const H = state.H || 1;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    return { x: Math.min(W, Math.max(0, x)), y: Math.min(H, Math.max(0, y)) };
  }

  function onSvgPointerDown(e: PointerEvent): void {
    if (!state.batch || !refs.svg) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const target = e.target as Element | null;
    const handleEl = target?.closest?.('[data-handle]') as Element | null;
    if (handleEl) {
      e.preventDefault();
      e.stopPropagation();
      const annId = handleEl.getAttribute('data-ann') ?? '';
      const idx = Number(handleEl.getAttribute('data-index') ?? '0');
      const ann = state.annotations.find((a) => a.id === annId);
      if (!ann) return;
      const index = Math.max(0, Math.min(Number.isFinite(idx) ? idx : 0, ann.points.length - 1));
      state.selectedId = annId;
      interaction = { mode: 'handle', annId, index };
      paintList();
      paintOverlay();
      paintMeasure();
      return;
    }

    const shapeEl = target?.closest?.('[data-ann]') as Element | null;
    if (shapeEl) {
      const annId = shapeEl.getAttribute('data-ann');
      if (annId) {
        state.selectedId = annId;
        paintList();
        paintOverlay();
        paintMeasure();
      }
      return;
    }

    // 空白区域:开始绘制(若已有 armed 起点,保留它以支持“单击-单击”模式:
    // 本次若形成拖动则以拖动线段为准,若仍是单击则与 armed 连成两点)
    const p = eventToPixels(e);
    interaction = { mode: 'draw', p0: p, p1: p, moved: false };
    e.preventDefault();
  }

  function onWinPointerMove(e: PointerEvent): void {
    if (disposed || !state.batch) return;

    // 坐标读数
    const stage = refs.stage;
    if (stage && refs.coords && refs.svg) {
      const r = stage.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        const p = eventToPixels(e);
        refs.coords.innerHTML = `x <b>${p.x.toFixed(1)}</b> &nbsp; y <b>${p.y.toFixed(1)}</b>`;
      }
    }

    const it = interaction;
    if (!it) return;

    if (it.mode === 'draw') {
      const p = eventToPixels(e);
      it.p1 = p;
      if (dist(it.p0, p) > 3) it.moved = true;
      paintOverlay();
      return;
    }

    // 端点拖动
    const ann = state.annotations.find((a) => a.id === it.annId);
    if (!ann) return;
    const idx = Math.min(it.index, ann.points.length - 1);
    ann.points[idx] = roundPt(eventToPixels(e));
    recomputeAnnValues(ann);
    paintOverlay();
    paintMeasure();
    if (ann.kind === 'scale') paintCalib();
  }

  function onWinPointerUp(e: PointerEvent): void {
    if (disposed) return;
    const it = interaction;
    if (!it) return;
    interaction = null;

    if (it.mode === 'handle') {
      void persistHandleDrag(it.annId);
      return;
    }

    if (!state.batch) return;
    const tool = state.tool;

    if (tool === 'point' || tool === 'note') {
      // 标记类工具:抬手即在按下位置放置(容忍轻微抖动)
      void createMarkerAnnotation(tool, it.p0);
      return;
    }

    // 拖动成型
    if (it.moved && dist(it.p0, it.p1) >= MIN_LINE_PX) {
      armed = null;
      void createLineAnnotation(tool, it.p0, it.p1);
      if (refs.hint) refs.hint.textContent = toolHint(tool);
      return;
    }

    // 单击-单击模式
    if (!armed) {
      armed = { x: it.p0.x, y: it.p0.y };
      paintOverlay();
      if (refs.hint) refs.hint.textContent = '已记录起点,请单击终点完成(或按 Esc 取消)';
    } else {
      const p1 = eventToPixels(e);
      const p0 = armed;
      armed = null;
      paintOverlay();
      if (dist(p0, p1) >= MIN_LINE_PX) void createLineAnnotation(tool, p0, p1);
      if (refs.hint) refs.hint.textContent = toolHint(tool);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (disposed) return;
    if (e.key === 'Escape' && (armed || interaction)) {
      armed = null;
      interaction = null;
      paintOverlay();
      if (refs.hint) refs.hint.textContent = toolHint(state.tool);
    }
  }

  // ============================================================
  // 导出
  // ============================================================
  function exportJson(): void {
    if (!state.batch) return;
    try {
      exportAnnotationsJson(state.batch, state.annotations);
      toast('标注 JSON 已开始下载', 'ok');
    } catch {
      toast('JSON 导出失败', 'err');
    }
  }

  function exportCsv(): void {
    if (!state.batch) return;
    try {
      exportAnnotationsCsv(state.batch, state.annotations);
      toast('CSV 已开始下载', 'ok');
    } catch {
      toast('CSV 导出失败', 'err');
    }
  }

  async function exportPng(): Promise<void> {
    if (!state.batch) return;
    const url = currentImageUrl();
    if (!url) {
      toast('当前批次没有可叠加的底图', 'err');
      return;
    }
    try {
      await exportOverlayPng({ batch: state.batch, imageUrl: url, annotations: state.annotations });
      toast('叠加图 PNG 已开始下载', 'ok');
    } catch (err) {
      toast(err instanceof Error ? `PNG 导出失败:${err.message}` : 'PNG 导出失败', 'err');
    }
  }
}
