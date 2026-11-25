/** 极简 hyperscript DOM 工具 */

export type ElChild = Node | string | number | false | null | undefined | ElChild[];

export interface ElProps {
  class?: string;
  id?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  html?: string;
  attrs?: Record<string, string | number | boolean | undefined | null>;
  on?: Record<string, EventListenerOrEventListenerObject>;
  dataset?: Record<string, string | number>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val == null || val === false) continue;
      if (key === 'class') el.className = String(val);
      else if (key === 'id') el.id = String(val);
      else if (key === 'html') el.innerHTML = String(val);
      else if (key === 'style') {
        if (typeof val === 'string') el.style.cssText = val;
        else Object.assign(el.style, val);
      } else if (key === 'on' && val && typeof val === 'object') {
        for (const [ev, fn] of Object.entries(val as Record<string, EventListener>)) {
          el.addEventListener(ev, fn);
        }
      } else if (key === 'attrs' && val && typeof val === 'object') {
        for (const [a, v] of Object.entries(val as Record<string, string | number | boolean | null | undefined>)) {
          if (v == null || v === false) el.removeAttribute(a);
          else el.setAttribute(a, v === true ? '' : String(v));
        }
      } else if (key === 'dataset' && val && typeof val === 'object') {
        Object.assign(el.dataset, val);
      } else if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (key === 'value') {
        (el as HTMLInputElement).value = String(val);
      } else {
        try {
          (el as any)[key] = val;
        } catch {
          /* ignore */
        }
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: HTMLElement, children: ElChild[]): void {
  for (const child of children.flat() as ElChild[]) {
    if (child === false || child == null || child === undefined) continue;
    if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function mount(el: HTMLElement, children: ElChild[]): void {
  clear(el);
  appendChildren(el, children);
}

/** 卡片容器 */
export function card(title: string | Node, ...body: ElChild[]): HTMLElement {
  return h('section', { class: 'card' }, [
    h('header', { class: 'card-head' }, [typeof title === 'string' ? h('h2', {}, title) : title]),
    h('div', { class: 'card-body' }, ...body),
  ]);
}

export function button(
  label: string,
  opts: { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; icon?: string; disabled?: boolean; title?: string; style?: string | Partial<CSSStyleDeclaration>; onClick?: (e: MouseEvent) => void } = {},
): HTMLButtonElement {
  const cls = ['btn', opts.variant ? `btn-${opts.variant}` : ''];
  const btn = h('button', {
    class: cls.join(' ').trim(),
    disabled: opts.disabled,
    title: opts.title,
    style: opts.style,
    onClick: opts.onClick,
  }, [opts.icon ? h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, opts.icon) : null, label]) as HTMLButtonElement;
  return btn;
}

export function badge(text: string, tone: 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'accent' = 'muted'): HTMLElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}

export function progressBar(value01: number, label?: string): HTMLElement {
  const pct = Math.round(Math.min(1, Math.max(0, value01)) * 100);
  return h('div', { class: 'progress-wrap', role: 'progressbar', attrs: { 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 } }, [
    h('div', { class: 'progress-bar', style: { width: `${pct}%` } }),
    label ? h('span', { class: 'progress-label' }, label) : null,
  ]);
}

/** 简单 toast */
export function toast(message: string, tone: 'info' | 'ok' | 'err' | 'warn' = 'info', timeout = 3200): void {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = h('div', { id: 'toast-host' });
    document.body.appendChild(host);
  }
  const item = h('div', { class: `toast toast-${tone}` }, message);
  host.appendChild(item);
  setTimeout(() => {
    item.classList.add('toast-hide');
    setTimeout(() => item.remove(), 300);
  }, timeout);
}

/** 模态框;返回关闭函数 */
export function modal(title: string, content: Node | Node[], opts: { width?: number; footer?: Node[] } = {}): () => void {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  const box = h('div', { class: 'modal', style: opts.width ? { maxWidth: `${opts.width}px` } : undefined }, [
    h('header', { class: 'modal-head' }, [h('h3', {}, title), h('button', { class: 'icon-btn', onClick: close, title: '关闭' }, '✕')]),
    h('div', { class: 'modal-body' }, Array.isArray(content) ? content : [content]),
    opts.footer ? h('footer', { class: 'modal-foot' }, opts.footer) : null,
  ]);
  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  return close;
}

export function confirmDialog(message: string, title = '确认操作'): Promise<boolean> {
  return new Promise((resolve) => {
    const close = modal(title, h('p', { class: 'confirm-msg' }, message), {
      footer: [
        button('取消', { onClick: () => { close(); resolve(false); } }),
        button('确定', { variant: 'danger', onClick: () => { close(); resolve(true); } }),
      ],
    });
  });
}

/** 文件选择 Promise */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDate(iso: string | number | Date): string {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
