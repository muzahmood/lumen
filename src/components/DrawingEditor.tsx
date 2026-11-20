import { useEffect, useRef, useState } from 'react';
import { convertToExcalidrawElements, Excalidraw, exportToSvg, getSceneVersion, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { api, ApiError, errorMessage } from '../lib/api';
import { useResolvedTheme } from '../lib/settings';
import { chooseDialog, confirmDialog, toast, useApp } from '../lib/store';
import type { DrawingInfo } from '../lib/types';
import { newId, relativeTime } from '../lib/utils';
import { localTextSealed, onBeforeLocalSeal } from '../lib/vault';
import { useBackLayer } from '../lib/backLayers';
import { Spinner } from './ui';

type ExcalidrawAPI = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0];
type InitialData = React.ComponentProps<typeof Excalidraw>['initialData'];

const BACKUP_KEY = 'kb.drawing-backup';
/** A crash copy older than this is stale enough not to offer. */
const BACKUP_MAX_AGE = 14 * 24 * 60 * 60 * 1000;

/**
 * One copy at a time, of whichever drawing was last changed and not yet saved. It records where the
 * drawing was opened from, so it's only offered back in the same place: the same drawing, or a new
 * drawing started from the same note (or from Home, for a null note).
 */
interface DrawingBackup {
  /** The drawing that was opened (null: a new drawing). */
  requestId: string | null;
  /** The note it was opened from (null: Home). */
  noteId: string | null;
  /** The drawing's id once saved; a new drawing gets one on its first Save. */
  id: string | null;
  at: number;
  scene: string;
}

function readBackup(requestId: string | null, noteId: string | null): DrawingBackup | null {
  try {
    const b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null') as Partial<DrawingBackup> | null;
    if (!b || typeof b.scene !== 'string' || typeof b.at !== 'number' || Date.now() - b.at > BACKUP_MAX_AGE) return null;
    // Copies written before requestId/noteId were recorded only knew the drawing's id.
    const sameDrawing = 'requestId' in b ? b.requestId === requestId && (requestId !== null || b.noteId === noteId) : b.id === requestId;
    return sameDrawing ? { requestId, noteId, id: b.id ?? null, at: b.at, scene: b.scene } : null;
  } catch {
    return null;
  }
}

function writeBackup(backup: DrawingBackup) {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  } catch {
    /* quota exceeded with large embedded images; skip */
  }
}

function clearBackup() {
  try {
    localStorage.removeItem(BACKUP_KEY);
  } catch {
    /* ignore */
  }
}

function sceneData(raw: unknown, scrollToContent: boolean): InitialData {
  const s = raw as { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
  return {
    elements: (s.elements ?? []) as never,
    appState: { ...(s.appState ?? {}), collaborators: new Map() } as never,
    files: (s.files ?? {}) as never,
    scrollToContent,
  };
}

/** Full-screen Excalidraw editor. Loaded on demand because the library is large. */
export default function DrawingEditor() {
  const request = useApp((s) => s.drawing);
  const theme = useResolvedTheme();
  const [initial, setInitial] = useState<InitialData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const baseVersion = useRef<number | null>(null);
  const dirty = useRef(false);
  /** What Cancel does (set below, once the drawing is open): Back does the same. */
  const cancelRef = useRef<() => unknown>(() => undefined);
  const createdAt = useRef<number | undefined>(undefined);
  /** Id once saved at least once in this session (new drawings get one on first save). */
  const savedId = useRef<string | null>(null);
  /**
   * The saved revision this editor's drawing is based on, sent with each save so one made elsewhere
   * meanwhile isn't silently replaced: null for a new drawing, undefined when unknown (the drawing
   * list couldn't be read, or a crash copy was restored after a warning that it replaces newer work).
   */
  const baseRev = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!request) return;
    setInitial(null);
    setLoadError(null);
    dirty.current = false;
    baseVersion.current = null;
    savedId.current = request.drawingId;
    baseRev.current = request.drawingId ? undefined : null;
    let cancelled = false;
    const id = request.drawingId;
    (async () => {
      let data: InitialData | null = null;
      let fetchError: unknown = null;
      let savedAt: number | undefined;
      if (id) {
        try {
          const [scene, list] = await Promise.all([api.getDrawingScene(id), api.listDrawings().catch(() => null)]);
          const info = list?.drawings.find((d) => d.id === id);
          createdAt.current = info?.created_at;
          savedAt = info?.updated_at;
          baseRev.current = info?.rev;
          data = sceneData(scene, true);
        } catch (err) {
          // Offline, say. A copy kept on this device may still be there to open.
          fetchError = err;
        }
      } else {
        data = { appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: false } as InitialData;
      }
      if (cancelled) return;
      // The browser closed or crashed mid-drawing last time: offer the copy kept on this device.
      const backup = readBackup(id, request.noteId);
      let restored = false;
      if (backup) {
        const newerSave = savedAt !== undefined && savedAt > backup.at;
        const ok = await confirmDialog({
          title: 'Restore your unsaved drawing?',
          message: `This device kept a copy of ${id ? 'this drawing' : 'a new drawing'} from ${relativeTime(backup.at)} that was never saved.${
            newerSave ? ' The drawing has been saved again since then, so restoring replaces that newer version once you save.' : ''
          }${fetchError ? ' The saved version can’t be reached right now.' : ''}`,
          confirmLabel: 'Restore it',
          cancelLabel: 'Not now',
        });
        if (cancelled) return;
        if (ok) {
          try {
            data = sceneData(JSON.parse(backup.scene), true);
            // A new drawing that was saved once keeps its id, so Done updates it and adds it to the note.
            if (backup.id) savedId.current = backup.id;
            // The dialog said restoring replaces anything saved since, so the save doesn't check.
            baseRev.current = undefined;
            restored = true;
          } catch {
            toast('That copy couldn’t be read, so the last saved version is open instead.', { kind: 'error' });
          }
        }
        // "Not now" keeps the copy: it's offered again next time, until this drawing is saved or discarded.
      }
      if (!data) throw fetchError;
      setInitial(data);
      // A restored copy isn't saved yet: closing without saving should still ask.
      if (restored) dirty.current = true;
    })().catch((err) => !cancelled && setLoadError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Keep a local copy while drawing, in case the tab crashes, closes or reloads: every 15 seconds,
  // and right away when the page is hidden or closed.
  useEffect(() => {
    if (!request) return;
    const keep = () => {
      const a = apiRef.current;
      // Once the device is locking, the copy has been (or is being) encrypted: rewriting it here, as
      // the page reloads to the unlock screen, would leave the drawing readable in the browser.
      if (!a || !dirty.current || localTextSealed()) return;
      writeBackup({
        requestId: request.drawingId,
        noteId: request.noteId,
        id: savedId.current,
        at: Date.now(),
        scene: serializeAsJSON(a.getSceneElements(), a.getAppState(), a.getFiles(), 'local'),
      });
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') keep();
    };
    const t = setInterval(keep, 15000);
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', keep);
    // Locking: the latest strokes go into the copy just before it's encrypted with the rest.
    const stopKeepingOnLock = onBeforeLocalSeal(keep);
    return () => {
      stopKeepingOnLock();
      clearInterval(t);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', keep);
    };
  }, [request]);

  // Back (a phone's back gesture) closes it as Cancel does: asking first about unsaved changes, and
  // staying (with Back armed again) if the answer is to keep drawing.
  useBackLayer(!!request, () => cancelRef.current());

  if (!request) return null;

  const finish = (id: string | null) => {
    useApp.setState({ drawing: null });
    request.resolve(id);
  };

  const save = async (close: boolean) => {
    const a = apiRef.current;
    if (!a) return;
    const elements = a.getSceneElements();
    if (!elements.length && !savedId.current) {
      finish(null);
      return;
    }
    setSaving(true);
    try {
      const appState = a.getAppState();
      const files = a.getFiles();
      const scene = serializeAsJSON(elements, appState, files, 'local');
      const svgEl = await exportToSvg({
        elements,
        appState: { ...appState, exportBackground: false, exportWithDarkMode: false, exportEmbedScene: false },
        files,
        exportPadding: 24,
      });
      svgEl.setAttribute('role', 'img');
      const svg = new XMLSerializer().serializeToString(svgEl);
      const text = elements
        .filter((e) => e.type === 'text')
        .map((e) => (e as unknown as { text: string }).text)
        .join('\n');
      let id = savedId.current ?? newId();
      for (;;) {
        try {
          const saved = await api.saveDrawing(id, { scene, svg, noteId: request.noteId, text, createdAt: createdAt.current, baseRev: baseRev.current });
          baseRev.current = saved.rev;
          break;
        } catch (err) {
          if (!(err instanceof ApiError && err.code === 'drawing_conflict')) throw err;
          const theirs = (err.data as { drawing?: DrawingInfo | null } | undefined)?.drawing ?? null;
          const choice = await chooseDialog({
            title: 'This drawing was changed somewhere else',
            message: `It was saved ${theirs ? relativeTime(theirs.updated_at) : 'since you opened it'} on another device or tab. Save yours as a separate drawing in this note, or replace that version with yours (it can’t be brought back).`,
            confirmLabel: 'Save as a copy',
            altLabel: 'Replace theirs',
            cancelLabel: 'Keep editing',
          });
          if (choice === null) return;
          if (choice === 'confirm') {
            id = newId();
            baseRev.current = null;
            createdAt.current = undefined;
          } else {
            // Replace exactly the version just reported; a newer one still asks again.
            baseRev.current = theirs?.rev ?? null;
          }
        }
      }
      savedId.current = id;
      clearBackup();
      dirty.current = false;
      baseVersion.current = getSceneVersion(elements);
      if (close) finish(id);
      else toast('Drawing saved');
    } catch (err) {
      toast(`Couldn’t save the drawing: ${errorMessage(err)}`, { kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    if (dirty.current) {
      const ok = await confirmDialog({
        title: 'Discard changes to this drawing?',
        message: 'Your edits since the last save will be lost.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
      // Discarded on purpose, so there's nothing to offer back next time. (Closing without changes
      // leaves a copy that was put off with "Not now" in place.)
      clearBackup();
    }
    // A drawing saved earlier in this session still needs to reach the note.
    finish(savedId.current);
  };
  cancelRef.current = cancel;

  return (
    <div className="drawing-overlay" role="dialog" aria-modal="true" aria-label="Drawing editor">
      <header className="drawing-bar">
        <button type="button" className="btn btn-ghost" onClick={() => void cancel()} disabled={saving}>
          Cancel
        </button>
        <span className="drawing-title">{request.drawingId ? 'Edit drawing' : 'New drawing'}</span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void save(false)} disabled={saving || !initial}>
          Save
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={saving || !initial}>
          {saving ? 'Saving…' : 'Done'}
        </button>
      </header>
      <div className="drawing-host">
        {loadError ? (
          <div className="note-empty">
            <p>This drawing couldn’t be opened. {loadError}</p>
            <button type="button" className="btn" onClick={() => finish(null)}>
              Close
            </button>
          </div>
        ) : !initial ? (
          <div className="note-empty">
            <Spinner label="Loading drawing" />
          </div>
        ) : (
          <Excalidraw
            initialData={initial}
            theme={theme}
            excalidrawAPI={(a) => {
              apiRef.current = a;
              // Handy for debugging from the console during development.
              if (import.meta.env.DEV) {
                Object.assign(window, { __kbDrawing: a, __kbConvert: convertToExcalidrawElements });
              }
            }}
            onChange={(elements) => {
              const v = getSceneVersion(elements);
              if (baseVersion.current === null) baseVersion.current = v;
              else if (v !== baseVersion.current) dirty.current = true;
            }}
            UIOptions={{
              canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: true },
            }}
            aiEnabled={false}
          />
        )}
      </div>
    </div>
  );
}
