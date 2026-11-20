import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarClock, Check, CircleCheck, FileText, Folder as FolderIcon, ListTodo, PanelLeftOpen, Repeat } from 'lucide-react';
import { changeNoteText, knownText } from '../lib/liveEdit';
import { isTemplate } from '../lib/journal';
import { libraryDocs, syncLibrary } from '../lib/library';
import { useMediaQuery, useSettings } from '../lib/settings';
import { goHome, openNote, toast, useApp } from '../lib/store';
import { dueLabel, parseTasks, toggleTaskIn, type Task } from '../lib/tasks';
import type { NoteMeta } from '../lib/types';
import { modKey, noteTitle, todayIso } from '../lib/utils';
import { IconButton, Segmented, Spinner } from './ui';

interface Item {
  note: NoteMeta;
  task: Task;
  key: string;
}

/** Parsed tasks per note, kept while the note's text is the same string. */
const parsed = new Map<string, { text: string; tasks: Task[] }>();

function tasksOf(id: string, text: string): Task[] {
  const hit = parsed.get(id);
  if (hit && hit.text === text) return hit.tasks;
  // Most notes have no tasks at all: skip splitting them into lines.
  const tasks = /\[[ xX]\]/.test(text) ? parseTasks(text) : [];
  parsed.set(id, { text, tasks });
  return tasks;
}

/** When a task was ticked: "today", "yesterday", or the date ("Nov 3"). */
const doneLabel = (on: string, today: string) => {
  const label = dueLabel(on, today);
  return label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label;
};

const itemKey = (noteId: string, t: Pick<Task, 'line' | 'text'>) => `${noteId}\u0000${t.line}\u0000${t.text}`;

function TaskRow({ item, showNote, today, onToggle }: { item: Item; showNote: boolean; today: string; onToggle: (item: Item) => void }) {
  const { task, note } = item;
  const overdue = !task.done && !!task.due && task.due < today;
  return (
    <li className={`task-row${task.done ? ' is-done' : ''}`} style={{ paddingLeft: 14 + task.depth * 22 }}>
      <input
        type="checkbox"
        className="task-box"
        checked={task.done}
        onChange={() => onToggle(item)}
        aria-label={`${task.done ? 'Mark not done' : 'Mark done'}: ${task.text || 'Untitled task'}`}
      />
      <span className="task-body">
        <button type="button" className="task-text" onClick={() => openNote(note.id, { hash: `#L${task.line}` })}>
          {task.text || <span className="task-empty">Untitled task</span>}
        </button>
        {(task.due || showNote || task.repeat || (task.done && task.doneOn)) && (
          <span className="task-meta">
            {task.due && (
              <span className={`task-due${overdue ? ' is-overdue' : task.due === today ? ' is-today' : ''}`}>
                <CalendarClock size={12} aria-hidden="true" /> {dueLabel(task.due, today)}
              </span>
            )}
            {task.repeat && (
              <span className="task-repeat">
                <Repeat size={12} aria-hidden="true" /> {task.repeat[0].toUpperCase() + task.repeat.slice(1)}
              </span>
            )}
            {task.done && task.doneOn && (
              <span className="task-done-on">
                <Check size={12} aria-hidden="true" /> Done {doneLabel(task.doneOn, today)}
              </span>
            )}
            {showNote && (
              <button type="button" className="task-note" onClick={() => openNote(note.id, { hash: `#L${task.line}` })}>
                <FileText size={12} aria-hidden="true" /> {noteTitle(note.title)}
              </button>
            )}
          </span>
        )}
      </span>
    </li>
  );
}

export function TasksView() {
  const notes = useApp((s) => s.notes);
  const folders = useApp((s) => s.folders);
  const status = useApp((s) => s.status);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const updateSettings = useSettings((s) => s.update);
  const isPhone = useMediaQuery('(max-width: 759px)');
  const [mode, setMode] = useState<'open' | 'all'>('open');
  const [synced, setSynced] = useState(false);
  const [rev, setRev] = useState(0);
  // Ticked here: still shown (struck through) until the view is left, so a slip is easy to undo.
  const [justDone, setJustDone] = useState<Set<string>>(() => new Set());
  // Drawn again when the date moves on (what's due today, and what's overdue, change at midnight).
  useApp((s) => s.day);
  const today = todayIso();

  // Every note's text, kept in step with the note list (other devices' edits included).
  useEffect(() => {
    if (status !== 'ready') return;
    let live = true;
    void syncLibrary()
      .catch(() => undefined)
      .finally(() => {
        if (!live) return;
        setSynced(true);
        setRev((r) => r + 1);
      });
    return () => {
      live = false;
    };
  }, [notes, status]);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);

  const { dated, byNote, openCount, overdueCount, unread } = useMemo(() => {
    const docs = libraryDocs();
    const dated: Item[] = [];
    const byNote: Array<{ note: NoteMeta; items: Item[] }> = [];
    let openCount = 0;
    let overdueCount = 0;
    let unread = 0;
    const live = Object.values(notes)
      // Templates hold tasks for the notes made from them, not tasks of their own.
      .filter((n) => !n.deleted_at && !isTemplate(n, folders))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
    for (const note of live) {
      const text = knownText(note.id)?.content;
      if (text === undefined) {
        // Not read yet (offline, or still loading): counted if its preview says it has tasks.
        if (note.info?.t && note.info.t[1] > 0 && !docs.has(note.id)) unread++;
        continue;
      }
      const items: Item[] = [];
      for (const task of tasksOf(note.id, text)) {
        const key = itemKey(note.id, task);
        if (!task.done) {
          openCount++;
          if (task.due && task.due < today) overdueCount++;
        }
        const shown = mode === 'all' || !task.done || justDone.has(key);
        if (!shown) continue;
        const item = { note, task, key };
        if (task.due && (!task.done || justDone.has(key))) dated.push(item);
        else items.push(item);
      }
      if (items.length) byNote.push({ note, items });
    }
    dated.sort((a, b) => a.task.due!.localeCompare(b.task.due!) || a.note.title.localeCompare(b.note.title) || a.task.line - b.task.line);
    return { dated, byNote, openCount, overdueCount, unread };
    // `rev` stands for the texts (the on-device copy and unsent edits), which aren't React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, folders, mode, justDone, rev, today]);

  const toggle = (item: Item) => {
    const done = !item.task.done;
    let missing = false;
    const changed = changeNoteText(item.note.id, (src) => {
      const next = toggleTaskIn(src, item.task, done, todayIso(), useSettings.getState().taskDoneDates);
      if (next === null) missing = true;
      return next ?? src;
    });
    if (!changed || missing) {
      toast('That task has changed since this list was made. Open the note to see it.', {
        kind: 'error',
        action: { label: 'Open', run: () => openNote(item.note.id) },
      });
      setRev((r) => r + 1);
      return;
    }
    // A repeating task ticked has its next one added above it, so it's now a line further down.
    const key = done && item.task.repeat ? itemKey(item.note.id, { line: item.task.line + 1, text: item.task.text }) : item.key;
    setJustDone((prev) => {
      const next = new Set(prev);
      if (done) next.add(key);
      else next.delete(key);
      return next;
    });
    setRev((r) => r + 1);
  };

  const overdue = dated.filter((i) => i.task.due! < today);
  const dueToday = dated.filter((i) => i.task.due === today);
  const upcoming = dated.filter((i) => i.task.due! > today);
  const loading = status !== 'ready' || (!synced && openCount === 0 && byNote.length === 0);

  const section = (title: string, items: Item[], tone?: string) =>
    items.length > 0 && (
      <section className="home-section" aria-label={title}>
        <div className="home-section-head">
          <h2 className={tone ? `tasks-head ${tone}` : 'tasks-head'}>
            {title} <span className="tasks-count">{items.length}</span>
          </h2>
        </div>
        <ul className="task-list">
          {items.map((item) => (
            <TaskRow key={item.key} item={item} showNote today={today} onToggle={toggle} />
          ))}
        </ul>
      </section>
    );

  return (
    <section className="note-pane home tasks" aria-label="Tasks">
      <header className="pane-header home-header">
        {isPhone && (
          <IconButton label="Back" onClick={goHome}>
            <ArrowLeft size={19} />
          </IconButton>
        )}
        {!isPhone && sidebarCollapsed && (
          <IconButton label="Show sidebar" shortcut={`${modKey()} \\`} className="sidebar-open-btn" onClick={() => updateSettings({ sidebarCollapsed: false })}>
            <PanelLeftOpen size={17} />
          </IconButton>
        )}
        <span className="spacer" />
        <Segmented
          label="Show"
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
      </header>

      <div className="home-scroll">
        <div className="home-inner">
          <div className="home-hero">
            <h1 className="home-greeting">Tasks</h1>
            {!loading && (
              <p className="home-summary">
                {openCount === 0
                  ? 'No open tasks.'
                  : `${openCount} open ${openCount === 1 ? 'task' : 'tasks'}${overdueCount ? `, ${overdueCount} overdue` : ''}.`}
                {/* How to give a task a date, until one has. */}
                {openCount > 0 && dated.length === 0 && ' Give a task a due date by adding “due:2026-11-20” after it, or type /due.'}
              </p>
            )}
          </div>

          {loading ? (
            <div className="tasks-loading">
              <Spinner label="Reading your notes" />
            </div>
          ) : (
            <>
              {section('Overdue', overdue, 'is-overdue')}
              {section('Today', dueToday, 'is-today')}
              {section('Upcoming', upcoming)}
              {byNote.map(({ note, items }) => (
                <section key={note.id} className="home-section" aria-label={noteTitle(note.title)}>
                  <div className="home-section-head">
                    <button type="button" className="tasks-note-head" onClick={() => openNote(note.id)}>
                      <FileText size={14} aria-hidden="true" />
                      <span>{noteTitle(note.title)}</span>
                    </button>
                    {note.folder_id && folderName.get(note.folder_id) && (
                      <span className="recent-folder tasks-folder">
                        <FolderIcon size={11} /> {folderName.get(note.folder_id)}
                      </span>
                    )}
                  </div>
                  <ul className="task-list">
                    {items.map((item) => (
                      <TaskRow key={item.key} item={item} showNote={false} today={today} onToggle={toggle} />
                    ))}
                  </ul>
                </section>
              ))}
              {openCount === 0 && dated.length === 0 && byNote.length === 0 && (
                <div className="home-empty tasks-empty">
                  <CircleCheck size={20} aria-hidden="true" />
                  <p>
                    {mode === 'open' ? 'Nothing left to do.' : 'No tasks yet.'} Start a line with “- [ ]” in any note, or type “/task”, and it
                    shows up here.
                  </p>
                </div>
              )}
              {unread > 0 && (
                <p className="tasks-unread">
                  <ListTodo size={14} aria-hidden="true" /> {unread} {unread === 1 ? 'note with tasks couldn’t' : 'notes with tasks couldn’t'} be read right
                  now. They appear once Lumen can reach them.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
