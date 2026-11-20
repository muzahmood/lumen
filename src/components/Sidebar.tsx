import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CloudOff,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Hash,
  House,
  Inbox,
  LayoutTemplate,
  ListTodo,
  MoreHorizontal,
  PanelLeftClose,
  PenTool,
  Pencil,
  Pin,
  Plus,
  Search,
  SearchCode,
  Settings,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { useUnsynced } from '../lib/saver';
import { useMediaQuery, useSettings, type SavedSearch } from '../lib/settings';
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteSavedSearch,
  editSavedSearch,
  folderDescendants,
  goHome,
  moveFolder,
  newDiagramNote,
  newDrawingNote,
  newNote,
  openDailyNote,
  openNote,
  openTasks as showTasks,
  promptRenameTag,
  removeTag,
  renameFolder,
  renameSavedSearch,
  setFilter,
  toastError,
  updateNoteMeta,
  updateNotesMeta,
  useApp,
} from '../lib/store';
import { isTemplate, newFromTemplate, newNoteTemplates, newTemplate } from '../lib/journal';
import type { Folder, ListFilter } from '../lib/types';
import { initialOf, modKey, noteTitle } from '../lib/utils';
import { IconButton, MenuButton, MenuPopover, type MenuItem } from './ui';

export const NOTE_DRAG = 'application/x-kb-note';

/** Notes dropped on a folder (one, or several chosen together: ids comma-separated) move into it. */
function moveDropped(ids: string, patch: { folder_id: string | null }) {
  const list = ids.split(',').filter(Boolean);
  return list.length === 1 ? updateNoteMeta(list[0], patch) : updateNotesMeta(list.map((id) => ({ id, patch })));
}
const FOLDER_DRAG = 'application/x-kb-folder';

function sameFilter(a: ListFilter, b: ListFilter) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'folder' && b.kind === 'folder') return a.id === b.id;
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag.toLowerCase() === b.tag.toLowerCase();
  if (a.kind === 'search' && b.kind === 'search') return a.id === b.id;
  return true;
}

export const APP_NAME = 'Lumen';

/** The wordmark's class: a name drawn only from the letters the cut-down face has uses that face alone (app.css). */
export function wordmarkClass(name: string): string {
  return /^[Lumen]+$/.test(name) ? 'wordmark is-cut' : 'wordmark';
}

/**
 * The Lumen mark: an open notebook with a red ribbon marking your place, on a lapis tile. It is a
 * bayaz, the personal notebook in which readers in the Urdu and Persian tradition copied the lines
 * worth keeping. Brand colors are fixed so the logo stays recognisable whatever accent is chosen.
 * Same drawing as public/icon.svg, worker/gate.ts and scripts/make-icons.mjs.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#22346E" />
      <path d="M16 9.6C13 7.7 9.6 7.3 6.4 7.9v14.6c3.2-.6 6.6-.2 9.6 1.8Z" fill="#F4F0E8" />
      <path d="M16 9.6c3-1.9 6.4-2.3 9.6-1.7v14.6c-3.2-.6-6.6-.2-9.6 1.8Z" fill="#DCD3C2" />
      <path d="M16 9.6v14.7" stroke="#22346E" strokeWidth="0.7" strokeOpacity="0.35" />
      <path d="M19.6 8.7l2.8-.55V26.4l-1.4-1.5-1.4 1.5Z" fill="#B3261E" />
    </svg>
  );
}

export function newItems(): MenuItem[] {
  return [
    { label: 'Note', icon: <FileText size={15} />, hint: 'Alt N', onSelect: () => void newNote() },
    { label: 'Drawing', icon: <PenTool size={15} />, onSelect: () => void newDrawingNote() },
    { label: 'Diagram', icon: <Workflow size={15} />, onSelect: () => void newDiagramNote() },
    { separator: true },
    { label: 'Today’s journal', icon: <CalendarDays size={15} />, onSelect: () => void openDailyNote() },
    { label: 'Folder', icon: <FolderPlus size={15} />, onSelect: () => void createFolder(null) },
    // Notes in the Templates folder (see journal.ts).
    { separator: true },
    { heading: 'Templates' },
    ...newNoteTemplates()
      .slice(0, 12)
      .map((t) => ({ label: noteTitle(t.title), icon: <LayoutTemplate size={15} />, onSelect: () => void newFromTemplate(t.id) }) as MenuItem),
    { label: 'New template', icon: <Plus size={15} />, onSelect: () => void newTemplate() },
  ];
}

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
  onDrop,
  shortcut,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  onDrop?: (noteIds: string[]) => void;
  shortcut?: string;
}) {
  const [over, setOver] = useState(false);
  const dropProps = onDrop
    ? {
        onDragOver: (e: DragEvent) => {
          if (e.dataTransfer.types.includes(NOTE_DRAG)) {
            e.preventDefault();
            setOver(true);
          }
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          setOver(false);
          const ids = e.dataTransfer.getData(NOTE_DRAG);
          if (ids) onDrop(ids.split(',').filter(Boolean));
        },
      }
    : {};
  return (
    <button
      type="button"
      className={`nav-item${active ? ' is-active' : ''}${over ? ' is-drop' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      {...dropProps}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {shortcut && <span className="nav-kbd">{shortcut}</span>}
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

/**
 * Which panes are showing, for what the sidebar highlights. On a phone one page shows at a time
 * (mobileTab): Home or Tasks, or the note list, so only that page's item is highlighted. Wider, the
 * list and the main pane are side by side, so the list's filter is highlighted as well as Home or Tasks.
 */
function useShownPanes() {
  const isPhone = useMediaQuery('(max-width: 759px)');
  const tab = useApp((s) => s.mobileTab);
  return { main: !isPhone || tab === 'home', list: !isPhone || tab === 'notes' };
}

function FolderRow({
  folder,
  depth,
  childrenMap,
  counts,
}: {
  folder: Folder;
  depth: number;
  childrenMap: Map<string | null, Folder[]>;
  counts: Map<string, number>;
}) {
  const filter = useApp((s) => s.filter);
  const folders = useApp((s) => s.folders);
  const expanded = useSettings((s) => s.expandedFolders);
  const update = useSettings((s) => s.update);
  const [over, setOver] = useState(false);
  const kids = childrenMap.get(folder.id) ?? [];
  const isOpen = expanded.includes(folder.id);
  const shown = useShownPanes();
  const active = shown.list && filter.kind === 'folder' && filter.id === folder.id;

  const toggle = () =>
    update({ expandedFolders: isOpen ? expanded.filter((id) => id !== folder.id) : [...expanded, folder.id] });

  const moveTargets = (): MenuItem[] => {
    const banned = folderDescendants(folders, folder.id);
    const items: MenuItem[] = [
      { heading: 'Move folder to' },
      { label: 'Top level', icon: <Inbox size={15} />, checked: !folder.parent_id, onSelect: () => void moveFolder(folder, null) },
    ];
    const walk = (parent: string | null, d: number) => {
      for (const f of childrenMap.get(parent) ?? []) {
        if (banned.has(f.id)) continue;
        items.push({
          label: f.name,
          icon: <FolderIcon size={15} />,
          indent: d,
          checked: folder.parent_id === f.id,
          onSelect: () => void moveFolder(folder, f.id),
        });
        walk(f.id, d + 1);
      }
    };
    walk(null, 0);
    return items;
  };

  const menu = (): MenuItem[] => [
    { label: 'New note here', icon: <Plus size={15} />, onSelect: () => void createNote({ folder_id: folder.id }).catch(toastError) },
    {
      label: 'New subfolder',
      icon: <FolderPlus size={15} />,
      onSelect: async () => {
        const f = await createFolder(folder.id);
        if (f && !isOpen) toggle();
      },
    },
    { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => void renameFolder(folder) },
    { separator: true },
    ...moveTargets(),
    { separator: true },
    { label: 'Delete folder', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteFolder(folder) },
  ];

  return (
    <>
      <div
        className={`nav-row${active ? ' is-active' : ''}${over ? ' is-drop' : ''}`}
        style={{ paddingLeft: depth * 14 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(FOLDER_DRAG, folder.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          const t = e.dataTransfer.types;
          if (t.includes(NOTE_DRAG) || t.includes(FOLDER_DRAG)) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const noteIds = e.dataTransfer.getData(NOTE_DRAG);
          if (noteIds) {
            void moveDropped(noteIds, { folder_id: folder.id });
            return;
          }
          const folderId = e.dataTransfer.getData(FOLDER_DRAG);
          if (folderId && !folderDescendants(folders, folderId).has(folder.id)) {
            const f = folders.find((x) => x.id === folderId);
            if (f) void moveFolder(f, folder.id);
          }
        }}
      >
        <button
          type="button"
          className={`nav-item${active ? ' is-active' : ''}`}
          onClick={() => setFilter({ kind: 'folder', id: folder.id })}
          aria-current={active ? 'page' : undefined}
          aria-expanded={kids.length ? isOpen : undefined}
          // As in a file tree: Right arrow opens a folder's subfolders, Left arrow closes them.
          onKeyDown={(e) => {
            if (!kids.length || e.altKey || e.ctrlKey || e.metaKey) return;
            if ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) {
              e.preventDefault();
              toggle();
            }
          }}
        >
          {/* A mouse shortcut only: no control inside the folder's button, which opens and closes its
              subfolders from the keyboard (→ ←) and says so (aria-expanded). */}
          <span
            className={`nav-icon folder-toggle${kids.length ? ' has-kids' : ''}`}
            onClick={(e) => {
              if (!kids.length) return;
              e.stopPropagation();
              toggle();
            }}
          >
            <span className="folder-glyph">{active || isOpen ? <FolderOpen size={16} /> : <FolderIcon size={16} />}</span>
            {kids.length > 0 && <ChevronRight size={14} className={`folder-chevron${isOpen ? ' is-open' : ''}`} />}
          </span>
          <span className="nav-label">{folder.name}</span>
          {(counts.get(folder.id) ?? 0) > 0 && <span className="nav-count">{counts.get(folder.id)}</span>}
        </button>
        <MenuButton label={`${folder.name} options`} icon={<MoreHorizontal size={15} />} items={menu} className="nav-more" />
      </div>
      {isOpen &&
        kids.map((k) => <FolderRow key={k.id} folder={k} depth={depth + 1} childrenMap={childrenMap} counts={counts} />)}
    </>
  );
}

const UNSYNCED_REASON: Record<string, string> = {
  offline: 'Offline',
  error: 'Retrying',
  failed: 'Not saved',
  conflict: 'Choose a version',
};

/**
 * Notes whose edits haven't reached the server and won't on their own right now (offline, failing,
 * or changed elsewhere too), listed so they can be opened. Hidden while everything is synced.
 */
function UnsyncedMarker() {
  const unsynced = useUnsynced();
  const notes = useApp((s) => s.notes);
  if (!unsynced.length) return null;
  const n = unsynced.length;
  return (
    <MenuButton
      className="unsynced-btn"
      label={`${n} ${n === 1 ? 'note' : 'notes'} not synced`}
      icon={<CloudOff size={14} />}
      text={`${n} ${n === 1 ? 'note' : 'notes'} not synced`}
      align="start"
      items={() => [
        { heading: 'Saved on this device only' },
        ...unsynced.map((u) => ({
          label: noteTitle(notes[u.id]?.title),
          hint: UNSYNCED_REASON[u.status] ?? '',
          icon: <FileText size={15} />,
          onSelect: () => {
            useApp.setState({ drawerOpen: false });
            openNote(u.id);
          },
        })),
      ]}
    />
  );
}

export function Sidebar() {
  const folders = useApp((s) => s.folders);
  const notes = useApp((s) => s.notes);
  const filter = useApp((s) => s.filter);
  const me = useApp((s) => s.me);
  const screen = useApp((s) => s.screen);
  const noteId = useApp((s) => s.noteId);
  const shown = useShownPanes();
  const workspaceName = useSettings((s) => s.workspaceName);
  const tagsOpen = useSettings((s) => s.tagsOpen);
  const savedSearches = useSettings((s) => s.savedSearches);
  const [searchMenu, setSearchMenu] = useState<{ x: number; y: number; saved: SavedSearch } | null>(null);
  const update = useSettings((s) => s.update);
  const [foldersOpen, setFoldersOpen] = useState(true);
  // A tag's menu, from a right-click on it (or a long press).
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; tag: string } | null>(null);

  const { childrenMap, counts, tags, all, pinned, trash, openTasks } = useMemo(() => {
    const childrenMap = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const list = childrenMap.get(f.parent_id) ?? [];
      list.push(f);
      childrenMap.set(f.parent_id, list);
    }
    for (const list of childrenMap.values()) list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const ids = new Set(folders.map((f) => f.id));
    const orphans = folders.filter((f) => f.parent_id && !ids.has(f.parent_id));
    if (orphans.length) childrenMap.set(null, [...(childrenMap.get(null) ?? []), ...orphans]);

    const direct = new Map<string, number>();
    const tagCounts = new Map<string, { tag: string; count: number }>();
    let all = 0;
    let pinned = 0;
    let trash = 0;
    let openTasks = 0;
    for (const n of Object.values(notes)) {
      if (n.deleted_at) {
        trash++;
        continue;
      }
      all++;
      if (n.pinned) pinned++;
      if (n.info?.t && !isTemplate(n, folders)) openTasks += Math.max(0, n.info.t[1] - n.info.t[0]);
      if (n.folder_id) direct.set(n.folder_id, (direct.get(n.folder_id) ?? 0) + 1);
      for (const t of n.tags) {
        const key = t.toLowerCase();
        const cur = tagCounts.get(key);
        if (cur) cur.count++;
        else tagCounts.set(key, { tag: t, count: 1 });
      }
    }
    // A folder's count includes the notes in its subfolders, matching what opening it lists.
    const counts = new Map<string, number>();
    const total = (id: string, depth: number): number => {
      const known = counts.get(id);
      if (known !== undefined) return known;
      let n = direct.get(id) ?? 0;
      if (depth < 50) for (const child of childrenMap.get(id) ?? []) n += total(child.id, depth + 1);
      counts.set(id, n);
      return n;
    };
    for (const f of folders) total(f.id, 0);
    const tags = [...tagCounts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return { childrenMap, counts, tags, all, pinned, trash, openTasks };
  }, [folders, notes]);

  const roots = childrenMap.get(null) ?? [];

  return (
    <nav className="sidebar" aria-label="Library">
      <div className="sidebar-head">
        <div className="workspace">
          <BrandMark size={26} />
          <span className={`workspace-name ${wordmarkClass(workspaceName || APP_NAME)}`}>{workspaceName || APP_NAME}</span>
        </div>
        <IconButton
          label="Hide sidebar"
          shortcut={`${modKey()} \\`}
          size="sm"
          className="sidebar-collapse"
          onClick={() => update({ sidebarCollapsed: true })}
        >
          <PanelLeftClose size={16} />
        </IconButton>
        <IconButton label="Close menu" size="sm" className="drawer-close" onClick={() => useApp.setState({ drawerOpen: false })}>
          <X size={17} />
        </IconButton>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="search-trigger" onClick={() => useApp.setState({ paletteOpen: true, drawerOpen: false })}>
          <Search size={15} />
          <span>Search</span>
          <span className="search-kbd">
            <kbd>{modKey()}</kbd>
            <kbd>K</kbd>
          </span>
        </button>
        <div className="new-split">
          <button type="button" className="btn btn-primary new-main" onClick={() => void newNote()}>
            <Plus size={16} strokeWidth={2.25} /> New note
          </button>
          <MenuButton label="Create something else" icon={<ChevronDown size={16} />} items={newItems} align="end" className="btn btn-primary new-more" />
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="nav-group">
          <NavItem icon={<House size={16} />} label="Home" active={shown.main && screen === 'home' && !noteId} onClick={goHome} />
          <NavItem
            icon={<FileText size={16} />}
            label="All notes"
            count={all}
            active={shown.list && sameFilter(filter, { kind: 'all' })}
            onClick={() => setFilter({ kind: 'all' })}
            onDrop={(ids) => void updateNotesMeta(ids.map((id) => ({ id, patch: { folder_id: null } })))}
          />
          <NavItem
            icon={<Pin size={16} />}
            label="Pinned"
            count={pinned}
            active={shown.list && sameFilter(filter, { kind: 'pinned' })}
            onClick={() => setFilter({ kind: 'pinned' })}
            onDrop={(ids) => void updateNotesMeta(ids.map((id) => ({ id, patch: { pinned: true } })))}
          />
          <NavItem
            icon={<ListTodo size={16} />}
            label="Tasks"
            count={openTasks}
            active={shown.main && screen === 'tasks' && !noteId}
            onClick={showTasks}
          />
          <NavItem icon={<CalendarDays size={16} />} label="Today’s journal" onClick={() => void openDailyNote()} />
        </div>

        <section className="nav-section" aria-label="Folders">
          <div className="section-head">
            <button type="button" className="section-toggle" aria-expanded={foldersOpen} onClick={() => setFoldersOpen(!foldersOpen)}>
              Folders
              <ChevronRight size={13} className={foldersOpen ? 'is-open' : ''} />
            </button>
            <IconButton label="New folder" size="sm" onClick={() => void createFolder(null)}>
              <Plus size={15} />
            </IconButton>
          </div>
          {foldersOpen && (
            <>
              {roots.length === 0 && (
                <button type="button" className="nav-placeholder" onClick={() => void createFolder(null)}>
                  <FolderPlus size={15} /> Create a folder
                </button>
              )}
              {roots.map((f) => (
                <FolderRow key={f.id} folder={f} depth={0} childrenMap={childrenMap} counts={counts} />
              ))}
            </>
          )}
        </section>

        {savedSearches.length > 0 && (
          <section className="nav-section" aria-label="Saved searches">
            <div className="section-head">
              <span className="section-label">Saved searches</span>
            </div>
            <div className="nav-group">
              {savedSearches.map((saved) => (
                <div
                  key={saved.id}
                  className="nav-row"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSearchMenu({ x: e.clientX, y: e.clientY, saved });
                  }}
                >
                  <NavItem
                    icon={<SearchCode size={16} />}
                    label={saved.name}
                    active={shown.list && sameFilter(filter, { kind: 'search', id: saved.id })}
                    onClick={() => setFilter({ kind: 'search', id: saved.id })}
                  />
                  <MenuButton
                    label={`${saved.name} options`}
                    className="nav-more"
                    icon={<MoreHorizontal size={15} />}
                    items={() => savedSearchMenuItems(saved)}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {tags.length > 0 && (
          <section className="nav-section" aria-label="Tags">
            <div className="section-head">
              <button type="button" className="section-toggle" aria-expanded={tagsOpen} onClick={() => update({ tagsOpen: !tagsOpen })}>
                Tags
                <ChevronRight size={13} className={tagsOpen ? 'is-open' : ''} />
              </button>
            </div>
            {tagsOpen && (
              <div className="tag-cloud">
                {tags.map(({ tag, count }) => {
                  const active = shown.list && sameFilter(filter, { kind: 'tag', tag });
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`tag-pill${active ? ' is-active' : ''}`}
                      onClick={() => setFilter({ kind: 'tag', tag })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setTagMenu({ x: e.clientX, y: e.clientY, tag });
                      }}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Hash size={11} aria-hidden="true" />
                      {tag}
                      <span className="tag-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      <div className="sidebar-foot">
        <UnsyncedMarker />
        <NavItem
          icon={<Trash2 size={16} />}
          label="Trash"
          count={trash}
          active={shown.list && sameFilter(filter, { kind: 'trash' })}
          onClick={() => setFilter({ kind: 'trash' })}
        />
        <button type="button" className="profile" onClick={() => useApp.setState({ settingsOpen: true, drawerOpen: false })}>
          <span className="avatar" aria-hidden="true">
            {initialOf(me?.email ?? workspaceName)}
          </span>
          <span className="profile-text">
            <span className="profile-name">{me?.email ?? 'Local workspace'}</span>
            <span className="profile-sub">{me?.verified ? 'Signed in with Cloudflare Access' : 'Settings and backup'}</span>
          </span>
          <Settings size={16} className="profile-gear" />
        </button>
      </div>
      {tagMenu && <MenuPopover anchor={{ x: tagMenu.x, y: tagMenu.y }} items={tagMenuItems(tagMenu.tag)} onClose={() => setTagMenu(null)} />}
      {searchMenu && (
        <MenuPopover anchor={{ x: searchMenu.x, y: searchMenu.y }} items={savedSearchMenuItems(searchMenu.saved)} onClose={() => setSearchMenu(null)} />
      )}
    </nav>
  );
}

/** What can be done to a saved search: from its menu in the sidebar or in its list. */
export function savedSearchMenuItems(saved: SavedSearch): MenuItem[] {
  return [
    { heading: saved.query },
    { label: 'Rename…', icon: <Pencil size={15} />, onSelect: () => void renameSavedSearch(saved.id) },
    { label: 'Change what it finds…', icon: <Search size={15} />, onSelect: () => void editSavedSearch(saved.id) },
    { label: 'Delete saved search', icon: <Trash2 size={15} />, danger: true, onSelect: () => deleteSavedSearch(saved.id) },
  ];
}

/** What can be done to a tag across every note: from its menu in the sidebar or in its list. */
export function tagMenuItems(tag: string): MenuItem[] {
  return [
    { heading: `#${tag}` },
    { label: 'Rename or merge…', icon: <Pencil size={15} />, onSelect: () => void promptRenameTag(tag) },
    { label: 'Remove from all notes', icon: <Trash2 size={15} />, danger: true, onSelect: () => void removeTag(tag) },
  ];
}
