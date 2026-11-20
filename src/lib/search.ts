/**
 * Searching notes, from the list's search box and Ctrl/⌘ K (the query language is in searchQuery.ts).
 *
 * - An encrypted library is searched on this device, filters and all.
 * - Otherwise the server's full-text index finds the words, and the filters (which need only what
 *   the note list knows: tags, folders, pinned, tasks) are applied here; a query of filters alone
 *   doesn't go to the server at all.
 */
import { api, currentCodec } from './api';
import { isJournalEntry, isTemplate, journalFolderId } from './journal';
import { hasText, isEmpty, loose, noteFilter, parseQuery, serverText } from './searchQuery';
import { useApp } from './store';
import type { NoteMeta, SearchHit } from './types';

const hitOf = (n: NoteMeta): SearchHit => ({ id: n.id, title: n.title, folder_id: n.folder_id, updated_at: n.updated_at, tags: n.tags, snippet: n.excerpt });

export async function searchNotes(
  q: string,
  opts: { signal?: AbortSignal; limit?: number; scope?: (n: NoteMeta) => boolean } = {},
): Promise<SearchHit[]> {
  const query = parseQuery(q);
  if (isEmpty(query)) return [];
  const limit = opts.limit ?? 40;
  const { notes, folders } = useApp.getState();
  const journal = journalFolderId();
  const filter = noteFilter(query, { folders, isJournal: (n) => isJournalEntry(n, journal), isTemplate: (n) => isTemplate(n, folders) });
  const keep = (n: NoteMeta) => !n.deleted_at && filter(n) && (!opts.scope || opts.scope(n));

  const codec = currentCodec();
  if (codec) return codec.search(query, limit, opts.signal, keep);

  if (!hasText(query)) {
    // Filters (and maybe words to leave out) only: from the note list, newest first.
    // A word left out matches the start of a word, as the server's search and the one on the device do.
    const without = query.without.map(loose);
    const hasWordStart = (text: string, w: string) => {
      for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + 1)) if (i === 0 || !/[\p{L}\p{N}_]/u.test(text[i - 1])) return true;
      return false;
    };
    return Object.values(notes)
      .filter((n) => keep(n) && !without.some((w) => hasWordStart(loose(`${n.title} ${n.tags.join(' ')} ${n.excerpt}`), w)))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit)
      .map(hitOf);
  }
  const narrowed = query.filters.length > 0 || !!opts.scope;
  // With filters, ask for more, since some are left out here.
  const { results } = await api.searchServer(serverText(query), narrowed ? 100 : limit, opts.signal);
  return results.filter((h) => (notes[h.id] ? keep(notes[h.id]) : !narrowed)).slice(0, limit);
}
