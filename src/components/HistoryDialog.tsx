import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { flush } from '../lib/saver';
import { confirmDialog, noteCache, toast, useApp } from '../lib/store';
import type { VersionInfo } from '../lib/types';
import { formatBytes, fullDate, relativeTime } from '../lib/utils';
import { knownText } from '../lib/liveEdit';
import { DiffView } from './DiffView';
import { Preview } from './Preview';
import { Modal, Segmented, Spinner } from './ui';

export function HistoryDialog() {
  const noteId = useApp((s) => s.historyFor);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [content, setContent] = useState<{ id: number; title: string; content: string; titleUnreadable?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What restoring would change, by default: the version compared with the note as it is now.
  const [view, setView] = useState<'changes' | 'preview'>('changes');
  const currentTitle = useApp((s) => (s.historyFor ? s.notes[s.historyFor]?.title : '')) ?? '';

  useEffect(() => {
    if (!noteId) return;
    // Answers for a note no longer shown (history opened for another meanwhile) are dropped.
    let live = true;
    setVersions(null);
    setSelected(null);
    setContent(null);
    setError(null);
    flush(noteId)
      .then(() => api.versions(noteId))
      .then((r) => {
        if (!live) return;
        setVersions(r.versions);
        if (r.versions[0]) setSelected(r.versions[0].id);
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [noteId]);

  useEffect(() => {
    if (selected === null) return;
    setContent(null);
    setError(null);
    if (!noteId) return;
    // Only the snapshot picked last is shown (and so restored): an earlier pick whose answer arrives
    // after it is dropped.
    let live = true;
    api
      .version(selected, noteId)
      .then((v) => live && setContent({ id: selected, title: v.title, content: v.content, titleUnreadable: v.titleUnreadable }))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [selected, noteId]);

  if (!noteId) return null;
  const close = () => useApp.setState({ historyFor: null });

  const restore = async () => {
    if (!content || content.id !== selected) return;
    const ok = await confirmDialog({
      title: 'Restore this version?',
      message: 'The current text is kept in history, so you can switch back later.',
      confirmLabel: 'Restore version',
    });
    if (!ok) return;
    try {
      const current = noteCache.get(noteId) ?? (await api.getNote(noteId));
      // A title that couldn't be decrypted stays as it is rather than being replaced by a blank.
      const title = content.titleUnreadable ? undefined : content.title;
      const meta = await api.updateNote(noteId, { ...(title !== undefined ? { title } : {}), content: content.content, force: true, snapshot: true });
      noteCache.set(noteId, { ...current, ...meta, ...(title !== undefined ? { title } : {}), content: content.content });
      // Remount the note view so the editor picks up the restored text.
      useApp.setState((s) => ({ notes: { ...s.notes, [noteId]: meta }, reloadToken: s.reloadToken + 1 }));
      close();
      toast('Version restored', { kind: 'success' });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  return (
    <Modal
      open
      size="xl"
      title="Version history"
      description="Pick a snapshot to see what’s changed since, then restore it if you need it back."
      onClose={close}
      className="history-modal"
      footer={
        <>
          <span className="footer-note">A snapshot is kept every 10 minutes while you edit, up to 50 per note.</span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={close}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={!content} onClick={() => void restore()}>
            Restore this version
          </button>
        </>
      }
    >
      {error && <p className="dialog-message error-text">{error}</p>}
      {!versions && !error && <Spinner />}
      {versions && versions.length === 0 && (
        <p className="dialog-message">No earlier versions yet. Snapshots appear after you edit this note over time.</p>
      )}
      {versions && versions.length > 0 && (
        <div className="history-split">
          <ul className="history-list">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`history-item${selected === v.id ? ' is-active' : ''}`}
                  onClick={() => setSelected(v.id)}
                  title={fullDate(v.created_at)}
                >
                  <span>{relativeTime(v.created_at)}</span>
                  <span className="history-meta">
                    {new Date(v.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    {'  '}
                    {formatBytes(v.size)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="history-preview">
            <div className="history-view">
              <Segmented
                label="Show"
                value={view}
                onChange={setView}
                size="sm"
                options={[
                  { value: 'changes', label: 'Changes' },
                  { value: 'preview', label: 'Preview' },
                ]}
              />
            </div>
            {!content ? (
              <Spinner />
            ) : view === 'changes' ? (
              <DiffView
                before={{ title: content.titleUnreadable ? currentTitle : content.title, content: content.content }}
                after={{ title: currentTitle, content: knownText(noteId)?.content ?? '' }}
                beforeLabel="In this version"
                afterLabel="In the note now"
              />
            ) : (
              <>
                <h1 className="history-title">{content.title || 'Untitled'}</h1>
                <Preview source={content.content} readOnly />
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
