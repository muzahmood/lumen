import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import {
  BookmarkPlus,
  Check,
  CheckSquare,
  Copy,
  FileText,
  Folder as FolderIcon,
  FolderInput,
  Hash,
  ListFilter,
  Menu as MenuIcon,
  MoreHorizontal,
  PanelLeftOpen,
  PenTool,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  SquarePen,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { searchNotes } from '../lib/search';
import { useSettings } from '../lib/settings';
import {
  deleteNoteForever,
  deleteNotesForever,
  duplicateNote,
  emptyTrash,
  folderDescendants,
  folderPath,
  newNote,
  openNote,
  promptDialog,
  restoreNote,
  restoreNotes,
  saveSearch,
  setFilter,
  setListQuery,
  toast,
  trashNote,
  trashNotes,
  updateNoteMeta,
  updateNotesMeta,
  useApp,
} from '../lib/store';
import type { Folder, NoteMeta, SearchHit, SortKey } from '../lib/types';
import { dateGroup, modKey, noteTitle, shortTime, snippetToHtml, titleCollator } from '../lib/utils';
import { NOTE_DRAG, savedSearchMenuItems, tagMenuItems } from './Sidebar';
import { AssetImg } from './AssetImg';
import { EmptyState, IconButton, MenuButton, MenuPopover, Skeleton, Spinner, type MenuItem } from './ui';

function folderMenuItems(folders: Folder[], current: string | null, onPick: (id: string | null) => void): MenuItem[] {
  const children = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const list = children.get(f.parent_id) ?? [];
    list.push(f);
    children.set(f.parent_id, list);
  }
  const items: MenuItem[] = [
    { heading: 'Move to' },
    { label: 'No folder', icon: <FileText size={15} />, checked: !current, onSelect: () => onPick(null) },
  ];
  const walk = (parent: string | null, depth: number) => {
    for (const f of (children.get(parent) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))) {
      items.push({ label: f.name, icon: <FolderIcon size={15} />, indent: depth, checked: current === f.id, onSelect: () => onPick(f.id) });
      if (depth < 6) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return items;
}

export function noteMenuItems(note: NoteMeta, folders: Folder[]): MenuItem[] {
  if (note.deleted_at) {
    return [
      { label: 'Restore', icon: <RotateCcw size={15} />, onSelect: () => void restoreNote(note.id) },
      { label: 'Delete forever', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteNoteForever(note.id) },
    ];
  }
  return [
    {
      label: note.pinned ? 'Unpin' : 'Pin to top',
      icon: note.pinned ? <PinOff size={15} /> : <Pin size={15} />,
      onSelect: () => void updateNoteMeta(note.id, { pinned: !note.pinned }),
    },
    { label: 'Duplicate', icon: <Copy size={15} />, onSelect: () => void duplicateNote(note.id) },
    { separator: true },
    ...folderMenuItems(folders, note.folder_id, (id) => void updateNoteMeta(note.id, { folder_id: id })),
    { separator: true },
    { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => void trashNote(note.id) },
  ];
}

const SORT_LABEL: Record<SortKey, string> = {
  updated: 'Last edited',
  created: 'Date created',
  title: 'Title',
};

/* ---------------------------------------------------------------- row --- */

function TaskRing({ done, total }: { done: number; total: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  return (
    <span className={`row-badge${done === total ? ' is-complete' : ''}`} data-tip={`${done} of ${total} tasks done`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${c * pct} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 7 7)"
        />
      </svg>
      {done}/{total}
    </span>
  );
}

interface RowProps {
  note: NoteMeta;
  active: boolean;
  folderName?: string;
  showPreview: boolean;
  timeOf: 'updated' | 'created' | 'deleted';
  onContext: (e: MouseEvent, note: NoteMeta) => void;
  selected: boolean;
  /** The list is choosing notes: rows show a tick box, and a click picks rather than opens. */
  selecting: boolean;
  /** A click that picks the note (Ctrl/⌘, Shift, or while choosing) rather than opens it: true if it did. */
  onPick: (e: MouseEvent, id: string) => boolean;
  onDrag: (e: DragEvent, id: string) => void;
  /** Today's date: a row's time ("2:14 PM", "Yesterday") is drawn again when it moves on. */
  day: string;
}

/**
 * Dragging a note onto a folder in the sidebar moves it there; dropped elsewhere it's a link. Dragging
 * one of several selected notes takes them all (their ids, comma-separated).
 */
function startNoteDrag(e: DragEvent, ids: string[]) {
  e.dataTransfer.setData(NOTE_DRAG, ids.join(','));
  e.dataTransfer.setData('text/uri-list', ids.map((id) => `${location.origin}/note/${id}`).join('\r\n'));
  e.dataTransfer.effectAllowed = 'move';
}

const NoteRow = memo(function NoteRow({ note: n, active, folderName, showPreview, timeOf, onContext, selected, selecting, onPick, onDrag }: RowProps) {
  const ts = timeOf === 'deleted' ? n.deleted_at ?? n.updated_at : timeOf === 'created' ? n.created_at : n.updated_at;
  const thumb = showPreview ? n.info?.th : undefined;
  return (
    <a
      href={`/note/${n.id}`}
      className={`row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${selecting ? ' is-selecting' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        if (onPick(e, n.id)) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        openNote(n.id);
      }}
      onContextMenu={(e) => onContext(e, n)}
      draggable={!n.deleted_at}
      onDragStart={(e) => onDrag(e, n.id)}
    >
      {selecting && (
        <span className="row-check" aria-hidden="true">
          {selected && <Check size={12} strokeWidth={3} />}
        </span>
      )}
      <span className="row-body">
        <span className="row-top">
          <span className={`row-title${n.title.trim() ? '' : ' is-untitled'}`}>{noteTitle(n.title)}</span>
          {/* A link can't be "selected" for screen readers (aria-selected): its name says so instead. */}
          {selecting && <span className="sr-only">{selected ? ', chosen' : ', not chosen'}</span>}
          {n.pinned && timeOf !== 'deleted' && <Pin size={12} className="row-pin" aria-label="Pinned" />}
          <time className="row-time" dateTime={new Date(ts).toISOString()}>
            {shortTime(ts)}
          </time>
        </span>
        {showPreview && <span className="row-excerpt">{n.excerpt || 'No additional text'}</span>}
        {(folderName || n.tags.length > 0 || n.info?.t || n.info?.d || n.info?.dr) && (
          <span className="row-meta">
            {folderName && (
              <span className="row-chip">
                <FolderIcon size={11} /> {folderName}
              </span>
            )}
            {n.info?.t && <TaskRing done={n.info.t[0]} total={n.info.t[1]} />}
            {n.info?.d ? (
              <span className="row-badge" data-tip={`${n.info.d} diagram${n.info.d > 1 ? 's' : ''}`}>
                <Workflow size={12} />
              </span>
            ) : null}
            {n.info?.dr ? (
              <span className="row-badge" data-tip={`${n.info.dr} drawing${n.info.dr > 1 ? 's' : ''}`}>
                <PenTool size={12} />
              </span>
            ) : null}
            {n.tags.slice(0, 2).map((t) => (
              <span key={t} className="row-tag">
                #{t}
              </span>
            ))}
            {n.tags.length > 2 && <span className="row-tag">+{n.tags.length - 2}</span>}
          </span>
        )}
      </span>
      {thumb && (
        <span className={`row-thumb${thumb.startsWith('/api/drawings/') ? ' is-drawing' : ''}`}>
          <AssetImg src={thumb} alt="" loading="lazy" decoding="async" />
        </span>
      )}
    </a>
  );
});

export function ListSkeleton() {
  return (
    <div className="list-skeleton" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="row-skel">
          <Skeleton width={`${55 + ((i * 17) % 35)}%`} height={13} />
          <Skeleton width="92%" height={10} />
          <Skeleton width={`${40 + ((i * 23) % 40)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- list --- */

export function NoteList() {
  const status = useApp((s) => s.status);
  const ready = status === 'ready';
  const filter = useApp((s) => s.filter);
  const notes = useApp((s) => s.notes);
  const folders = useApp((s) => s.folders);
  const activeId = useApp((s) => s.noteId);
  const day = useApp((s) => s.day);
  const sort = useSettings((s) => s.sort);
  const listPreviews = useSettings((s) => s.listPreviews);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const updateSettings = useSettings((s) => s.update);
  const searchHere = useSettings((s) => s.searchHere);
  const savedSearches = useSettings((s) => s.savedSearches);
  // A saved search shows what it finds (the search box narrows that further).
  const saved = filter.kind === 'search' ? savedSearches.find((s) => s.id === filter.id) : undefined;

  // In the store, so it's in the address and Back brings it back (picking another view clears it).
  const query = useApp((s) => s.listQuery);
  const setQuery = setListQuery;
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; note: NoteMeta } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContext = useCallback((e: MouseEvent, note: NoteMeta) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, note });
  }, []);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);

  const heading = useMemo(() => {
    switch (filter.kind) {
      case 'all':
        return 'All notes';
      case 'pinned':
        return 'Pinned';
      case 'trash':
        return 'Trash';
      case 'tag':
        return `#${filter.tag}`;
      case 'folder':
        return folderPath(folders, filter.id).at(-1)?.name ?? 'Folder';
      case 'search':
        return saved?.name ?? 'Saved search';
    }
  }, [filter, folders, saved]);

  const list = useMemo(() => {
    const all = Object.values(notes);
    let out: NoteMeta[];
    switch (filter.kind) {
      case 'trash':
        out = all.filter((n) => n.deleted_at);
        break;
      case 'pinned':
        out = all.filter((n) => !n.deleted_at && n.pinned);
        break;
      case 'folder': {
        // A folder lists its subfolders' notes too; those rows name their subfolder.
        const ids = folderDescendants(folders, filter.id);
        out = all.filter((n) => !n.deleted_at && n.folder_id !== null && ids.has(n.folder_id));
        break;
      }
      case 'tag': {
        const t = filter.tag.toLowerCase();
        out = all.filter((n) => !n.deleted_at && n.tags.some((x) => x.toLowerCase() === t));
        break;
      }
      case 'search':
        // What it finds comes from the search (below), not from here.
        out = [];
        break;
      default:
        out = all.filter((n) => !n.deleted_at);
    }
    if (filter.kind === 'trash') return out.sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0));
    const cmp =
      sort === 'title'
        ? (a: NoteMeta, b: NoteMeta) => titleCollator.compare(noteTitle(a.title), noteTitle(b.title))
        : sort === 'created'
          ? (a: NoteMeta, b: NoteMeta) => b.created_at - a.created_at
          : (a: NoteMeta, b: NoteMeta) => b.updated_at - a.updated_at;
    return out.sort(cmp);
  }, [notes, filter, sort, folders]);

  // Pinned first, then date sections (or a single section when sorting by title).
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: NoteMeta[] }> = [];
    const push = (label: string, n: NoteMeta) => {
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(n);
      else out.push({ label, items: [n] });
    };
    const showPinned = filter.kind !== 'pinned' && filter.kind !== 'trash';
    if (showPinned) for (const n of list) if (n.pinned) push('Pinned', n);
    for (const n of list) {
      if (showPinned && n.pinned) continue;
      if (filter.kind === 'trash') push('Deleted', n);
      else if (sort === 'title') push(showPinned && out.length ? 'Notes' : '', n);
      else push(dateGroup(sort === 'created' ? n.created_at : n.updated_at), n);
    }
    return out;
    // Again when the date moves on: yesterday's "Today" is now "Yesterday".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, filter.kind, sort, day]);

  // In a folder or tag, the search can stay inside it (with its subfolders, or the tags under it).
  const here = filter.kind === 'folder' ? folderName.get(filter.id) : filter.kind === 'tag' ? `#${filter.tag}` : undefined;
  const scoped = !!here && searchHere;
  const scope = useMemo(() => {
    if (!scoped) return undefined;
    if (filter.kind === 'folder') {
      const ids = folderDescendants(folders, filter.id);
      return (n: NoteMeta) => !!n.folder_id && ids.has(n.folder_id);
    }
    if (filter.kind === 'tag') {
      const tag = filter.tag.toLowerCase();
      return (n: NoteMeta) => n.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`));
    }
    return undefined;
  }, [scoped, filter, folders]);

  /** What's typed, with where it's searched ("Only in" a folder or tag), so a saved search finds the same. */
  const withScope = (q: string) => {
    if (scoped && filter.kind === 'folder') {
      const path = folderPath(folders, filter.id)
        .map((f) => f.name)
        .join('/');
      return `${q.trim()} in:${/\s/.test(path) ? `"${path.replace(/"/g, '')}"` : path}`;
    }
    if (scoped && filter.kind === 'tag') return `${q.trim()} tag:${filter.tag}`;
    return q.trim();
  };

  // What's searched for: what's typed, within a saved search's own query.
  const searchFor = saved ? `${saved.query} ${query}`.trim() : query;
  useEffect(() => {
    const q = searchFor.trim();
    if (q.length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchNotes(q, { signal: ctrl.signal, scope, limit: saved ? 200 : undefined })
        .then(setHits)
        .catch(() => {
          const lq = q.toLowerCase();
          setHits(
            Object.values(useApp.getState().notes)
              .filter((n) => !n.deleted_at && (n.title.toLowerCase().includes(lq) || n.excerpt.toLowerCase().includes(lq)))
              .slice(0, 40)
              .map((n) => ({ id: n.id, title: n.title, folder_id: n.folder_id, updated_at: n.updated_at, tags: n.tags, snippet: n.excerpt })),
          );
        })
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Again once the notes have loaded: a search typed while they were (an encrypted library opening
    // on a slow connection) found nothing, and would go on saying so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFor, scope, ready]);

  // Search results drop notes trashed or deleted since the search ran (from their menu, say).
  const shownHits = useMemo(() => hits?.filter((h) => notes[h.id] && !notes[h.id].deleted_at) ?? null, [hits, notes]);

  // Rows name their folder, except in a folder's own view, where only subfolder notes need it.
  const rowFolder = (folderId: string | null) =>
    folderId && !(filter.kind === 'folder' && folderId === filter.id) ? folderName.get(folderId) : undefined;
  const timeOf = filter.kind === 'trash' ? 'deleted' : sort === 'created' ? 'created' : 'updated';

  const filterKey = JSON.stringify(filter);

  // Arrow keys move between notes (Enter opens one); ArrowDown from the search box enters the list.
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const moveFocus = (e: KeyboardEvent, from: Element | null) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key) || e.altKey || e.metaKey || e.ctrlKey) return;
    const rows = Array.from(scrollRef.current?.querySelectorAll<HTMLAnchorElement>('a.row') ?? []);
    if (!rows.length) return;
    const i = rows.indexOf(from as HTMLAnchorElement);
    if (i < 0 && e.key !== 'ArrowDown') return;
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : i - 1;
    e.preventDefault();
    if (next < 0) {
      searchRef.current?.focus();
      return;
    }
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  };

  /* ---------------------------------------------- choosing several --- */

  // Ctrl/⌘-click picks a note, Shift-click a run of them; "Select notes" (for touch) picks with taps.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const anchorRef = useRef<string | null>(null);
  const visibleIds = useMemo(() => (shownHits ? shownHits.map((h) => h.id) : groups.flatMap((g) => g.items.map((n) => n.id))), [shownHits, groups]);
  // Only chosen notes still in this list: one restored from the trash (by Undo, or on another device)
  // leaves the trash's list, so "Delete forever" can never reach it; likewise a note moved elsewhere.
  const picked = useMemo(() => {
    const shown = new Set(visibleIds);
    return [...selected].filter((id) => notes[id] && shown.has(id));
  }, [selected, notes, visibleIds]);
  const selectMode = selecting || picked.length > 0;
  const live = useRef({ selectMode, visibleIds, selected });
  live.current = { selectMode, visibleIds, selected };

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelecting(false);
    anchorRef.current = null;
  }, []);
  // Another view, or another search, starts again.
  useEffect(clearSelection, [filterKey, query, clearSelection]);

  const onPick = useCallback((e: MouseEvent, id: string): boolean => {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey || live.current.selectMode)) return false;
    const anchor = anchorRef.current;
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = live.current.visibleIds;
      if (e.shiftKey && anchor) {
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
    return true;
  }, []);

  const onDrag = useCallback((e: DragEvent, id: string) => {
    const sel = live.current.selected;
    startNoteDrag(e, sel.has(id) && sel.size > 1 ? [...sel] : [id]);
  }, []);

  // Esc lets the choice go; Ctrl/⌘ A in the list picks every note shown.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const s = useApp.getState();
      if (e.key === 'Escape' && !e.defaultPrevented && !s.dialog && !s.paletteOpen && !s.settingsOpen) {
        e.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode, clearSelection]);

  const inTrash = filter.kind === 'trash';
  const chosen = picked.map((id) => notes[id]);
  const chosenLive = chosen.filter((n) => !n.deleted_at);
  const allPinned = chosenLive.length > 0 && chosenLive.every((n) => n.pinned);
  const count = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;

  const moveChosen = async (folderId: string | null) => {
    const saved = await updateNotesMeta(chosenLive.map((n) => ({ id: n.id, patch: { folder_id: folderId } })));
    if (saved.length) toast(`Moved ${count(saved.length)} to ${folderId ? folderName.get(folderId) ?? 'the folder' : 'No folder'}`, { kind: 'success' });
    clearSelection();
  };

  const pinChosen = async () => {
    await updateNotesMeta(chosenLive.filter((n) => n.pinned === allPinned).map((n) => ({ id: n.id, patch: { pinned: !allPinned } })));
  };

  const cleanTag = (raw: string) => raw.replace(/^#+/, '').trim().replace(/\s+/g, '-').slice(0, 60);
  const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  /** Adds `tag` to the chosen notes that lack it, or (when they all have it) takes it off them all. */
  const toggleTag = async (raw: string) => {
    const tag = cleanTag(raw);
    if (!tag) return;
    const editable = chosenLive.filter((n) => !n.tagsUnreadable);
    const allHave = editable.every((n) => n.tags.some((t) => sameTag(t, tag)));
    const changes = editable
      .filter((n) => allHave || !n.tags.some((t) => sameTag(t, tag)))
      .map((n) => ({ id: n.id, patch: { tags: allHave ? n.tags.filter((t) => !sameTag(t, tag)) : [...n.tags, tag] } }));
    const saved = await updateNotesMeta(changes);
    if (saved.length) toast(`${allHave ? 'Removed' : 'Added'} #${tag} ${allHave ? 'from' : 'to'} ${count(saved.length)}`, { kind: 'success' });
  };

  const tagItems = (): MenuItem[] => {
    // The tags already on the chosen notes, then the library's most used.
    const usage = new Map<string, { tag: string; count: number }>();
    for (const n of Object.values(notes)) {
      if (n.deleted_at) continue;
      for (const t of n.tags) {
        const key = t.toLowerCase();
        const cur = usage.get(key);
        if (cur) cur.count++;
        else usage.set(key, { tag: t, count: 1 });
      }
    }
    const onChosen = new Set(chosenLive.flatMap((n) => n.tags.map((t) => t.toLowerCase())));
    const tags = [...usage.values()]
      .sort((a, b) => Number(onChosen.has(b.tag.toLowerCase())) - Number(onChosen.has(a.tag.toLowerCase())) || b.count - a.count)
      .slice(0, 14);
    return [
      { heading: `Tags on ${count(chosenLive.length)}` },
      ...tags.map(({ tag }) => {
        const has = chosenLive.filter((n) => n.tags.some((t) => sameTag(t, tag))).length;
        return {
          label: `#${tag}`,
          checked: has === chosenLive.length,
          hint: has > 0 && has < chosenLive.length ? `${has} of ${chosenLive.length}` : undefined,
          onSelect: () => void toggleTag(tag),
        } as MenuItem;
      }),
      ...(tags.length ? [{ separator: true } as MenuItem] : []),
      {
        label: 'New tag…',
        icon: <Plus size={15} />,
        onSelect: async () => {
          const name = await promptDialog({ title: `Tag ${count(chosenLive.length)}`, placeholder: 'Tag name', confirmLabel: 'Add tag' });
          if (name?.trim()) await toggleTag(name);
        },
      },
    ];
  };

  const commonFolder = chosenLive.length && chosenLive.every((n) => n.folder_id === chosenLive[0].folder_id) ? chosenLive[0].folder_id : '\u0000mixed';
  const bulkMoveItems = (): MenuItem[] => folderMenuItems(folders, commonFolder, (id) => void moveChosen(id));

  const bulkMenuItems = (): MenuItem[] =>
    inTrash
      ? [
          { heading: count(picked.length) },
          { label: 'Restore', icon: <RotateCcw size={15} />, onSelect: () => void restoreNotes(picked).then(clearSelection) },
          {
            label: 'Delete forever',
            icon: <Trash2 size={15} />,
            danger: true,
            onSelect: () => void deleteNotesForever(picked).then((done) => done && clearSelection()),
          },
        ]
      : [
          { heading: count(chosenLive.length) },
          { label: allPinned ? 'Unpin' : 'Pin to top', icon: allPinned ? <PinOff size={15} /> : <Pin size={15} />, onSelect: () => void pinChosen() },
          { separator: true },
          ...bulkMoveItems(),
          { separator: true },
          { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => void trashNotes(chosenLive.map((n) => n.id)).then(clearSelection) },
        ];

  const viewItems = (): MenuItem[] => [
    { heading: 'Sort by' },
    ...(['updated', 'created', 'title'] as SortKey[]).map((k) => ({
      label: SORT_LABEL[k],
      checked: sort === k,
      onSelect: () => updateSettings({ sort: k }),
    })),
    { separator: true },
    { label: 'Show previews', checked: listPreviews, onSelect: () => updateSettings({ listPreviews: !listPreviews }) },
    { separator: true },
    { label: 'Select notes', icon: <CheckSquare size={15} />, hint: `${modKey()} click`, onSelect: () => setSelecting(true) },
  ];

  return (
    <section className="list-pane" aria-label={heading}>
      <header className="pane-header list-header">
        <IconButton label="Open menu" className="drawer-toggle" onClick={() => useApp.setState({ drawerOpen: true })}>
          <MenuIcon size={18} />
        </IconButton>
        {sidebarCollapsed && (
          <IconButton
            label="Show sidebar"
            shortcut={`${modKey()} \\`}
            className="sidebar-open-btn"
            onClick={() => updateSettings({ sidebarCollapsed: false })}
          >
            <PanelLeftOpen size={17} />
          </IconButton>
        )}
        <div className="list-title">
          {filter.kind === 'tag' && <Hash size={16} className="list-title-icon" />}
          {filter.kind === 'search' && <Search size={16} className="list-title-icon" />}
          <h1>{filter.kind === 'tag' ? filter.tag : heading}</h1>
          <span className="list-count">{filter.kind === 'search' ? (shownHits?.length ?? '') : list.length}</span>
        </div>
        {filter.kind === 'trash' ? (
          list.length > 0 && (
            <>
              <IconButton label="Select notes" onClick={() => setSelecting(true)}>
                <CheckSquare size={17} />
              </IconButton>
              <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => void emptyTrash()}>
                Empty trash
              </button>
            </>
          )
        ) : (
          <>
            {filter.kind === 'tag' && <MenuButton label="Tag options" icon={<MoreHorizontal size={17} />} items={() => tagMenuItems(filter.tag)} />}
            {saved && <MenuButton label="Saved search options" icon={<MoreHorizontal size={17} />} items={() => savedSearchMenuItems(saved)} />}
            <MenuButton label="View options" icon={<ListFilter size={17} />} items={viewItems} />
            <IconButton label="New note" shortcut="Alt N" className="list-new" onClick={() => void newNote()}>
              <SquarePen size={17} />
            </IconButton>
          </>
        )}
      </header>

      {selectMode ? (
        <div className="bulk-bar" role="toolbar" aria-label="Chosen notes">
          <IconButton label="Done choosing (Esc)" size="sm" onClick={clearSelection}>
            <X size={16} />
          </IconButton>
          <span className="bulk-count" aria-live="polite">
            {picked.length ? `${picked.length} selected` : 'Choose notes'}
          </span>
          {picked.length < visibleIds.length && (
            <button type="button" className="link-btn" onClick={() => setSelected(new Set(visibleIds))}>
              All
            </button>
          )}
          <span className="spacer" />
          {inTrash ? (
            <>
              <IconButton label="Restore" disabled={!picked.length} onClick={() => void restoreNotes(picked).then(clearSelection)}>
                <RotateCcw size={16} />
              </IconButton>
              <IconButton
                label="Delete forever"
                disabled={!picked.length}
                onClick={() => void deleteNotesForever(picked).then((done) => done && clearSelection())}
              >
                <Trash2 size={16} />
              </IconButton>
            </>
          ) : (
            <>
              <MenuButton label="Move to folder" icon={<FolderInput size={16} />} items={bulkMoveItems} disabled={!chosenLive.length} />
              <MenuButton label="Tags" icon={<Hash size={16} />} items={tagItems} disabled={!chosenLive.length} />
              <IconButton label={allPinned ? 'Unpin' : 'Pin to top'} active={allPinned} disabled={!chosenLive.length} onClick={() => void pinChosen()}>
                <Pin size={16} fill={allPinned ? 'currentColor' : 'none'} />
              </IconButton>
              <IconButton
                label="Move to trash"
                disabled={!chosenLive.length}
                onClick={() => void trashNotes(chosenLive.map((n) => n.id)).then(clearSelection)}
              >
                <Trash2 size={16} />
              </IconButton>
            </>
          )}
        </div>
      ) : (
      <div className="list-search">
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            name="note-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
              else if (e.key === 'ArrowDown') moveFocus(e, null);
            }}
            placeholder={saved ? `Search in ${saved.name}` : scoped ? `Search ${here}` : 'Search all notes'}
            aria-label={saved ? `Search in ${saved.name}` : scoped ? `Search ${here}` : 'Search all notes'}
            enterKeyHint="search"
          />
          {searching ? (
            <Spinner label="Searching" size={14} />
          ) : (
            query && (
              <button type="button" className="clear-btn" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )
          )}
        </label>
        {filter.kind !== 'search' && filter.kind !== 'trash' && query.trim().length >= 2 && (
          <IconButton label="Save this search" size="sm" className="save-search" onClick={() => void saveSearch(withScope(query))}>
            <BookmarkPlus size={15} />
          </IconButton>
        )}
        {here && query.trim() && (
          <button
            type="button"
            className={`search-scope${scoped ? ' is-on' : ''}`}
            aria-pressed={scoped}
            onClick={() => updateSettings({ searchHere: !searchHere })}
          >
            {scoped ? <Check size={12} strokeWidth={3} /> : null}
            Only in {here}
          </button>
        )}
      </div>
      )}

      <div
        className="list-scroll"
        ref={scrollRef}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            setSelected(new Set(visibleIds));
            return;
          }
          moveFocus(e, document.activeElement);
        }}
      >
        {status === 'loading' ? (
          <ListSkeleton />
        ) : shownHits ? (
          <>
            <div className="group-label">
              {shownHits.length ? `${shownHits.length} ${shownHits.length === 1 ? 'result' : 'results'}` : 'Search results'}
            </div>
            {shownHits.length === 0 && saved && !query.trim() && (
              <EmptyState icon={<SearchX size={20} />} title="Nothing matches this saved search yet">
                It finds notes as they come to match <code>{saved.query}</code>.
              </EmptyState>
            )}
            {shownHits.length === 0 && !(saved && !query.trim()) && (
              <EmptyState icon={<SearchX size={20} />} title={`Nothing matches “${query.trim()}”`}>
                Words match the start of words{scoped ? ` in ${here}` : ', across every note'}. Narrow it down with <code>tag:</code>,{' '}
                <code>in:</code>, <code>is:pinned</code>, <code>has:task</code>, <code>"exact words"</code>, or <code>-word</code> to leave
                one out.
              </EmptyState>
            )}
            {shownHits.map((h) => {
              // Search results get the same menu and dragging as ordinary rows, and follow what's
              // done to them there: trashed or deleted notes drop out, a moved note shows its new folder.
              const meta = notes[h.id];
              const folderId = meta.folder_id;
              const isPicked = selected.has(h.id);
              return (
                <a
                  key={h.id}
                  href={`/note/${h.id}`}
                  className={`row${h.id === activeId ? ' is-active' : ''}${isPicked ? ' is-selected' : ''}${selectMode ? ' is-selecting' : ''}`}
                  aria-current={h.id === activeId ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!onPick(e, h.id)) openNote(h.id);
                  }}
                  onContextMenu={(e) => onContext(e, meta)}
                  draggable
                  onDragStart={(e) => onDrag(e, h.id)}
                >
                  {selectMode && (
                    <span className="row-check" aria-hidden="true">
                      {isPicked && <Check size={12} strokeWidth={3} />}
                    </span>
                  )}
                  <span className="row-body">
                    <span className="row-top">
                      <span className="row-title">{noteTitle(meta.title)}</span>
                      {selectMode && <span className="sr-only">{isPicked ? ', chosen' : ', not chosen'}</span>}
                      <time className="row-time">{shortTime(meta.updated_at)}</time>
                    </span>
                    <span className="row-excerpt" dangerouslySetInnerHTML={{ __html: snippetToHtml(h.snippet || '') }} />
                    {folderId && folderName.get(folderId) && (
                      <span className="row-meta">
                        <span className="row-chip">
                          <FolderIcon size={11} /> {folderName.get(folderId)}
                        </span>
                      </span>
                    )}
                  </span>
                </a>
              );
            })}
          </>
        ) : saved ? (
          <ListSkeleton />
        ) : list.length === 0 ? (
          <EmptyList kind={filter.kind} />
        ) : (
          groups.map((g, gi) => (
            <section key={`${g.label}-${gi}`} className="group" aria-label={g.label || 'Notes'}>
              {g.label && <div className="group-label">{g.label}</div>}
              {g.items.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  active={n.id === activeId}
                  folderName={rowFolder(n.folder_id)}
                  showPreview={listPreviews}
                  timeOf={timeOf}
                  onContext={onContext}
                  selected={selected.has(n.id)}
                  selecting={selectMode}
                  onPick={onPick}
                  onDrag={onDrag}
                  day={day}
                />
              ))}
            </section>
          ))
        )}
      </div>
      {menu && (
        <MenuPopover
          anchor={{ x: menu.x, y: menu.y }}
          // A right-click on one of several chosen notes acts on them all.
          items={selected.has(menu.note.id) && picked.length > 1 ? bulkMenuItems() : noteMenuItems(menu.note, folders)}
          onClose={closeMenu}
        />
      )}
    </section>
  );
}

function EmptyList({ kind }: { kind: string }) {
  if (kind === 'search') {
    return (
      <EmptyState icon={<SearchX size={20} />} title="This saved search was deleted">
        It may have been deleted on another device.
        <button type="button" className="btn btn-sm" onClick={() => setFilter({ kind: 'all' }, { replace: true })}>
          Show all notes
        </button>
      </EmptyState>
    );
  }
  if (kind === 'trash') {
    return (
      <EmptyState icon={<Trash2 size={20} />} title="Trash is empty">
        Deleted notes stay here for 30 days before they’re removed for good.
      </EmptyState>
    );
  }
  if (kind === 'pinned') {
    return (
      <EmptyState icon={<Pin size={20} />} title="Nothing pinned yet">
        Pin the notes you open often and they stay at the top of every list.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<FileText size={20} />} title="No notes here yet">
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void newNote()}>
        <Plus size={15} /> New note
      </button>
    </EmptyState>
  );
}
