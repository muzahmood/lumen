import { createElement, lazy, Suspense, useEffect, useRef, type ComponentProps, type ComponentType } from 'react';
import { CircleAlert, CloudOff, FileText, House, Library, Minimize2, Plus, Search } from 'lucide-react';
import { CommandPalette } from './components/CommandPalette';
import { EncryptingScreen, UnlockScreen } from './components/Encryption';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Home } from './components/Home';
import { MermaidEditor } from './components/MermaidEditor';
import { NoteList } from './components/NoteList';
import { BrandMark, Sidebar } from './components/Sidebar';
import { TasksView } from './components/TasksView';
import { DialogHost, Lightbox, modalOpen, Spinner, Toasts, TooltipHost } from './components/ui';
import { recoverDrafts, useUnsynced } from './lib/saver';
import {
  ACCENTS,
  DEFAULT_LIST_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  useResolvedTheme,
  useSettings,
} from './lib/settings';
import { useBackLayer } from './lib/backLayers';
import { takeLaunchAction } from './lib/launch';
import { announceUpdate } from './lib/recovery';
import { goHome, loadAll, newNote, showNotes, toast, useApp } from './lib/store';
import { initVault, noticeEncryption, useVault } from './lib/vault';

/**
 * React.lazy remembers a failed download for good, so a screen that failed to load (offline, say)
 * would fail again even once the connection is back. This one can be reset to try again.
 * (The `any` matches React.lazy's own signature.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function retryableLazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  let Current = lazy(load);
  const Loader = (props: ComponentProps<T>) => createElement(Current as ComponentType<ComponentProps<T>>, props);
  return Object.assign(Loader, {
    reset: () => {
      Current = lazy(load);
    },
  });
}

// Split out of the first download: the editor, Markdown/math/code rendering and backups are only
// needed once a note or dialog opens, so Home and the note list appear sooner, especially on phones.
/** A text field or editable area, where a key typed is text rather than a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

const loadNoteView = () => import('./components/NoteView');
const loadSettings = () => import('./components/SettingsDialog');
const loadHistory = () => import('./components/HistoryDialog');
const NoteView = retryableLazy(() => loadNoteView().then((m) => ({ default: m.NoteView })));
const HistoryDialog = retryableLazy(() => loadHistory().then((m) => ({ default: m.HistoryDialog })));
const SettingsDialog = retryableLazy(() => loadSettings().then((m) => ({ default: m.SettingsDialog })));
// Not fetched ahead of time: Excalidraw is large, and is only needed once someone draws.
const DrawingEditor = retryableLazy(() => import('./components/DrawingEditor'));

// Start fetching the editor right away when the app opens on a note, otherwise once the browser is idle,
// so opening a note never waits on the network. Settings and history come along, so the service
// worker has them for offline use too. A failure here is harmless: the screen tries again when opened.
const warmUp = () => {
  void loadNoteView().catch(() => undefined);
  void loadSettings().catch(() => undefined);
  void loadHistory().catch(() => undefined);
};
if (location.pathname.startsWith('/note/')) warmUp();
else if ('requestIdleCallback' in window) requestIdleCallback(warmUp, { timeout: 4000 });
else setTimeout(warmUp, 1500);

/** A dialog that failed to open closes itself and says why, instead of taking the app down with it. */
function dialogFailed(close: () => void, retry: () => void) {
  return (message: string, cause: 'updated' | 'offline' | 'other') => {
    close();
    retry();
    if (cause === 'updated') announceUpdate();
    else toast(message, { kind: 'error', ...(cause === 'other' ? { action: { label: 'Reload', run: () => location.reload() } } : {}) });
  };
}

function NoteLoading() {
  return (
    <section className="note-pane" aria-busy="true">
      <div className="note-message">
        <Spinner label="Opening note" />
      </div>
    </section>
  );
}

const FONTS = {
  sans: { family: 'var(--font-ui)', leading: '1.72' },
  serif: { family: 'var(--font-serif)', leading: '1.78' },
  mono: { family: 'var(--font-mono)', leading: '1.7' },
} as const;

const WIDTHS = { narrow: '38rem', normal: '44rem', wide: '58rem' } as const;

/** Drag handle on a pane's right edge. Updates a CSS variable live and saves on release. */
function Resizer({
  cssVar,
  min,
  max,
  value,
  fallback,
  onCommit,
  label,
}: {
  cssVar: string;
  min: number;
  max: number;
  value: number;
  fallback: number;
  onCommit: (v: number) => void;
  label: string;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number) => document.documentElement.style.setProperty(cssVar, `${w}px`);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = { x: e.clientX, w: value };
        document.body.classList.add('is-resizing');
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* capture is a nicety; dragging still works without it */
        }
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        set(Math.min(max, Math.max(min, start.current.w + e.clientX - start.current.x)));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const w = Math.min(max, Math.max(min, start.current.w + e.clientX - start.current.x));
        start.current = null;
        document.body.classList.remove('is-resizing');
        onCommit(Math.round(w));
      }}
      onDoubleClick={() => onCommit(fallback)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onCommit(Math.max(min, value - 16));
        if (e.key === 'ArrowRight') onCommit(Math.min(max, value + 16));
      }}
    />
  );
}

function MobileTabBar() {
  const noteId = useApp((s) => s.noteId);
  const unsynced = useUnsynced().length;
  const tab = useApp((s) => s.mobileTab);
  const drawerOpen = useApp((s) => s.drawerOpen);
  const screen = useApp((s) => s.screen);
  if (noteId) return null;
  const onHome = tab === 'home' && screen === 'home' && !drawerOpen;
  const onNotes = tab === 'notes' && !drawerOpen;
  return (
    <nav className="tabbar" aria-label="Sections">
      <button type="button" className={`tab${onHome ? ' is-active' : ''}`} aria-current={onHome ? 'page' : undefined} onClick={goHome}>
        <House size={21} />
        <span>Home</span>
      </button>
      <button
        type="button"
        className={`tab${onNotes ? ' is-active' : ''}`}
        aria-current={onNotes ? 'page' : undefined}
        onClick={showNotes}
      >
        <FileText size={21} />
        <span>Notes</span>
      </button>
      <button type="button" className="tab tab-new" aria-label="New note" onClick={() => void newNote()}>
        <span className="tab-new-btn">
          <Plus size={24} strokeWidth={2.25} />
        </span>
      </button>
      <button type="button" className="tab" onClick={() => useApp.setState({ paletteOpen: true })}>
        <Search size={21} />
        <span>Search</span>
      </button>
      <button
        type="button"
        className={`tab${drawerOpen ? ' is-active' : ''}`}
        aria-current={drawerOpen ? 'page' : undefined}
        aria-label={unsynced > 0 ? `Library, ${unsynced} ${unsynced === 1 ? 'note' : 'notes'} not synced` : undefined}
        onClick={() => useApp.setState({ drawerOpen: true })}
      >
        <span className="tab-icon">
          <Library size={21} />
          {unsynced > 0 && <span className="tab-dot" />}
        </span>
        <span>Library</span>
      </button>
    </nav>
  );
}

export function App() {
  const status = useApp((s) => s.status);
  const loadError = useApp((s) => s.loadError);
  const noteId = useApp((s) => s.noteId);
  const drawerOpen = useApp((s) => s.drawerOpen);
  const focusMode = useApp((s) => s.focusMode);
  const authExpired = useApp((s) => s.authExpired);
  const online = useApp((s) => s.online);
  const drawing = useApp((s) => s.drawing);
  const reloadToken = useApp((s) => s.reloadToken);
  const mobileTab = useApp((s) => s.mobileTab);
  const screen = useApp((s) => s.screen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const historyFor = useApp((s) => s.historyFor);
  const theme = useResolvedTheme();
  const settings = useSettings();
  const vault = useVault((s) => s.state);
  const encryption = useApp((s) => s.encryption);
  const attachmentsDeferred = useApp((s) => s.attachmentsDeferred);
  // Back (a phone's back gesture) closes the drawer, as it does anything else open over the page.
  useBackLayer(drawerOpen, () => useApp.setState({ drawerOpen: false }));

  // Notes load once this device knows whether they're encrypted, and can decrypt them if so.
  useEffect(() => {
    void initVault();
  }, []);
  const started = useRef(false);
  useEffect(() => {
    if (vault !== 'off' && vault !== 'unlocked') return;
    if (started.current) {
      // Unlocked after encryption was turned on elsewhere: reload the list, now decrypted.
      void loadAll(true);
      return;
    }
    started.current = true;
    void loadAll();
    recoverDrafts();
  }, [vault]);
  useEffect(() => noticeEncryption(encryption.on), [encryption.on]);
  // A home-screen shortcut or something shared into Lumen, once the notes are here (see launch.ts).
  useEffect(() => {
    if (status === 'ready') takeLaunchAction();
    // A backup kept on the server about once a week, when set up (loaded only then: it brings the zip code).
    if (status === 'ready') {
      void import('./lib/autoBackup').then(
        (m) => m.startAutoBackups(),
        () => undefined,
      );
    }
  }, [status]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const color = theme === 'dark' ? '#0B1119' : '#F1F4F8';
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  }, [theme]);

  useEffect(() => {
    const s = document.documentElement.style;
    const accent = ACCENTS[settings.accent] ?? ACCENTS.iris;
    s.setProperty('--accent', theme === 'dark' ? accent.dark : accent.light);
    s.setProperty('--on-accent', theme === 'dark' ? accent.onDark : accent.onLight);
    s.setProperty('--note-size', `${settings.fontSize}px`);
    s.setProperty('--font-note', FONTS[settings.noteFont].family);
    s.setProperty('--note-leading', FONTS[settings.noteFont].leading);
    s.setProperty('--doc-width', WIDTHS[settings.readingWidth]);
    s.setProperty('--sidebar-w', `${settings.sidebarWidth}px`);
    s.setProperty('--list-w', `${settings.listWidth}px`);
  }, [theme, settings.accent, settings.fontSize, settings.noteFont, settings.readingWidth, settings.sidebarWidth, settings.listWidth]);

  // Track the visible viewport so docked toolbars stay above the on-screen keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    const apply = () => {
      const h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`);
      document.documentElement.classList.toggle('keyboard-open', !!vv && window.innerHeight - vv.height > 140);
      if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not with Alt: Windows reports AltGr as Ctrl Alt, and AltGr types characters (\ on German,
      // French or Nordic keyboards), including in text fields such as the passphrase.
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
      const s = useApp.getState();
      if (s.drawing) return;
      // A dialog is open (a question, Settings, history, a diagram or picture): the keys are its own.
      // The switcher opened under it would take the typing out of sight, a new note would open behind it.
      const covered = !!(s.dialog || s.settingsOpen || s.historyFor || s.mermaid || s.lightbox) || modalOpen();
      if (covered && e.key !== 'Escape') return;
      if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        useApp.setState({ paletteOpen: !s.paletteOpen });
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        const st = useSettings.getState();
        st.update({ sidebarCollapsed: !st.sidebarCollapsed });
      } else if (mod && e.key === ',') {
        e.preventDefault();
        useApp.setState({ settingsOpen: true });
      } else if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        // On a Mac, Option N types a letter (ñ, ń): matched by key position only outside text fields.
        (e.key.toLowerCase() === 'n' || (e.code === 'KeyN' && !isTypingTarget(e.target)))
      ) {
        e.preventDefault();
        void newNote();
      } else if (
        e.key === 'Escape' &&
        // Already used, e.g. by the editor to close a formula or its autocomplete.
        !e.defaultPrevented &&
        !s.paletteOpen &&
        !s.dialog &&
        !s.settingsOpen &&
        !s.mermaid &&
        !s.historyFor &&
        !s.lightbox
      ) {
        if (s.drawerOpen) useApp.setState({ drawerOpen: false });
        else if (s.focusMode) useApp.setState({ focusMode: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (vault === 'checking') {
    return (
      <main className="splash" aria-busy="true">
        <Spinner label="Opening Lumen" size={22} />
      </main>
    );
  }
  if (vault === 'locked') {
    return (
      <>
        <UnlockScreen />
        <DialogHost />
        <Toasts />
      </>
    );
  }

  if (status === 'error') {
    return (
      <main className="splash">
        <BrandMark size={44} />
        <h1>{authExpired ? 'Your session has ended' : 'Your notes didn’t load'}</h1>
        <p>{authExpired ? 'Sign in again through Cloudflare Access to keep going.' : loadError}</p>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          {authExpired ? 'Sign in again' : 'Try again'}
        </button>
      </main>
    );
  }

  // Notes saved before encryption was turned on (or left by an interrupted run) are encrypted first.
  // So is everything still encrypted with a key that was replaced, and files and drawings saved
  // before they were encrypted too.
  if (
    vault === 'unlocked' &&
    encryption.on &&
    (encryption.pending > 0 || encryption.rekey > 0 || (encryption.attachments > 0 && !attachmentsDeferred))
  ) {
    return (
      <>
        <EncryptingScreen mode={encryption.pending > 0 ? 'convert' : encryption.rekey > 0 ? 'rekey' : 'attachments'} />
        <Toasts />
      </>
    );
  }

  const classes = [
    'app',
    noteId ? 'has-note' : `mobile-${mobileTab}`,
    drawerOpen ? 'drawer-open' : '',
    focusMode ? 'focus-mode' : '',
    settings.sidebarCollapsed ? 'sidebar-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <div className="sidebar-slot">
        <Sidebar />
        <Resizer
          cssVar="--sidebar-w"
          min={200}
          max={360}
          value={settings.sidebarWidth}
          fallback={DEFAULT_SIDEBAR_WIDTH}
          label="Resize sidebar"
          onCommit={(v) => settings.update({ sidebarWidth: v })}
        />
      </div>
      {drawerOpen && <div className="scrim" onClick={() => useApp.setState({ drawerOpen: false })} aria-hidden="true" />}
      <div className="list-slot">
        <NoteList />
        <Resizer
          cssVar="--list-w"
          min={260}
          max={520}
          value={settings.listWidth}
          fallback={DEFAULT_LIST_WIDTH}
          label="Resize note list"
          onCommit={(v) => settings.update({ listWidth: v })}
        />
      </div>
      <main className="main-slot">
        {noteId ? (
          <ErrorBoundary scope="pane" label="The note editor" resetKey={`${noteId}:${reloadToken}`} onReset={NoteView.reset}>
            <Suspense fallback={<NoteLoading />}>
              <NoteView key={`${noteId}:${reloadToken}`} noteId={noteId} />
            </Suspense>
          </ErrorBoundary>
        ) : screen === 'tasks' ? (
          <TasksView />
        ) : (
          <Home />
        )}
      </main>
      <MobileTabBar />

      {focusMode && (
        <button type="button" className="focus-exit" onClick={() => useApp.setState({ focusMode: false })}>
          <Minimize2 size={14} /> Exit focus
        </button>
      )}
      {authExpired && (
        <div className="banner banner-danger" role="alert">
          <CircleAlert size={16} />
          <span>Your Cloudflare Access session ended. Edits are kept on this device.</span>
          <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
            Sign in again
          </button>
        </div>
      )}
      {!online && !authExpired && (
        <div className="banner" role="status">
          <CloudOff size={16} />
          <span>You’re offline. Edits are saved here and sync when you reconnect.</span>
        </div>
      )}

      <CommandPalette />
      {settingsOpen && (
        <ErrorBoundary
          scope="dialog"
          label="Settings"
          onFail={dialogFailed(() => useApp.setState({ settingsOpen: false }), SettingsDialog.reset)}
        >
          <Suspense fallback={null}>
            <SettingsDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {historyFor && (
        <ErrorBoundary
          scope="dialog"
          label="Version history"
          onFail={dialogFailed(() => useApp.setState({ historyFor: null }), HistoryDialog.reset)}
        >
          <Suspense fallback={null}>
            <HistoryDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      <MermaidEditor />
      <DialogHost />
      <Lightbox />
      <Toasts />
      <TooltipHost />
      {drawing && (
        <ErrorBoundary
          scope="dialog"
          label="The drawing editor"
          onFail={dialogFailed(() => {
            // Whoever asked for the drawing is still waiting on an answer.
            useApp.getState().drawing?.resolve(null);
            useApp.setState({ drawing: null });
          }, DrawingEditor.reset)}
        >
          <Suspense
            fallback={
              <div className="drawing-overlay">
                <div className="note-message">
                  <Spinner label="Opening the drawing editor" />
                </div>
              </div>
            }
          >
            <DrawingEditor />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}
