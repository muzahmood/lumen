import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import morphdom from 'morphdom';
import { assetRef, decryptingAssets, hydrateAssets, openAsset } from '../lib/assets';
import { allowRemote, codeToCopy, renderMarkdown, type Heading, type RenderEnv } from '../lib/markdown';
import { hydrateEmbeds } from '../lib/embeds';
import { decodeMermaidSource, hydrateMermaid } from '../lib/mermaid';
import { useResolvedTheme, useSettings } from '../lib/settings';
import { createNote, openNote, toast, useApp } from '../lib/store';
import { useNotePeek } from './NotePeek';

export interface PreviewHandle {
  element: () => HTMLElement | null;
  scrollToLine: (line: number) => void;
  scrollToHeading: (id: string) => void;
}

interface Props {
  source: string;
  className?: string;
  onToggleTask?: (line: number) => void;
  onEditMermaid?: (start: number, end: number, code: string) => void;
  onEditDrawing?: (id: string) => void;
  onHeadings?: (headings: Heading[]) => void;
  readOnly?: boolean;
  /** The note shown: its ![[embeds]] never show it inside itself. */
  noteId?: string;
}

// React 19: `ref` is an ordinary prop.
export function Preview({ ref, ...props }: Props & { ref?: Ref<PreviewHandle> }) {
  const rootRef = useRef<HTMLElement>(null);
  const theme = useResolvedTheme();
  const breaks = useSettings((s) => s.lineBreaks);
  const remoteImages = useSettings((s) => s.remoteImages);
  const notes = useApp((s) => s.notes);
  const drawingRevs = useApp((s) => s.drawingRevs);
  const handlers = useRef(props);
  handlers.current = props;

  // The note list changes on every save, but which titles exist rarely does. The previous map is kept
  // while its contents are the same, so a save doesn't re-render the whole note below.
  const lastIndex = useRef(new Map<string, string>());
  const titleIndex = useMemo(() => {
    const map = new Map<string, string>();
    const list = Object.values(notes).filter((n) => !n.deleted_at);
    list.sort((a, b) => b.updated_at - a.updated_at);
    for (const n of list) {
      const key = n.title.trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, n.id);
    }
    const prev = lastIndex.current;
    if (prev.size === map.size && [...map].every(([k, v]) => prev.get(k) === v)) return prev;
    lastIndex.current = map;
    return map;
  }, [notes]);

  const resolveTitle = (t: string) => titleIndex.get(t.toLowerCase()) ?? null;
  // Other notes shown in this one: "![[Note]]" embeds, and the preview on resting over a [[link]].
  const partOptions = () => ({ resolveTitle, breaks, remoteImages, theme });
  const fillEmbeds = (root: HTMLElement) => {
    if (!root.querySelector('span.kb-embed[data-embed-id]')) return;
    void hydrateEmbeds(root, { ...partOptions(), within: handlers.current.noteId ? [handlers.current.noteId] : [] });
  };
  const peek = useNotePeek(partOptions);
  // An embedded note changed (saved here or elsewhere): shown as it is now.
  useEffect(() => {
    if (rootRef.current) fillEmbeds(rootRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // Maths and code colours load on demand (renderExtras.ts): bumped once they're in, to render again.
  const [extrasLoaded, setExtrasLoaded] = useState(0);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const env: RenderEnv = {
      resolveTitle: (t: string) => titleIndex.get(t.toLowerCase()) ?? null,
      drawingRevs,
      headings: [] as Heading[],
    };
    const html = renderMarkdown(props.source, env, { breaks, remoteImages, assets: decryptingAssets() ? 'decrypt' : 'load' });
    let live = true;
    let shown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      if (!live || shown) return;
      shown = true;
      clearTimeout(timer);
      apply(root, html, env.headings ?? []);
    };
    if (env.pending) {
      env.pending.then(
        () => live && setExtrasLoaded((n) => n + 1),
        show, // couldn't load (offline): the TeX and plain code stay
      );
      // Maths would show as TeX and then jump into formulas: wait for KaTeX instead, briefly (it's
      // usually in within a few dozen milliseconds, from the service worker's copy).
      if (env.pendingMath) timer = setTimeout(show, 1500);
      else show();
    } else show();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [props.source, theme, breaks, remoteImages, titleIndex, drawingRevs, extrasLoaded]);

  function apply(root: HTMLElement, html: string, headings: Heading[]) {
    morphdom(root, `<article>${html}</article>`, {
      childrenOnly: true,
      onBeforeElUpdated(from, to) {
        // An encrypted image or video already decrypted keeps its picture rather than starting over.
        const asset = from.getAttribute('data-kb-asset');
        if (asset && asset === to.getAttribute('data-kb-asset')) {
          const shown = from.getAttribute('src');
          if (shown) {
            to.setAttribute('src', shown);
            to.classList.remove('kb-asset-pending');
          }
          for (const name of ['poster', 'title', 'alt', 'tabindex']) {
            const value = from.getAttribute(name);
            if (value !== null && !to.hasAttribute(name)) to.setAttribute(name, value);
          }
          if (from.classList.contains('kb-asset-failed')) to.classList.add('kb-asset-failed');
        }
        // An embed already filled in, of the same note and heading: kept (fillEmbeds updates it if it changed).
        if (from instanceof HTMLElement && from.classList.contains('kb-embed') && from.classList.contains('is-filled')) {
          const t = to as HTMLElement;
          if (from.dataset.embedId === t.dataset.embedId && (from.dataset.embedHeading ?? '') === (t.dataset.embedHeading ?? '')) return false;
        }
        if (from instanceof HTMLElement && from.classList.contains('kb-mermaid')) {
          const sameSrc = from.dataset.src === (to as HTMLElement).dataset.src;
          if (sameSrc && from.dataset.rendered === `${theme}:${(from.dataset.src ?? '').length}`) {
            // Keep the rendered SVG; only refresh line numbers used for editing.
            from.dataset.line = (to as HTMLElement).dataset.line;
            from.dataset.lineEnd = (to as HTMLElement).dataset.lineEnd;
            return false;
          }
        }
        return !from.isEqualNode(to);
      },
    });
    handlers.current.onHeadings?.(headings);
    hydrateAssets(root);
    void hydrateMermaid(root, theme);
    fillEmbeds(root);
  }

  useImperativeHandle(
    ref,
    () => ({
      element: () => rootRef.current,
      scrollToLine(line: number) {
        const root = rootRef.current;
        if (!root) return;
        const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-line]'));
        let best: HTMLElement | null = null;
        for (const el of blocks) {
          const n = Number(el.dataset.line);
          if (n <= line) best = el;
          else break;
        }
        const scroller = root.closest('.pane-scroll') as HTMLElement | null;
        if (best && scroller) {
          const top = best.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
          scroller.scrollTo({ top });
        } else if (scroller && line === 0) {
          scroller.scrollTo({ top: 0 });
        }
      },
      scrollToHeading(id: string) {
        const el = rootRef.current?.querySelector(`#${CSS.escape(id)}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }),
    [],
  );

  const onClick = (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const h = handlers.current;

    const box = target.closest<HTMLInputElement>('input.kb-task-box');
    if (box) {
      // Another note's task, shown here: ticked in its own note.
      if (h.readOnly || !h.onToggleTask || box.closest('.kb-embed')) {
        e.preventDefault();
        return;
      }
      h.onToggleTask(Number(box.dataset.taskLine));
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    const action = actionEl?.dataset.action;
    if (action === 'copy-code') {
      const code = codeToCopy(actionEl!.closest('.kb-code')?.querySelector('code')?.textContent ?? '');
      void navigator.clipboard?.writeText(code).then(
        () => toast('Code copied'),
        () => toast('Couldn’t copy to the clipboard', { kind: 'error' }),
      );
      return;
    }
    if (action === 'edit-mermaid') {
      const block = actionEl!.closest<HTMLElement>('.kb-mermaid');
      if (block && h.onEditMermaid && !h.readOnly) {
        h.onEditMermaid(Number(block.dataset.line), Number(block.dataset.lineEnd), decodeMermaidSource(block.dataset.src ?? ''));
      }
      return;
    }
    if (action === 'zoom-diagram') {
      const svg = actionEl!.innerHTML;
      useApp.setState({ lightbox: { kind: 'svg', html: svg } });
      return;
    }
    if (action === 'edit-drawing') {
      const id = actionEl!.dataset.drawingId;
      if (id && h.onEditDrawing && !h.readOnly) h.onEditDrawing(id);
      return;
    }

    // An image from another website, held back by Settings → Security: this click loads it.
    const held = target.closest<HTMLImageElement>('img[data-remote-src]');
    if (held) {
      e.preventDefault();
      const src = held.dataset.remoteSrc!;
      allowRemote(src);
      held.removeAttribute('data-remote-src');
      held.classList.remove('kb-remote');
      held.alt = '';
      held.removeAttribute('title');
      held.src = src;
      return;
    }

    const img = target.closest('img');
    if (img && !target.closest('a')) {
      // An encrypted image still being decrypted (or that couldn't be) has nothing to enlarge.
      if (img.hasAttribute('data-kb-asset') && !img.getAttribute('src')) return;
      useApp.setState({ lightbox: { kind: 'image', src: img.currentSrc || img.src, alt: img.alt } });
      return;
    }

    const link = target.closest<HTMLAnchorElement>('a');
    if (!link) return;
    // A link to an encrypted upload: decrypted here, then opened or downloaded.
    if (decryptingAssets() && assetRef(link.getAttribute('href') ?? '')?.kind === 'file') {
      e.preventDefault();
      openAsset(link.getAttribute('href')!);
      return;
    }
    if (link.dataset.wikilinkNew) {
      e.preventDefault();
      const title = link.dataset.wikilinkNew;
      void createNote({ title, folder_id: null }).catch(() => toast('Couldn’t create the note', { kind: 'error' }));
      return;
    }
    const href = link.getAttribute('href') ?? '';
    const internal = /^\/note\/([A-Za-z0-9_-]+)(#.*)?$/.exec(href);
    if (internal) {
      e.preventDefault();
      openNote(internal[1], { hash: internal[2] });
      return;
    }
    if (href.startsWith('#')) {
      e.preventDefault();
      let id = '';
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return; // a malformed %-escape: nowhere to go
      }
      // "#" alone (a placeholder link) goes nowhere.
      if (!id) return;
      const el = rootRef.current?.querySelector(`#${CSS.escape(id)}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    const drawing = (e.target as HTMLElement).closest<HTMLElement>('.kb-drawing');
    const h = handlers.current;
    if (drawing?.dataset.drawingId && h.onEditDrawing && !h.readOnly) h.onEditDrawing(drawing.dataset.drawingId);
  };

  return (
    <>
      <article
        ref={rootRef}
        className={`kb-prose${props.className ? ` ${props.className}` : ''}`}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onMouseOver={peek.onMouseOver}
        onMouseOut={peek.onMouseOut}
      />
      {peek.element}
    </>
  );
}
