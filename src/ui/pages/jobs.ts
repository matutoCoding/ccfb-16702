import { h, button, badge, progressBar, toast, confirmDialog, fmtDate } from '../../ui/dom';
import type { PageContext } from '../../main';
import { dbApi } from '../../core/db';
import type { BatchRecord, FitJobRecord } from '../../core/types';
import { fitQueue } from '../../gpu/fitQueue';

export function renderJobsPage(ctx: PageContext): () => void {
  const root = ctx.root;
  root.appendChild(h('div', { class: 'empty' }, [h('div', { class: 'spinner' })]));
  let batches: BatchRecord[] = [];
  let jobs: FitJobRecord[] = [];
  let selectedBatch = ctx.params.id ?? '';
  let algo: 'ptm' | 'hsh' = 'ptm';
  let tileSize = 256;
  let correctExposure = true;
  let unsub: (() => void) | null = null;

  async function load() {
    batches = await dbApi.batches.list();
    batches.sort((a, b) => b.createdAt - a.createdAt);
    if (!selectedBatch && batches[0]) selectedBatch = batches[0].id;
    jobs = await dbApi.jobs.list();
    jobs.sort((a, b) => b.createdAt - a.createdAt);
  }

  function statusBadge(j: FitJobRecord) {
    switch (j.status) {
      case 'done':
        return badge('已完成', 'ok');
      case 'running':
        return badge('拟合中', 'info');
      case 'queued':
        return badge('排队中', 'muted');
      case 'paused':
        return badge('已暂停/可续算', 'warn');
      case 'error':
        return badge('失败', 'err');
      case 'canceled':
        return badge('已取消', 'muted');
    }
  }

  function jobCard(j: FitJobRecord): HTMLElement {
    const batch = batches.find((b) => b.id === j.batchId);
    const total = j.tilesX * j.tilesY;
    const done = j.doneTiles.length;
    const pct = total ? done / total : 0;
    const running = fitQueue.isRunning(j.id);
    const canRun = j.status !== 'running' && j.status !== 'done';
    const hasLights = batch && batch.lights.length === batch.imageIds.length && batch.lights.length > 0;

    return h('div', { class: 'card' }, [
      h('div', { class: 'card-body' }, [
        h('div', { class: 'field-row', style: { alignItems: 'flex-start' } }, [
          h('div', { style: { flex: '2', minWidth: '220px' } }, [
            h('div', { class: 'pill-row' }, [
              h('strong', { style: { fontSize: '14.5px' } }, batch?.artifactName ?? '未知器物'),
              badge(j.algo.toUpperCase(), 'accent'),
              statusBadge(j),
            ]),
            h('div', { class: 'card-hint mt8' }, [
              batch?.name ?? j.batchId,
              ` · ${batch?.width ?? '?'}×${batch?.height ?? '?'} · tile ${j.tileSize} · ${j.tilesX}×${j.tilesY}=${total} 块`,
            ]),
            h('div', { class: 'card-hint' }, `创建于 ${fmtDate(j.createdAt)}${j.finishedAt ? ' · 完成于 ' + fmtDate(j.finishedAt) : ''}`),
            j.error ? h('div', { class: 'text-err mt8', style: { fontSize: '12.5px' } }, j.error) : null,
            !hasLights ? h('div', { class: 'text-warn mt8', style: { fontSize: '12.5px' } }, '⚠ 该批次缺少灯位,请先到灯位标定完成') : null,
          ]),
          h('div', { style: { flex: '1.4', minWidth: '180px' } }, [
            progressBar(pct, `${done}/${total} tile · ${Math.round(pct * 100)}%`),
            h('div', { class: 'card-hint mt8' }, j.fitMs ? `计算耗时 ${(j.fitMs / 1000).toFixed(2)} s` : '尚未完成计算'),
          ]),
          h('div', { class: 'actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
            j.status === 'done' && j.resultId
              ? button('查看重光照', { variant: 'primary', onClick: () => ctx.navigate(`#/viewer/${j.resultId}`) })
              : canRun
                ? button(done > 0 ? '继续拟合' : '开始拟合', {
                    variant: 'primary',
                    disabled: !hasLights || running,
                    onClick: async () => {
                      try {
                        await fitQueue.startJob(j.id);
                      } catch (e) {
                        toast(String((e as Error).message || e), 'err', 5000);
                      }
                      rerender();
                    },
                  })
                : null,
            running
              ? button('暂停', {
                  onClick: () => {
                    fitQueue.requestPause(j.id);
                    toast('当前 tile 完成后暂停,进度已保存');
                  },
                })
              : null,
            button('删除', {
              variant: 'danger',
              onClick: async () => {
                if (!(await confirmDialog('删除该拟合任务及其系数块?批次与照片不会删除。'))) return;
                await deleteJobAndResult(j);
                toast('任务已删除');
                rerender();
              },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  async function deleteJobAndResult(j: FitJobRecord) {
    if (j.resultId) {
      const r = await dbApi.results.get(j.resultId);
      if (r) {
        await dbApi.results.del(r.id);
        const { deleteChunksByPrefix } = await import('../../core/db');
        await deleteChunksByPrefix(r.coeffPrefix);
        await deleteChunksByPrefix(r.normalPrefix);
      }
    }
    await dbApi.jobs.del(j.id);
  }

  const createCard = h('section', { class: 'card' });
  const listHost = h('div', { class: 'grid', style: { gap: '12px' } });

  function renderCreateCard() {
    createCard.replaceChildren();
    const batchSelect = h(
      'select',
      {
        class: 'input',
        onChange: (e: Event) => (selectedBatch = (e.target as HTMLSelectElement).value),
      },
      batches.map((b) => h('option', { value: b.id, selected: b.id === selectedBatch }, `${b.artifactName} · ${b.name} (${b.imageIds.length}张)`)),
    ) as HTMLSelectElement;

    const algoSeg = h('div', { class: 'seg' }, [
      h('button', { class: algo === 'ptm' ? 'active' : '', onClick: () => { algo = 'ptm'; renderCreateCard(); } }, 'PTM 二次多项式 (18系数)'),
      h('button', { class: algo === 'hsh' ? 'active' : '', onClick: () => { algo = 'hsh'; renderCreateCard(); } }, '半球谐 HSH 二阶 (27系数)'),
    ]);
    const tileSeg = h('div', { class: 'seg' }, [128, 256, 512].map((t) =>
      h('button', { class: tileSize === t ? 'active' : '', onClick: () => { tileSize = t; renderCreateCard(); } }, `${t}px`),
    ));
    const expoCheck = h('input', { type: 'checkbox' }) as HTMLInputElement;
    expoCheck.checked = correctExposure;
    expoCheck.addEventListener('change', () => (correctExposure = expoCheck.checked));

    createCard.appendChild(
      h('div', { class: 'card-body' }, [
        h('div', { class: 'grid cols-2' }, [
          h('div', { class: 'field' }, [h('label', {}, '拍摄批次'), batchSelect]),
          h('div', { class: 'field' }, [h('label', {}, '分块尺寸(大图分块进后台队列)'), tileSeg]),
        ]),
        h('div', { class: 'field' }, [h('label', {}, '拟合模型'), algoSeg]),
        h('label', { class: 'pill-row', style: { fontSize: '13px', color: 'var(--fg-dim)' } }, [expoCheck, '拟合前对曝光异常灯图自动增益拉齐']),
        h('div', { class: 'pill-row mt12' }, [
          button('创建并开始拟合', {
            variant: 'primary',
            disabled: !batches.length,
            onClick: async () => {
              try {
                const j = await fitQueue.createJob(selectedBatch, algo, tileSize, correctExposure);
                toast('任务已创建,开始 GPU 拟合…', 'ok');
                rerender();
                await fitQueue.startJob(j.id);
                rerender();
              } catch (e) {
                toast(String((e as Error).message || e), 'err', 5000);
              }
            },
          }),
          button('去导入批次', { variant: 'ghost', onClick: () => ctx.navigate('#/batches') }),
        ]),
      ]),
    );
  }

  function rerender() {
    load().then(() => {
      renderCreateCard();
      listHost.replaceChildren();
      const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'paused' || j.status === 'error');
      const done = jobs.filter((j) => j.status === 'done' || j.status === 'canceled');
      if (!jobs.length) {
        listHost.appendChild(
          h('div', { class: 'empty' }, [h('div', { class: 'ico' }, '🧮'), h('h3', {}, '还没有拟合任务'), h('p', {}, '选择一个批次和模型,系数将逐像素在 WebGPU 计算着色器中分块算出。')]),
        );
      } else {
        if (active.length) {
          listHost.appendChild(h('div', { class: 'nav-label' }, `进行中 / 可恢复 (${active.length})`));
          active.forEach((j) => listHost.appendChild(jobCard(j)));
        }
        if (done.length) {
          listHost.appendChild(h('div', { class: 'nav-label mt12' }, `已完成 (${done.length})`));
          done.forEach((j) => listHost.appendChild(jobCard(j)));
        }
      }
    });
  }

  (async () => {
    await fitQueue.resetStaleJobs();
    await load();
    root.replaceChildren(
      h('div', { class: 'grid', style: { gap: '16px' } }, [
        createCard,
        listHost,
      ]),
    );
    renderCreateCard();
    unsub = fitQueue.subscribe(() => {
      // 队列事件触发刷新(节流微任务)
      void load().then(() => {
        if (!document.body.contains(root)) return;
        const scroll = root.querySelector('.content');
        listHost.replaceChildren();
        const active = jobs.filter((j) => j.status !== 'done' && j.status !== 'canceled');
        const done = jobs.filter((j) => j.status === 'done' || j.status === 'canceled');
        if (!jobs.length) {
          listHost.appendChild(h('div', { class: 'empty' }, [h('div', { class: 'ico' }, '🧮'), h('h3', {}, '还没有拟合任务')]));
        } else {
          active.forEach((j) => listHost.appendChild(jobCard(j)));
          done.forEach((j) => listHost.appendChild(jobCard(j)));
        }
      });
    });
    rerender();
  })();

  return () => {
    unsub?.();
  };
}
