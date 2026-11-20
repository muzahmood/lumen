import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarDays,
  Copy,
  CornerDownLeft,
  Download,
  FilePlus,
  FileText,
  FolderPlus,
  History,
  House,
  LayoutTemplate,
  Link as LinkIcon,
  ListTodo,
  Maximize2,
  Moon,
  PanelLeft,
  PenTool,
  Pin,
  PinOff,
  Plus,
  Search,
  SearchCode,
  Settings,
  Sun,
  TextSearch,
  Trash2,
  Workflow,
} from 'lucide-react';
import { searchNotes } from '../lib/search';
import { editJournalTemplate, newFromTemplate, newNoteTemplates, newTemplate } from '../lib/journal';
import { useResolvedTheme, useSettings } from '../lib/settings';
import {
  createFolder,
  createNote,
  duplicateNote,
  goHome,
  newDiagramNote,
  newDrawingNote,
  newNote,
  openDailyNote,
  openNote,
  openTasks,
  setFilter,
  toast,
  toastError,
  trashNote,
  updateNoteMeta,
  useApp,
} from '../lib/store';
import type { NoteMeta, SearchHit } from '../lib/types';
import { modKey, noteTitle, shortTime, snippetToHtml } from '../lib/utils';
import { useBackLayer } from '../lib/backLayers';

interface Item {
  key: string;
  group: string;
  icon: ReactNode;
  label: string;
  detail?: string;
  snippet?: string;
  hint?: string;
  run: () => void;
}

const CREATE_KEY = 'c-create';

function score(title: string, q: string): number {
  const t = title.toLowerCase();
  if (!q) return 1;
  const i = t.indexOf(q);
  if (i === 0) return 300 - t.length / 100;
  if (i > 0) return (/\s|-|_/.test(t[i - 1]) ? 200 : 100) - i;
  let pos = 0;
  for (const ch of q.replace(/\s+/g, '')) {
    pos = t.indexOf(ch, pos);
    if (pos < 0) return 0;
    pos++;
  }
  return 10;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const notes = useApp((s) => s.notes);
  const folders = useApp((s) => s.folders);
  const openId = useApp((s) => s.noteId);
  const theme = useResolvedTheme();
  const updateSettings = useSettings((s) => s.update);
  const savedSearches = useSettings((s) => s.savedSearches);
  const ready = useApp((s) => s.status === 'ready');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => useApp.setState({ paletteOpen: false });
  // Back (a phone's back gesture) closes it.
  useBackLayer(open, close);
  // Where focus was before the palette opened, to go back to when it closes (as a dialog does).
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery('');
      setHits([]);
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (returnTo.current) {
      const back = returnTo.current;
      returnTo.current = null;
      // Unless something else took focus meanwhile (a note the palette opened, say).
      const active = document.activeElement;
      if (back.isConnected && (!active || active === document.body)) back.focus({ preventScroll: true });
    }
  }, [open]);

  const commandMode = query.startsWith('>');
  const q = (commandMode ? query.slice(1) : query).trim().toLowerCase();

  useEffect(() => {
    if (!open || commandMode || q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchNotes(q, { signal: ctrl.signal })
        .then(setHits)
        .catch(() => undefined)
        .finally(() => setSearching(false));
    }, 160);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Again once the notes have loaded (see NoteList): a search typed while they were found nothing.
  }, [q, open, commandMode, ready]);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);

  const current = openId ? notes[openId] : undefined;

  const commands: Item[] = useMemo(() => {
    const m = modKey();
    // Commands for the note that's open, so the keyboard reaches them without the menu.
    const noteCommands: Item[] =
      current && !current.deleted_at
        ? [
            {
              key: 'n-pin',
              group: 'This note',
              icon: current.pinned ? <PinOff size={16} /> : <Pin size={16} />,
              label: current.pinned ? 'Unpin this note' : 'Pin this note',
              run: () => void updateNoteMeta(current.id, { pinned: !current.pinned }),
            },
            { key: 'n-history', group: 'This note', icon: <History size={16} />, label: 'Version history', run: () => useApp.setState({ historyFor: current.id }) },
            { key: 'n-dup', group: 'This note', icon: <Copy size={16} />, label: 'Duplicate this note', run: () => void duplicateNote(current.id) },
            {
              key: 'n-export',
              group: 'This note',
              icon: <Download size={16} />,
              label: 'Export as PDF or Markdown',
              run: () => useApp.setState({ exportFor: current.id }),
            },
            {
              key: 'n-link',
              group: 'This note',
              icon: <LinkIcon size={16} />,
              label: 'Copy link to this note',
              run: () => {
                const url = `${location.origin}/note/${current.id}`;
                // No clipboard here (an insecure page, an old browser): show the link to copy by hand.
                if (!navigator.clipboard) {
                  toast(url);
                  return;
                }
                void navigator.clipboard.writeText(url).then(
                  () => toast('Link copied', { kind: 'success' }),
                  () => toast(url),
                );
              },
            },
            { key: 'n-trash', group: 'This note', icon: <Trash2 size={16} />, label: 'Move this note to trash', run: () => void trashNote(current.id) },
          ]
        : [];
    return [
      ...noteCommands,
      { key: 'c-new', group: 'Actions', icon: <Plus size={16} />, label: 'New note', hint: 'Alt N', run: () => void newNote() },
      { key: 'c-draw', group: 'Actions', icon: <PenTool size={16} />, label: 'New drawing', run: () => void newDrawingNote() },
      { key: 'c-diagram', group: 'Actions', icon: <Workflow size={16} />, label: 'New diagram', run: () => void newDiagramNote() },
      { key: 'c-daily', group: 'Actions', icon: <CalendarDays size={16} />, label: 'Open today’s journal', run: () => void openDailyNote() },
      { key: 'c-folder', group: 'Actions', icon: <FolderPlus size={16} />, label: 'New folder', run: () => void createFolder(null) },
      // Notes in the Templates folder (see journal.ts).
      ...newNoteTemplates()
        .slice(0, 20)
        .map((t) => ({
          key: `t-${t.id}`,
          group: 'Templates',
          icon: <LayoutTemplate size={16} />,
          label: `New note from “${noteTitle(t.title)}”`,
          run: () => void newFromTemplate(t.id),
        })),
      { key: 'c-template', group: 'Templates', icon: <LayoutTemplate size={16} />, label: 'New template', run: () => void newTemplate() },
      { key: 'c-journal-template', group: 'Templates', icon: <CalendarDays size={16} />, label: 'Edit the journal template', run: () => void editJournalTemplate() },
      { key: 'c-home', group: 'Go to', icon: <House size={16} />, label: 'Home', run: goHome },
      { key: 'c-all', group: 'Go to', icon: <FileText size={16} />, label: 'All notes', run: () => setFilter({ kind: 'all' }) },
      { key: 'c-pinned', group: 'Go to', icon: <Pin size={16} />, label: 'Pinned notes', run: () => setFilter({ kind: 'pinned' }) },
      { key: 'c-tasks', group: 'Go to', icon: <ListTodo size={16} />, label: 'Tasks', run: openTasks },
      { key: 'c-trash', group: 'Go to', icon: <Trash2 size={16} />, label: 'Trash', run: () => setFilter({ kind: 'trash' }) },
      ...savedSearches.map((saved) => ({
        key: `c-search-${saved.id}`,
        group: 'Go to',
        icon: <SearchCode size={16} />,
        label: saved.name,
        hint: 'Saved search',
        run: () => setFilter({ kind: 'search', id: saved.id }),
      })),
      {
        key: 'c-theme',
        group: 'Preferences',
        icon: theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />,
        label: theme === 'dark' ? 'Use light theme' : 'Use dark theme',
        run: () => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      {
        key: 'c-sidebar',
        group: 'Preferences',
        icon: <PanelLeft size={16} />,
        label: 'Toggle sidebar',
        hint: `${m} \\`,
        run: () => updateSettings({ sidebarCollapsed: !useSettings.getState().sidebarCollapsed }),
      },
      {
        key: 'c-focus',
        group: 'Preferences',
        icon: <Maximize2 size={16} />,
        label: 'Toggle focus mode',
        run: () => useApp.setState((s) => ({ focusMode: !s.focusMode })),
      },
      { key: 'c-settings', group: 'Preferences', icon: <Settings size={16} />, label: 'Settings', hint: `${m} ,`, run: () => useApp.setState({ settingsOpen: true }) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, updateSettings, current, notes, folders, savedSearches]);

  const items: Item[] = useMemo(() => {
    // Best matches first, so the five shown for a search are the five that fit it best.
    const matchedCommands = q
      ? commands
          .map((c) => ({ c, s: score(c.label, q) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.c)
      : commands;
    if (commandMode) return matchedCommands;
    const live = Object.values(notes).filter((n) => !n.deleted_at);
    let titleMatches: NoteMeta[];
    if (!q) {
      titleMatches = live.sort((a, b) => b.updated_at - a.updated_at).slice(0, 6);
    } else {
      titleMatches = live
        .map((n) => ({ n, s: score(noteTitle(n.title), q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.n.updated_at - a.n.updated_at)
        .slice(0, 7)
        .map((x) => x.n);
    }
    const seen = new Set(titleMatches.map((n) => n.id));
    const noteItems: Item[] = titleMatches.map((n) => ({
      key: `n-${n.id}`,
      group: q ? 'Notes' : 'Recent',
      icon: <FileText size={16} />,
      label: noteTitle(n.title),
      detail: n.folder_id ? folderName.get(n.folder_id) : undefined,
      hint: shortTime(n.updated_at),
      run: () => openNote(n.id),
    }));
    const contentItems: Item[] = hits
      .filter((h) => !seen.has(h.id))
      .slice(0, 8)
      .map((h) => ({
        key: `h-${h.id}`,
        group: 'Found in text',
        icon: <TextSearch size={16} />,
        label: noteTitle(h.title),
        snippet: h.snippet,
        hint: shortTime(h.updated_at),
        run: () => openNote(h.id),
      }));
    // Typing a title that doesn't exist yet offers to create it (also Ctrl/⌘ Enter at any time).
    const typed = query.trim();
    const exists = live.some((n) => n.title.trim().toLowerCase() === typed.toLowerCase());
    const createItems: Item[] =
      typed && !exists
        ? [
            {
              key: CREATE_KEY,
              group: 'Create',
              icon: <FilePlus size={16} />,
              label: `New note “${typed}”`,
              hint: `${modKey()} Enter`,
              run: () => void createNote({ title: typed }).catch(toastError),
            },
          ]
        : [];
    return [
      ...noteItems,
      ...contentItems,
      ...createItems,
      ...(q ? matchedCommands.slice(0, 5) : matchedCommands.filter((c) => c.group === 'Actions')),
    ];
  }, [commands, commandMode, notes, q, query, hits, folderName]);

  const noNotesFound = !commandMode && !!q && !items.some((i) => i.group === 'Notes' || i.group === 'Found in text');

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  let lastGroup = '';

  return (
    <div className="overlay overlay-palette" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <div className="palette-input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, or type > for commands"
            aria-label="Search notes or commands"
            aria-controls="palette-list"
            aria-activedescendant={items[index] ? `pal-${items[index].key}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                // A new note with the typed title; the note itself if that title exists; an untitled
                // note when nothing is typed.
                const create = items.find((it) => it.key === CREATE_KEY);
                const typed = query.trim().toLowerCase();
                const existing = typed && !commandMode ? Object.values(notes).find((n) => !n.deleted_at && n.title.trim().toLowerCase() === typed) : undefined;
                if (create) choose(create);
                else if (existing) choose({ key: 'open', group: '', icon: null, label: '', run: () => openNote(existing.id) });
                else if (!typed) choose({ key: 'new', group: '', icon: null, label: '', run: () => void newNote() });
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(items[index]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
          />
          {searching && <span className="spinner" style={{ width: 14, height: 14 }} />}
          <button type="button" className="palette-esc" onClick={close}>
            Esc
          </button>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {/* Also when only "New note …" or commands came up: a search that finds no note says so, with the tip. */}
          {(items.length === 0 || (noNotesFound && !searching)) && (
            <div className={`palette-empty${items.length ? ' is-inline' : ''}`}>
              {items.length === 0 && <TextSearch size={20} />}
              <span>{items.length === 0 ? <>No notes or commands match “{query}”</> : <>No notes match “{query}”</>}</span>
              {!commandMode && (
                <span className="palette-empty-tip">
                  Narrow a search with <code>tag:</code>, <code>in:</code>, <code>is:pinned</code>, <code>has:task</code>, <code>"exact words"</code>{' '}
                  or <code>-word</code>.
                </span>
              )}
            </div>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  id={`pal-${item.key}`}
                  data-index={i}
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item${i === index ? ' is-selected' : ''}`}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-text">
                    <span className="palette-label">
                      {item.label}
                      {item.detail && <span className="palette-detail">{item.detail}</span>}
                    </span>
                    {item.snippet && (
                      <span className="palette-snippet" dangerouslySetInnerHTML={{ __html: snippetToHtml(item.snippet) }} />
                    )}
                  </span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {i === index && <CornerDownLeft size={14} className="palette-enter" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>{modKey()}</kbd>
            <kbd>Enter</kbd> new note
          </span>
          <span>
            <kbd>&gt;</kbd> for commands
          </span>
        </div>
      </div>
    </div>
  );
}
