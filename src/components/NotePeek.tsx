/**
 * The preview of a linked note that appears when a pointer rests on a [[link]] in reading view (on a
 * device with a mouse or trackpad; on touch, a tap simply opens the note). Its text is this device's
 * (see embeds.ts), shortened, and read-only.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { hydrateAssets } from '../lib/assets';
import { renderNotePart, type PartOptions } from '../lib/embeds';
import { hydrateMermaid } from '../lib/mermaid';
import { useMediaQuery } from '../lib/settings';
import { useApp } from '../lib/store';
import { noteTitle } from '../lib/utils';

const SHOW_AFTER = 450;
const HIDE_AFTER = 180;
const PEEK_CHARS = 1400;

interface Peek {
  id: string;
  /** The heading the link goes to, as in its address (#h-…), or null. */
  heading: string | null;
  link: HTMLAnchorElement;
}

/** Hover handlers for a reading view, and the preview to render beside it. */
export function useNotePeek(options: () => Omit<PartOptions, 'limit'> & { theme: 'light' | 'dark' }) {
  const canHover = useMediaQuery('(hover: hover) and (pointer: fine)');
  const [peek, setPeek] = useState<Peek | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const hideSoon = useCallback(() => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPeek(null), HIDE_AFTER);
  }, []);
  const stay = useCallback(() => clearTimeout(hideTimer.current), []);

  const onMouseOver = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!canHover) return;
      const link = (e.target as Element).closest<HTMLAnchorElement>('a.kb-wikilink[data-note-id]');
      if (!link) return;
      clearTimeout(hideTimer.current);
      if (peek?.link === link) return;
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        const hash = (link.getAttribute('href') ?? '').split('#')[1];
        setPeek({ id: link.dataset.noteId!, heading: hash?.startsWith('h-') ? hash.slice(2) : null, link });
      }, SHOW_AFTER);
    },
    [canHover, peek],
  );

  const onMouseOut = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      const link = (e.target as Element).closest('a.kb-wikilink[data-note-id]');
      if (!link || link.contains(e.relatedTarget as Node | null)) return;
      hideSoon();
    },
    [hideSoon],
  );

  // Gone when the page scrolls, a key is pressed (Escape, or typing), or the link itself goes.
  useEffect(() => {
    if (!peek) return;
    const close = () => setPeek(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', close, true);
    const watch = setInterval(() => !peek.link.isConnected && close(), 500);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', close, true);
      clearInterval(watch);
    };
  }, [peek]);

  useEffect(
    () => () => {
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    },
    [],
  );

  const element = peek ? <NotePeek key={`${peek.id}#${peek.heading ?? ''}`} peek={peek} options={optionsRef.current()} onEnter={stay} onLeave={hideSoon} /> : null;
  return { onMouseOver, onMouseOut, element };
}

function NotePeek({
  peek,
  options,
  onEnter,
  onLeave,
}: {
  peek: Peek;
  options: Omit<PartOptions, 'limit'> & { theme: 'light' | 'dark' };
  onEnter: () => void;
  onLeave: () => void;
}) {
  const meta = useApp((s) => s.notes[peek.id]);
  const [part, setPart] = useState<{ html: string; found: boolean } | null | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let live = true;
    void renderNotePart(peek.id, peek.heading, { ...options, limit: PEEK_CHARS }).then((p) => live && setPart(p));
    return () => {
      live = false;
    };
    // The options are read once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek.id, peek.heading]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !part?.found) return;
    hydrateAssets(body);
    void hydrateMermaid(body, options.theme);
  }, [part, options.theme]);

  // Below the link, or above it when there's more room there; kept inside the window.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const r = peek.link.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : below;
    setPos({ left, top });
  }, [peek, part]);

  // The link says what's shown about it, for screen readers.
  useEffect(() => {
    const link = peek.link;
    link.setAttribute('aria-describedby', 'note-peek');
    return () => link.removeAttribute('aria-describedby');
  }, [peek.link]);

  if (!meta) return null;
  return createPortal(
    <div
      ref={boxRef}
      id="note-peek"
      className="note-peek"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="note-peek-title">{noteTitle(meta.title)}</div>
      {part === undefined ? (
        <div className="note-peek-note">Loading…</div>
      ) : part === null ? (
        <div className="note-peek-note">Can’t show this note here. Open it to read it.</div>
      ) : !part.found ? (
        <div className="note-peek-note">There’s no such heading in this note.</div>
      ) : (
        <div ref={bodyRef} className="kb-prose note-peek-body" dangerouslySetInnerHTML={{ __html: part.html }} />
      )}
    </div>,
    document.body,
  );
}
