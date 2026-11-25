/** 标注页使用的输入模态框(基于 dom.ts 的 modal,不使用 window.prompt) */
import { h, button, modal } from '../dom';

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmText?: string;
  /** 多行文本(备注) */
  multiline?: boolean;
  /** 数字输入 */
  numeric?: boolean;
  /** 返回错误文案则阻止关闭;返回 null 表示通过 */
  validate?: (raw: string) => string | null;
}

export interface PromptDialog {
  result: Promise<string | null>;
  /** 以“取消”语义关闭并 resolve null */
  close: () => void;
}

export function promptModal(opts: PromptOptions): PromptDialog {
  let settled = false;
  let resolveResult!: (v: string | null) => void;
  const result = new Promise<string | null>((resolve) => {
    resolveResult = resolve;
  });

  const errEl = h('div', { class: 'ann-form-err', role: 'alert' });

  const input = opts.multiline
    ? h('textarea', {
        class: 'input',
        placeholder: opts.placeholder ?? '',
        attrs: { rows: 3 },
      })
    : h('input', {
        class: 'input',
        type: opts.numeric ? 'number' : 'text',
        step: opts.numeric ? 'any' : undefined,
        min: opts.numeric ? '0' : undefined,
        placeholder: opts.placeholder ?? '',
      });
  if (opts.initial !== undefined) input.value = opts.initial;

  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', keyHandler, true);
    closeModal();
    resolveResult(value);
  };

  const submit = () => {
    const raw = input.value;
    if (opts.validate) {
      const err = opts.validate(raw);
      if (err) {
        errEl.textContent = err;
        input.focus();
        return;
      }
    }
    finish(raw);
  };

  const confirmBtn = button(opts.confirmText ?? '确定', { variant: 'primary', onClick: () => submit() });
  const cancelBtn = button('取消', { onClick: () => finish(null) });

  const closeModal = modal(
    opts.title,
    h('div', { class: 'field', style: { marginBottom: '0' } }, [
      opts.label ? h('label', {}, opts.label) : null,
      input,
      errEl,
    ]),
    { footer: [cancelBtn, confirmBtn] },
  );

  // 让右上角 ✕ / 点击遮罩也能以取消语义结束 Promise
  const backdrops = document.querySelectorAll('.modal-backdrop');
  const backdrop = backdrops[backdrops.length - 1] as HTMLElement | undefined;
  if (backdrop) {
    backdrop.addEventListener(
      'mousedown',
      (e) => {
        if (e.target === backdrop) finish(null);
      },
      true,
    );
    const x = backdrop.querySelector('.modal-head .icon-btn');
    x?.addEventListener('click', () => finish(null));
  }

  function keyHandler(e: KeyboardEvent) {
    if (e.key === 'Enter' && !opts.multiline) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }
  }
  // 捕获阶段,避免被页面级 Escape 处理干扰
  document.addEventListener('keydown', keyHandler, true);

  window.setTimeout(() => {
    try {
      input.focus();
      if (!opts.multiline && opts.initial) (input as HTMLInputElement).select();
    } catch {
      /* ignore */
    }
  }, 40);

  return { result, close: () => finish(null) };
}

/** 已知实际长度输入(比例尺标定) */
export function knownMmDialog(pxLength: number): PromptDialog {
  return promptModal({
    title: '比例尺标定',
    label: `已知实际长度(mm)· 线段像素长度 ${pxLength.toFixed(1)} px`,
    placeholder: '例如 20',
    numeric: true,
    confirmText: '确定',
    validate: (raw) => {
      const v = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(v)) return '请输入有效数字';
      if (v <= 0) return '实际长度必须大于 0';
      return null;
    },
  });
}
