import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useBackLayer } from '../lib/backLayers';
import { Check, CircleAlert, CircleCheck, Info, Minus, Plus, ScanSearch, X } from 'lucide-react';
import { SAFE_TO_OPEN } from '../lib/assets';
import { dismissToast, useApp } from '../lib/store';

/* ------------------------------------------------------------ buttons --- */

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  shortcut?: string;
  size?: 'sm' | 'md' | 'lg';
};

export function IconButton({ label, active, shortcut, size = 'md', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-kbd={shortcut}
      aria-pressed={active === undefined ? undefined : active}
      className={`icon-btn icon-btn-${size}${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ---------------------------------------------------------- segmented --- */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  tip?: string;
  hideLabel?: boolean;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  full,
  size = 'md',
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  full?: boolean;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`);
      setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [value, options.length]);

  return (
    <div ref={ref} className={`seg seg-${size}${full ? ' seg-full' : ''}`} role="radiogroup" aria-label={label}>
      {thumb && <span className="seg-thumb" style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.hideLabel ? o.label : undefined}
          data-value={o.value}
          data-tip={o.tip}
          className={`seg-btn${o.value === value ? ' is-on' : ''}`}
          // As a radio group: one Tab stop (the chosen option), and the arrow keys move the choice.
          tabIndex={o.value === value ? 0 : -1}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            const to = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : step ? (i + step + options.length) % options.length : -1;
            if (to < 0) return;
            e.preventDefault();
            onChange(options[to].value);
            ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(options[to].value)}"]`)?.focus();
          }}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {!o.hideLabel && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- modal --- */

function focusables(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
  initialFocus?: string;
  bare?: boolean;
  /** What screen readers call the dialog when it has no text title (Settings, the lightbox). */
  label?: string;
}

/** Dialogs open now, oldest first: only the last one answers Escape and keeps Tab inside it. */
const openModals: object[] = [];

/** Whether a dialog is open: the app's own shortcuts then leave the keyboard to it. */
export const modalOpen = () => openModals.length > 0;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  className,
  footer,
  closeOnBackdrop = true,
  initialFocus,
  bare,
  label,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Back (a phone's back gesture) closes it, as its Close button would.
  useBackLayer(open, () => onCloseRef.current());

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const token = {};
    openModals.push(token);
    requestAnimationFrame(() => {
      if (!panel) return;
      const target = (initialFocus && panel.querySelector<HTMLElement>(initialFocus)) || panel;
      target.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      // Only the dialog on top: Escape on a question asked from Settings closes the question, not Settings.
      if (openModals[openModals.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panel) {
        const items = focusables(panel);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        // From the dialog itself (where focus starts) or from outside it, Tab still stays inside.
        const outside = !active || active === panel || !panel.contains(active);
        if (e.shiftKey && (active === first || outside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || outside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = openModals.indexOf(token);
      if (i >= 0) openModals.splice(i, 1);
      previous?.focus?.();
    };
  }, [open, initialFocus]);

  if (!open) return null;
  return createPortal(
    <div
      className={`overlay overlay-${size}`}
      onPointerDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`modal modal-${size}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        aria-describedby={title !== undefined && description ? descriptionId : undefined}
        tabIndex={-1}
      >
        {!bare && <span className="sheet-grabber" aria-hidden="true" />}
        {title !== undefined && (
          <header className="modal-header">
            <div className="modal-heading">
              <h2 className="modal-title">{title}</h2>
              {description && (
                <p className="modal-description" id={descriptionId}>
                  {description}
                </p>
              )}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------- menu --- */

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  hint?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  heading?: string;
  indent?: number;
}

type Anchor = DOMRect | { x: number; y: number };

export function MenuPopover({
  anchor,
  items,
  onClose,
  align = 'start',
  label,
  opener,
}: {
  anchor: Anchor;
  items: MenuItem[];
  onClose: () => void;
  align?: 'start' | 'end';
  label?: string;
  /** The button that opened the menu: pressing it toggles the menu, and focus goes back to it after. */
  opener?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  // Back closes the menu (on a phone, the sheet it opens as).
  useBackLayer(true, onClose);
  // A long menu (folders to move to, say) gets a box to narrow it down by typing.
  const choices = items.filter((item) => item.label && !item.separator && !item.heading);
  const filterable = choices.length > 10;
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? choices.filter((item) => item.label!.toLowerCase().includes(q)) : items;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    let below = true;
    if ('x' in anchor && !('width' in anchor)) {
      left = anchor.x;
      top = anchor.y;
    } else {
      const r = anchor as DOMRect;
      left = align === 'end' ? r.right - width : r.left;
      top = r.bottom + 6;
      if (top + height > vh - 8 && r.top - height - 6 > 8) {
        top = r.top - height - 6;
        below = false;
      }
    }
    left = Math.min(Math.max(8, left), vw - width - 8);
    top = Math.min(Math.max(8, top), vh - height - 8);
    setPos({ left, top, origin: `${align === 'end' ? 'right' : 'left'} ${below ? 'top' : 'bottom'}` });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // Its own button isn't "outside": its click closes the menu (closing here, it would reopen it).
      if (opener?.contains(e.target as Node)) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        // From the filter box (not a button), down goes to the first item and up to the last.
        const next =
          i < 0 ? (e.key === 'ArrowDown' ? 0 : buttons.length - 1) : e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const onResize = () => onClose();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('.menu-filter input, button:not([disabled])')?.focus({ preventScroll: true }));
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  // Closed while focus was in the menu (gone now, so focus is on the page): back to the button that
  // opened it, so the keyboard carries on from there. A press elsewhere keeps its own focus.
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body)) opener.focus({ preventScroll: true });
    },
    [opener],
  );

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={
        pos
          ? ({ left: pos.left, top: pos.top, transformOrigin: pos.origin } as CSSProperties)
          : { left: -9999, top: -9999, visibility: 'hidden' }
      }
    >
      {filterable && (
        <div className="menu-filter">
          <input
            type="text"
            value={query}
            placeholder="Type to filter"
            aria-label="Filter this menu"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter picks the match when there's just one (and it isn't a destructive action like
              // "Move to trash"); otherwise it moves to the first match, to be seen before it's picked.
              if (e.key === 'Enter') {
                e.preventDefault();
                const matches = shown.filter((item) => item.label && !item.disabled);
                if (matches.length === 1 && !matches[0].danger) {
                  onClose();
                  matches[0].onSelect?.();
                } else {
                  ref.current?.querySelector<HTMLButtonElement>('button.menu-item:not([disabled])')?.focus();
                }
              }
            }}
          />
        </div>
      )}
      {q && !shown.length && <div className="menu-empty">Nothing matches</div>}
      {shown.map((item, i) => {
        if (item.separator) return <div key={i} className="menu-sep" role="separator" />;
        if (item.heading) return <div key={i} className="menu-heading">{item.heading}</div>;
        return (
          <button
            key={i}
            type="button"
            // An item that can be ticked (a folder choice, a view option) says whether it is.
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked === undefined ? undefined : item.checked}
            className={`menu-item${item.danger ? ' is-danger' : ''}${item.checked ? ' is-checked' : ''}`}
            disabled={item.disabled}
            style={item.indent ? { paddingLeft: 10 + item.indent * 14 } : undefined}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.icon !== undefined && <span className="menu-icon">{item.icon}</span>}
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
            {item.checked && <Check size={14} className="menu-check" />}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export function MenuButton({
  label,
  icon,
  items,
  align = 'end',
  className,
  text,
  shortcut,
  chevron,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  items: MenuItem[] | (() => MenuItem[]);
  align?: 'start' | 'end';
  className?: string;
  text?: ReactNode;
  shortcut?: string;
  chevron?: ReactNode;
  disabled?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${text ? 'chip-btn' : 'icon-btn icon-btn-md'}${anchor ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        aria-label={label}
        data-tip={text ? undefined : label}
        data-tip-kbd={shortcut}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        disabled={disabled}
        onClick={() => setAnchor(anchor ? null : btnRef.current!.getBoundingClientRect())}
      >
        {icon}
        {text}
        {chevron}
      </button>
      {anchor && (
        <MenuPopover
          anchor={anchor}
          items={typeof items === 'function' ? items() : items}
          onClose={close}
          align={align}
          label={label}
          opener={btnRef.current}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ dialogs --- */

export function DialogHost() {
  const dialog = useApp((s) => s.dialog);
  const [value, setValue] = useState('');
  useEffect(() => {
    if (dialog) setValue(dialog.initial ?? '');
  }, [dialog]);
  if (!dialog) return null;
  const finish = (result: string | boolean | null) => {
    useApp.setState({ dialog: null });
    // A passphrase typed here isn't kept once it's been handed over.
    setValue('');
    dialog.resolve(result);
  };
  const isPrompt = dialog.kind === 'prompt';
  const confirm = () => {
    if (isPrompt && !value.trim()) return;
    finish(isPrompt ? value : true);
  };
  return (
    <Modal
      open
      size="sm"
      title={dialog.title}
      description={dialog.message}
      onClose={() => finish(isPrompt ? null : false)}
      initialFocus={isPrompt ? 'input' : '.btn-primary, .btn-danger'}
      className="dialog"
      footer={
        <>
          {!dialog.notice && (
            <button type="button" className="btn btn-ghost" onClick={() => finish(isPrompt ? null : false)}>
              {dialog.cancelLabel ?? 'Cancel'}
            </button>
          )}
          {dialog.altLabel && !isPrompt && (
            <button type="button" className="btn" onClick={() => finish('alt')}>
              {dialog.altLabel}
            </button>
          )}
          {/* Acts directly rather than through form="<id>": a note open behind the dialog could hold
              an element with the same id and take the button's form away. */}
          <button
            type="button"
            className={dialog.danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={isPrompt && !value.trim()}
            onClick={confirm}
          >
            {dialog.confirmLabel ?? (isPrompt ? 'Save' : 'OK')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        {isPrompt &&
          (dialog.secret ? (
            // Uncontrolled, as SecretInput in Encryption.tsx: React copies a controlled input's value into
            // its `value` attribute, where a CSS attribute selector could read a passphrase out.
            <input
              className="input"
              type="password"
              placeholder={dialog.placeholder}
              aria-label={dialog.placeholder ?? dialog.title}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <input
              className="input"
              type="text"
              value={value}
              placeholder={dialog.placeholder}
              aria-label={dialog.placeholder ?? dialog.title}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
          ))}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------- toasts --- */

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind ?? 'info'}`}>
          <span className="toast-icon" aria-hidden="true">
            {t.kind === 'error' ? <CircleAlert size={16} /> : t.kind === 'success' ? <CircleCheck size={16} /> : <Info size={16} />}
          </span>
          <span className="toast-msg">{t.message}</span>
          {[...(t.more ?? []), ...(t.action ? [t.action] : [])].map((a) => (
            <button
              key={a.label}
              type="button"
              className={`toast-action${a.danger ? ' is-danger' : ''}`}
              onClick={() => {
                dismissToast(t.id);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------ tooltip --- */

/** One shared tooltip for every element with data-tip (and optional data-tip-kbd). */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    let warmUntil = 0;
    const hide = () => {
      clearTimeout(timer);
      if (current) warmUntil = Date.now() + 500;
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
      if (el === current) return;
      clearTimeout(timer);
      if (!el || !el.dataset.tip) {
        if (current) hide();
        return;
      }
      current = el;
      const delay = Date.now() < warmUntil || tip ? 60 : 500;
      setTip(null);
      timer = setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        setTip({ text: el.dataset.tip!, kbd: el.dataset.tipKbd, rect: el.getBoundingClientRect() });
      }, delay);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) {
      setPos(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const r = tip.rect;
    const below = r.top - height - 8 < 8;
    const top = below ? r.bottom + 8 : r.top - height - 8;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    setPos({ left, top, below });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      className={`tooltip${pos?.below ? ' is-below' : ''}`}
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      <span>{tip.text}</span>
      {tip.kbd && (
        <span className="tooltip-kbd">
          {tip.kbd.split(' ').map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      )}
    </div>,
    document.body,
  );
}

/* ----------------------------------------------------------- lightbox --- */

export function Lightbox() {
  const lightbox = useApp((s) => s.lightbox);
  const [zoom, setZoom] = useState(1);
  useEffect(() => setZoom(1), [lightbox]);
  // A decrypted image is a blob: address on this site. Opened in a tab of its own it would be a page of
  // this site, so only kinds that can't run anything (not SVG) get "Open original".
  const src = lightbox?.kind === 'image' ? lightbox.src : '';
  const [openable, setOpenable] = useState(false);
  useEffect(() => {
    let live = true;
    if (!src.startsWith('blob:')) {
      setOpenable(!!src);
      return;
    }
    setOpenable(false);
    fetch(src)
      .then((r) => r.blob())
      .then((b) => live && setOpenable(SAFE_TO_OPEN.test(b.type) && b.type.startsWith('image/')))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [src]);
  if (!lightbox) return null;
  const close = () => useApp.setState({ lightbox: null });
  return (
    <Modal open onClose={close} size="full" className="lightbox" bare label={lightbox.kind === 'image' ? lightbox.alt?.trim() || 'Image' : 'Enlarged view'}>
      <div className="lightbox-bar">
        <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>
          <Minus size={18} />
        </IconButton>
        <button
          type="button"
          className="chip-btn"
          onClick={() => setZoom(1)}
          data-tip="Reset zoom"
          aria-label={`${Math.round(zoom * 100)}%, reset zoom`}
        >
          <ScanSearch size={15} aria-hidden="true" /> {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(6, z * 1.25))}>
          <Plus size={18} />
        </IconButton>
        <span className="spacer" />
        {lightbox.kind === 'image' && openable && (
          <a className="btn btn-ghost btn-sm" href={lightbox.src} target="_blank" rel="noopener noreferrer">
            Open original
          </a>
        )}
        <IconButton label="Close" onClick={close} shortcut="Esc">
          <X size={20} />
        </IconButton>
      </div>
      <div
        className="lightbox-stage"
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          setZoom((z) => Math.min(6, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 0.9))));
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="lightbox-content" style={{ width: `${zoom * 100}%` }}>
          {lightbox.kind === 'image' ? (
            <img src={lightbox.src} alt={lightbox.alt ?? ''} />
          ) : (
            <div className="lightbox-svg" dangerouslySetInnerHTML={{ __html: lightbox.html }} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------- feedback ----- */

export function Spinner({ label = 'Loading', size = 18 }: { label?: string; size?: number }) {
  return <span className="spinner" role="progressbar" aria-label={label} style={{ width: size, height: size }} />;
}

export function Skeleton({ width, height = 12, radius }: { width?: number | string; height?: number; radius?: number }) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      <p className="empty-state-title">{title}</p>
      {children && <div className="empty-state-body">{children}</div>}
    </div>
  );
}
