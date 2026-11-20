import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CircleCheck,
  FileText,
  Folder as FolderIcon,
  HardDriveDownload,
  PanelLeftOpen,
  PenTool,
  Search,
  Settings,
  Workflow,
} from 'lucide-react';
import { useSettings } from '../lib/settings';
import {
  captureNote,
  newDiagramNote,
  newDrawingNote,
  newNote,
  openDailyNote,
  openNote,
  openTasks as openTasksView,
  setFilter,
  toast,
  useApp,
} from '../lib/store';
import { captureToJournal, isTemplate } from '../lib/journal';
import type { NoteMeta } from '../lib/types';
import { greeting, modKey, noteTitle, shortTime } from '../lib/utils';
import { APP_NAME, BrandMark, wordmarkClass } from './Sidebar';
import { AssetImg } from './AssetImg';
import { IconButton, Segmented, Skeleton } from './ui';

const CAPTURE_KEY = 'kb.capture';

function QuickAction({
  icon,
  title,
  desc,
  tone,
  onClick,
  kbd,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  tone: string;
  onClick: () => void;
  kbd?: string;
}) {
  return (
    <button type="button" className={`quick quick-${tone}`} onClick={onClick}>
      <span className="quick-icon">{icon}</span>
      <span className="quick-text">
        <span className="quick-title">{title}</span>
        <span className="quick-desc">{desc}</span>
      </span>
      {kbd && <kbd className="quick-kbd">{kbd}</kbd>}
    </button>
  );
}

function NoteCard({ note, folder }: { note: NoteMeta; folder?: string }) {
  const thumb = note.info?.th;
  return (
    <a
      className={`card${thumb ? ' has-cover' : ''}`}
      href={`/note/${note.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        openNote(note.id);
      }}
    >
      {thumb && (
        <span className={`card-cover${thumb.startsWith('/api/drawings/') ? ' is-drawing' : ''}`}>
          <AssetImg src={thumb} alt="" loading="lazy" />
        </span>
      )}
      <span className="card-body">
        <span className="card-title">{noteTitle(note.title)}</span>
        {!thumb && <span className="card-excerpt">{note.excerpt || 'No additional text'}</span>}
        <span className="card-meta">
          <span>{shortTime(note.updated_at)}</span>
          {folder && (
            <span className="card-folder">
              <FolderIcon size={11} /> {folder}
            </span>
          )}
          {note.info?.t && (
            <span className="card-folder">
              <CircleCheck size={11} /> {note.info.t[0]}/{note.info.t[1]}
            </span>
          )}
        </span>
      </span>
    </a>
  );
}

const BACKUP_SNOOZE = 'kb.backup.snooze';
const DAY = 86_400_000;

/**
 * A reminder to download a backup when there's never been one, or the last was over a month ago (on any
 * device). "Later" puts it off for a week on this device.
 */
function BackupNudge({ total }: { total: number }) {
  const lastBackup = useApp((s) => s.lastBackup);
  const encrypted = useApp((s) => s.encryption.on);
  const [snoozed, setSnoozed] = useState(() => {
    try {
      return Number(localStorage.getItem(BACKUP_SNOOZE) || 0) > Date.now();
    } catch {
      return false;
    }
  });
  if (snoozed || total < 3) return null;
  if (lastBackup && Date.now() - lastBackup < 30 * DAY) return null;
  const days = lastBackup ? Math.floor((Date.now() - lastBackup) / DAY) : null;
  const later = () => {
    try {
      localStorage.setItem(BACKUP_SNOOZE, String(Date.now() + 7 * DAY));
    } catch {
      /* shown again next time */
    }
    setSnoozed(true);
  };
  return (
    <div className="backup-nudge" role="status">
      <span className="backup-nudge-icon" aria-hidden="true">
        <HardDriveDownload size={18} />
      </span>
      <span className="backup-nudge-text">
        <strong>{days === null ? 'You haven’t backed up your notes yet' : `Your last backup was ${days} days ago`}</strong>
        <span>
          A backup is your own copy of everything, in case something goes wrong.{encrypted ? ' It’s encrypted, and takes a minute.' : ' It takes a minute.'}
        </span>
      </span>
      <span className="backup-nudge-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={later}>
          Later
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => useApp.setState({ settingsOpen: true, settingsSection: 'data' })}>
          Back up now
        </button>
      </span>
    </div>
  );
}

export function Home() {
  const notes = useApp((s) => s.notes);
  const folders = useApp((s) => s.folders);
  const status = useApp((s) => s.status);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const workspaceName = useSettings((s) => s.workspaceName);
  const updateSettings = useSettings((s) => s.update);
  const captureTo = useSettings((s) => s.captureTo);
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(CAPTURE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [saving, setSaving] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // The date and greeting as of each redraw, and Home redraws once a minute and when it comes back into
  // view: an installed app left open overnight shows today, not yesterday's "Good evening".
  const now = new Date();
  const [, redraw] = useState(0);
  useEffect(() => {
    const tick = () => redraw((n) => n + 1);
    const timer = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    try {
      if (draft) localStorage.setItem(CAPTURE_KEY, draft);
      else localStorage.removeItem(CAPTURE_KEY);
    } catch {
      /* ignore */
    }
  }, [draft]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft]);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const { pinned, recent, openTasks, taskNotes, total } = useMemo(() => {
    const live = Object.values(notes).filter((n) => !n.deleted_at);
    const byRecent = live.slice().sort((a, b) => b.updated_at - a.updated_at);
    let openTasks = 0;
    let taskNotes = 0;
    for (const n of live) {
      if (n.info?.t && n.info.t[0] < n.info.t[1] && !isTemplate(n, folders)) {
        openTasks += n.info.t[1] - n.info.t[0];
        taskNotes++;
      }
    }
    return {
      pinned: byRecent.filter((n) => n.pinned).slice(0, 6),
      // Pinned notes already have their own cards above.
      recent: byRecent.filter((n) => !n.pinned).slice(0, 8),
      openTasks,
      taskNotes,
      total: live.length,
    };
  }, [notes, folders]);

  const save = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    let ok: boolean;
    if (captureTo === 'journal') {
      const id = await captureToJournal(draft);
      ok = !!id;
      if (id) toast('Added to today’s journal', { kind: 'success', action: { label: 'Open', run: () => openNote(id) } });
    } else {
      ok = await captureNote(draft);
    }
    setSaving(false);
    if (ok) setDraft('');
  };

  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <section className="note-pane home" aria-label="Home">
      <header className="pane-header home-header">
        {sidebarCollapsed && (
          <IconButton label="Show sidebar" shortcut={`${modKey()} \\`} className="sidebar-open-btn" onClick={() => updateSettings({ sidebarCollapsed: false })}>
            <PanelLeftOpen size={17} />
          </IconButton>
        )}
        <div className="home-brand">
          <BrandMark size={24} />
          <span className={wordmarkClass(workspaceName || APP_NAME)}>{workspaceName || APP_NAME}</span>
        </div>
        <span className="spacer" />
        <IconButton label="Search" className="home-mobile-only" onClick={() => useApp.setState({ paletteOpen: true })}>
          <Search size={18} />
        </IconButton>
        <IconButton label="Settings" className="home-mobile-only" onClick={() => useApp.setState({ settingsOpen: true })}>
          <Settings size={18} />
        </IconButton>
      </header>

      <div className="home-scroll">
        <div className="home-inner">
          <div className="home-hero">
            <p className="home-date">{dateLabel}</p>
            <h1 className="home-greeting">{greeting(now)}</h1>
            {status === 'loading' && (
              // Its line, held until the notes are in, so nothing below moves when the summary arrives.
              <p className="home-summary is-pending" aria-hidden="true">
                {' '}
                <Skeleton width="18em" height={12} />
              </p>
            )}
            {status === 'ready' && (
              <p className="home-summary">
                {total === 0 ? (
                  'Nothing here yet. Capture a first thought below.'
                ) : openTasks > 0 ? (
                  <>
                    {total} {total === 1 ? 'note' : 'notes'}, with{' '}
                    <button type="button" className="link-btn home-tasks-link" onClick={openTasksView}>
                      {openTasks} open {openTasks === 1 ? 'task' : 'tasks'}
                    </button>{' '}
                    across {taskNotes} {taskNotes === 1 ? 'note' : 'notes'}.
                  </>
                ) : (
                  `${total} ${total === 1 ? 'note' : 'notes'}, and no open tasks.`
                )}
              </p>
            )}
          </div>

          <form
            className="capture"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <textarea
              ref={areaRef}
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder="Capture a thought, a link or a to-do…"
              aria-label="Quick capture"
              name="quick-capture"
            />
            <div className="capture-bar">
              <Segmented
                size="sm"
                label="Save to"
                value={captureTo}
                onChange={(v) => updateSettings({ captureTo: v })}
                options={[
                  { value: 'note', label: 'New note' },
                  { value: 'journal', label: 'Journal' },
                ]}
              />
              <span className="capture-hint">
                {captureTo === 'journal' ? 'Added to today’s entry, with the time.' : 'The first line becomes the title.'}
              </span>
              <span className="spacer" />
              <span className="capture-keys" aria-hidden="true">
                <kbd>{modKey()}</kbd>
                <kbd>Enter</kbd>
              </span>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim() || saving}>
                {captureTo === 'journal' ? 'Add' : 'Save note'}
              </button>
            </div>
          </form>

          <div className="quick-grid">
            <QuickAction icon={<FileText size={18} />} title="New note" desc="Start from a blank page" tone="accent" kbd="Alt N" onClick={() => void newNote()} />
            <QuickAction icon={<PenTool size={18} />} title="Drawing" desc="Sketch on a whiteboard" tone="rose" onClick={() => void newDrawingNote()} />
            <QuickAction icon={<Workflow size={18} />} title="Diagram" desc="Flowcharts and more" tone="teal" onClick={() => void newDiagramNote()} />
            <QuickAction icon={<CalendarDays size={18} />} title="Journal" desc="Today’s entry" tone="amber" onClick={() => void openDailyNote()} />
          </div>

          {status === 'ready' && <BackupNudge total={total} />}

          {status === 'loading' ? (
            // Placeholder rows until the notes are in, replaced whole by the sections below rather than
            // filled in: a Pinned section arriving above them would push them down the page.
            <div className="home-section home-loading" aria-hidden="true">
              <div className="home-section-head">
                <Skeleton width={128} height={14} />
              </div>
              <div className="recent-list">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="recent-skel">
                    <Skeleton width={36} height={36} radius={9} />
                    <span>
                      <Skeleton width="40%" height={12} />
                      <Skeleton width="75%" height={10} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {pinned.length > 0 && (
                <section className="home-section" aria-label="Pinned">
                  <div className="home-section-head">
                    <h2>Pinned</h2>
                    <button type="button" className="link-btn" onClick={() => setFilter({ kind: 'pinned' })}>
                      Show all
                    </button>
                  </div>
                  <div className="card-grid">
                    {pinned.map((n) => (
                      <NoteCard key={n.id} note={n} folder={n.folder_id ? folderName.get(n.folder_id) : undefined} />
                    ))}
                  </div>
                </section>
              )}

              <section className="home-section" aria-label="Recently edited">
                <div className="home-section-head">
                  <h2>Recently edited</h2>
                  {recent.length > 0 && (
                    <button type="button" className="link-btn" onClick={() => setFilter({ kind: 'all' })}>
                      All notes
                    </button>
                  )}
                </div>
                {recent.length === 0 ? (
                  <p className="home-empty">
                    {pinned.length ? 'Your pinned notes are above. Other notes show up here as you edit them.' : 'Notes you edit show up here.'}
                  </p>
                ) : (
                  <div className="recent-list">
                    {recent.map((n) => (
                      <a
                        key={n.id}
                        href={`/note/${n.id}`}
                        className="recent"
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey) return;
                          e.preventDefault();
                          openNote(n.id);
                        }}
                      >
                        <span className={`recent-icon${n.info?.th ? ' has-thumb' : ''}${n.info?.th?.startsWith('/api/drawings/') ? ' is-drawing' : ''}`}>
                          {n.info?.th ? (
                            <AssetImg src={n.info.th} alt="" loading="lazy" />
                          ) : n.info?.d ? (
                            <Workflow size={16} />
                          ) : n.info?.dr ? (
                            <PenTool size={16} />
                          ) : (
                            <FileText size={16} />
                          )}
                        </span>
                        <span className="recent-text">
                          <span className="recent-title">{noteTitle(n.title)}</span>
                          <span className="recent-excerpt">
                            {n.folder_id && folderName.get(n.folder_id) && (
                              <span className="recent-folder">
                                <FolderIcon size={11} /> {folderName.get(n.folder_id)}
                              </span>
                            )}
                            <span className="recent-snippet">{n.excerpt || 'No additional text'}</span>
                          </span>
                        </span>
                        <time className="recent-time">{shortTime(n.updated_at)}</time>
                      </a>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
