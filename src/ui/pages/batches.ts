import { h, button, badge, toast, modal, confirmDialog, fmtBytes, fmtDate } from '../../ui/dom';
import type { PageContext } from '../../main';
import { dbApi, uid } from '../../core/db';
import type { BatchRecord } from '../../core/types';
import { createDemoBatch } from '../../core/synth/demoBatch';
import { detectExposure } from '../../core/image/exposure';
import { estimateAlignments, type RgbaImageLike } from '../../core/image/alignment';

export function renderBatchesPage(ctx: PageContext): () => void {
  const root = ctx.root;
  let batches: BatchRecord[] = [];
  let alive = true;

  async function load() {
    batches = await dbApi.batches.list();
    batches.sort((a, b) => b.createdAt - a.createdAt);
  }

  function progressModal(title: string): { close: () => void; set: (pct: number, text: string) => void } {
    const bar = h('div', { class: 'progress-bar', style: { width: '0%' } });
    const text = h('div', { class: 'card-hint mt12' }, '准备中…');
    const wrap = h('div', {}, [h('div', { class: 'progress-wrap', style: { height: '12px' } }, [bar]), text]);
    const close = modal(title, wrap, {});
    return {
      close,
      set: (pct: number, t: string) => {
        bar.style.width = `${Math.round(pct * 100)}%`;
        text.textContent = t;
      },
    };
  }

  async function generateDemo(size: number) {
    const p = progressModal('生成合成多光源数据');
    try {
      const settings = await dbApi.settings.get();
      const id = await createDemoBatch({
        size,
        photos: 48,
        author: settings.author,
        onProgress: (done, total, stage) => p.set(done / total, stage),
      });
      p.close();
      toast(`已生成 ${size}² × 48 灯合成批次,灯位为已知`, 'ok', 4200);
      await refresh();
      setTimeout(() => ctx.navigate(`#/jobs/${id}`), 600);
    } catch (e) {
      p.close();
      console.error(e);
      toast('生成失败: ' + String((e as Error).message || e), 'err', 6000);
    }
  }

  async function importFiles(files: File[]) {
    const images = files.filter((f) => /image\/(jpeg|png|webp)/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
    if (!images.length) return toast('请选择 JPG / PNG / WebP 图片', 'err');
    const settings = await dbApi.settings.get();

    // 元数据表单
    const nameInput = h('input', { class: 'input', value: `导入批次 · ${images.length} 张` }) as HTMLInputElement;
    const artifactInput = h('input', { class: 'input', value: '未命名器物' }) as HTMLInputElement;
    const dateInput = h('input', { class: 'input', type: 'date', value: new Date().toISOString().slice(0, 10) }) as HTMLInputElement;
    const authorInput = h('input', { class: 'input', value: settings.author }) as HTMLInputElement;
    await new Promise<void>((resolve) => {
      const close = modal(
        '新建拍摄批次',
        h('div', {}, [
          h('div', { class: 'field' }, [h('label', {}, '批次名称'), nameInput]),
          h('div', { class: 'field' }, [h('label', {}, '器物 / 编号'), artifactInput]),
          h('div', { class: 'grid cols-2' }, [
            h('div', { class: 'field' }, [h('label', {}, '拍摄日期'), dateInput]),
            h('div', { class: 'field' }, [h('label', {}, '作者'), authorInput]),
          ]),
          h('p', { class: 'card-hint' }, `将导入 ${images.length} 张原图(保存在本机 IndexedDB),导入后请做自动对齐与灯位标定。`),
        ]),
        {
          footer: [
            button('取消', { onClick: () => { close(); resolve(); } }),
            button('开始导入', {
              variant: 'primary',
              onClick: async () => {
                close();
                resolve();
                await doImport();
              },
            }),
          ],
        },
      );
    });

    async function doImport() {
      const p = progressModal('导入照片');
      const batchId = uid('batch');
      const imageIds: string[] = [];
      const fileNames: string[] = [];
      let W = 0;
      let H = 0;
      const lumas: number[] = [];
      let thumb = '';
      try {
        for (let i = 0; i < images.length; i++) {
          const file = images[i];
          p.set(i / images.length, `读取 ${i + 1}/${images.length}:${file.name}`);
          const url = URL.createObjectURL(file);
          const im = await loadImage(url);
          W = W || im.naturalWidth;
          H = H || im.naturalHeight;
          const c = document.createElement('canvas');
          // 亮度统计用小图
          const sc = Math.min(1, 320 / Math.max(im.naturalWidth, im.naturalHeight));
          c.width = Math.round(im.naturalWidth * sc);
          c.height = Math.round(im.naturalHeight * sc);
          const cx = c.getContext('2d', { willReadFrequently: true })!;
          cx.drawImage(im, 0, 0, c.width, c.height);
          const data = cx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          let n = 0;
          for (let px = 0; px < data.length; px += 16) {
            sum += 0.2126 * data[px] + 0.7152 * data[px + 1] + 0.0722 * data[px + 2];
            n++;
          }
          const meanLuma = sum / n;
          lumas.push(meanLuma);
          if (i === 0) {
            const tc = document.createElement('canvas');
            const tsc = 420 / im.naturalWidth;
            tc.width = 420;
            tc.height = Math.round(im.naturalHeight * tsc);
            tc.getContext('2d')!.drawImage(im, 0, 0, tc.width, tc.height);
            thumb = tc.toDataURL('image/jpeg', 0.82);
          }
          URL.revokeObjectURL(url);
          const id = uid('img');
          imageIds.push(id);
          fileNames.push(file.name);
          await dbApi.images.put({
            id,
            batchId,
            index: i,
            name: file.name,
            width: im.naturalWidth,
            height: im.naturalHeight,
            type: file.type || 'image/jpeg',
            size: file.size,
            blob: file,
            meanLuma,
          });
        }
        const flags = detectExposure(lumas, imageIds);
        const batch: BatchRecord = {
          id: batchId,
          name: nameInput.value.trim() || `导入批次 · ${images.length} 张`,
          artifactName: artifactInput.value.trim() || '未命名器物',
          capturedAt: dateInput.value,
          createdAt: Date.now(),
          author: authorInput.value.trim() || settings.author,
          width: W,
          height: H,
          imageIds,
          fileNames,
          lights: [],
          lightsSource: 'none',
          alignments: [],
          exposureFlags: flags,
          thumbnail: thumb,
        };
        await dbApi.batches.put(batch);
        p.close();
        toast(`导入完成:${images.length} 张${flags.length ? `,发现 ${flags.length} 张曝光异常` : ''}`, flags.length ? 'info' : 'ok', 4200);
        await refresh();
      } catch (e) {
        p.close();
        console.error(e);
        toast('导入失败: ' + String((e as Error).message || e), 'err', 6000);
      }
    }
  }

  async function autoAlign(b: BatchRecord, btn: HTMLButtonElement) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '对齐中…';
    try {
      const imgs = await dbApi.images.listByBatch(b.id);
      imgs.sort((a, z) => a.index - z.index);
      const maxDim = 760;
      const smalls: RgbaImageLike[] = [];
      let sw = 0;
      let sh = 0;
      for (const rec of imgs) {
        const bmp = await createImageBitmap(rec.blob);
        const sc = Math.min(1, maxDim / Math.max(rec.width, rec.height));
        sw = Math.round(rec.width * sc);
        sh = Math.round(rec.height * sc);
        const c = new OffscreenCanvas(sw, sh);
        const cx = c.getContext('2d', { willReadFrequently: true })!;
        cx.drawImage(bmp, 0, 0, sw, sh);
        smalls.push({ width: sw, height: sh, data: cx.getImageData(0, 0, sw, sh).data });
        bmp.close();
      }
      const shifts = estimateAlignments(smalls, { refIndex: 0 });
      const fullScale = b.width / sw;
      b.alignments = shifts.map((s) => ({
        imageId: imgs[s.index].id,
        index: s.index,
        shiftX: Math.round(s.shiftX * fullScale),
        shiftY: Math.round(s.shiftY * fullScale),
        score: s.score,
      }));
      await dbApi.batches.put(b);
      const maxShift = Math.max(...b.alignments.map((a) => Math.hypot(a.shiftX, a.shiftY)));
      toast(`对齐完成,最大偏移 ${maxShift}px(全分辨率估计)`, 'ok');
      await refresh();
    } catch (e) {
      console.error(e);
      toast('对齐失败: ' + String((e as Error).message || e), 'err');
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function removeBatch(b: BatchRecord) {
    if (!(await confirmDialog(`删除批次「${b.artifactName}」及其 ${b.imageIds.length} 张照片?相关拟合结果也会删除,此操作不可恢复。`, '删除批次'))) return;
    const imgs = await dbApi.images.listByBatch(b.id);
    for (const im of imgs) await dbApi.images.del(im.id);
    const jobs = await dbApi.jobs.listByBatch(b.id);
    const { deleteChunksByPrefix } = await import('../../core/db');
    for (const j of jobs) {
      if (j.resultId) {
        const r = await dbApi.results.get(j.resultId);
        if (r) {
          await deleteChunksByPrefix(r.coeffPrefix);
          await deleteChunksByPrefix(r.normalPrefix);
          await dbApi.results.del(r.id);
        }
      }
      await dbApi.jobs.del(j.id);
    }
    await dbApi.batches.del(b.id);
    toast('批次已删除');
    await refresh();
  }

  function batchCard(b: BatchRecord): HTMLElement {
    const expo = b.exposureFlags?.length ?? 0;
    const aligned = (b.alignments?.length ?? 0) > 0;
    const calib = b.lights.length === b.imageIds.length && b.lights.length > 0;
    return h('div', { class: 'card batch-card' }, [
      h('div', { class: 'batch-thumb' }, [
        b.thumbnail ? h('img', { src: b.thumbnail, alt: b.name }) : h('div', { class: 'ph' }, '🪙'),
        h('div', { class: 'badges' }, [
          badge(`${b.imageIds.length} 张`, 'info'),
          expo ? badge(`${expo} 张曝光异常`, 'warn') : null,
          aligned ? badge('已对齐', 'ok') : badge('未对齐', 'muted'),
          calib ? badge(b.lightsSource === 'known' ? '已知灯位' : '已标定', 'ok') : badge('待标定', 'err'),
        ]),
      ]),
      h('div', { class: 'batch-meta' }, [
        h('div', { class: 't' }, b.artifactName),
        h('div', { class: 'row' }, [h('span', {}, b.name), h('span', { class: 'mono' }, `${b.width}×${b.height}`)]),
        h('div', { class: 'row' }, [h('span', {}, `📅 ${b.capturedAt} · 👤 ${b.author}`), h('span', {}, fmtDate(b.createdAt).slice(11))]),
        b.mmPerPixel ? h('div', { class: 'row' }, [badge(`比例尺已标定 · 1px=${b.mmPerPixel.toFixed(4)}mm`, 'accent')]) : null,
        h('div', { class: 'pill-row mt8' }, [
          button('💡 灯位标定', { variant: 'primary', onClick: (e) => { e.stopPropagation(); ctx.navigate(`#/calibration/${b.id}`); } }),
          button('🧮 拟合', { variant: 'subtle', onClick: (e: MouseEvent) => { e.stopPropagation(); ctx.navigate(`#/jobs/${b.id}`); } }),
          button('🔆 查看', { variant: 'subtle', onClick: (e: MouseEvent) => { e.stopPropagation(); ctx.navigate(`#/viewer/${b.id}`); } }),
          button('📏 标注', { variant: 'subtle', onClick: (e: MouseEvent) => { e.stopPropagation(); ctx.navigate(`#/annotate/${b.id}`); } }),
        ]),
        h('div', { class: 'pill-row' }, [
          button(aligned ? '重新自动对齐' : '自动对齐', {
            variant: 'ghost',
            style: { padding: '4px 8px', fontSize: '12px' },
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              autoAlign(b, e.currentTarget as HTMLButtonElement);
            },
          }),
          button('删除', {
            variant: 'ghost',
            style: { padding: '4px 8px', fontSize: '12px', color: 'var(--red)' },
            onClick: (e: MouseEvent) => {
              e.stopPropagation();
              removeBatch(b);
            },
          }),
        ]),
      ]),
    ]) as HTMLElement;
  }

  async function refresh() {
    await load();
    if (!alive) return;
    grid.replaceChildren();
    if (!batches.length) {
      grid.appendChild(
        h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, [
          h('div', { class: 'ico' }, '📷'),
          h('h3', {}, '还没有拍摄批次'),
          h('p', {}, '导入几十张 JPG/PNG 多光源照片,或先用内置高度场合成一组带刻字凹痕的 48 灯测试数据。'),
        ]),
      );
    } else {
      batches.forEach((b) => grid.appendChild(batchCard(b)));
    }
  }

  const grid = h('div', { class: 'batch-grid mt16' });
  const drop = h('div', { class: 'dropzone' }, [
    h('div', { class: 'ico' }, '📁'),
    h('div', { style: { fontWeight: '650', marginBottom: '4px' } }, '点击选择或把 JPG / PNG 照片拖到这里'),
    h('div', { class: 'card-hint' }, '一组通常 30–60 张,同机位、不同灯位;曝光不一致会自动提示'),
  ]);
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, style: { display: 'none' } }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void importFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length) void importFiles(files);
  });

  root.appendChild(
    h('div', {}, [
      h('div', { class: 'hero' }, [
        h('h2', {}, '拍摄批次'),
        h('p', {}, '文保中心的钱币、印章、甲骨与铜镜 RTI 圆顶拍摄:按批次导入多光源照片,自动对齐、提示曝光异常,再进入灯位标定与 GPU 拟合。所有原图与数据仅存于本机 IndexedDB。'),
        h('div', { class: 'hero-actions' }, [
          button('📥 导入 JPG / PNG', { variant: 'primary', onClick: () => fileInput.click() }),
          button('✨ 生成合成样例 (1280²·48灯)', { onClick: () => generateDemo(1280) }),
          button('🎯 生成验收数据 (2000²·48灯)', { variant: 'subtle', onClick: () => generateDemo(2000) }),
        ]),
      ]),
      drop,
      fileInput,
      grid,
    ]),
  );
  void refresh();

  return () => {
    alive = false;
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = url;
  });
}
