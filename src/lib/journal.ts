/**
 * Templates and the journal.
 *
 * - Templates are the notes in a top-level folder named "Templates" (and its subfolders). A new note
 *   from one gets its text with the placeholders filled in (templateText.ts); its title too, so a
 *   template titled "Meeting {{date}}" makes "Meeting 2026-11-17".
 * - Journal entries are notes titled with a date (YYYY-MM-DD) and tagged #journal. They're found by
 *   that, not by their folder's name: new ones go where the latest one is (a folder named "Journal" at
 *   first), so renaming or moving that folder doesn't start the journal over.
 * - A template titled "Journal" is the one new entries are made from; otherwise a short default.
 */
import { api } from './api';
import { changeNoteText, knownText } from './liveEdit';
import { createNote, folderDescendants, loadAll, noteCache, openNote, toastError, useApp } from './store';
import { DEFAULT_JOURNAL, fillTemplate, isoDate, parseIsoDate } from './templateText';
import type { Folder, NoteMeta } from './types';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isTag = (t: string, name: string) => t.toLowerCase() === name;

/* ------------------------------------------------------------ templates --- */

export function templatesFolder(folders: Folder[] = useApp.getState().folders): Folder | undefined {
  return folders.find((f) => !f.parent_id && f.name.trim().toLowerCase() === 'templates');
}

/** Whether a note is one of the templates (it then stays out of the Tasks view and task counts). */
export function isTemplate(note: NoteMeta, folders: Folder[] = useApp.getState().folders): boolean {
  const root = templatesFolder(folders);
  return !!root && !!note.folder_id && folderDescendants(folders, root.id).has(note.folder_id);
}

/** Every template, by title. */
export function templateNotes(): NoteMeta[] {
  const { notes, folders } = useApp.getState();
  return Object.values(notes)
    .filter((n) => !n.deleted_at && isTemplate(n, folders))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Templates to make new notes from: all but the journal's ("Today's journal" uses that one). */
export function newNoteTemplates(): NoteMeta[] {
  const journal = journalTemplate();
  return templateNotes().filter((t) => t !== journal);
}

/** A note's text: from this device's copy when it has one, otherwise from the server. */
async function textOf(id: string): Promise<string> {
  return knownText(id)?.content ?? (await api.getNote(id)).content;
}

const makingFolder = new Map<string, Promise<Folder>>();

/** `existing`, or a new top-level folder of that name: made once, however many ask at the same moment. */
async function ensureFolder(name: string, existing: Folder | undefined): Promise<Folder> {
  if (existing) return existing;
  let job = makingFolder.get(name);
  if (!job) {
    job = (async () => {
      const folder = await api.createFolder({ name });
      useApp.setState((s) => ({ folders: [...s.folders, folder] }));
      return folder;
    })().finally(() => makingFolder.delete(name));
    makingFolder.set(name, job);
  }
  return job;
}

/** A new note from a template, in the folder being viewed (not the templates' own), opened to edit. */
export async function newFromTemplate(id: string) {
  try {
    const s = useApp.getState();
    const template = s.notes[id];
    if (!template) return;
    const now = new Date();
    const title = fillTemplate(template.title, { date: now }).trim();
    const content = fillTemplate(await textOf(id), { date: now, title });
    const root = templatesFolder(s.folders);
    const viewing = s.filter.kind === 'folder' ? s.filter.id : null;
    const inTemplates = !!root && !!viewing && folderDescendants(s.folders, root.id).has(viewing);
    await createNote(
      { title, content, folder_id: inTemplates ? null : viewing, tags: template.tags.filter((t) => !isTag(t, 'template')), pinned: false },
      { mode: 'edit' },
    );
  } catch (err) {
    toastError(err);
  }
}

/** A template's text, filled in for the note `title` it goes into (the editor's /template). */
export async function filledTemplate(id: string, title: string): Promise<string> {
  return fillTemplate(await textOf(id), { date: new Date(), title });
}

/** A new, empty template in the Templates folder (made if there isn't one), opened to edit. */
export async function newTemplate() {
  try {
    const folder = await ensureFolder('Templates', templatesFolder());
    await createNote({ title: '', content: '', folder_id: folder.id, tags: [], pinned: false }, { mode: 'edit' });
  } catch (err) {
    toastError(err);
  }
}

/* -------------------------------------------------------------- journal --- */

/** The template new journal entries are made from: the one titled "Journal", else one titled "Daily". */
export function journalTemplate(): NoteMeta | undefined {
  const templates = templateNotes();
  return templates.find((n) => /^journal$/i.test(n.title.trim())) ?? templates.find((n) => /^daily$/i.test(n.title.trim()));
}

/**
 * Where the latest entry is: its folder's id, or null at the top level; undefined when there's no
 * entry yet (or its folder is gone).
 */
function latestEntryFolder(): string | null | undefined {
  const { notes, folders } = useApp.getState();
  const tagged = Object.values(notes)
    .filter((n) => !n.deleted_at && ISO.test(n.title.trim()) && n.tags.some((t) => isTag(t, 'journal')) && !isTemplate(n, folders))
    .sort((a, b) => b.title.localeCompare(a.title));
  if (!tagged.length) return undefined;
  const folderId = tagged[0].folder_id;
  if (!folderId) return null;
  return folders.some((f) => f.id === folderId) ? folderId : undefined;
}

/** Where new entries go: beside the latest one (the top level too), else a top-level "Journal" folder, else nowhere yet. */
export function journalFolderId(): string | null {
  const latest = latestEntryFolder();
  if (latest !== undefined) return latest;
  return useApp.getState().folders.find((f) => !f.parent_id && f.name.trim().toLowerCase() === 'journal')?.id ?? null;
}

export function isJournalEntry(note: NoteMeta, folderId: string | null = journalFolderId()): boolean {
  if (note.deleted_at || !ISO.test(note.title.trim())) return false;
  return note.tags.some((t) => isTag(t, 'journal')) || (!!folderId && note.folder_id === folderId);
}

/** Every journal entry by its date (the most recently edited one, if a date has two). */
export function journalEntries(): Map<string, NoteMeta> {
  const folderId = journalFolderId();
  const out = new Map<string, NoteMeta>();
  for (const n of Object.values(useApp.getState().notes)) {
    if (!isJournalEntry(n, folderId)) continue;
    const date = n.title.trim();
    const had = out.get(date);
    if (!had || n.updated_at > had.updated_at) out.set(date, n);
  }
  return out;
}

/**
 * The entry for `date`, if there is one. Checked against a fresh note list when this one could be
 * missing it: still loading, or not refreshed for a while (a tab left open since the phone made today's).
 */
async function findEntry(date: string): Promise<string | null> {
  if (useApp.getState().status !== 'ready') await loadAll();
  let found = journalEntries().get(date);
  if (!found && Date.now() - useApp.getState().lastSync > 10_000) {
    await loadAll(true);
    found = journalEntries().get(date);
  }
  return found?.id ?? null;
}

const makingEntry = new Map<string, Promise<{ id: string; made: boolean }>>();

/**
 * The entry for `date`, made (from the journal template, through `start`) if there isn't one: once,
 * however many ask at the same moment (a double tap, a capture while the shortcut opens it). `made`
 * says whether this call made it.
 */
function ensureEntry(date: string, start: (text: string) => string, open: boolean): Promise<{ id: string; made: boolean }> {
  const running = makingEntry.get(date);
  if (running) return running.then(({ id }) => ({ id, made: false }));
  const job = (async () => {
    const found = await findEntry(date);
    if (found) return { id: found, made: false };
    let folderId = journalFolderId();
    // The first entry (none to sit beside) starts a "Journal" folder; one kept at the top level stays there.
    if (!folderId && latestEntryFolder() === undefined) folderId = (await ensureFolder('Journal', undefined)).id;
    const template = journalTemplate();
    const day = parseIsoDate(date, new Date()) ?? new Date();
    const text = fillTemplate(template ? await textOf(template.id) : DEFAULT_JOURNAL, { date: day, title: date });
    const meta = await createNote({ title: date, folder_id: folderId, tags: ['journal'], pinned: false, content: start(text) }, { open, mode: 'edit' });
    return { id: meta.id, made: true };
  })().finally(() => makingEntry.delete(date));
  makingEntry.set(date, job);
  return job;
}

/** Opens the journal entry for `date` (YYYY-MM-DD), making it from the journal template if there isn't one. */
export async function openJournal(date: string) {
  try {
    const { id, made } = await ensureEntry(date, (text) => text, true);
    if (!made) openNote(id);
  } catch (err) {
    toastError(err);
  }
}

/**
 * What was typed into Home's quick capture, added to the end of today's journal entry (made from the
 * template if there isn't one yet) with the time in front; a task or list item goes in as it is, so it
 * stays one. Returns the entry's id, or null if it couldn't be saved.
 */
export async function captureToJournal(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const block = /^([-*+]|\d+[.)])\s/.test(trimmed) ? trimmed : `**${time}** ${trimmed}`;
  const append = (src: string) => `${src.replace(/\s+$/, '')}${src.trim() ? '\n\n' : ''}${block}\n`;
  try {
    // Made with this capture in it, or (already there, or being made by another call) added to.
    const { id, made } = await ensureEntry(isoDate(now), append, false);
    if (made) return id;
    // The entry's text, from the server if this device hasn't loaded it yet.
    if (!knownText(id)) noteCache.set(id, await api.getNote(id));
    if (!changeNoteText(id, append)) throw new Error('Couldn’t open today’s journal entry.');
    return id;
  } catch (err) {
    toastError(err);
    return null;
  }
}

/** Opens the journal template, making it (from the default) if there isn't one yet. */
export async function editJournalTemplate() {
  try {
    const existing = journalTemplate();
    if (existing) {
      openNote(existing.id);
      return;
    }
    const folder = await ensureFolder('Templates', templatesFolder());
    await createNote({ title: 'Journal', content: DEFAULT_JOURNAL, folder_id: folder.id, tags: [], pinned: false }, { mode: 'edit' });
  } catch (err) {
    toastError(err);
  }
}
