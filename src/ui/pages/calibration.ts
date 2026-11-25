import { h, button, badge, toast, progressBar } from '../../ui/dom';
import type { PageContext } from '../../main';
import { dbApi } from '../../core/db';
import type { BatchRecord, LightDir, SphereCalibration } from '../../core/types';
import { detectBlackSphere, detectHighlight, lightFromHighlight } from '../../core/calib/sphereDetect';

export function renderCalibrationPage(ctx: PageContext): () => void {
  const root = ctx.root;
  let alive = true;
  let batch: BatchRecord | null = null;
  let images: Awaited<ReturnType<typeof dbApi.images.listByBatch>> = [];
  let index = 0;
  let sphere: SphereCalibration | null = null;
  let imgEl: HTMLImageElement | null = null;
  let objectUrl: string | null = null;
  let busy = false;

  root.appendChild(h('div', { class: 'empty' }, [h('div', { class: 'spinner' })]));

  async function init() {
    const id = ctx.params.id;
    if (id) batch = (await dbApi.batches.get(id)) ?? null;
    if (!batch) {
      const all = await dbApi.batches.list();
      all.sort((a, b) => b.createdAt - a.createdAt);
      batch = all[0] ?? null;
    }
    if (!batch) {
      root.replaceChildren(
        h('div', { class: 'empty' }, [
          h('div', { class: 'ico' }, '💡'),
          h('h3', {}, '没有可标定的批次'),
          h('p', {}, '先导入照片或生成合成样例。'),
          button('去拍摄批次', { variant: 'primary', onClick: () => ctx.navigate('#/batches') }),
        ]),
      );
      return;
    }
    images = (await dbApi.images.listByBatch(batch.id)).sort((a, b) => a.index - b.index);
    sphere = batch.sphere ? structuredClone(batch.sphere) : null;
    if (!sphere && batch.width) {
      sphere = { cx: batch.width / 2, cy: batch.height / 2, radius: Math.min(batch.width, batch.height) * 0.08, highlights: images.map(() => ({ x: 0, y: 0 })) };
    }
    if (!sphere!.highlights || sphere!.highlights.length !== images.length) {
      const old = sphere?.highlights ?? [];
      sphere!.highlights = images.map((_, i) => old[i] ?? { x: sphere!.cx, y: sphere!.cy - sphere!.radius * 0.4 });
    }
    buildUi();
    await loadImage(index);
  }

  let canvas: HTMLCanvasElement;
  let ctx2d: CanvasRenderingContext2D;
  let infoLine: HTMLElement;
  let polar: HTMLCanvasElement;

  function buildUi() {
    root.replaceChildren();
    canvas = h('canvas', { class: 'calib-canvas' }) as HTMLCanvasElement;
    canvas.width = 1040;
    canvas.height = Math.round((1040 * batch!.height) / batch!.width);
    ctx2d = canvas.getContext('2d')!;
    canvas.style.width = '100%';
    const wrap = h('div', { class: 'calib-wrap' }, [canvas]);
    infoLine = h('div', { class: 'card-hint mt8' }, '');

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    const thumbStrip = h('div', { class: 'thumb-strip' });
    images.forEach((im, i) => {
      const url = URL.createObjectURL(im.blob);
      const t = h('div', { class: `thumb ${i === index ? 'sel' : ''}`, title: im.name }, [
        h('img', { src: url }),
        h('span', { class: 'idx' }, `#${i + 1}`),
      ]);
      t.addEventListener('click', () => {
        index = i;
        thumbStrip.querySelectorAll('.thumb').forEach((el, k) => el.classList.toggle('sel', k === i));
        void loadImage(i);
      });
      thumbStrip.appendChild(t);
    });

    const batchSelect = h(
      'select',
      {
        class: 'input',
        onChange: (e: Event) => {
          const id = (e.target as HTMLSelectElement).value;
          ctx.navigate(`#/calibration/${id}`);
        },
      },
      [h('option', { value: '' }, '切换批次…')],
    ) as HTMLSelectElement;
    void dbApi.batches.list().then((all) => {
      batchSelect.replaceChildren(
        h('option', { value: '' }, '切换批次…'),
        ...all.map((b) => h('option', { value: b.id, selected: b.id === batch!.id }, `${b.artifactName} · ${b.imageIds.length}张`)),
      );
    });

    const autoSphereBtn = button('🔍 自动找黑色反光球', { variant: 'primary', onClick: () => autoSphere() });
    const autoOneBtn = button('检测本张高光', { onClick: () => detectOne(index) });
    const progFill = h('div', { class: 'progress-bar', style: { width: '0%' } }) as HTMLElement;
    const progLabel = h('span', { class: 'progress-label' }, '准备…') as HTMLElement;
    const progEl = h('div', { class: 'progress-wrap', style: { height: '14px' } }, [progFill, progLabel]);
    const prog = {
      el: progEl,
      set: (pct: number, text: string) => {
        progFill.style.width = `${Math.round(pct * 100)}%`;
        progLabel.textContent = text;
      },
    };
    const autoAllBtn = button('⚡ 全部自动标定', {
      onClick: async () => {
        if (!sphere) return;
        busy = true;
        progWrap.classList.remove('hidden');
        try {
          if (!sphere.radius || sphere.radius < 5) await autoSphere();
          for (let i = 0; i < images.length; i++) {
            await detectOne(i, true);
            prog.set((i + 1) / images.length, `标定 ${i + 1}/${images.length}`);
            await new Promise((r) => setTimeout(r, 0));
          }
          await persist();
          toast('全部灯位标定完成,可逐张拖动高光修正', 'ok');
        } finally {
          busy = false;
          prog.set(1, '完成');
          setTimeout(() => progWrap.classList.add('hidden'), 1200);
          draw();
          drawPolar();
        }
      },
    });
    const progWrap = h('div', { class: 'mt12 hidden' }, [prog.el]);

    const prevNext = h('div', { class: 'pill-row' }, [
      button('← 上一张', { variant: 'subtle', onClick: () => { index = (index - 1 + images.length) % images.length; syncThumbs(); void loadImage(index); } }),
      button('下一张 →', { variant: 'subtle', onClick: () => { index = (index + 1) % images.length; syncThumbs(); void loadImage(index); } }),
    ]);
    function syncThumbs() {
      thumbStrip.querySelectorAll('.thumb').forEach((el, k) => el.classList.toggle('sel', k === index));
    }

    polar = h('canvas', { width: 240, height: 240, style: { width: '220px', maxWidth: '100%' } }) as HTMLCanvasElement;

    const knownBanner =
      batch!.lightsSource === 'known'
        ? h('div', { class: 'card-hint', style: { color: 'var(--accent-strong)' } }, 'ℹ 该合成批次自带已知灯位,可直接去拟合;本页也可用标定球流程练习并覆盖灯位。')
        : h('div', { class: 'card-hint' }, '拖动青色高光点修正位置;拖动球心可移动球,拖动右下手柄改半径。');

    const right = h('div', { class: 'grid', style: { gap: '16px' } }, [
      h('section', { class: 'card' }, [h('div', { class: 'card-body' }, [batchSelect])]),
      h('section', { class: 'card' }, [
        h('header', { class: 'card-head' }, [h('h2', {}, '标定操作')]),
        h('div', { class: 'card-body' }, [
          knownBanner,
          h('div', { class: 'pill-row mt12' }, [autoSphereBtn, autoOneBtn]),
          h('div', { class: 'mt12' }, [autoAllBtn]),
          progWrap,
          h('div', { class: 'mt12' }, [prevNext]),
          infoLine,
        ]),
      ]),
      h('section', { class: 'card' }, [h('header', { class: 'card-head' }, [h('h2', {}, '灯位覆盖图')]), h('div', { class: 'card-body', style: { textAlign: 'center' } }, [polar])]),
      h('section', { class: 'card' }, [
        h('div', { class: 'card-body pill-row' }, [
          button('💾 保存灯位', { variant: 'primary', onClick: () => persist().then(() => toast('灯位已保存', 'ok')) }),
          button('保存并去拟合 →', {
            onClick: async () => {
              await persist();
              ctx.navigate(`#/jobs/${batch!.id}`);
            },
          }),
        ]),
      ]),
    ]);

    root.replaceChildren(
      h('div', {}, [
        h('div', { class: 'workbench' }, [
          h('section', { class: 'card stage-card' }, [h('div', { class: 'card-body tight' }, [wrap, thumbStrip])]),
          right,
        ]),
      ]),
    );
    drawPolar();
  }

  // ---------- 坐标换算 ----------
  function toFull(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * batch!.width,
      y: ((e.clientY - rect.top) / rect.height) * batch!.height,
    };
  }
  function drawScale(): number {
    return canvas.width / batch!.width;
  }

  type DragMode = 'none' | 'highlight' | 'center' | 'radius';
  let drag: DragMode = 'none';

  function hitTest(p: { x: number; y: number }): DragMode {
    if (!sphere) return 'none';
    const hl = sphere.highlights[index];
    if (hl && Math.hypot(p.x - hl.x, p.y - hl.y) < 22 / (canvas.getBoundingClientRect().width / batch!.width)) return 'highlight';
    const rh = { x: sphere.cx + sphere.radius * 0.707, y: sphere.cy + sphere.radius * 0.707 };
    if (Math.hypot(p.x - rh.x, p.y - rh.y) < 26) return 'radius';
    if (Math.hypot(p.x - sphere.cx, p.y - sphere.cy) < sphere.radius * 0.5) return 'center';
    return 'none';
  }

  function onPointerDown(e: PointerEvent) {
    if (busy || !sphere) return;
    const p = toFull(e);
    drag = hitTest(p);
    if (drag !== 'none') canvas.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    const p = toFull(e);
    if (drag === 'highlight') {
      sphere!.highlights[index] = { x: clamp(p.x, 0, batch!.width), y: clamp(p.y, 0, batch!.height), manual: true };
      updateLightFromCurrent();
      draw();
      drawPolar();
    } else if (drag === 'center') {
      sphere!.cx = p.x;
      sphere!.cy = p.y;
      draw();
    } else if (drag === 'radius') {
      sphere!.radius = Math.max(20, Math.hypot(p.x - sphere!.cx, p.y - sphere!.cy) / 0.707);
      draw();
    } else {
      canvas.style.cursor = hitTest(p) === 'none' ? 'crosshair' : 'grab';
    }
  }
  function onPointerUp() {
    if (drag !== 'none') {
      drag = 'none';
      void persist();
    }
  }

  function updateLightFromCurrent() {
    if (!sphere) return;
    const hl = sphere.highlights[index];
    if (!hl || !hl.x) return;
    const l = lightFromHighlight(sphere.cx, sphere.cy, sphere.radius, hl.x, hl.y);
    const light: LightDir = {
      ...l,
      azimuth: (Math.atan2(l.y, l.x) * 180) / Math.PI,
      elevation: (Math.asin(l.z) * 180) / Math.PI,
    };
    batch!.lights[index] = light;
  }

  async function getRgbaScaled(maxDim = 1000): Promise<{ data: Uint8ClampedArray; w: number; h: number; scale: number }> {
    const rec = images[index];
    const bmp = await createImageBitmap(rec.blob);
    const sc = Math.min(1, maxDim / Math.max(rec.width, rec.height));
    const w = Math.round(rec.width * sc);
    const h = Math.round(rec.height * sc);
    const c = new OffscreenCanvas(w, h);
    const cx = c.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return { data: cx.getImageData(0, 0, w, h).data, w, h, scale: 1 / sc };
  }

  async function autoSphere() {
    toast('检测黑色反光球…');
    const { data, w, h, scale } = await getRgbaScaled(900);
    const circle = detectBlackSphere(data, w, h);
    if (!circle) return toast('没找到可靠的黑色圆球,请手动拖动圆框', 'err', 4200);
    sphere!.cx = circle.cx * scale;
    sphere!.cy = circle.cy * scale;
    sphere!.radius = circle.radius * scale;
    toast(`找到球(置信度 ${circle.score.toFixed(2)}),可拖动修正`, 'ok');
    draw();
  }

  async function detectOne(i: number, silent = false) {
    const oldIndex = index;
    index = i;
    const { data, w, h, scale } = await getRgbaScaled(900);
    if (!sphere || sphere.radius < 5) {
      const c = detectBlackSphere(data, w, h);
      if (c) {
        sphere!.cx = c.cx * scale;
        sphere!.cy = c.cy * scale;
        sphere!.radius = c.radius * scale;
      }
    }
    if (!sphere) return;
    // 用缩放后的圆坐标检测
    const cSmall = { cx: sphere.cx / scale, cy: sphere.cy / scale, radius: sphere.radius / scale, score: 1 };
    const hl = detectHighlight(data, w, h, cSmall);
    if (hl) {
      sphere.highlights[i] = { x: hl.x * scale, y: hl.y * scale, manual: false };
      updateLightFor(i);
      if (i === oldIndex) draw();
    } else if (!silent) {
      toast(`第 ${i + 1} 张未检测到高光,可手动点选`, 'warn');
    }
    index = oldIndex;
  }

  function updateLightFor(i: number) {
    const hl = sphere!.highlights[i];
    if (!hl || !hl.x) return;
    const l = lightFromHighlight(sphere!.cx, sphere!.cy, sphere!.radius, hl.x, hl.y);
    batch!.lights[i] = { ...l, azimuth: (Math.atan2(l.y, l.x) * 180) / Math.PI, elevation: (Math.asin(l.z) * 180) / Math.PI };
  }

  async function loadImage(i: number) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(images[i].blob);
    imgEl = await loadHtmlImage(objectUrl);
    if (!alive) return;
    draw();
    const l = batch?.lights[i];
    if (l) infoLine.textContent = `#${i + 1} 光源 x=${l.x.toFixed(3)} y=${l.y.toFixed(3)} z=${l.z.toFixed(3)} · 仰角 ${(l.elevation ?? 0).toFixed(1)}°`;
    else infoLine.textContent = `#${i + 1} 尚未标定`;
  }

  function draw() {
    if (!ctx2d || !imgEl || !batch) return;
    const ds = drawScale();
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    if (!sphere) return;
    const cx = sphere.cx * ds;
    const cy = sphere.cy * ds;
    const r = sphere.radius * ds;
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = 'rgba(110,168,254,.9)';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2d.stroke();
    // 球心
    ctx2d.fillStyle = '#6ea8fe';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx2d.fill();
    // 半径手柄
    const hx = cx + r * 0.707;
    const hy = cy + r * 0.707;
    ctx2d.fillStyle = '#6ea8fe';
    ctx2d.fillRect(hx - 5, hy - 5, 10, 10);
    // 高光
    const hl = sphere.highlights[index];
    if (hl && hl.x) {
      const x = hl.x * ds;
      const y = hl.y * ds;
      ctx2d.strokeStyle = hl.manual ? '#e8964f' : '#58c98b';
      ctx2d.lineWidth = 2.5;
      ctx2d.beginPath();
      ctx2d.arc(x, y, 11, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.beginPath();
      ctx2d.moveTo(x - 16, y);
      ctx2d.lineTo(x + 16, y);
      ctx2d.moveTo(x, y - 16);
      ctx2d.lineTo(x, y + 16);
      ctx2d.stroke();
    }
  }

  function drawPolar() {
    if (!polar || !batch) return;
    const pc = polar.getContext('2d')!;
    const W = polar.width;
    const c = W / 2;
    pc.clearRect(0, 0, W, W);
    pc.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev').trim() || '#1b1e24';
    pc.fillRect(0, 0, W, W);
    pc.strokeStyle = '#3d4450';
    for (const rr of [0.33, 0.66, 0.95]) {
      pc.beginPath();
      pc.arc(c, c, c * rr, 0, Math.PI * 2);
      pc.stroke();
    }
    pc.strokeStyle = '#2e333d';
    pc.beginPath();
    pc.moveTo(c, 8);
    pc.lineTo(c, W - 8);
    pc.moveTo(8, c);
    pc.lineTo(W - 8, c);
    pc.stroke();
    batch.lights.forEach((l, i) => {
      // 极径用 sqrt(1-z²) 投影,x 右 y 上 -> canvas y 取负
      const rr = Math.sqrt(Math.max(0, 1 - l.z * l.z)) * c * 0.95;
      const x = c + (l.x / Math.max(1e-6, Math.hypot(l.x, l.y))) * rr;
      const y = c - (l.y / Math.max(1e-6, Math.hypot(l.x, l.y))) * rr;
      pc.fillStyle = i === index ? '#e0bd76' : '#56c8d8';
      pc.beginPath();
      pc.arc(x, y, i === index ? 5 : 3.2, 0, Math.PI * 2);
      pc.fill();
    });
  }

  async function persist() {
    if (!batch || !sphere) return;
    batch.sphere = sphere;
    batch.lightsSource = batch.lights.some((l) => l) ? 'sphere' : batch.lightsSource;
    // 灯位感知曝光复查
    if (batch.lights.length === images.length) {
      const { detectExposureLightAware } = await import('../../core/image/exposure');
      const flags = detectExposureLightAware(images.map((i) => i.meanLuma), batch.lights, batch.imageIds);
      batch.exposureFlags = flags;
    }
    await dbApi.batches.put(batch);
  }

  init().catch((e) => {
    console.error(e);
    root.replaceChildren(h('div', { class: 'empty' }, [h('p', { class: 'text-err' }, String(e?.message || e))]));
  });

  return () => {
    alive = false;
    window.removeEventListener('pointerup', onPointerUp);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}
