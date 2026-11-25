import './styles.css';
import { h, clear } from './ui/dom';
import { dbApi } from './core/db';
import { gpuSelfTest } from './gpu/selftest';

import { renderBatchesPage } from './ui/pages/batches';
import { renderCalibrationPage } from './ui/pages/calibration';
import { renderJobsPage } from './ui/pages/jobs';
import { renderViewerPage } from './ui/pages/viewer';
import { renderAnnotatePage } from './ui/pages/annotate';
import { renderComparePage } from './ui/pages/compare';
import { renderSettingsPage } from './ui/pages/settings';

export type RouteParams = Record<string, string>;
export interface PageContext {
  root: HTMLElement;
  params: RouteParams;
  navigate: (hash: string) => void;
}

const ROUTES: { id: string; match: (h: string) => RouteParams | null; title: string; sub: string; render: (ctx: PageContext) => void | (() => void) }[] = [
  { id: 'batches', match: (p) => (p === '/batches' || p === '/' ? {} : null), title: '拍摄批次', sub: '导入多光源照片、对齐与曝光检查', render: (c) => renderBatchesPage(c) },
  { id: 'calibration', match: (p) => (p.startsWith('/calibration') ? parseId(p, '/calibration') : null), title: '灯位标定', sub: '黑色反光球高光检测 · 反算光源方向', render: (c) => renderCalibrationPage(c) },
  { id: 'jobs', match: (p) => (p === '/jobs' ? {} : null), title: '拟合任务', sub: 'PTM / 半球谐 · WebGPU 分块计算 · 断点续算', render: (c) => renderJobsPage(c) },
  { id: 'viewer', match: (p) => (p.startsWith('/viewer') ? parseId(p, '/viewer') : null), title: '重光照查看', sub: '拖动光源实时重光照 · 镜面增强 / 法线 / 多光源 / 浮雕', render: (c) => renderViewerPage(c) },
  { id: 'annotate', match: (p) => (p.startsWith('/annotate') ? parseId(p, '/annotate') : null), title: '测量标注', sub: '比例尺标定 · 长度与刻痕宽度 · 作者时间', render: (c) => renderAnnotatePage(c) },
  { id: 'compare', match: (p) => (p === '/compare' || p.startsWith('/compare/') ? parseId(p, '/compare') : null), title: '两期对比', sub: '同一器物不同时间 · 锈蚀变化高亮', render: (c) => renderComparePage(c) },
  { id: 'settings', match: (p) => (p === '/settings' ? {} : null), title: '设置与验收', sub: '作者信息 · GPU · 合成数据与精度/性能基准', render: (c) => renderSettingsPage(c) },
];

function parseId(path: string, prefix: string): RouteParams | null {
  if (path === prefix) return {};
  if (path.startsWith(prefix + '/')) return { id: decodeURIComponent(path.slice(prefix.length + 1)) };
  return null;
}

const NAV = [
  { hash: '#/batches', icon: '📷', label: '拍摄批次', routeId: 'batches' },
  { hash: '#/calibration', icon: '💡', label: '灯位标定', routeId: 'calibration' },
  { hash: '#/jobs', icon: '🧮', label: '拟合任务', routeId: 'jobs' },
  { hash: '#/viewer', icon: '🔆', label: '重光照查看', routeId: 'viewer' },
  { hash: '#/annotate', icon: '📏', label: '测量标注', routeId: 'annotate' },
  { hash: '#/compare', icon: '🕓', label: '两期对比', routeId: 'compare' },
  { hash: '#/settings', icon: '⚙️', label: '设置验收', routeId: 'settings' },
];

let cleanup: void | (() => void);

async function applyTheme() {
  const s = await dbApi.settings.get();
  document.documentElement.dataset.theme = s.theme;
}

function currentPath(): string {
  const raw = location.hash.replace(/^#/, '') || '/batches';
  return raw.startsWith('/') ? raw : '/' + raw;
}

async function render() {
  await applyTheme();
  const path = currentPath();
  let route = ROUTES.find((r) => r.match(path) !== null);
  if (!route) {
    location.hash = '#/batches';
    return;
  }
  const params = route.match(path)!;

  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.route === route!.id);
  });
  const titleEl = document.getElementById('page-title');
  const subEl = document.getElementById('page-sub');
  if (titleEl) titleEl.textContent = route.title;
  if (subEl) subEl.textContent = route.sub;

  const content = document.getElementById('content')!;
  clear(content);
  const page = h('div', { class: 'page' });
  content.appendChild(page);
  try {
    if (cleanup) cleanup();
  } catch {
    /* ignore */
  }
  cleanup = route.render({
    root: page,
    params,
    navigate: (hash: string) => {
      location.hash = hash.startsWith('#') ? hash : '#' + hash;
    },
  });
}

function shell(): HTMLElement {
  return h('div', { class: 'app-shell' }, [
    h('aside', { class: 'sidebar' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-mark' }, 'RTI'),
        h('div', {}, [h('div', { class: 'brand-name' }, '文保 RTI Studio'), h('div', { class: 'brand-sub' }, 'REFLECTANCE · WEBGPU')]),
      ]),
      h('nav', { class: 'nav-group' }, [
        h('div', { class: 'nav-label' }, '工作流'),
        ...NAV.map((n) =>
          h(
            'button',
            {
              class: 'nav-item',
              dataset: { route: n.routeId },
              onClick: () => {
                location.hash = n.hash;
              },
            },
            [h('span', { class: 'nav-ico' }, n.icon), n.label],
          ),
        ),
      ]),
      h('div', { class: 'sidebar-foot' }, [
        h('div', {}, 'TypeScript · WebGPU Compute'),
        h('div', { class: 'mt8' }, '系数 / 标注 / 批次均存于本机 IndexedDB'),
      ]),
    ]),
    h('main', { class: 'main' }, [
      h('header', { class: 'topbar' }, [
        h('div', {}, [h('h1', { id: 'page-title' }, ''), h('div', { class: 'sub', id: 'page-sub' }, '')]),
        h('div', { class: 'topbar-spacer' }),
        h('span', { id: 'gpu-state', class: 'badge badge-info' }, 'WebGPU 检测中…'),
      ]),
      h('div', { class: 'content', id: 'content' }),
    ]),
  ]);
}

async function refreshGpuBadge() {
  const el = document.getElementById('gpu-state');
  if (!el) return;
  try {
    const { isWebGpuAvailable, getGpuContext } = await import('./gpu/device');
    if (!isWebGpuAvailable()) {
      el.className = 'badge badge-err';
      el.textContent = 'WebGPU 不可用';
      return;
    }
    const g = await getGpuContext();
    el.className = 'badge badge-ok';
    el.textContent = '⚡ ' + (g.info.length > 42 ? 'WebGPU 就绪' : g.info);
    el.title = g.info;
  } catch (e) {
    el.className = 'badge badge-err';
    el.textContent = 'WebGPU 初始化失败';
    el.title = String(e);
  }
}

declare global {
  interface Window {
    __rti?: Record<string, unknown>;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('app')!.appendChild(shell());
  window.addEventListener('hashchange', render);
  render();
  refreshGpuBadge();
  window.__rti = {
    gpuSelfTest,
    dbApi,
    version: '1.0.0',
    createDemoBatch: (await import('./core/synth/demoBatch')).createDemoBatch,
    fitQueue: (await import('./gpu/fitQueue')).fitQueue,
    accuracyBenchmark: (await import('./gpu/benchmark')).accuracyBenchmark,
    performanceBenchmark2000: (await import('./gpu/benchmark')).performanceBenchmark2000,
  };
});
