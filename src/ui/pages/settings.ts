import { h, button, badge, toast, confirmDialog, modal } from '../../ui/dom';
import type { PageContext } from '../../main';
import { dbApi } from '../../core/db';
import { getGpuContext, isWebGpuAvailable } from '../../gpu/device';
import { gpuSelfTest } from '../../gpu/selftest';
import { accuracyBenchmark, performanceBenchmark2000 } from '../../gpu/benchmark';
import type { SettingsRecord } from '../../core/types';

export function renderSettingsPage(ctx: PageContext): () => void {
  const root = ctx.root;
  let settings: SettingsRecord | null = null;
  let alive = true;

  async function init() {
    settings = await dbApi.settings.get();
    if (!alive) return;
    build();
  }

  function build() {
    const s = settings!;
    const authorInput = h('input', { class: 'input', value: s.author }) as HTMLInputElement;
    authorInput.addEventListener('change', () => save({ author: authorInput.value || '研究员' }));
    const unitSel = h(
      'select',
      { class: 'input' },
      ['mm', 'cm'].map((u) => h('option', { value: u, selected: s.unit === u }, u === 'mm' ? '毫米 mm' : '厘米 cm')),
    ) as HTMLSelectElement;
    unitSel.addEventListener('change', () => save({ unit: unitSel.value as 'mm' | 'cm' }));
    const tileSel = h(
      'select',
      { class: 'input' },
      [128, 256, 512].map((t) => h('option', { value: String(t), selected: s.tileSize === t }, `${t} px/tile`) ),
    ) as HTMLSelectElement;
    tileSel.addEventListener('change', () => save({ tileSize: Number(tileSel.value) }));
    const themeSel = h(
      'select',
      { class: 'input' },
      [['dark', '深色影像工作站'], ['light', '浅色']].map(([v, label]) => h('option', { value: v, selected: s.theme === v }, label)),
    ) as HTMLSelectElement;
    themeSel.addEventListener('change', () => {
      const theme = themeSel.value as 'dark' | 'light';
      document.documentElement.dataset.theme = theme;
      save({ theme });
    });

    root.replaceChildren(
      h('div', { class: 'grid', style: { gap: '16px' } }, [
        h('div', { class: 'grid cols-2' }, [
          h('section', { class: 'card' }, [
            h('header', { class: 'card-head' }, [h('h2', {}, '个人与偏好')]),
            h('div', { class: 'card-body' }, [
              h('div', { class: 'field' }, [h('label', {}, '作者署名(标注自动携带)'), authorInput]),
              h('div', { class: 'field' }, [h('label', {}, '长度单位'), unitSel]),
              h('div', { class: 'field' }, [h('label', {}, '拟合分块尺寸'), tileSel]),
              h('div', { class: 'field' }, [h('label', {}, '主题'), themeSel]),
            ]),
          ]),
          gpuCard(),
        ]),
        accuracyCard(),
        perfCard(),
        dataCard(),
        aboutCard(),
      ]),
    );
  }

  async function save(patch: Partial<SettingsRecord>) {
    settings = { ...settings!, ...patch };
    await dbApi.settings.set(settings);
    toast('设置已保存', 'ok', 1400);
  }

  function gpuCard(): HTMLElement {
    const host = h('div', { class: 'card-body' }, [h('p', { class: 'card-hint' }, '检测中…')]);
    (async () => {
      if (!isWebGpuAvailable()) {
        host.replaceChildren(h('p', { class: 'text-err' }, '当前浏览器不支持 WebGPU,请使用最新版 Chrome / Edge。'));
        return;
      }
      try {
        const g = await getGpuContext();
        host.replaceChildren(
          h('div', { class: 'kv-list' }, [
            h('span', { class: 'k' }, '适配器'), h('span', { class: 'v' }, g.info || 'WebGPU'),
            h('span', { class: 'k' }, 'maxStorageBinding'), h('span', { class: 'v mono' }, `${Math.round(g.maxStorageBufferBindingSize / 1048576)} MB`),
            h('span', { class: 'k' }, '设备上限'), h('span', { class: 'v mono' }, `${g.device.limits.maxComputeWorkgroupsPerDimension} wg/dim`),
          ]),
          h('div', { class: 'mt12' }, [
            button('运行 GPU/CPU 数学一致性自检 (256²·48灯)', {
              variant: 'primary',
              onClick: async (e) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                btn.textContent = '自检中…';
                try {
                  const r = await gpuSelfTest(256, 48);
                  modal(
                    'GPU 自检结果',
                    h('div', { class: 'kv-list' }, [
                      h('span', { class: 'k' }, '系数最大绝对误差'), h('span', { class: 'v mono text-good' }, r.maxCoeffDiff.toExponential(2)),
                      h('span', { class: 'k' }, '系数平均相对误差'), h('span', { class: 'v mono' }, r.meanCoeffRel.toExponential(2)),
                      h('span', { class: 'k' }, 'GPU 法线平均误差'), h('span', { class: 'v' }, `${r.gpuNormalMeanDeg.toFixed(3)}°`),
                      h('span', { class: 'k' }, 'CPU 法线平均误差'), h('span', { class: 'v' }, `${r.cpuNormalMeanDeg.toFixed(3)}°`),
                      h('span', { class: 'k' }, 'P95 误差'), h('span', { class: 'v' }, `${r.gpu.p95Deg.toFixed(2)}°`),
                    ]),
                  );
                } catch (err) {
                  toast('自检失败: ' + String((err as Error).message || err), 'err', 6000);
                } finally {
                  btn.disabled = false;
                  btn.textContent = '重新自检';
                }
              },
            }),
          ]),
        );
      } catch (e) {
        host.replaceChildren(h('p', { class: 'text-err' }, 'WebGPU 初始化失败: ' + String((e as Error).message || e)));
      }
    })();
    return h('section', { class: 'card' }, [h('header', { class: 'card-head' }, [h('h2', {}, 'WebGPU 计算环境')]), host]);
  }

  function accuracyCard(): HTMLElement {
    const resultHost = h('div', { class: 'mt12' }, [h('p', { class: 'card-hint' }, '使用内置带刻字/凹痕高度场合成灯图,GPU 拟合后把法线与真值法线比较。验收线:平均角度误差 < 3°。')]);
    const sizeSel = h(
      'select',
      { class: 'input', style: { maxWidth: '220px' } },
      [256, 512, 1024].map((v) => h('option', { value: String(v), selected: v === 512 }, `${v}×${v}`)),
    ) as HTMLSelectElement;
    const runBtn = button('运行精度验收', { variant: 'primary' });
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      const old = runBtn.textContent;
      runBtn.textContent = '合成并拟合中…';
      resultHost.replaceChildren(h('div', { class: 'pill-row' }, [h('div', { class: 'spinner' }), h('span', {}, '正在合成 48 张灯图并 GPU 拟合…')]));
      try {
        const r = await accuracyBenchmark(Number(sizeSel.value), 48);
        resultHost.replaceChildren(
          h('div', {}, [
            h('div', { class: 'pill-row' }, [
              badge(r.pass ? 'PASS < 3°' : 'FAIL', r.pass ? 'ok' : 'err'),
              h('strong', { style: { fontSize: '18px' } }, `平均 ${r.stats.meanDeg.toFixed(3)}°`),
            ]),
            h('div', { class: 'kv-list mt12' }, [
              h('span', { class: 'k' }, '中位数'), h('span', { class: 'v' }, `${r.stats.medianDeg.toFixed(3)}°`),
              h('span', { class: 'k' }, 'P95'), h('span', { class: 'v' }, `${r.stats.p95Deg.toFixed(2)}°`),
              h('span', { class: 'k' }, '最大'), h('span', { class: 'v' }, `${r.stats.maxDeg.toFixed(1)}°`),
              h('span', { class: 'k' }, 'GPU 拟合耗时'), h('span', { class: 'v mono' }, `${(r.gpuMs / 1000).toFixed(2)} s`),
            ]),
          ]),
        );
      } catch (e) {
        resultHost.replaceChildren(h('p', { class: 'text-err' }, String((e as Error).message || e)));
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = old;
      }
    });
    return h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '🎯 拟合精度验收')]),
      h('div', { class: 'card-body' }, [h('div', { class: 'pill-row' }, [sizeSel, runBtn]), resultHost]),
    ]);
  }

  function perfCard(): HTMLElement {
    const host = h('div', { class: 'mt12' }, [h('p', { class: 'card-hint' }, '压测 2000×2000、48 灯、64 个 tile 的真实 GPU 提交/回读与 u8 量化路径。验收线:页面拟合 < 20 秒。完整端到端(含 JPEG 解码、对齐采样、IndexedDB 落盘)请在批次页生成 2000² 验收数据后到拟合任务页运行,任务卡显示计算耗时。')]);
    const btn = button('运行 2000²×48 性能基准', { variant: 'primary' });
    const prog = h('div', { class: 'progress-wrap mt12 hidden', style: { height: '12px' } }, [h('div', { class: 'progress-bar', style: { width: '0%' } })]);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '基准运行中…';
      prog.classList.remove('hidden');
      const bar = prog.firstElementChild as HTMLElement;
      try {
        const r = await performanceBenchmark2000((d, t) => (bar.style.width = `${(d / t) * 100}%`));
        host.replaceChildren(
          h('div', {}, [
            h('div', { class: 'pill-row' }, [
              badge(r.pass20s ? 'PASS < 20s' : 'FAIL', r.pass20s ? 'ok' : 'err'),
              h('strong', { style: { fontSize: '18px' } }, `${(r.totalMs / 1000).toFixed(2)} s`),
            ]),
            h('div', { class: 'kv-list mt12' }, [
              h('span', { class: 'k' }, '规模'), h('span', { class: 'v mono' }, `${r.width}×${r.height} · ${r.photos} 张 · ${r.tiles} tiles`),
              h('span', { class: 'k' }, 'GPU 计算+回读'), h('span', { class: 'v mono' }, `${(r.gpuFitMs / 1000).toFixed(2)} s`),
              h('span', { class: 'k' }, 'CPU 量化'), h('span', { class: 'v mono' }, `${(r.quantMs / 1000).toFixed(2)} s`),
            ]),
          ]),
        );
      } catch (e) {
        host.replaceChildren(h('p', { class: 'text-err' }, String((e as Error).message || e)));
      } finally {
        btn.disabled = false;
        btn.textContent = '重新运行性能基准';
      }
    });
    return h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '⚡ 性能验收')]),
      h('div', { class: 'card-body' }, [btn, prog, host]),
    ]);
  }

  function dataCard(): HTMLElement {
    const usage = h('span', { class: 'card-hint' }, '');
    void navigator.storage?.estimate?.().then((e) => {
      usage.textContent = `IndexedDB 已用约 ${((e.usage ?? 0) / 1048576).toFixed(1)} MB / 配额 ${((e.quota ?? 0) / 1073741824).toFixed(1)} GB`;
    });
    return h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '数据管理')]),
      h('div', { class: 'card-body pill-row' }, [
        usage,
        h('span', { style: { flex: '1' } }),
        button('清空全部本地数据', {
          variant: 'danger',
          onClick: async () => {
            if (!(await confirmDialog('将删除所有批次、照片、任务、系数、标注与对比记录,且不可恢复。确定?', '危险操作'))) return;
            indexedDB.deleteDatabase('rti-studio');
            toast('已清空,页面即将刷新', 'ok');
            setTimeout(() => location.reload(), 900);
          },
        }),
      ]),
    ]);
  }

  function aboutCard(): HTMLElement {
    return h('section', { class: 'card' }, [
      h('header', { class: 'card-head' }, [h('h2', {}, '关于与算法')]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'feat-list' }, [
          feat('🧮', 'PTM / HSH', '6 项二次多项式与 9 项半球谐,最小二乘投影矩阵 CPU 预算、WebGPU 逐像素计算'),
          feat('🧭', '稳健法线', '非对称残差截断 IRLS + 可见性权重,压制镜面高光与背光截断'),
          feat('💾', '断点续算', '系数按 tile 量化入 IndexedDB,关闭页面后已算块不重算'),
          feat('📤', '标准导出', 'PTM 1.2 RGB 与 Relight/CHI HSH .rti,外部查看器可打开'),
        ]),
        h('p', { class: 'card-hint mt12' }, '所有计算与数据均在本机浏览器内完成,不上传任何文物影像。'),
      ]),
    ]);
  }

  function feat(icon: string, title: string, desc: string) {
    return h('div', { class: 'feat' }, [h('div', { class: 'fi' }, icon), h('div', {}, [h('div', { class: 'ft' }, title), h('div', { class: 'fd' }, desc)])]);
  }

  void init();
  return () => {
    alive = false;
  };
}
