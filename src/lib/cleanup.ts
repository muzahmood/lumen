/**
 * Settings → Data → Remove unused files: the uploads and drawings nothing links to.
 *
 * The server can't tell on its own (it can't read encrypted notes, and reading every note and every
 * saved version would take more of a Worker's time than it has), so this device reads them: every note
 * (the trash too), every saved version of every note (so restoring an older version never brings back
 * missing images), and the edits it hasn't sent yet. The server then offers only what none of them
 * link to, never anything added or changed in the last week, and deletes only what was agreed to.
 */
import { api, currentCodec } from './api';
import { confirmDialog, toast, toastError, type DialogRequest } from './store';
import { formatBytes } from './utils';

const LINK = /\/api\/(?:files|drawings)\/([A-Za-z0-9_-]{6,64})/g;

function linksIn(text: string, into: Set<string>) {
  for (const m of text.matchAll(LINK)) into.add(m[1]);
}

/** Edits this device hasn't sent yet (any tab's): they may link to a file the server's copy doesn't. */
function draftLinks(into: Set<string>) {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('kb.draft.')) linksIn(localStorage.getItem(k) ?? '', into);
    }
  } catch {
    /* no storage here: no drafts either */
  }
}

/** What every note links to (the trash too), and this device's unsent edits. */
async function noteLinks(): Promise<Set<string>> {
  const c = currentCodec();
  // Encrypted: from the copy of every note kept on this device, which also counts drafts and refuses
  // to answer when a note can't be read.
  if (c) return new Set(await c.referencedFiles());
  const ids = new Set<string>();
  for (let after = 0; ; ) {
    const page = await api.exportNotes(after);
    for (const n of page.notes) linksIn(n.content, ids);
    if (page.next === null) break;
    after = page.next;
  }
  draftLinks(ids);
  return ids;
}

/** What every saved version links to. Throws, removing nothing, when one can't be read. */
async function versionLinks(): Promise<Set<string>> {
  const c = currentCodec();
  const ids = new Set<string>();
  let unreadable = 0;
  for (let after = 0; ; ) {
    const page = await api.exportVersions(after);
    for (const v of page.versions) {
      // Readable as stored (a library not encrypted, or a version put there some other way): what it
      // links to counts all the same, so its files are kept.
      if (!v.enc) linksIn(v.content, ids);
      else if (!c) unreadable++;
      else {
        try {
          linksIn((await c.openVersion(v, v.note_id)).content, ids);
        } catch {
          unreadable++;
        }
      }
    }
    if (page.next === null) break;
    after = page.next;
  }
  if (unreadable) {
    throw new Error(
      `${unreadable === 1 ? 'A saved version of a note' : `${unreadable} saved versions of notes`} couldn’t be read, so Lumen can’t tell which files ${
        unreadable === 1 ? 'it uses' : 'they use'
      }. Nothing was removed.`,
    );
  }
  return ids;
}

export interface UnusedFiles {
  files: Array<{ id: string; name: string; size: number }>;
  drawings: Array<{ id: string; size: number }>;
  bytes: number;
  /** What saved versions linked to when this was worked out (they never change; new ones copy a note). */
  inVersions: string[];
}

/** What could be deleted, to show before asking. Nothing changes. */
export async function findUnusedFiles(): Promise<UnusedFiles> {
  const notes = await noteLinks();
  const versions = await versionLinks();
  const found = await api.cleanup({ dryRun: true, referenced: [...notes, ...versions] });
  return { files: found.files, drawings: found.drawings, bytes: found.bytes, inVersions: [...versions] };
}

/** The question before deleting what was found (Settings → Data, and after notes are deleted for good). */
export function unusedFilesQuestion(found: UnusedFiles): Omit<DialogRequest, 'kind' | 'resolve'> {
  const count = found.files.length + found.drawings.length;
  return {
    title: `Delete ${count} unused ${count === 1 ? 'file' : 'files'}?`,
    message: `This frees ${formatBytes(found.bytes)}. Nothing links to ${count === 1 ? 'it' : 'these'}: no note (including notes in the trash), no saved version of a note, and no edit waiting on this device. Files added in the last week are never included.`,
    confirmLabel: 'Delete files',
    danger: true,
  };
}

export const NOTHING_UNUSED = 'Every file is used by a note or one of its saved versions';

/**
 * The whole check, the question and the delete, with the outcome as a message: offered when notes are
 * deleted for good (their pictures, files and drawings stay in storage until nothing links to them).
 */
export async function removeUnusedFilesNow(): Promise<void> {
  try {
    const found = await findUnusedFiles();
    if (!found.files.length && !found.drawings.length) {
      toast(NOTHING_UNUSED, { kind: 'success' });
      return;
    }
    if (!(await confirmDialog(unusedFilesQuestion(found)))) return;
    const done = await deleteUnusedFiles(found);
    toast(`Freed ${formatBytes(done.bytes)}`, { kind: 'success' });
  } catch (err) {
    toastError(err);
  }
}

/**
 * Deletes what `findUnusedFiles` offered and the person agreed to: only those, and of them only what
 * still has nothing linking to it (the notes are read again, in case one was saved meanwhile).
 */
export async function deleteUnusedFiles(agreed: UnusedFiles): Promise<{ bytes: number; count: number }> {
  const notes = await noteLinks();
  const done = await api.cleanup({
    dryRun: false,
    referenced: [...notes, ...agreed.inVersions],
    confirm: { files: agreed.files.map((f) => f.id), drawings: agreed.drawings.map((d) => d.id) },
  });
  return { bytes: done.bytes, count: done.files.length + done.drawings.length };
}
