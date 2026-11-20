import { useEffect, useState, type ReactNode } from 'react';
import {
  Check,
  CircleAlert,
  Database,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  Palette,
  PencilLine,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import { api, errorMessage, type BackupInfo, type BackupList } from '../lib/api';
import { exportBackup, importMarkdownFiles, restoreBackup, restoreSummary } from '../lib/backup';
import { deleteUnusedFiles, findUnusedFiles, NOTHING_UNUSED, unusedFilesQuestion } from '../lib/cleanup';
import { ACCENTS, useSettings, type Accent, type Settings } from '../lib/settings';
import { signOutOfDevice } from '../lib/signout';
import { confirmDialog, promptDialog, toast, useApp } from '../lib/store';
import { pickFiles } from '../lib/upload';
import { altKey, downloadBlob, formatBytes, fullDate, modKey, relativeTime } from '../lib/utils';
import { EncryptionSettings } from './Encryption';
import { Modal, Segmented } from './ui';

type Section = 'general' | 'appearance' | 'editor' | 'data' | 'security' | 'shortcuts';

const SECTIONS: Array<{ id: Section; label: string; icon: ReactNode }> = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={16} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} /> },
  { id: 'editor', label: 'Editor', icon: <PencilLine size={16} /> },
  { id: 'data', label: 'Data and backup', icon: <Database size={16} /> },
  { id: 'security', label: 'Security', icon: <ShieldCheck size={16} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={16} /> },
];

function Row({ label, hint, children, stack }: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`setting${stack ? ' is-stacked' : ''}`}>
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle<K extends keyof Settings>({ k, label }: { k: K; label: string }) {
  const value = useSettings((s) => s[k]) as boolean;
  const update = useSettings((s) => s.update);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      className={`switch${value ? ' is-on' : ''}`}
      onClick={() => update({ [k]: !value } as Partial<Settings>)}
    >
      <span />
    </button>
  );
}

function ThemeCard({ value, label, icon }: { value: Settings['theme']; label: string; icon: ReactNode }) {
  const theme = useSettings((s) => s.theme);
  const update = useSettings((s) => s.update);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={theme === value}
      className={`theme-card${theme === value ? ' is-on' : ''}`}
      onClick={() => update({ theme: value })}
    >
      <span className={`theme-preview theme-preview-${value}`} aria-hidden="true">
        <span className="tp-side" />
        <span className="tp-main">
          <span className="tp-line" />
          <span className="tp-line short" />
          <span className="tp-dot" />
        </span>
      </span>
      <span className="theme-card-label">
        {icon} {label}
      </span>
    </button>
  );
}

type Stats = Awaited<ReturnType<typeof api.stats>>;

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen);
  const me = useApp((s) => s.me);
  const encrypted = useApp((s) => s.encryption.on);
  const lastBackup = useApp((s) => s.lastBackup);
  const settings = useSettings();
  const [section, setSection] = useState<Section>('general');
  const [stats, setStats] = useState<Stats | null>(null);
  // Backups kept on the server (automatic ones): null until asked, or when the server can't say.
  const [kept, setKept] = useState<BackupList | null>(null);
  const refreshKept = () => api.listBackups().then(setKept, () => setKept(null));
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  // Opened for a particular section (the backup reminder on Home opens Data).
  const requested = useApp((s) => s.settingsSection);
  useEffect(() => {
    if (!open || !requested) return;
    if (SECTIONS.some((s) => s.id === requested)) setSection(requested as Section);
    useApp.setState({ settingsSection: null });
  }, [open, requested]);

  useEffect(() => {
    if (open && section === 'data') {
      api.stats().then(setStats).catch(() => setStats(null));
      void refreshKept();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section]);

  if (!open) return null;
  const close = () => {
    if (!busy) useApp.setState({ settingsOpen: false });
  };

  const run = async (label: string, fn: (p: (m: string, f?: number) => void) => Promise<void>) => {
    setBusy(label);
    setProgress(0);
    try {
      await fn((m, f) => {
        setBusy(m);
        if (f !== undefined) setProgress(f);
      });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    } finally {
      setBusy(null);
      setProgress(null);
      api.stats().then(setStats).catch(() => undefined);
    }
  };

  /** Downloads a backup of everything: encrypted (with encryption on), or a readable .zip after a warning. */
  const backup = async (sealed: boolean) => {
    if (encrypted && !sealed) {
      const ok = await confirmDialog({
        title: 'Download a readable copy?',
        message: 'This .zip isn’t encrypted: anyone who gets the file can read every note, image and drawing in it. Keep it somewhere safe.',
        confirmLabel: 'Download readable copy',
      });
      if (!ok) return;
    }
    await run(sealed ? 'Preparing encrypted backup…' : 'Preparing backup…', async (p) => {
      const { blob, filename, missing, unreadable } = await exportBackup(p, { encrypted: sealed });
      downloadBlob(blob, filename);
      // Remembered for every device, for the reminder on Home.
      api.markBackup().then(
        ({ at }) => useApp.setState({ lastBackup: at }),
        () => undefined,
      );
      const names = (list: string[]) => list.slice(0, 3).join(', ') + (list.length > 3 ? `, and ${list.length - 3} more` : '');
      const gaps: string[] = [];
      if (unreadable.length) {
        const one = unreadable.length === 1;
        gaps.push(
          `Backup downloaded without ${one ? 'one note' : `${unreadable.length} notes`} this device can’t decrypt: ${names(unreadable.map((t) => `“${t}”`))}. ${one ? 'It was' : 'They were'} encrypted with a different key, or changed outside Lumen.`,
        );
      }
      if (missing.length) {
        gaps.push(
          `${gaps.length ? '' : 'Backup downloaded, but '}${missing.length} ${missing.length === 1 ? 'file' : 'files'} couldn’t be included${gaps.length ? ' either' : ''}: ${names(missing)}. Check your connection and try again.`,
        );
      }
      if (gaps.length) toast(gaps.join(' '), { kind: 'error', timeout: 15000 });
      else toast(sealed ? 'Encrypted backup downloaded' : 'Backup downloaded', { kind: 'success' });
    });
  };

  /** For an encrypted backup this device has no key for: the passphrase or recovery key from when it was made. */
  const askBackupSecret = (retry: boolean) =>
    promptDialog({
      title: 'Unlock this backup',
      message: `${retry ? 'That didn’t open it. ' : ''}This backup is encrypted, and this device doesn’t have its key. Enter the passphrase or recovery key you had when you made it.`,
      placeholder: 'Passphrase or recovery key',
      confirmLabel: 'Unlock',
      secret: true,
    });

  const restoreFile = (file: File) =>
    run('Restoring…', async (p) => {
      const r = await restoreBackup(file, p, askBackupSecret);
      if (r) {
        const { message, kind } = restoreSummary(r);
        toast(message, { kind, ...(kind === 'error' ? { timeout: 15_000 } : {}) });
      }
    });

  const restoreKept = async (b: BackupInfo) => {
    const ok = await confirmDialog({
      title: `Restore the backup from ${fullDate(b.made_at)}?`,
      message: 'Notes in it replace notes with the same id here. Notes made since stay as they are.',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    let file: File | null = null;
    await run('Downloading backup…', async () => {
      file = new File([(await api.fetchBackup(b.name)) as BlobPart], b.name);
    });
    if (file) await restoreFile(file);
  };

  const downloadKept = (b: BackupInfo) =>
    run('Downloading backup…', async () => {
      downloadBlob(new Blob([(await api.fetchBackup(b.name)) as BlobPart], { type: 'application/octet-stream' }), `lumen-${b.name}`);
    });

  const backUpNow = () =>
    run(encrypted ? 'Preparing encrypted backup…' : 'Preparing backup…', async () => {
      const { backUpIfDue } = await import('../lib/autoBackup');
      await backUpIfDue({ force: true });
      await refreshKept();
    });

  const cleanup = () =>
    run('Checking for unused files…', async () => {
      const preview = await findUnusedFiles();
      if (!preview.files.length && !preview.drawings.length) {
        toast(NOTHING_UNUSED, { kind: 'success' });
        return;
      }
      if (!(await confirmDialog(unusedFilesQuestion(preview)))) return;
      const done = await deleteUnusedFiles(preview);
      toast(`Freed ${formatBytes(done.bytes)}`, { kind: 'success' });
    });

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <Modal open size="xl" onClose={close} className="settings" bare label="Settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="settings-nav-title">Settings</p>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item${section === s.id ? ' is-active' : ''}`}
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <h2>{current.label}</h2>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Close settings" onClick={close}>
              <X size={16} />
            </button>
          </header>
          <div className="settings-body">
            {section === 'general' && (
              <>
                <Row label="Workspace name" hint="Shown at the top of the sidebar and on Home.">
                  <input
                    className="input input-sm"
                    aria-label="Workspace name"
                    value={settings.workspaceName}
                    maxLength={40}
                    onChange={(e) => settings.update({ workspaceName: e.target.value })}
                  />
                </Row>
                <Row label="Note previews in lists" hint="Show a short preview, thumbnail and task progress under each note title.">
                  <Toggle k="listPreviews" label="Note previews in lists" />
                </Row>
                <Row label="Outline on wide screens" hint="Lists a note’s headings beside it so you can jump between sections.">
                  <Toggle k="showOutline" label="Outline on wide screens" />
                </Row>
                <p className="setting-note">
                  Settings follow you to your other devices (encrypted with your notes when they are), except text size, the
                  width of the sidebar and note list, which folders are open, and locking automatically, which are set for each
                  device.
                </p>
              </>
            )}

            {section === 'appearance' && (
              <>
                <Row label="Theme" stack>
                  <div className="theme-cards" role="radiogroup" aria-label="Theme">
                    <ThemeCard value="system" label="System" icon={<Monitor size={14} />} />
                    <ThemeCard value="light" label="Light" icon={<Sun size={14} />} />
                    <ThemeCard value="dark" label="Dark" icon={<Moon size={14} />} />
                  </div>
                </Row>
                <Row label="Accent color" hint="Used for buttons, links, selection and the logo.">
                  <div className="swatches" role="radiogroup" aria-label="Accent color">
                    {(Object.keys(ACCENTS) as Accent[]).map((a) => (
                      <button
                        key={a}
                        type="button"
                        role="radio"
                        aria-checked={settings.accent === a}
                        aria-label={ACCENTS[a].label}
                        data-tip={ACCENTS[a].label}
                        className={`swatch${settings.accent === a ? ' is-on' : ''}`}
                        style={{ ['--swatch' as string]: ACCENTS[a].light, ['--swatch-dark' as string]: ACCENTS[a].dark }}
                        onClick={() => settings.update({ accent: a })}
                      >
                        {settings.accent === a && <Check size={13} strokeWidth={3} />}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label="Note font" stack>
                  <div className="font-cards" role="radiogroup" aria-label="Note font">
                    {(
                      [
                        ['sans', 'Sans', 'Clean and modern'],
                        ['serif', 'Serif', 'Bookish, for long reads'],
                        ['mono', 'Mono', 'For technical notes'],
                      ] as const
                    ).map(([v, label, desc]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={settings.noteFont === v}
                        className={`font-card font-card-${v}${settings.noteFont === v ? ' is-on' : ''}`}
                        onClick={() => settings.update({ noteFont: v })}
                      >
                        <span className="font-sample">Ag</span>
                        <span className="font-name">{label}</span>
                        <span className="font-desc">{desc}</span>
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label="Text size" hint={`${settings.fontSize}px`}>
                  <input
                    type="range"
                    className="range"
                    min={14}
                    max={21}
                    step={1}
                    value={settings.fontSize}
                    onChange={(e) => settings.update({ fontSize: Number(e.target.value) })}
                    aria-label="Text size"
                  />
                </Row>
                <Row label="Line width">
                  <Segmented
                    label="Line width"
                    value={settings.readingWidth}
                    onChange={(v) => settings.update({ readingWidth: v })}
                    options={[
                      { value: 'narrow', label: 'Narrow' },
                      { value: 'normal', label: 'Normal' },
                      { value: 'wide', label: 'Wide' },
                    ]}
                  />
                </Row>
              </>
            )}

            {section === 'editor' && (
              <>
                <Row label="Open notes in">
                  <Segmented
                    label="Open notes in"
                    value={settings.defaultMode}
                    onChange={(v) => settings.update({ defaultMode: v })}
                    options={[
                      { value: 'edit', label: 'Edit' },
                      { value: 'split', label: 'Split' },
                      { value: 'read', label: 'Read' },
                    ]}
                  />
                </Row>
                <Row
                  label="Live preview"
                  hint="Hide Markdown symbols on lines you aren’t editing, and show checkboxes, images and diagrams in place."
                >
                  <Toggle k="livePreview" label="Live preview" />
                </Row>
                {!settings.livePreview && (
                  <Row label="Image thumbnails" hint="Show small previews under image links while editing Markdown.">
                    <Toggle k="editorImages" label="Image thumbnails" />
                  </Row>
                )}
                <Row label="Single line breaks" hint="In reading view, start a new line wherever you pressed Enter.">
                  <Toggle k="lineBreaks" label="Single line breaks" />
                </Row>
                <Row label="Spell check">
                  <Toggle k="spellcheck" label="Spell check" />
                </Row>
                <Row
                  label="Date ticked tasks"
                  hint="Add the day a task is ticked (✅ 2026-11-20): to tasks with a due date or that repeat, to every task, or to none. A repeating task (🔁 every week) comes back, due on its next date, whichever you choose."
                >
                  <Segmented
                    label="Date ticked tasks"
                    value={settings.taskDoneDates}
                    onChange={(v) => settings.update({ taskDoneDates: v })}
                    options={[
                      { value: 'dated', label: 'With dates' },
                      { value: 'all', label: 'All' },
                      { value: 'off', label: 'Off' },
                    ]}
                  />
                </Row>
                <Row label="Shrink large photos" hint="Resize photos to 2560px and convert them to WebP before upload.">
                  <Toggle k="compressImages" label="Shrink large photos" />
                </Row>
              </>
            )}

            {section === 'data' && (
              <>
                <div className="stat-grid">
                  <div className="stat">
                    <span className="stat-value">{stats ? stats.notes.active ?? 0 : '–'}</span>
                    <span className="stat-label">Notes</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{stats ? formatBytes(stats.files.bytes) : '–'}</span>
                    <span className="stat-label">{stats ? `${stats.files.count} files` : 'Files'}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-value">{stats ? formatBytes(stats.drawings.bytes) : '–'}</span>
                    <span className="stat-label">{stats ? `${stats.drawings.count} drawings` : 'Drawings'}</span>
                  </div>
                </div>
                <Row
                  label="File storage"
                  hint={
                    me?.storage === 'r2'
                      ? 'Cloudflare R2, 10 GB free.'
                      : me?.storage === 'kv'
                        ? 'Cloudflare Workers KV, 1 GB free. Add an R2 bucket for more room (see the README).'
                        : 'Not set up yet. Uploads stay off until a KV namespace or R2 bucket is connected.'
                  }
                >
                  <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void cleanup()}>
                    Remove unused files
                  </button>
                </Row>
                <Row
                  label="Back up everything"
                  hint={
                    <>
                      {encrypted
                        ? 'An encrypted file of every note, image and drawing. It opens in Lumen with your passphrase or recovery key (the ones you have when you make it), even if this Lumen is gone.'
                        : 'Download a .zip of every note, image and drawing. Notes inside are plain Markdown.'}{' '}
                      <span className="backup-when">{lastBackup ? `Last backup ${relativeTime(lastBackup)}.` : 'No backup made yet.'}</span>
                    </>
                  }
                >
                  <div className="row-actions">
                    {encrypted && (
                      <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void backup(false)}>
                        Readable .zip
                      </button>
                    )}
                    <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void backup(encrypted)}>
                      Download backup
                    </button>
                  </div>
                </Row>
                <Row
                  label="Restore a backup"
                  hint="Bring back notes and files from a Lumen backup (encrypted, or a .zip). Notes with the same id are replaced."
                >
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={async () => {
                      const [file] = await pickFiles('.lumenbackup,.zip,application/zip', false);
                      if (!file) return;
                      const ok = await confirmDialog({
                        title: 'Restore from this backup?',
                        message: `Notes in ${file.name} replace notes with the same id here.`,
                        confirmLabel: 'Restore',
                      });
                      if (!ok) return;
                      await restoreFile(file);
                    }}
                  >
                    Choose file
                  </button>
                </Row>
                <Row
                  label="Automatic backups"
                  hint={
                    kept?.available
                      ? `About once a week, whichever device has Lumen open makes a backup${encrypted ? ' (encrypted on it, as above)' : ''} and keeps it on your Cloudflare account, in a bucket of its own. The newest ${kept.keep} are kept.`
                      : kept
                        ? 'Not set up on this Lumen: they need an R2 bucket of their own. The README says how.'
                        : 'Checking…'
                  }
                >
                  {kept?.available && <Toggle k="autoBackup" label="Automatic backups" />}
                </Row>
                {kept?.available && (
                  <div className="kept-backups">
                    {kept.backups.length === 0 ? (
                      <p className="kept-empty">None kept yet. The first is made a few minutes after Lumen opens.</p>
                    ) : (
                      <ul aria-label="Kept backups">
                        {kept.backups.map((b) => (
                          <li key={b.name} className="kept-backup">
                            <span className="kept-when">
                              {fullDate(b.made_at)}
                              <span className="kept-size">
                                {formatBytes(b.size)}
                                {b.encrypted ? ', encrypted' : ''}
                              </span>
                            </span>
                            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void restoreKept(b)} aria-label={`Restore the backup from ${fullDate(b.made_at)}`}>
                              Restore
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => void downloadKept(b)} aria-label={`Download the backup from ${fullDate(b.made_at)}`}>
                              Download
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void backUpNow()}>
                      Back up now
                    </button>
                  </div>
                )}
                <Row label="Import Markdown" hint="Each .md or .txt file becomes a note in the folder you’re viewing.">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={async () => {
                      const files = await pickFiles('.md,.markdown,.txt,text/markdown,text/plain');
                      if (!files.length) return;
                      await run('Importing…', async (p) => {
                        const n = await importMarkdownFiles(files, p);
                        toast(`Imported ${n} ${n === 1 ? 'note' : 'notes'}`, { kind: 'success' });
                      });
                    }}
                  >
                    Choose files
                  </button>
                </Row>
                {busy && (
                  <div className="progress" role="status">
                    <span>{busy}</span>
                    <div className="progress-bar">
                      <div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
                    </div>
                  </div>
                )}
              </>
            )}

            {section === 'security' && (
              <>
                {me?.verified ? (
                  <div className="callout-card is-ok">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>Protected by Cloudflare Access</strong>
                      <p>Every request is checked before any note is sent{me.email ? `. Signed in as ${me.email}.` : '.'}</p>
                    </div>
                  </div>
                ) : (
                  <div className="callout-card is-warn">
                    <CircleAlert size={20} />
                    <div>
                      <strong>Running locally without Cloudflare Access</strong>
                      <p>
                        That’s expected on your own computer. Once deployed, nothing (not even the app itself) is served until Cloudflare Access
                        has signed you in.
                      </p>
                    </div>
                  </div>
                )}
                <EncryptionSettings Row={Row} />
                <Row
                  label="Images from other websites"
                  hint="Loading one tells that website your IP address and when you opened the note. Ask first shows a box to click instead."
                >
                  <select
                    className="input input-sm select-input"
                    value={settings.remoteImages}
                    aria-label="Images from other websites"
                    onChange={(e) => settings.update({ remoteImages: e.target.value as 'load' | 'ask' })}
                  >
                    <option value="load">Load automatically</option>
                    <option value="ask">Ask first</option>
                  </select>
                </Row>
                <Row
                  label="Sign out of this device"
                  hint="Removes the notes, files and drawings this browser keeps for offline use, then ends your Access session."
                >
                  <button type="button" className="btn btn-sm" onClick={() => void signOutOfDevice(me?.via === 'local')}>
                    <LogOut size={14} /> Sign out
                  </button>
                </Row>
                <p className="setting-note">
                  Notes live in your own Cloudflare account: text in a D1 database, files in {me?.storage === 'r2' ? 'R2' : 'Workers KV'}. Unsaved
                  edits are also kept in this browser until the server confirms them
                  {encrypted ? ', encrypted whenever this device is locked.' : '.'}
                </p>
                {encrypted && (
                  <p className="setting-note">
                    Encryption protects what’s stored. The app itself still comes from your Worker, so anyone who could change its code
                    could capture your passphrase the next time you unlock: keep your Cloudflare and GitHub accounts behind two-step sign-in.
                    D1 keeps its own restore points (Time Travel) for up to 30 days, so copies from before encryption was turned on last
                    that long.
                  </p>
                )}
              </>
            )}

            {section === 'shortcuts' && (
              <div className="shortcuts">
                {[
                  [`${modKey()} K`, 'Search notes and run commands'],
                  [`${modKey()} Enter`, 'In search: new note with the typed title'],
                  ['Alt N', 'New note'],
                  ['↑ ↓', 'Move between notes in the list'],
                  [`${modKey()} click, Shift click`, 'Choose several notes in the list'],
                  [`${modKey()} A`, 'Choose every note in the list (Esc lets them go)'],
                  ['→ ←', 'Open or close a folder in the sidebar'],
                  [`${modKey()} E`, 'Switch between reading and editing'],
                  [`${modKey()} S`, 'Save now'],
                  [`${modKey()} \\`, 'Show or hide the sidebar'],
                  [`${modKey()} ,`, 'Open settings'],
                  [`${modKey()} B`, 'Bold'],
                  [`${modKey()} I`, 'Italic'],
                  [`${modKey()} Shift H`, 'Highlight'],
                  [`${modKey()} Shift K`, 'Insert link'],
                  [`${modKey()} Shift V`, 'Paste as plain text (a normal paste turns formatting into Markdown)'],
                  [`${modKey()} Enter`, 'Tick a task (or make the line one)'],
                  [`${modKey()} ${altKey()} 1–6`, 'Heading 1 to 6'],
                  [`${modKey()} ${altKey()} 0`, 'Plain text'],
                  [`${modKey()} F`, 'Find in note'],
                  [`${modKey()} click`, 'Open a link while editing'],
                  ['/', 'Insert menu'],
                  ['[[', 'Link to another note'],
                ].map(([k, d]) => (
                  <div key={d} className="shortcut">
                    <span>{d}</span>
                    <span className="shortcut-keys">
                      {k.split(' ').map((p) => (
                        <kbd key={p}>{p}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
