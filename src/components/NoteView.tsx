import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import {
  ArrowLeft,
  AtSign,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  CloudOff,
  Columns2,
  Copy,
  Download,
  Eye,
  FileText,
  Folder as FolderIcon,
  History,
  Link as LinkIcon,
  Loader,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRight,
  PencilLine,
  Pin,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { insertBlock } from '../lib/editorCommands';
import type { EditorHost } from '../lib/editorExtensions';
import { assetRef, decryptingAssets, openAsset } from '../lib/assets';
import { filledTemplate, templateNotes } from '../lib/journal';
import { changeNoteText, registerLiveView } from '../lib/liveEdit';
import { extractHeadings, type Heading } from '../lib/markdown';
import { linkFirstMention, offerLinkUpdate, unlinkedMentions, type MentionHit } from '../lib/relink';
import {
  baseVersionOf,
  conflictOf,
  edit,
  errorOf,
  flush,
  onTextReplaced,
  pendingText,
  resolveConflict,
  statusOf,
  track,
  unsavedPatch,
  useSaveStatus,
  type SaveStatus,
} from '../lib/saver';
import { abandonedMessage, uploadPlaceholder, withoutAbandonedUploads } from '../lib/uploading';
import { cleanTitle } from '../../shared/noteText';
import { useMediaQuery, useSettings } from '../lib/settings';
import {
  bumpDrawing,
  createNote,
  deleteNoteForever,
  discardEmptyNote,
  duplicateNote,
  folderPath,
  goBack,
  noteCache,
  openDrawingEditor,
  openMermaidEditor,
  openNote,
  preferredMode,
  restoreNote,
  setFilter,
  toast,
  toastError,
  trashNote,
  updateNoteMeta,
  upsertMeta,
  useApp,
} from '../lib/store';
import { loadExtrasWhenIdle } from '../lib/renderExtras';
import type { Backlink, Note, NoteMeta, ViewMode } from '../lib/types';
import { pickFiles, uploadForNote } from '../lib/upload';
import {
  formatBytes,
  fullDate,
  idFor,
  modKey,
  noteTitle,
  readingMinutes,
  relativeTime,
  slugify,
  todayIso,
  wordCount,
} from '../lib/utils';
import { isTicked, tickLines } from '../lib/tasks';
import { DiffView } from './DiffView';
import { Editor, type EditorHandle } from './Editor';
import { ExportDialog } from './ExportDialog';
import { JournalNav } from './JournalNav';
import { Preview, type PreviewHandle } from './Preview';
import { TagEditor } from './TagEditor';
import { Toolbar } from './Toolbar';
import { IconButton, MenuButton, Modal, modalOpen, Segmented, Skeleton, type MenuItem } from './ui';

/**
 * Note titles (lower case) to ids, for [[links]]. The editor asks for each link on screen every time it
 * redraws (each keystroke and scroll), so the map is built once per change to the note list.
 */
let titleIndexCache: { notes: Record<string, NoteMeta>; map: Map<string, string> } | null = null;
function titleIndexOf(notes: Record<string, NoteMeta>): Map<string, string> {
  if (titleIndexCache?.notes === notes) return titleIndexCache.map;
  const map = new Map<string, string>();
  for (const n of Object.values(notes)) {
    if (!n.deleted_at && n.title.trim()) map.set(n.title.trim().toLowerCase(), n.id);
  }
  titleIndexCache = { notes, map };
  return map;
}

/**
 * `value` once it has stayed the same for `delay` ms (or at once when delay is 0). A new `key` (another
 * note) shows its value straight away rather than the last note's for a moment.
 */
function useSettled<T>(value: T, delay: number, key: unknown): T {
  // What was last shown: switching from no delay to a delay continues from there, never from older text.
  const shown = useRef({ value, key });
  const [, rerender] = useState(0);
  if (!delay || shown.current.key !== key) shown.current = { value, key };
  useEffect(() => {
    if (!delay || shown.current.value === value) return;
    const t = setTimeout(() => {
      shown.current = { value, key };
      rerender((n) => n + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [value, delay, key]);
  return shown.current.value;
}

function stripContent(n: Note) {
  const { content: _c, ...meta } = n;
  return meta;
}

function NoteSkeleton() {
  return (
    <div className="doc-row">
      <div className="doc" aria-hidden="true">
        <Skeleton width="55%" height={34} radius={8} />
        <div style={{ height: 18 }} />
        <Skeleton width="30%" height={14} />
        <div style={{ height: 34 }} />
        {[92, 100, 84, 96, 60].map((w, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <Skeleton width={`${w}%`} height={13} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function NoteView({ noteId }: { noteId: string }) {
  const meta = useApp((s) => s.notes[noteId]);
  const folders = useApp((s) => s.folders);
  const focusMode = useApp((s) => s.focusMode);
  const me = useApp((s) => s.me);
  const drawingRevs = useApp((s) => s.drawingRevs);
  const anchor = useApp((s) => s.anchor);
  const exportOpen = useApp((s) => s.exportFor === noteId);
  const settings = useSettings();
  const isWide = useMediaQuery('(min-width: 1100px)');
  const isRoomy = useMediaQuery('(min-width: 1360px)');
  const isPhone = useMediaQuery('(max-width: 759px)');
  const status = useSaveStatus(noteId);

  const [loaded, setLoaded] = useState<Note | null>(() => noteCache.get(noteId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [epoch, setEpoch] = useState(0);
  const [mode, setMode] = useState<ViewMode>('edit');
  const [focusTarget, setFocusTarget] = useState<'title' | 'body' | null>(null);
  const [previewHeadings, setPreviewHeadings] = useState<Heading[]>([]);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [scrolled, setScrolled] = useState(false);
  const [titleOut, setTitleOut] = useState(false);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  // The two versions of a conflict side by side, to choose with both in view.
  const [comparing, setComparing] = useState(false);
  // A conflict choice on its way (Keep both saves a copy first): the choices wait for it.
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);

  const contentRef = useRef(content);
  contentRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const editorRef = useRef<EditorHandle>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRaf = useRef(0);

  const trashed = !!meta?.deleted_at;
  const effectiveMode: ViewMode = trashed ? 'read' : mode === 'split' && !isWide ? 'edit' : mode;

  /* ------------------------------------------------------------ loading */

  // The saved title links to this note were written with, to offer updating them after a rename.
  const titleAtOpen = useRef<string | null>(null);

  const apply = useCallback(
    (n: Note, initial: boolean) => {
      const t = track(n);
      // "Uploading…" placeholders whose upload stopped with the page that started it (uploading.ts):
      // taken out as the note opens, saved like any edit, with the files named so they can be added again.
      if (initial && !n.deleted_at) {
        const { text, abandoned } = withoutAbandonedUploads(t.content);
        if (abandoned.length) {
          const saved = unsavedPatch(noteId)?.content === undefined;
          edit(noteId, { content: text }, n.version, saved ? { content: t.content } : undefined);
          t.content = text;
          toast(abandonedMessage(abandoned), { kind: 'error', timeout: 12_000 });
        }
      }
      titleAtOpen.current = n.title;
      setLoaded(n);
      setTitle(t.title);
      setContent(t.content);
      contentRef.current = t.content;
      setEpoch((e) => e + 1);
      if (initial) {
        const pref = preferredMode.get(noteId);
        const defaultMode = useSettings.getState().defaultMode;
        setMode(pref ?? (t.content.trim() ? defaultMode : 'edit'));
        setFocusTarget(pref === 'edit' ? (t.title ? 'body' : 'title') : null);
      }
    },
    [noteId],
  );

  // Text from elsewhere, shown in place: the editor keeps its cursor (and the phone its keyboard), and
  // the change isn't an edit to save or a step to undo. The editor and title box change first, at once,
  // so anything typed before React redraws lands on the new text rather than the old.
  const showText = useCallback((t: { title: string; content: string }) => {
    if (contentRef.current.replace(/\r\n?/g, '\n') !== t.content.replace(/\r\n?/g, '\n')) {
      editorRef.current?.replaceAll(t.content);
      contentRef.current = t.content;
      setContent(t.content);
    }
    if (cleanTitle(titleValueRef.current) !== cleanTitle(t.title)) {
      titleValueRef.current = t.title;
      if (titleRef.current) titleRef.current.value = t.title;
      setTitle(t.title);
    }
  }, []);

  // A newer version of the open note, with nothing unsaved here.
  const refresh = useCallback(
    (n: Note) => {
      const t = track(n);
      titleAtOpen.current = n.title;
      setLoaded(n);
      showText(t);
    },
    [showText],
  );

  // A save refused for a newer version, settled without asking (merged, or the newer version kept).
  useEffect(() => onTextReplaced((id, t) => id === noteId && showText(t)), [noteId, showText]);

  // Maths and code colours load on demand (renderExtras.ts). Most notes need neither, so once a note
  // is showing (in either view) they're fetched in idle time: ready for the next, and kept for offline
  // use. Not before: on a slow connection they'd compete with the note itself.
  const showing = !!loaded;
  useEffect(() => (showing ? loadExtrasWhenIdle() : undefined), [showing]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBacklinks([]);
    setScrolled(false);
    setTitleOut(false);
    const cached = noteCache.get(noteId);
    if (cached) apply(cached, true);
    else setLoaded(null);
    api
      .getNote(noteId)
      .then((n) => {
        if (cancelled) return;
        noteCache.set(noteId, n);
        upsertMeta(stripContent(n));
        if (!cached) apply(n, true);
        // Only a newer version: an older one (the offline copy, on a connection that failed) never
        // replaces what's shown.
        else if (n.version > cached.version && !pendingText(noteId)) refresh(n);
      })
      .catch((err) => {
        if (!cancelled && !cached) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      void flush(noteId);
    };
  }, [noteId, apply, refresh]);

  // Leaving a note that is still completely empty removes it, so stray "Untitled" notes don't pile up.
  // Only a note that actually opened: one that failed to load (offline, or couldn't be decrypted)
  // only looks empty here. And only one that never had text saved (version 1): a note emptied by
  // accident keeps its history, and the server deletes only at that version, so text another device
  // saved into the note meanwhile is never deleted.
  const loadedOk = useRef(false);
  loadedOk.current = loaded?.id === noteId;
  useEffect(() => {
    const id = noteId;
    return () => {
      const opened = loadedOk.current;
      setTimeout(() => {
        const s = useApp.getState();
        if (s.noteId === id || !opened) return;
        const m = s.notes[id];
        if (!m || m.deleted_at || m.pinned || m.tags.length || m.title.trim() || m.excerpt.trim() || m.version > 1) return;
        if (titleValueRef.current.trim() || contentRef.current.trim()) return;
        void discardEmptyNote(id, m.version);
      }, 600);
    };
  }, [noteId]);

  // Another device saved this note: reload it if we have nothing unsaved.
  useEffect(() => {
    if (!meta || !loaded) return;
    if (meta.version > baseVersionOf(noteId) && !pendingText(noteId) && status === 'saved') {
      api
        .getNote(noteId)
        .then((n) => {
          noteCache.set(noteId, n);
          if (!pendingText(noteId) && statusOf(noteId) === 'saved') refresh(n);
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.version]);

  useEffect(() => {
    if (focusTarget === 'title') requestAnimationFrame(() => titleRef.current?.focus());
  }, [focusTarget, epoch]);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, loaded, effectiveMode]);

  // Backlinks show in every mode (a chip under the title; a list at the end in reading view). The
  // server matches links by the saved title, so look them up when the note opens and again once a
  // rename has been saved, not while it's still being typed.
  const backlinksFor = useRef<string | null>(null);
  const hasLoaded = !!loaded;
  const savedTitle = status === 'saved' ? (meta?.title ?? '') : null;
  // Bumped after linking a mention from here, so backlinks and mentions are looked up again.
  const [linkRev, setLinkRev] = useState(0);
  useEffect(() => {
    if (!hasLoaded || trashed || savedTitle === null || backlinksFor.current === `${savedTitle}\u0000${linkRev}`) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .backlinks(noteId)
        .then((r) => {
          if (cancelled) return;
          backlinksFor.current = `${savedTitle}\u0000${linkRev}`;
          setBacklinks(r.backlinks);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [noteId, hasLoaded, trashed, savedTitle, linkRev]);

  // Unlinked mentions: other notes naming this one's title without linking it. Looked up again when
  // the title is saved, the note list is refreshed (other devices' edits) or a mention is linked here.
  const [mentions, setMentions] = useState<MentionHit[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const lastSync = useApp((s) => s.lastSync);
  useEffect(() => {
    if (!hasLoaded || trashed || savedTitle === null) return;
    let live = true;
    const t = setTimeout(() => {
      void unlinkedMentions(noteId).then(
        (found) => live && setMentions(found),
        () => undefined,
      );
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [noteId, hasLoaded, trashed, savedTitle, lastSync, linkRev]);

  const linkMentionIn = (otherId: string) => {
    if (!linkFirstMention(otherId, meta?.title ?? title)) return;
    setLinkRev((n) => n + 1);
    // The other note's new links reach backlinks once it has saved.
    setTimeout(() => setLinkRev((n) => n + 1), 2500);
  };

  /* ------------------------------------------------------------ editing */

  const onContent = useCallback(
    (value: string) => {
      contentRef.current = value;
      setContent(value);
      edit(noteId, { content: value });
    },
    [noteId],
  );

  const replaceContent = useCallback(
    (fn: (src: string) => string) => {
      const next = fn(contentRef.current);
      if (next !== contentRef.current) onContent(next);
    },
    [onContent],
  );

  // This view is where its note's text changes, once the note has loaded (see liveEdit.ts). An upload
  // that finishes after its note was left, and perhaps opened again, changes the text as it is now.
  const replaceRef = useRef(replaceContent);
  replaceRef.current = replaceContent;
  const isLoaded = loaded?.id === noteId;
  useEffect(() => {
    if (!isLoaded) return;
    return registerLiveView(noteId, (fn) => replaceRef.current(fn));
  }, [noteId, isLoaded]);

  // Renamed: once the title is left (or the note is), offer to update [[links]] still using the old one.
  const checkRename = () => {
    const from = titleAtOpen.current?.trim();
    if (from === undefined || trashed) return;
    const to = titleValueRef.current.trim();
    titleAtOpen.current = titleValueRef.current;
    if (from && to && from.toLowerCase() !== to.toLowerCase()) void offerLinkUpdate(noteId, from, to);
  };
  const checkRenameRef = useRef(checkRename);
  checkRenameRef.current = checkRename;
  useEffect(() => () => checkRenameRef.current(), [noteId]);

  const onTitle = (value: string) => {
    const clean = value.replace(/\n/g, ' ');
    setTitle(clean);
    edit(noteId, { title: clean });
    const current = useApp.getState().notes[noteId];
    if (current) useApp.setState((s) => ({ notes: { ...s.notes, [noteId]: { ...current, title: clean } } }));
  };

  const insertMarkdownBlock = (md: string) => {
    const view = editorRef.current?.view();
    if (view && effectiveMode !== 'read') insertBlock(view, md);
    else replaceContent((src) => `${src.trimEnd() ? `${src.trimEnd()}\n\n` : ''}${md}\n`);
  };

  // Ticked in reading view: dated, and a repeating task's next one added (see tickTaskLine).
  const toggleTask = (line: number) =>
    replaceContent((src) => {
      const ticked = isTicked(src.split('\n')[line] ?? '');
      if (ticked === null) return src;
      return tickLines(src, [{ line, done: !ticked }], todayIso(), useSettings.getState().taskDoneDates);
    });

  const editMermaid = async (start: number, end: number, code: string) => {
    const next = await openMermaidEditor(code, false);
    if (next === null) return;
    replaceContent((src) => {
      const lines = src.split('\n');
      const opening = lines[start] ?? '';
      const fence = /^\s*(```+|~~~+)/.exec(opening);
      if (!fence) return src;
      const last = end - 1;
      const closed = last > start && /^\s*(```+|~~~+)\s*$/.test(lines[last] ?? '');
      const body = next.replace(/\s+$/, '').split('\n');
      lines.splice(start, Math.max(1, end - start), opening, ...body, closed ? lines[last] : fence[1]);
      return lines.join('\n');
    });
  };

  const editDrawing = async (id: string) => {
    const saved = await openDrawingEditor(id, noteId);
    if (saved) bumpDrawing(saved);
    // Changed elsewhere meanwhile, and saved as a separate drawing: it goes in the note too.
    if (saved && saved !== id) insertMarkdownBlock(`![Drawing](/api/drawings/${saved}.svg)`);
  };

  const insertDrawing = async () => {
    const id = await openDrawingEditor(null, noteId);
    if (id) insertMarkdownBlock(`![Drawing](/api/drawings/${id}.svg)`);
  };

  const insertMermaid = async (code?: string) => {
    const result = await openMermaidEditor(code ?? '', true);
    if (result?.trim()) insertMarkdownBlock(`\`\`\`mermaid\n${result.trim()}\n\`\`\``);
  };

  const uploadFiles = async (files: File[]) => {
    // Encrypting adds a few bytes (the IV and tag), which count toward the storage's limit.
    const max = (me?.maxUploadBytes ?? 25 * 1024 * 1024) - (decryptingAssets() ? 64 : 0);
    const ok = files.filter((f) => {
      if (f.size > max && !f.type.startsWith('image/')) {
        toast(`${f.name} is larger than ${formatBytes(max)}.`, { kind: 'error' });
        return false;
      }
      return true;
    });
    if (!ok.length) return;
    // Each placeholder says when its upload started: one left behind by a page that closed
    // mid-upload is recognised, and taken out, when the note next opens (uploading.ts).
    const jobs = ok.map((file) => ({ file, placeholder: uploadPlaceholder(file) }));
    insertMarkdownBlock(jobs.map((j) => j.placeholder).join('\n'));
    for (const job of jobs) {
      try {
        const res = await uploadForNote(job.file, noteId, settings.compressImages);
        // Through the note's current view (or its saved text): this one may have closed meanwhile.
        changeNoteText(noteId, (src) => src.replace(job.placeholder, res.markdown));
      } catch (err) {
        changeNoteText(noteId, (src) => src.replace(`${job.placeholder}\n`, '').replace(job.placeholder, ''));
        toastError(err);
      }
    }
  };

  const titleIndex = () => titleIndexOf(useApp.getState().notes);

  const hostRef = useRef<EditorHost>(null!);
  hostRef.current = {
    openMermaid: (code) => void insertMermaid(code),
    openDrawing: () => void insertDrawing(),
    pickImages: async () => {
      const files = await pickFiles('image/*');
      if (files.length) void uploadFiles(files);
    },
    takePhoto: async () => {
      const files = await pickFiles('image/*', false, 'environment');
      if (files.length) void uploadFiles(files);
    },
    pickFiles: async () => {
      const files = await pickFiles('*/*');
      if (files.length) void uploadFiles(files);
    },
    uploadFiles: (files) => void uploadFiles(files),
    noteTitles: () =>
      Object.values(useApp.getState().notes)
        .filter((n) => !n.deleted_at && n.id !== noteId && n.title.trim())
        .sort((a, b) => b.updated_at - a.updated_at)
        .map((n) => n.title),
    templates: () => templateNotes().filter((t) => t.id !== noteId).map((t) => ({ id: t.id, title: t.title })),
    insertTemplate: (id) => {
      void filledTemplate(id, titleValueRef.current.trim()).then(insertMarkdownBlock, toastError);
    },
    editDrawing: (id) => void editDrawing(id),
    editMermaid: (s, e, c) => void editMermaid(s, e, c),
    openLink: (href) => {
      const internal = /^\/note\/([A-Za-z0-9_-]+)(#.*)?/.exec(href);
      if (internal) {
        openNote(internal[1], { hash: internal[2] });
        return;
      }
      // An encrypted upload: decrypted here, then opened or downloaded.
      if (decryptingAssets() && assetRef(href)?.kind === 'file') {
        openAsset(href);
        return;
      }
      // Only ordinary web, mail and in-app links; never javascript:, data: or similar.
      let url: URL;
      try {
        url = new URL(href, location.href);
      } catch {
        return;
      }
      if (['http:', 'https:', 'mailto:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
    },
    openWikilink: (target) => {
      const hashAt = target.indexOf('#');
      const title = (hashAt < 0 ? target : target.slice(0, hashAt)).trim();
      const heading = hashAt < 0 ? '' : target.slice(hashAt + 1).trim();
      if (!title) return;
      const id = titleIndex().get(title.toLowerCase());
      if (id) openNote(id, { hash: heading ? `#h-${slugify(heading)}` : undefined });
      else void createNote({ title, folder_id: null }).catch(toastError);
    },
    noteExists: (t) => titleIndex().has(t.toLowerCase()),
    viewImage: (src, alt) => useApp.setState({ lightbox: { kind: 'image', src, alt } }),
    viewDiagram: (svg) => useApp.setState({ lightbox: { kind: 'svg', html: svg } }),
    assetUrl: (src) => {
      const m = /^\/api\/drawings\/([A-Za-z0-9_-]+)\.svg$/.exec(src);
      const rev = m ? drawingRevs[m[1]] : undefined;
      return rev ? `${src}?v=${rev}` : src;
    },
  };

  /* ------------------------------------------------------------ modes */

  const changeMode = (m: ViewMode) => {
    setMode(m);
    if (m !== 'read') setFocusTarget(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || useApp.getState().drawing || useApp.getState().mermaid || modalOpen()) return;
      if (e.key.toLowerCase() === 'e' && !e.shiftKey && !trashed) {
        e.preventDefault();
        setMode((m) => (m === 'read' ? 'edit' : 'read'));
      } else if (e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault();
        // Report what actually happened: the save can also end offline, failed or in conflict.
        void flush(noteId).then(() => {
          const result = statusOf(noteId);
          if (result === 'saved') toast('All changes saved', { kind: 'success' });
          else if (result === 'offline') toast('You’re offline. Your changes are kept on this device and sync when you reconnect.');
          else if (result === 'error' || result === 'failed') toast(errorOf(noteId) ?? 'Couldn’t save yet.', { kind: 'error' });
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [noteId, trashed]);

  /* ------------------------------------------------------------ outline */

  const previewSource = useDeferredValue(content);
  // Both re-read the whole note, so on a long note they wait for a pause in typing.
  const outlineSource = useSettled(previewSource, previewSource.length > 20_000 ? 300 : 0, noteId);
  // Split view renders the whole note beside the editor: after a short pause, not on every keystroke.
  const splitSource = useSettled(previewSource, effectiveMode === 'split' ? 150 : 0, noteId);
  const editHeadings = useMemo(
    () => (effectiveMode === 'edit' ? extractHeadings(outlineSource) : []),
    [effectiveMode, outlineSource],
  );
  const headings = effectiveMode === 'edit' ? editHeadings : previewHeadings;
  // Hidden by a container query when the note pane is too narrow.
  const showRail = settings.showOutline && !isPhone && effectiveMode !== 'split' && headings.length >= 2;

  const updateScrollState = () => {
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const top = scroller.scrollTop;
      setScrolled(top > 4);
      const head = titleRef.current;
      setTitleOut(head ? head.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top + 8 : top > 120);

      if (effectiveMode === 'split') {
        const view = editorRef.current?.view();
        if (!view) return;
        const editorTop = view.dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top + top;
        const block = view.lineBlockAtHeight(Math.max(0, top - editorTop + 40));
        previewRef.current?.scrollToLine(top < 20 ? 0 : view.state.doc.lineAt(block.from).number - 1);
        return;
      }
      if (!headings.length) return;
      if (effectiveMode === 'read') {
        const root = previewRef.current?.element();
        const limit = scroller.getBoundingClientRect().top + 110;
        let current: string | null = headings[0].id;
        for (const h of headings) {
          const el = root?.querySelector(`#${CSS.escape(h.id)}`);
          if (el && el.getBoundingClientRect().top <= limit) current = h.id;
        }
        setActiveHeading(current);
      } else {
        const view = editorRef.current?.view();
        if (!view) return;
        const editorTop = view.dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top + top;
        const block = view.lineBlockAtHeight(Math.max(0, top - editorTop + 110));
        const lineNo = view.state.doc.lineAt(block.from).number;
        let current: string | null = headings[0].id;
        for (const h of headings) if (h.line + 1 <= lineNo) current = h.id;
        setActiveHeading(current);
      }
    });
  };

  useEffect(() => {
    updateScrollState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headings.length, effectiveMode]);

  const jumpToHeading = (h: Heading, focus = true) => {
    if (effectiveMode === 'edit') {
      const view = editorRef.current?.view();
      if (!view) return;
      const line = view.state.doc.line(Math.min(h.line + 1, view.state.doc.lines));
      const effects = EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 90 });
      if (focus) {
        view.dispatch({ selection: { anchor: line.to }, effects });
        view.focus();
      } else {
        view.dispatch({ effects });
      }
    } else {
      previewRef.current?.scrollToHeading(h.id);
    }
    setActiveHeading(h.id);
  };

  // Arrived at a line (/note/<id>#L12, from the Tasks view): show it, with the cursor there when editing.
  const jumpToLine = (line: number) => {
    if (effectiveMode !== 'edit') previewRef.current?.scrollToLine(line);
    if (effectiveMode === 'read') return;
    const view = editorRef.current?.view();
    if (!view) return;
    const target = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
    view.dispatch({ selection: { anchor: target.to }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
    view.focus();
  };

  // Arrived through a link to a heading (/note/<id>#h-section): scroll there once it's on the page.
  useEffect(() => {
    if (!anchor || !loaded) return;
    const lineMatch = /^L(\d{1,7})$/.exec(anchor);
    if (lineMatch) {
      useApp.setState({ anchor: null });
      const line = Number(lineMatch[1]);
      requestAnimationFrame(() => jumpToLine(line));
      return;
    }
    const h = headings.find((x) => x.id === anchor);
    if (h) {
      useApp.setState({ anchor: null });
      requestAnimationFrame(() => jumpToHeading(h, false));
      return;
    }
    // No such heading (renamed or removed): give the page a moment to render, then let the link go,
    // so the note doesn't jump later when a heading by that name happens to appear.
    const t = setTimeout(() => {
      if (useApp.getState().anchor === anchor) useApp.setState({ anchor: null });
    }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, loaded, headings]);

  /* ------------------------------------------------------------ actions */

  const path = folderPath(folders, meta?.folder_id ?? null);
  const folderLabel = path.length ? path[path.length - 1].name : 'No folder';

  const moveItems = (): MenuItem[] => {
    const children = new Map<string | null, typeof folders>();
    for (const f of folders) {
      const list = children.get(f.parent_id) ?? [];
      list.push(f);
      children.set(f.parent_id, list);
    }
    const out: MenuItem[] = [
      { heading: 'Move to' },
      { label: 'No folder', icon: <FileText size={15} />, checked: !meta?.folder_id, onSelect: () => void updateNoteMeta(noteId, { folder_id: null }) },
    ];
    const walk = (parent: string | null, depth: number) => {
      const list = (children.get(parent) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const f of list) {
        out.push({
          label: f.name,
          icon: <FolderIcon size={15} />,
          indent: depth,
          checked: meta?.folder_id === f.id,
          onSelect: () => void updateNoteMeta(noteId, { folder_id: f.id }),
        });
        if (depth < 6) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  };

  const copyLink = () => {
    const url = `${location.origin}/note/${noteId}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast('Link copied', { kind: 'success' }),
      () => toast(url),
    );
  };

  const moreItems = (): MenuItem[] =>
    trashed
      ? [
          { label: 'Restore note', icon: <RotateCcw size={15} />, onSelect: () => void restoreNote(noteId) },
          { label: 'Delete forever', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteNoteForever(noteId) },
        ]
      : [
          { label: 'Version history', icon: <History size={15} />, onSelect: () => useApp.setState({ historyFor: noteId }) },
          { label: 'Duplicate', icon: <Copy size={15} />, onSelect: () => void duplicateNote(noteId) },
          { label: 'Copy link', icon: <LinkIcon size={15} />, onSelect: copyLink },
          { separator: true },
          {
            label: 'Show Markdown syntax',
            icon: <Eye size={15} />,
            checked: !settings.livePreview,
            onSelect: () => settings.update({ livePreview: !settings.livePreview }),
          },
          ...(!isPhone
            ? [
                {
                  label: 'Show outline',
                  icon: <PanelRight size={15} />,
                  checked: settings.showOutline,
                  onSelect: () => settings.update({ showOutline: !settings.showOutline }),
                } as MenuItem,
                {
                  label: focusMode ? 'Exit focus mode' : 'Focus mode',
                  icon: focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />,
                  onSelect: () => useApp.setState({ focusMode: !focusMode }),
                } as MenuItem,
              ]
            : []),
          { separator: true },
          { label: 'Export as PDF or Markdown…', icon: <Download size={15} />, onSelect: () => useApp.setState({ exportFor: noteId }) },
          { separator: true },
          { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => void trashNote(noteId) },
        ];

  /* ------------------------------------------------------------ render */

  const words = useMemo(() => wordCount(outlineSource), [outlineSource]);
  // Words in the selection, while there is one: in the editor, or in reading view's text.
  const [selectedText, setSelectedText] = useState('');
  const selectedWords = useMemo(() => (selectedText ? wordCount(selectedText) : 0), [selectedText]);
  useEffect(() => {
    const onChange = () => {
      const root = previewRef.current?.element();
      const sel = document.getSelection();
      if (!root || !sel || sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) {
        // Only clear what reading view set; the editor reports its own.
        if (root && document.activeElement?.closest('.cm-editor') == null) setSelectedText('');
        return;
      }
      setSelectedText(sel.toString());
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);
  useEffect(() => setSelectedText(''), [noteId, mode]);

  if (!loaded) {
    return (
      <section className="note-pane">
        <header className="pane-header note-header">
          {isPhone && (
            <IconButton label="Back" onClick={goBack}>
              <ArrowLeft size={19} />
            </IconButton>
          )}
        </header>
        {error ? (
          <div className="note-message">
            <CircleAlert size={22} />
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        ) : (
          <div className="pane-scroll">
            <NoteSkeleton />
          </div>
        )}
      </section>
    );
  }

  const conflict = status === 'conflict' ? conflictOf(noteId) : null;

  // The three ways out of a conflict, from the banner or the comparison.
  const keepMine = () => {
    setComparing(false);
    void resolveConflict(noteId, 'mine', { title, content: contentRef.current });
  };
  const keepBoth = async () => {
    // Once: a second press while the copy saves would make a second copy.
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setResolving(true);
    try {
      const mine = contentRef.current;
      const myTitle = title;
      const copyTitle = (t: string) => `${noteTitle(t)} (my version)`;
      // The copy first: only once it's saved is it safe to switch this note to the other version.
      // If it fails (offline, signed out), the conflict and this device's text stay as they were.
      let copy: NoteMeta;
      try {
        // Under an id made from this note's: pressed again after a reply that never came, it finds
        // the copy already saved rather than making a second.
        copy = await createNote(
          { title: copyTitle(myTitle), content: mine, folder_id: meta?.folder_id ?? null, tags: meta?.tags },
          { open: false, id: idFor(noteId, 'mine') },
        );
      } catch (err) {
        toastError(err);
        return;
      }
      // Typed while the copy was being saved: it goes into the copy too, since this note is about to
      // switch to the other version.
      const nowContent = contentRef.current;
      const nowTitle = titleRef.current?.value ?? myTitle;
      if (nowContent !== mine || nowTitle !== myTitle) {
        edit(
          copy.id,
          { content: nowContent, ...(nowTitle !== myTitle ? { title: copyTitle(nowTitle) } : {}) },
          copy.version,
          { title: copy.title, content: mine },
        );
        void flush(copy.id);
      }
      setComparing(false);
      // This device's text is in the copy just saved: no need to keep it in this note's history too.
      const theirs = await resolveConflict(noteId, 'theirs', undefined, { keepMine: false });
      if (theirs) apply(theirs, false);
      toast('Your version was saved as a separate note', { kind: 'success' });
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  };
  const useTheirs = async () => {
    // Nothing readable to switch to: this would only drop this device's edits.
    if (!conflict) return;
    setComparing(false);
    const theirs = await resolveConflict(noteId, 'theirs');
    if (theirs) apply(theirs, false);
  };

  const titleBlock = (
    <div className="doc-head">
      {meta && !trashed && <JournalNav note={meta} />}
      <textarea
        ref={titleRef}
        className="title-input"
        name="note-title"
        rows={1}
        value={title}
        placeholder="Untitled"
        aria-label="Note title"
        readOnly={trashed}
        spellCheck={settings.spellcheck}
        onChange={(e) => onTitle(e.target.value)}
        onBlur={checkRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.currentTarget.selectionStart === title.length)) {
            e.preventDefault();
            if (effectiveMode === 'read') setMode('edit');
            requestAnimationFrame(() => {
              const view = editorRef.current?.view();
              view?.focus();
              view?.dispatch({ selection: { anchor: 0 } });
            });
          }
        }}
      />
      <div className="props">
        <MenuButton
          label={`${folderLabel}, change folder`}
          icon={<FolderIcon size={14} />}
          text={<span className="prop-text">{folderLabel}</span>}
          chevron={<ChevronDown size={13} className="prop-chevron" />}
          items={moveItems}
          align="start"
          className="prop-chip"
        />
        {backlinks.length > 0 && (
          <MenuButton
            // Starts with the words shown, so "click 1 backlink" works with voice control.
            label={`${backlinks.length} ${backlinks.length === 1 ? 'backlink' : 'backlinks'}: the notes that link here`}
            icon={<LinkIcon size={14} />}
            text={
              <span className="prop-text">
                {backlinks.length} {backlinks.length === 1 ? 'backlink' : 'backlinks'}
              </span>
            }
            items={() => [
              { heading: 'Linked from' },
              ...backlinks.map((b) => ({ label: noteTitle(b.title), icon: <FileText size={15} />, onSelect: () => openNote(b.id) })),
            ]}
            align="start"
            className="prop-chip"
          />
        )}
        {mentions.length > 0 && !trashed && (
          <button
            type="button"
            className={`chip-btn prop-chip${showMentions ? ' is-open' : ''}`}
            aria-expanded={showMentions}
            aria-controls="note-mentions"
            data-tip="Notes that name this one without linking to it"
            onClick={() => setShowMentions((v) => !v)}
          >
            <AtSign size={14} aria-hidden="true" />
            <span className="prop-text">
              {mentions.length} {mentions.length === 1 ? 'mention' : 'mentions'}
            </span>
          </button>
        )}
        <TagEditor tags={meta?.tags ?? []} readOnly={trashed || !!meta?.tagsUnreadable} onChange={(tags) => void updateNoteMeta(noteId, { tags })} />
        <span className="props-meta">
          {meta && (
            <span data-tip={`Edited ${fullDate(meta.updated_at)}\nCreated ${fullDate(meta.created_at)}`}>
              Edited {relativeTime(meta.updated_at)}
            </span>
          )}
          {words > 0 && (
            <span>
              {selectedWords > 0
                ? `${selectedWords.toLocaleString()} of ${words.toLocaleString()} words selected`
                : `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}, ${readingMinutes(words)} min read`}
            </span>
          )}
        </span>
      </div>
      {showMentions && mentions.length > 0 && !trashed && (
        <section className="mentions" id="note-mentions" aria-label="Unlinked mentions">
          <p className="mentions-head">
            Named in {mentions.length} {mentions.length === 1 ? 'note' : 'notes'} without a link. <strong>Link</strong> turns the first one in each
            into a link to this note.
          </p>
          <ul>
            {mentions.map((m) => (
              <li key={m.id} className="mention">
                <span className="mention-body">
                  <button type="button" className="mention-note" onClick={() => openNote(m.id)}>
                    <FileText size={13} aria-hidden="true" /> {noteTitle(m.title)}
                    {m.count > 1 && <span className="mention-count">{m.count} mentions</span>}
                  </button>
                  <span className="mention-snippet">
                    {m.snippet.before}
                    <mark>{m.snippet.match}</mark>
                    {m.snippet.after}
                  </span>
                </span>
                <button type="button" className="btn btn-sm" onClick={() => linkMentionIn(m.id)}>
                  Link
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );

  const editor = (
    <Editor
      key={`${noteId}:${epoch}`}
      ref={editorRef}
      docKey={`${noteId}:${epoch}`}
      value={content}
      onChange={onContent}
      host={hostRef}
      spellcheck={settings.spellcheck}
      showImages={settings.editorImages}
      livePreview={settings.livePreview}
      autoFocus={focusTarget === 'body'}
      onSelectionText={setSelectedText}
    />
  );

  const preview = (
    <Preview
      ref={previewRef}
      source={splitSource}
      readOnly={trashed}
      onToggleTask={toggleTask}
      onEditMermaid={(s, e, c) => void editMermaid(s, e, c)}
      onEditDrawing={(id) => void editDrawing(id)}
      onHeadings={setPreviewHeadings}
      noteId={noteId}
    />
  );

  const emptyRead = effectiveMode === 'read' && !content.trim() && !trashed && (
    <button type="button" className="empty-read" onClick={() => changeMode('edit')}>
      <PencilLine size={16} /> This note is empty. Click to start writing.
    </button>
  );

  const rail = showRail && (
    <aside className="outline" aria-label="On this page">
      <p className="outline-title">On this page</p>
      <ul>
        {headings.map((h, i) => {
          const min = Math.min(...headings.map((x) => x.level));
          return (
            <li key={`${h.id}-${i}`}>
              <button
                type="button"
                className={`outline-item${activeHeading === h.id ? ' is-active' : ''}`}
                aria-current={activeHeading === h.id ? 'location' : undefined}
                style={{ paddingLeft: 10 + (h.level - min) * 12 }}
                onClick={() => jumpToHeading(h)}
              >
                {h.text || 'Untitled section'}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );

  return (
    <section className={`note-pane${effectiveMode === 'edit' ? ' is-editing' : ''}`} aria-label={noteTitle(title)}>
      <header className={`pane-header note-header${scrolled ? ' is-scrolled' : ''}`}>
        {isPhone && (
          <IconButton label="Back" onClick={goBack}>
            <ArrowLeft size={19} />
          </IconButton>
        )}
        {!isPhone && settings.sidebarCollapsed && !focusMode && (
          <IconButton
            label="Show sidebar"
            shortcut={`${modKey()} \\`}
            className="sidebar-open-btn"
            onClick={() => settings.update({ sidebarCollapsed: false })}
          >
            <PanelLeftOpen size={17} />
          </IconButton>
        )}
        <nav className="crumbs" aria-label="Location">
          {path.length === 0 ? (
            <button
              type="button"
              className="crumb"
              onClick={() => {
                setFilter({ kind: 'all' });
                if (isPhone) goBack();
              }}
            >
              <FileText size={14} />
              <span>Notes</span>
            </button>
          ) : (
            // The whole folder path, each folder opening its list. A deep one keeps its first folder
            // and the last two, with "…" for the rest (shown in full on hover).
            (path.length > 3 ? [path[0], null, ...path.slice(-2)] : path).map((f, i) =>
              f === null ? (
                <span key="gap" className="crumb-step">
                  <span className="crumb-div">/</span>
                  <span className="crumb-gap" data-tip={path.slice(1, -2).map((x) => x.name).join(' / ')}>
                    …
                  </span>
                </span>
              ) : (
                <span key={f.id} className="crumb-step">
                  {i > 0 && <span className="crumb-div">/</span>}
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => {
                      // Same switch as the sidebar, so the choice is remembered across reloads.
                      setFilter({ kind: 'folder', id: f.id });
                      if (isPhone) goBack();
                    }}
                  >
                    {i === 0 && <FolderIcon size={14} />}
                    <span>{f.name}</span>
                  </button>
                </span>
              ),
            )
          )}
          <span className={`crumb-sep${titleOut ? ' is-visible' : ''}`}>/</span>
          <span className={`crumb-title${titleOut ? ' is-visible' : ''}`}>{noteTitle(title)}</span>
        </nav>
        <SaveIndicator status={status} error={status === 'error' || status === 'failed' ? errorOf(noteId) : null} />
        {!trashed &&
          (isPhone ? (
            effectiveMode === 'read' ? (
              <IconButton label="Edit" onClick={() => changeMode('edit')}>
                <PencilLine size={18} />
              </IconButton>
            ) : (
              <IconButton label="Read" onClick={() => changeMode('read')}>
                <BookOpen size={18} />
              </IconButton>
            )
          ) : (
            <Segmented
              label="View"
              value={effectiveMode}
              onChange={changeMode}
              size="sm"
              options={[
                { value: 'edit', label: 'Edit', icon: <PencilLine size={14} />, tip: `Write (${modKey()} E)`, hideLabel: !isRoomy },
                ...(isWide
                  ? [{ value: 'split' as ViewMode, label: 'Split', icon: <Columns2 size={14} />, tip: 'Markdown and preview side by side', hideLabel: !isRoomy }]
                  : []),
                { value: 'read', label: 'Read', icon: <BookOpen size={14} />, tip: `Read (${modKey()} E)`, hideLabel: !isRoomy },
              ]}
            />
          ))}
        {!trashed && (
          <IconButton
            label={meta?.pinned ? 'Unpin' : 'Pin to top'}
            className="pin-btn"
            active={meta?.pinned}
            onClick={() => void updateNoteMeta(noteId, { pinned: !meta?.pinned })}
          >
            <Pin size={17} fill={meta?.pinned ? 'currentColor' : 'none'} />
          </IconButton>
        )}
        <MenuButton label="More" icon={<MoreHorizontal size={18} />} items={moreItems} />
      </header>

      {trashed && (
        <div className="alert alert-warn">
          <Trash2 size={15} />
          <span>This note is in the trash and will be deleted 30 days after it was moved there.</span>
          <button type="button" className="btn btn-sm" onClick={() => void restoreNote(noteId)}>
            Restore
          </button>
        </div>
      )}
      {status === 'conflict' && (
        <div className="alert alert-danger" role="alert">
          <CircleAlert size={15} />
          <span>
            {conflict
              ? `Changed on another device ${relativeTime(conflict.updated_at)}. Choose which version to keep.`
              : // Saved elsewhere in a form this device can't read (it couldn't be decrypted): there's
                // nothing to switch to, so "Use theirs" would only throw away what's typed here.
                'Changed on another device, and that version can’t be opened here. Keep yours, or keep both (yours become a separate note).'}
          </span>
          {conflict && (
            <button type="button" className="btn btn-sm" onClick={() => setComparing(true)}>
              Compare
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={keepMine} disabled={resolving}>
            Keep mine
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void keepBoth()} disabled={resolving}>
            Keep both
          </button>
          {conflict && (
            <button type="button" className="btn btn-sm" onClick={() => void useTheirs()} disabled={resolving}>
              Use theirs
            </button>
          )}
        </div>
      )}
      {comparing && conflict && (
        <Modal
          open
          size="xl"
          title="Compare the two versions"
          description={`Saved on another device ${relativeTime(conflict.updated_at)}, while this device had changes of its own.`}
          onClose={() => setComparing(false)}
          className="conflict-modal"
          footer={
            <>
              <span className="footer-note">
                Keep mine: theirs stays in the note’s history. Use theirs: your changes here are dropped. Keep both: yours become a
                separate note.
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn-ghost" onClick={() => void keepBoth()} disabled={resolving}>
                Keep both
              </button>
              <button type="button" className="btn" onClick={() => void useTheirs()} disabled={resolving}>
                Use theirs
              </button>
              <button type="button" className="btn btn-primary" onClick={keepMine} disabled={resolving}>
                Keep mine
              </button>
            </>
          }
        >
          <DiffView
            before={{ title: conflict.title, content: conflict.content }}
            after={{ title, content: contentRef.current }}
            beforeLabel="Theirs (saved on the other device)"
            afterLabel="Mine (on this device)"
          />
        </Modal>
      )}

      <div className={`note-body mode-${effectiveMode}`}>
        {effectiveMode === 'split' ? (
          <>
            <div className="pane-scroll split-left" ref={scrollRef} onScroll={updateScrollState}>
              <div className="doc-row">
                <div className="doc">
                  {titleBlock}
                  {editor}
                </div>
              </div>
            </div>
            <div className="pane-scroll split-right print-area">
              <div className="doc-row">
                <div className="doc">{preview}</div>
              </div>
            </div>
          </>
        ) : (
          <div className={`pane-scroll${effectiveMode === 'read' ? ' print-area' : ''}`} ref={scrollRef} onScroll={updateScrollState}>
            <div className={`doc-row${showRail ? ' has-rail' : ''}`}>
              <div className="doc">
                {titleBlock}
                {effectiveMode === 'edit' ? editor : preview}
                {emptyRead}
                {effectiveMode === 'read' && backlinks.length > 0 && (
                  <aside className="backlinks" aria-label="Linked from">
                    <h3>Linked from {backlinks.length} {backlinks.length === 1 ? 'note' : 'notes'}</h3>
                    <ul>
                      {backlinks.map((b) => (
                        <li key={b.id}>
                          <a
                            href={`/note/${b.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              openNote(b.id);
                            }}
                          >
                            <FileText size={15} />
                            <span>
                              <strong>{noteTitle(b.title)}</strong>
                              {b.excerpt && <span>{b.excerpt}</span>}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </aside>
                )}
              </div>
              {rail}
            </div>
          </div>
        )}

        {!isPhone && effectiveMode !== 'read' && (
          <div className={`dock-wrap${effectiveMode === 'split' ? ' is-split' : ''}`}>
            <Toolbar
              getView={() => editorRef.current?.view() ?? null}
              host={hostRef.current}
              onUndo={() => editorRef.current?.undo()}
              onRedo={() => editorRef.current?.redo()}
            />
          </div>
        )}
      </div>

      {isPhone && effectiveMode === 'edit' && (
        <div className="dock-bar">
          <Toolbar
            compact
            getView={() => editorRef.current?.view() ?? null}
            host={hostRef.current}
            onUndo={() => editorRef.current?.undo()}
            onRedo={() => editorRef.current?.redo()}
          />
        </div>
      )}

      {exportOpen && meta && (
        <ExportDialog
          note={{ id: noteId, title, content, tags: meta.tags, created_at: meta.created_at, updated_at: meta.updated_at }}
          onClose={() => useApp.setState({ exportFor: null })}
        />
      )}
    </section>
  );
}

function SaveIndicator({ status, error }: { status: SaveStatus; error: string | null }) {
  const map: Record<SaveStatus, { icon: React.ReactNode; text: string; cls: string; tip: string }> = {
    saved: { icon: <Cloud size={15} />, text: '', cls: 'is-saved', tip: 'All changes saved' },
    pending: { icon: <Loader size={14} className="spin" />, text: 'Saving', cls: 'is-pending', tip: 'Saving your changes' },
    saving: { icon: <Loader size={14} className="spin" />, text: 'Saving', cls: 'is-pending', tip: 'Saving your changes' },
    offline: { icon: <CloudOff size={15} />, text: 'Offline', cls: 'is-offline', tip: 'Saved on this device. Syncs when you reconnect.' },
    error: {
      icon: <CircleAlert size={15} />,
      text: 'Retrying',
      cls: 'is-error',
      tip: `${error ?? 'Couldn’t save yet.'} Retrying automatically.`,
    },
    failed: {
      icon: <CircleAlert size={15} />,
      text: 'Not saved',
      cls: 'is-error',
      tip: `${error ?? 'Couldn’t save.'} Your text is kept on this device; keep editing or press ${modKey()} S to try again.`,
    },
    conflict: { icon: <CircleAlert size={15} />, text: 'Conflict', cls: 'is-error', tip: 'Changed on another device' },
  };
  const s = map[status];
  return (
    <span className={`save-state ${s.cls}`} data-tip={s.tip} role="status">
      {status === 'saved' ? <Check size={15} aria-hidden="true" /> : s.icon}
      {s.text && <span aria-hidden="true">{s.text}</span>}
      <span className="sr-only">{s.tip}</span>
    </span>
  );
}
