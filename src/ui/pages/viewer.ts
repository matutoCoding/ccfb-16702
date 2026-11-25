import { h, button, badge, toast, modal } from '../../ui/dom';
import type { PageContext } from '../../main';
import { dbApi } from '../../core/db';
import type { ResultRecord } from '../../core/types';
import { loadResultData } from '../../core/result/resultReader';
import { computeDepthMap } from '../../core/result/depthMap';
import { RelightRenderer, DEFAULT_RENDER_STATE, type RenderState, type ViewMode } from '../../gpu/relightRenderer';

export function renderViewerPage(ctx: PageContext): void | (() => void) {
  let disposed = false;
  let renderer: RelightRenderer | null = null;
  let result: ResultRecord | null = null;
  const state: RenderState = structuredClone(DEFAULT_RENDER_STATE);
  let depthReady = false;

  const root = ctx.root;
  root.appendChild(h('div', { class: 'empty' }, [h('div', { class: 'spinner' }), h('p', { class: 'mt12' }, '正在加载拟合结果…')]));

  async function resolveResult(): Promise<ResultRecord | null> {
    const id = ctx.params.id;
    if (id) {
      const r = await dbApi.results.get(id);
      if (r) return r;
      const rs = await dbApi.results.listByBatch(id);
      const done = rs.filter((x) => x.normalBlob || x.coeffMin.some(isFinite));
      if (done.length) return done.sort((a, b) => b.createdAt - a.createdAt)[0];
    }
    const all = await dbApi.results.list();
    return all.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  function cleanupRenderer() {
    try {
      renderer?.dispose();
    } catch {
      /* ignore */
    }
    renderer = null;
  }

  async function build() {
    root.replaceChildren();
    result = await resolveResult();
    if (disposed) return;
    if (!result) {
      root.appendChild(
        h('div', { class: 'empty' }, [
          h('div', { class: 'ico' }, '🔆'),
          h('h3', {}, '还没有可查看的拟合结果'),
          h('p', {}, '先到「拟合任务」创建并完成一次 PTM / HSH 拟合,或生成内置合成样例。'),
          h('div', { class: 'pill-row mt16', style: { justifyContent: 'center' } }, [
            button('去拟合', { variant: 'primary', onClick: () => ctx.navigate('#/jobs') }),
            button('生成合成批次', { onClick: () => ctx.navigate('#/batches') }),
          ]),
        ]),
      );
      return;
    }

    const allResults = (await dbApi.results.list()).sort((a, b) => b.createdAt - a.createdAt);
    const batch = await dbApi.batches.get(result.batchId);

    const canvas = h('canvas', { class: 'gpu-canvas', attrs: { width: result.width, height: result.height } }) as HTMLCanvasElement;
    const coordsTip = h('div', { class: 'stage-coords' }, '');
    const hint = h('div', { class: 'stage-hint' }, '在画面上按住拖动改变光源方向');

    const stage = h('div', { class: 'stage', id: 'viewer-stage' }, [canvas, coordsTip, hint]);

    // ---- 光源控制盘 ----
    const dot = h('div', { class: 'lp-dot' });
    const pad = h('div', { class: 'light-pad', title: '拖动设置光源方向' }, [
      h('div', { class: 'ring', style: { inset: '12%' } }),
      h('div', { class: 'ring', style: { inset: '32%' } }),
      dot,
    ]);
    function updatePad() {
      dot.style.left = `${(0.5 + state.light.x / 2) * 100}%`;
      dot.style.top = `${(0.5 - state.light.y / 2) * 100}%`;
    }
    updatePad();
    function padFromEvent(e: PointerEvent) {
      const rect = pad.getBoundingClientRect();
      let x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      let y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      const r = Math.hypot(x, y);
      if (r > 1) {
        x /= r;
        y /= r;
      }
      state.light.x = +x.toFixed(3);
      state.light.y = +y.toFixed(3);
      state.light.z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      updatePad();
      requestRender();
    }
    let padDrag = false;
    pad.addEventListener('pointerdown', (e) => {
      padDrag = true;
      pad.setPointerCapture(e.pointerId);
      padFromEvent(e);
    });
    pad.addEventListener('pointermove', (e) => padDrag && padFromEvent(e));
    pad.addEventListener('pointerup', () => (padDrag = false));

    // ---- canvas 拖拽光源 ----
    let cdrag = false;
    let lx0 = 0;
    let ly0 = 0;
    let startLight = { ...state.light };
    canvas.addEventListener('pointerdown', (e) => {
      cdrag = true;
      lx0 = e.clientX;
      ly0 = e.clientY;
      startLight = { ...state.light };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      coordsTip.textContent = `光源 (${state.light.x.toFixed(2)}, ${state.light.y.toFixed(2)}, ${state.light.z.toFixed(2)})`;
      if (!cdrag) return;
      const dx = ((e.clientX - lx0) / rect.width) * 2.2;
      const dy = ((e.clientY - ly0) / rect.height) * 2.2;
      let x = startLight.x + dx;
      let y = startLight.y - dy;
      const r = Math.hypot(x, y);
      if (r > 0.98) {
        x = (x / r) * 0.98;
        y = (y / r) * 0.98;
      }
      state.light.x = x;
      state.light.y = y;
      state.light.z = Math.sqrt(Math.max(0.02, 1 - x * x - y * y));
      updatePad();
      requestRender();
    });
    canvas.addEventListener('pointerup', () => (cdrag = false));

    // ---- 模式切换 ----
    const modes: { id: ViewMode; label: string }[] = [
      { id: 'lit', label: '重光照' },
      { id: 'spec', label: '镜面增强' },
      { id: 'normal', label: '法线' },
      { id: 'multi', label: '多光源' },
      { id: 'relief', label: '浮雕线稿' },
      { id: 'depth', label: '刻痕深浅' },
    ];
    const seg = h('div', { class: 'seg', style: { flexWrap: 'wrap' } });
    const modeBtns = modes.map((m) =>
      h(
        'button',
        {
          class: state.mode === m.id ? 'active' : '',
          onClick: async () => {
            state.mode = m.id;
            [...seg.children].forEach((c, i) => (c as HTMLElement).classList.toggle('active', modes[i].id === m.id));
            if ((m.id === 'relief' || m.id === 'depth') && !depthReady && renderer && result) {
              depthStatus.textContent = '正在由法线积分深度…';
              await new Promise((r) => setTimeout(r, 30));
              const data = renderer.data;
              const dm = computeDepthMap(data, 1024);
              if (disposed) return;
              renderer.setDepth(dm);
              depthReady = true;
              depthStatus.textContent = '深度图 1024px 近似积分';
            }
            requestRender();
          },
        },
        m.label,
      ),
    );
    seg.append(...modeBtns);

    const brightness = sliderRow('亮度', 0.4, 2, 0.01, state.brightness, (v) => {
      state.brightness = v;
      requestRender();
    });
    const specStrength = sliderRow('镜面增强强度', 0, 2.5, 0.01, state.specStrength, (v) => {
      state.specStrength = v;
      requestRender();
    });
    const shininess = sliderRow('高光聚拢(锐度)', 4, 160, 1, state.shininess, (v) => {
      state.shininess = v;
      requestRender();
    });
    const lineStrength = sliderRow('线稿力度', 0.4, 2.4, 0.01, state.lineStrength, (v) => {
      state.lineStrength = v;
      requestRender();
    });
    const depthStatus = h('div', { class: 'card-hint' }, '切到线稿/深浅模式时生成深度');

    // 多光源强度
    const multiBox = h('div', {});
    const multiSliders = state.lights.map((l, i) =>
      sliderRow(`光源 ${i + 1} 强度`, 0, 1.6, 0.01, l.intensity, (v) => {
        l.intensity = v;
        requestRender();
      }),
    );
    multiBox.append(...multiSliders);

    const resultSelect = h(
      'select',
      {
        class: 'input',
        onChange: (e: Event) => {
          const id = (e.target as HTMLSelectElement).value;
          ctx.navigate(`#/viewer/${id}`);
        },
      },
      allResults.map((r) => h('option', { value: r.id, selected: r.id === result!.id }, `${r.algo.toUpperCase()} · ${r.width}² · ${new Date(r.createdAt).toLocaleString()}`)),
    ) as HTMLSelectElement;

    const exportPtmBtn = button('导出标准 PTM', {
      variant: 'primary',
      onClick: async () => {
        try {
          const { exportPTM, downloadBlob } = await import('../../core/export/exporters');
          const blob = await exportPTM(result!);
          downloadBlob(blob, `${batch?.artifactName ?? 'rti'}_${result!.algo}.ptm`);
          toast('PTM 已导出(RGB 1.2,RTIViewer/Relight 可打开)', 'ok', 4200);
        } catch (e) {
          toast(String((e as Error).message || e), 'err', 5000);
        }
      },
    });
    const exportRtiBtn = button('导出 RTI (HSH)', {
      onClick: async () => {
        try {
          const { exportRTI, downloadBlob } = await import('../../core/export/exporters');
          const blob = await exportRTI(result!);
          downloadBlob(blob, `${batch?.artifactName ?? 'hsh'}.rti`);
          toast('HSH .rti 已导出', 'ok');
        } catch (e) {
          toast(String((e as Error).message || e), 'err', 5000);
        }
      },
    });
    const exportPngBtn = button('导出当前画面 PNG', {
      onClick: async () => {
        if (!renderer) return;
        renderer.render(state);
        const blob = await renderer.snapshotPng();
        const { downloadBlob } = await import('../../core/export/exporters').catch(() => ({
          downloadBlob: (b: Blob, n: string) => {
            const u = URL.createObjectURL(b);
            const a = document.createElement('a');
            a.href = u;
            a.download = n;
            a.click();
            setTimeout(() => URL.revokeObjectURL(u), 4000);
          },
        }));
        downloadBlob(blob, `relight_${Date.now()}.png`);
      },
    });
    const normalPngBtn = result.normalBlob
      ? button('法线图 PNG', {
          variant: 'subtle',
          onClick: () => {
            const u = URL.createObjectURL(result!.normalBlob!);
            const a = document.createElement('a');
            a.href = u;
            a.download = 'normal_map.png';
            a.click();
            setTimeout(() => URL.revokeObjectURL(u), 4000);
          },
        })
      : null;

    const right = h('div', { class: 'grid', style: { gap: '16px' } }, [
      h('section', { class: 'card' }, [h('div', { class: 'card-body' }, [resultSelect])]),
      h('section', { class: 'card' }, [
        h('header', { class: 'card-head' }, [h('h2', {}, '光源与模式')]),
        h('div', { class: 'card-body' }, [
          seg,
          h('div', { class: 'mt16' }, [pad]),
          h('div', { class: 'kv-list mt12' }, [
            h('span', { class: 'k' }, '算法'),
            h('span', { class: 'v' }, [badge(result.algo.toUpperCase(), 'accent')]),
            h('span', { class: 'k' }, '分辨率'),
            h('span', { class: 'v mono' }, `${result.width}×${result.height}`),
            h('span', { class: 'k' }, '拟合耗时'),
            h('span', { class: 'v mono' }, result.fitMs ? `${(result.fitMs / 1000).toFixed(2)} s` : '—'),
          ]),
        ]),
      ]),
      h('section', { class: 'card' }, [h('header', { class: 'card-head' }, [h('h2', {}, '参数')]), h('div', { class: 'card-body' }, [brightness, specStrength, shininess, lineStrength, h('div', { class: 'mt12' }, [depthStatus])])]),
      h('section', { class: 'card' }, [h('header', { class: 'card-head' }, [h('h2', {}, '多光源合成(4 灯)')]), h('div', { class: 'card-body' }, [multiBox])]),
      h('section', { class: 'card' }, [
        h('header', { class: 'card-head' }, [h('h2', {}, '导出')]),
        h('div', { class: 'card-body pill-row' }, [
          exportPtmBtn,
          result.algo === 'hsh' ? exportRtiBtn : null,
          exportPngBtn,
          normalPngBtn,
          h('button', { class: 'btn btn-subtle', onClick: () => ctx.navigate(`#/annotate/${result!.batchId}`) }, '去测量标注 →'),
        ]),
      ]),
    ]);

    const wb = h('div', { class: 'workbench' }, [h('section', { class: 'card stage-card' }, [stage]), right]);
    root.appendChild(wb);

    let queued = false;
    function requestRender() {
      if (!renderer || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!disposed && renderer) renderer.render(state);
      });
    }
    (window as any).__rtiRequestRender = requestRender;

    // ---- 加载 GPU 数据 ----
    try {
      const data = await loadResultData(result);
      if (disposed) return;
      renderer = await RelightRenderer.create(canvas, data);
      if (disposed) {
        renderer.dispose();
        return;
      }
      requestRender();
    } catch (e) {
      console.error(e);
      stage.appendChild(h('div', { class: 'empty' }, [h('p', { class: 'text-err' }, '渲染器初始化失败: ' + String((e as Error).message || e))]));
    }
  }

  function sliderRow(label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLElement {
    const val = h('span', { class: 'mono text-dim', style: { fontSize: '12px' } }, value.toFixed(step < 1 ? 2 : 0));
    const input = h('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = v.toFixed(step < 1 ? 2 : 0);
      onInput(v);
    });
    return h('div', { class: 'field' }, [h('label', {}, [label, ' ', val]), input]);
  }

  build().catch((e) => {
    console.error(e);
    root.replaceChildren(h('div', { class: 'empty' }, [h('p', { class: 'text-err' }, String(e?.message || e))]));
  });

  return () => {
    disposed = true;
    cleanupRenderer();
  };
}
