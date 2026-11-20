// @vitest-environment jsdom
/** Which notes are templates and journal entries, found by what they are rather than a folder's name. */
import { afterEach, describe, expect, it } from 'vitest';
import { isTemplate, journalEntries, journalFolderId, journalTemplate, templateNotes } from '../../src/lib/journal';
import { useApp } from '../../src/lib/store';
import type { Folder, NoteMeta } from '../../src/lib/types';

const folder = (id: string, name: string, parent_id: string | null = null) => ({ id, name, parent_id }) as Folder;
const note = (id: string, title: string, folder_id: string | null, tags: string[] = [], updated_at = 1) =>
  ({ id, title, folder_id, tags, updated_at, deleted_at: null }) as unknown as NoteMeta;

function library(folders: Folder[], notes: NoteMeta[]) {
  useApp.setState({ folders, notes: Object.fromEntries(notes.map((n) => [n.id, n])) });
}

afterEach(() => library([], []));

describe('templates', () => {
  it('are the notes in a top-level Templates folder and its subfolders', () => {
    const folders = [folder('t', 'Templates'), folder('t2', 'Work', 't'), folder('x', 'Templates', 'w'), folder('w', 'Work')];
    library(folders, [note('a', 'Meeting {{date}}', 't2'), note('b', 'Journal', 't'), note('c', 'Elsewhere', 'x')]);
    expect(templateNotes().map((n) => n.id)).toEqual(['b', 'a']);
    expect(isTemplate(useApp.getState().notes.c)).toBe(false);
    expect(journalTemplate()?.id).toBe('b');
  });
});

describe('the journal', () => {
  it('follows its entries when their folder is renamed or moved', () => {
    library(
      [folder('d', 'Diary'), folder('j', 'Journal')],
      [note('e1', '2026-11-16', 'd', ['journal']), note('e2', '2026-11-17', 'd', ['Journal']), note('x', 'Groceries', 'd', ['journal'])],
    );
    expect(journalFolderId()).toBe('d');
    expect([...journalEntries().keys()].sort()).toEqual(['2026-11-16', '2026-11-17']);
  });

  it('counts dated notes in its folder even without the tag, and starts in a Journal folder', () => {
    library([folder('j', 'journal')], [note('e1', '2026-01-02', 'j'), note('e2', '2026-01-03', null)]);
    expect(journalFolderId()).toBe('j');
    expect([...journalEntries().keys()]).toEqual(['2026-01-02']);
    library([], []);
    expect(journalFolderId()).toBeNull();
  });

  it('keeps the most recently edited entry when a day has two', () => {
    library([], [note('old', '2026-03-04', null, ['journal'], 1), note('new', '2026-03-04', null, ['journal'], 5)]);
    expect(journalEntries().get('2026-03-04')?.id).toBe('new');
  });
});
