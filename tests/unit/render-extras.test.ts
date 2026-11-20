// @vitest-environment jsdom
/**
 * KaTeX (maths) and highlight.js (code colours) load on demand (src/lib/renderExtras.ts): what a note
 * shows before they're in, that only a note that needs them asks for them, how the editor's formulas
 * and the reading view catch up once they arrive, and what happens when they can't be loaded.
 * Each test starts from fresh modules, so nothing has loaded yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderEnv } from '../../src/lib/markdown';

let md: typeof import('../../src/lib/markdown');
let extras: typeof import('../../src/lib/renderExtras');

async function fresh() {
  vi.resetModules();
  extras = await import('../../src/lib/renderExtras');
  md = await import('../../src/lib/markdown');
}

beforeEach(fresh);

/** Waits for loading KaTeX and highlight.js, which a busy build machine can take seconds over. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 20 });

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = '';
  vi.doUnmock('katex');
  vi.doUnmock('highlight.js/lib/common');
  vi.useRealTimers();
});

const render = (source: string, env: RenderEnv = {}) => {
  const div = document.createElement('div');
  div.innerHTML = md.renderMarkdown(source, env);
  return div;
};

const MATHS = 'Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```ts\nconst a = 1;\n```';

describe('rendering a note before KaTeX and highlight.js have loaded', () => {
  it('needs neither for a note without maths or a named code language, and loads neither', async () => {
    const env: RenderEnv = {};
    const div = render('# Title\n\nPlain text, a [link](https://example.com), `inline code` and $5.\n\n```\nno language\n```', env);
    expect(env.pending).toBeUndefined();
    expect(div.querySelector('h1')?.textContent).toBe('Title');
    expect(div.querySelector('pre code')?.textContent).toBe('no language\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(extras.loadedKatex()).toBeNull();
    expect(extras.loadedHljs()).toBeNull();
  });

  it('shows a formula as its TeX and code without colours, then the real thing once they’re in', async () => {
    const env: RenderEnv = {};
    let div = render(MATHS, env);
    const pending = [...div.querySelectorAll('.kb-math-pending')].map((e) => e.textContent);
    expect(pending[0]).toBe('$e^{i\\pi} + 1 = 0$');
    expect(pending[1]).toMatch(/^\$\$\s*\\int_0\^1 x\\,dx\s*\$\$$/);
    expect(div.querySelector('.katex')).toBeNull();
    expect(div.querySelector('code.language-ts')?.textContent).toBe('const a = 1;\n');
    expect(div.querySelector('.hljs-keyword')).toBeNull();
    expect(env.pendingMath).toBe(true);

    await env.pending;
    div = render(MATHS, env);
    expect(env.pending).toBeUndefined();
    expect(div.querySelector('.kb-math-pending')).toBeNull();
    expect(div.querySelector('p > .katex')).not.toBeNull();
    expect(div.querySelector('.katex-block .katex-display')).not.toBeNull();
    expect(div.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });

  it('counts code alone as no change of layout (only its colours come later)', () => {
    const env: RenderEnv = {};
    render('```js\nlet x\n```', env);
    expect(env.pending).toBeInstanceOf(Promise);
    expect(env.pendingMath).toBe(false);
  });

  it('fills a formula in the editor once KaTeX is in, and has its size measured again', async () => {
    const el = document.createElement('span');
    const measured = vi.fn();
    md.fillMath(el, 'x^2', false, measured);
    expect(el.textContent).toBe('$x^2$');
    await until(() => expect(el.querySelector('.katex')).not.toBeNull());
    expect(measured).toHaveBeenCalledTimes(1);
    // The stand-in wasn't remembered as the formula.
    expect(md.renderMath('x^2', false)).toContain('katex');
    // Once in, a formula fills at once, with nothing to measure again.
    const later = document.createElement('span');
    const again = vi.fn();
    md.fillMath(later, 'y', false, again);
    expect(later.querySelector('.katex')).not.toBeNull();
    await Promise.resolve();
    expect(again).not.toHaveBeenCalled();
  });
});

describe('loading them in idle time once a note is open', () => {
  it('loads both when the browser is next idle (here, without requestIdleCallback, shortly after)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    extras.loadExtrasWhenIdle();
    expect(extras.loadedKatex()).toBeNull();
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    await until(() => expect(extras.loadedKatex() && extras.loadedHljs()).toBeTruthy());
  });

  it('loads nothing if the note closes first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cancel = extras.loadExtrasWhenIdle();
    cancel();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(extras.loadedKatex()).toBeNull();
  });

  it('waits for the connection when offline, then loads them', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      extras.loadExtrasWhenIdle();
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(extras.loadedKatex()).toBeNull();
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(2000);
      vi.useRealTimers();
      await until(() => expect(extras.loadedKatex()).not.toBeNull());
    } finally {
      onLine.mockRestore();
    }
  });

  it('forgets a wait for the connection if the note closes first', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      extras.loadExtrasWhenIdle()();
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(5000);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect(extras.loadedKatex()).toBeNull();
    } finally {
      onLine.mockRestore();
    }
  });

  it('uses requestIdleCallback where there is one', async () => {
    const idle = vi.fn((fn: () => void) => (setTimeout(fn, 0), 7));
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', idle);
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    try {
      extras.loadExtrasWhenIdle()();
      expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });
      expect(cancelIdle).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('when they can’t be loaded (offline, before they were ever fetched)', () => {
  it('keeps the TeX and plain code, and doesn’t try again on every render, only after a while', async () => {
    let attempts = 0;
    vi.doMock('highlight.js/lib/common', () => {
      attempts++;
      throw new Error('offline');
    });
    await fresh();
    vi.useFakeTimers({ toFake: ['Date'] });
    const env: RenderEnv = {};
    const div = render('Area: $\\pi r^2$\n\n```js\nlet a\n```', env);
    await expect(env.pending).rejects.toThrow();
    expect(div.querySelector('.kb-math-pending')?.textContent).toBe('$\\pi r^2$');
    expect(div.querySelector('code')?.textContent).toBe('let a\n');
    expect(attempts).toBe(1);

    // Each pause in typing renders again: no new download for a while.
    const again: RenderEnv = {};
    render('Area: $\\pi r^2$', again);
    await expect(again.pending).rejects.toThrow(/couldn’t be loaded/);
    expect(attempts).toBe(1);

    vi.setSystemTime(Date.now() + 11_000);
    const later: RenderEnv = {};
    render('Area: $\\pi r^2$', later);
    await expect(later.pending).rejects.toThrow();
    expect(attempts).toBe(2);
  });
});

describe('the reading view', () => {
  async function mountPreview(source: string) {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Preview } = await import('../../src/components/Preview');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push({ unmount: () => React.act(() => root.unmount()) });
    await React.act(async () => root.render(React.createElement(Preview, { source })));
    return { article: host.querySelector('article')!, act: React.act };
  }

  /** Holds KaTeX back until `release` is called. */
  async function holdKatex() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.doMock('katex', async () => {
      await gate;
      return vi.importActual('katex');
    });
    await fresh();
    return () => release();
  }

  it('waits for KaTeX rather than flashing a formula’s TeX, then shows the formula', async () => {
    const release = await holdKatex();
    const { article } = await mountPreview('Area: $\\pi r^2$');
    expect(article.textContent).toBe('');
    release();
    await until(() => expect(article.querySelector('.katex')).not.toBeNull());
    expect(article.querySelector('.kb-math-pending')).toBeNull();
    expect(article.textContent).toContain('Area:');
  });

  it('shows the TeX after a while on a slow connection, and the formula once KaTeX arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const release = await holdKatex();
    const { article, act } = await mountPreview('Area: $\\pi r^2$');
    expect(article.textContent).toBe('');
    await act(async () => void vi.advanceTimersByTime(1600));
    expect(article.querySelector('.kb-math-pending')?.textContent).toBe('$\\pi r^2$');
    vi.useRealTimers();
    release();
    await until(() => expect(article.querySelector('.katex')).not.toBeNull());
  });

  it('shows code at once, without waiting for its colours', async () => {
    const release = await holdKatex();
    const { article } = await mountPreview('```js\nlet a = 1\n```');
    expect(article.querySelector('code')?.textContent).toBe('let a = 1\n');
    expect(article.querySelector('.hljs-keyword')).toBeNull();
    release();
    await until(() => expect(article.querySelector('.hljs-keyword')?.textContent).toBe('let'));
  });

  it('shows the TeX straight away when KaTeX can’t be loaded (offline)', async () => {
    vi.doMock('katex', () => {
      throw new Error('offline');
    });
    await fresh();
    const { article } = await mountPreview('Area: $\\pi r^2$');
    await until(() => expect(article.querySelector('.kb-math-pending')?.textContent).toBe('$\\pi r^2$'));
  });
});
