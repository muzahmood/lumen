import { useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { Copy, Download, Eye, EyeOff, KeyRound, Lock, LockKeyhole, ShieldCheck, Shuffle } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { encryptAttachments, encryptLibrary, notesTooLarge, rekeyLibrary } from '../lib/e2ee';
import { loadEstimator, strengthOf, suggestPassphrase } from '../lib/passphrase';
import { flushAll, hasUnsaved } from '../lib/saver';
import { useSettings } from '../lib/settings';
import { signOutOfDevice } from '../lib/signout';
import { loadAll, toast, useApp } from '../lib/store';
import { downloadBlob } from '../lib/utils';
import {
  changePassphrase,
  lock,
  prepareKeyReplacement,
  prepareSetup,
  recoverWithKey,
  replaceRecoveryKey,
  takeLockNotice,
  unlockWithPassphrase,
  useVault,
  vaultKey,
  type PreparedSetup,
} from '../lib/vault';
import { BrandMark } from './Sidebar';
import { Spinner } from './ui';

const MIN_PASSPHRASE = 10;

function SecretInput({
  value,
  onChange,
  label,
  autoComplete,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  // Uncontrolled on purpose. React copies a controlled input's value into its `value` attribute,
  // where CSS attribute selectors can read it, so any stray style rule (say, from a note's diagram)
  // could leak the passphrase character by character. The property, set here, never reaches the DOM.
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.value !== value) ref.current.value = value;
  }, [value]);
  return (
    <span className="secret-input">
      <input
        ref={ref}
        className="input"
        type={shown ? 'text' : 'password'}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        placeholder={label}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="secret-toggle"
        aria-label={shown ? 'Hide' : 'Show'}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </span>
  );
}

/**
 * Problems with a new passphrase, in words for the person; null when it's fine. Too easy to guess is
 * one: anyone with a copy of the encryption settings can try passphrases offline (see passphrase.ts).
 * If the estimator can't load (offline, say), only the length is checked.
 */
async function passphraseProblem(next: string, confirm: string): Promise<string | null> {
  if (next.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters. A few unrelated words work well.`;
  await loadEstimator().catch(() => undefined);
  const strength = strengthOf(next);
  if (strength && !strength.enough) {
    return `That passphrase could be guessed in ${strength.time} by someone with a copy of your encryption settings. Add more unrelated words, or use a suggested one.`;
  }
  if (next !== confirm) return 'The two passphrases don’t match.';
  return null;
}

/** How long a passphrase would take to guess, as it's typed. */
function StrengthLine({ value }: { value: string }) {
  const strength = value ? strengthOf(value) : null;
  if (!strength) return null;
  return (
    <div className={`strength is-${strength.level}`}>
      <span className="strength-bar" aria-hidden="true">
        <span style={{ width: `${(strength.level + 1) * 20}%` }} />
      </span>
      <span className="strength-text">
        <strong>{strength.label}.</strong> {strength.time === 'under a second' ? 'Guessed' : `About ${strength.time.replace(/^about /, '')} to guess`}
        {strength.time === 'under a second' ? ' at once' : ''} for someone with a copy of your encryption settings and a fast graphics card.
        {strength.warning ? ` ${strength.warning}` : ''}
      </span>
    </div>
  );
}

/**
 * A new passphrase: typed twice, with how long it would take to guess as it's typed, and a strong
 * one to suggest (six random words, shown once so it can be saved, and filled in).
 */
function NewPassphrase({
  value,
  onChange,
  again,
  onAgain,
  labels = ['Passphrase', 'Passphrase again'],
}: {
  value: string;
  onChange: (v: string) => void;
  again: string;
  onAgain: (v: string) => void;
  labels?: [string, string];
}) {
  const [, setReady] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadEstimator().then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const suggest = async () => {
    try {
      const words = await suggestPassphrase();
      setSuggested(words);
      onChange(words);
      onAgain(words);
    } catch {
      toast('Couldn’t make a suggestion just now. Check your connection and try again.', { kind: 'error' });
    }
  };
  return (
    <>
      <SecretInput value={value} onChange={onChange} label={labels[0]} autoComplete="new-password" />
      <SecretInput value={again} onChange={onAgain} label={labels[1]} autoComplete="new-password" />
      <div className="strength-row" aria-live="polite">
        <StrengthLine value={value} />
      </div>
      {suggested && value === suggested ? (
        <div className="suggested-passphrase">
          <p className="setting-hint">Your new passphrase. Save it in your password manager, or write it down: nobody can reset it for you.</p>
          <code className="recovery-key" aria-label="Suggested passphrase">
            {suggested}
          </code>
          <div className="recovery-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(suggested)
                  .then(() => toast('Passphrase copied', { kind: 'success' }))
                  .catch(() => toast('Couldn’t copy. Select the passphrase and copy it yourself.', { kind: 'error' }))
              }
            >
              <Copy size={14} /> Copy
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void suggest()}>
              <Shuffle size={14} /> Another
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-ghost suggest-passphrase" onClick={() => void suggest()}>
          <Shuffle size={14} /> Suggest a strong passphrase
        </button>
      )}
    </>
  );
}

/** For password managers, which file a passphrase under a username. */
const UsernameHint = () => (
  <input type="text" name="username" autoComplete="username" value="Lumen encryption" readOnly hidden aria-hidden="true" />
);

/* ------------------------------------------------------------ unlock --- */

export function UnlockScreen() {
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [recovery, setRecovery] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Locked by a key replacement on another device, rather than by the person: say so.
  const [notice] = useState(takeLockNotice);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (mode === 'passphrase') {
      if (!passphrase) return;
    } else {
      setBusy(true);
      const problem = await passphraseProblem(next, confirm);
      setBusy(false);
      if (problem) return setError(problem);
    }
    setBusy(true);
    try {
      if (mode === 'passphrase') await unlockWithPassphrase(passphrase);
      else {
        await recoverWithKey(recovery, next);
        toast('Unlocked. Your new passphrase works on every device.', { kind: 'success', timeout: 6000 });
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const signOut = async () => {
    const me = await api.me().catch(() => null);
    await signOutOfDevice(me?.via === 'local');
  };

  return (
    // The whole page while locked: its main landmark.
    <main className="splash unlock">
      <BrandMark size={44} />
      <h1>{mode === 'passphrase' ? 'Unlock your notes' : 'Use your recovery key'}</h1>
      <p>
        {mode === 'passphrase'
          ? 'Your notes are end-to-end encrypted. Enter your passphrase to open them on this device.'
          : 'Enter the recovery key you saved when you turned on encryption, then choose a new passphrase.'}
      </p>
      {notice && mode === 'passphrase' && (
        <p className="unlock-notice" role="status">
          {notice}
        </p>
      )}
      <form className="unlock-form" onSubmit={(e) => void submit(e)}>
        <UsernameHint />
        {mode === 'passphrase' ? (
          <SecretInput value={passphrase} onChange={setPassphrase} label="Passphrase" autoComplete="current-password" autoFocus />
        ) : (
          <>
            <textarea
              className="input recovery-input"
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
              aria-label="Recovery key"
              placeholder="XXXX-XXXX-XXXX-…"
              rows={3}
              autoFocus
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <NewPassphrase value={next} onChange={setNext} again={confirm} onAgain={setConfirm} labels={['New passphrase', 'New passphrase again']} />
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner label="Unlocking" size={15} /> : <LockKeyhole size={15} />}
          {busy ? 'Unlocking…' : mode === 'passphrase' ? 'Unlock' : 'Unlock and save passphrase'}
        </button>
      </form>
      <div className="unlock-links">
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setMode(mode === 'passphrase' ? 'recovery' : 'passphrase');
            setError(null);
            // Nothing typed on one screen is kept for the other: secrets go once they're not needed.
            setPassphrase('');
            setRecovery('');
            setNext('');
            setConfirm('');
          }}
        >
          {mode === 'passphrase' ? 'Forgot your passphrase?' : 'Use your passphrase instead'}
        </button>
        <button type="button" className="link-btn" onClick={() => void signOut()}>
          Sign out of this device
        </button>
      </div>
    </main>
  );
}

/* -------------------------------------------- converting the library --- */

/**
 * The run going on, and which kind it is. One finishing can move the screen straight on to the next
 * kind (notes, then files): that one starts once the first has settled, never in its place.
 */
let running: { mode: string; promise: Promise<void> } | null = null;
/** The screen showing the run's progress (it can remount while the run carries on). */
let report: (done: number, total: number) => void = () => undefined;

/**
 * Shown while notes already saved are encrypted ('convert': right after turning it on, or to finish an
 * interrupted run), encrypted again with a new key ('rekey': after replacing the key), or while files and
 * drawings saved before they were encrypted are encrypted ('attachments', once).
 */
export function EncryptingScreen({ mode = 'convert' }: { mode?: 'convert' | 'rekey' | 'attachments' }) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rekey = mode === 'rekey';
  const files = mode === 'attachments';

  useEffect(() => {
    const key = vaultKey();
    if (!key) return;
    let live = true;
    setError(null);
    setProgress(null);
    report = (done, total) => {
      if (live) setProgress({ done, total });
    };
    let unreadable = 0;
    let missing = 0;
    const job = async () => {
      if (rekey) ({ unreadable } = await rekeyLibrary((done, total) => report(done, total)));
      else if (files) ({ missing } = await encryptAttachments((done, total) => report(done, total)));
      else await encryptLibrary(key, (done, total) => report(done, total));
    };
    const finished = () => {
      if (unreadable) {
        toast(
          `Your notes now use the new key, except ${unreadable === 1 ? 'one item' : `${unreadable} items`} no key could decrypt (already unreadable before). ${unreadable === 1 ? 'It was' : 'They were'} left exactly as ${unreadable === 1 ? 'it was' : 'they were'}.`,
          { timeout: 12_000 },
        );
      } else if (missing) {
        toast(
          `Your files and drawings are end-to-end encrypted. ${missing === 1 ? 'One was' : `${missing} were`} already missing from storage and couldn’t be encrypted, so ${missing === 1 ? 'it was' : 'they were'} removed from the list.`,
          { timeout: 12_000 },
        );
      } else if (!rekey && !files) {
        // What else keeps them private: images from other websites waiting for a click, and this device
        // locking itself (offered in one step when it doesn't yet).
        const { remoteImages, autoLockMinutes, update } = useSettings.getState();
        const more = [
          remoteImages === 'ask' ? 'Images from other websites now load only when you click them.' : '',
          autoLockMinutes ? '' : 'This device stays unlocked until you lock it.',
        ].filter(Boolean);
        toast(['Your notes are end-to-end encrypted.', ...more].join(' '), {
          kind: 'success',
          timeout: more.length ? 15_000 : undefined,
          ...(autoLockMinutes ? {} : { action: { label: 'Lock after 1 hour unused', run: () => update({ autoLockMinutes: 60 }) } }),
        });
      } else toast(rekey ? 'Your notes now use the new key' : 'Your files and drawings are end-to-end encrypted', { kind: 'success' });
    };
    // One run of each kind at a time, even if this screen mounts twice.
    let run: Promise<void>;
    if (running?.mode === mode) run = running.promise;
    else {
      const before = running?.promise.catch(() => undefined) ?? Promise.resolve();
      const promise: Promise<void> = before
        .then(job)
        .then(() => loadAll(true))
        .then(finished)
        .finally(() => {
          if (running?.promise === promise) running = null;
        });
      running = { mode, promise };
      run = promise;
    }
    run.catch((err) => {
      if (live) setError(errorMessage(err));
    });
    return () => {
      live = false;
    };
  }, [attempt, rekey, files]);

  const fraction = progress && progress.total ? progress.done / progress.total : 0;
  return (
    <main className="splash" aria-busy={!error}>
      <span className="splash-icon">
        <Lock size={26} />
      </span>
      <h1>
        {error
          ? rekey
            ? 'Re-encryption paused'
            : 'Encryption paused'
          : rekey
            ? 'Encrypting your notes with the new key'
            : files
              ? 'Encrypting your files and drawings'
              : 'Encrypting your notes'}
      </h1>
      <p>
        {error
          ? error
          : rekey
            ? 'Each note, title, tag, folder name and saved version is being decrypted with the old key and encrypted with the new one, on this device, and the keys of your images, files and drawings with them. Keep this page open.'
            : files
              ? 'Each image, file and drawing saved before they were encrypted is being downloaded, encrypted on this device and replaced on the server. This happens once. Keep this page open.'
              : 'Each note, title, tag, folder name and saved version is being encrypted on this device and replaced on the server. Keep this page open.'}
      </p>
      {!error && (
        <div className="progress encrypt-progress" role="status">
          <span>{progress ? `${Math.min(progress.done, progress.total)} of ${progress.total}` : 'Starting…'}</span>
          <div className="progress-bar">
            <div style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        </div>
      )}
      {error && (
        <>
          <p className="setting-hint">
            Nothing was lost. Anything already encrypted stays that way, and the rest is picked up when you try again.
            {files && ' Your notes are already encrypted: you can carry on and finish this later (it starts again next time you open Lumen).'}
          </p>
          <div className="splash-actions">
            {/* Files can wait: a storage limit for the day, say, shouldn't keep anyone out of their notes. */}
            {files && (
              <button type="button" className="btn" onClick={() => useApp.setState({ attachmentsDeferred: true })}>
                Continue for now
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        </>
      )}
    </main>
  );
}

/* ---------------------------------------------------------- settings --- */

function recoveryFile(key: string): Blob {
  const text = [
    'Lumen recovery key',
    '',
    key,
    '',
    'This key unlocks your notes if you forget your passphrase. Keep it somewhere safe and private,',
    'such as a password manager, or printed and stored away. Anyone with this key and access to your',
    'Lumen can read your notes. Making a new recovery key in Settings replaces this one, but it still',
    'opens copies of your encryption settings from before then: on a device that hasn’t been online',
    'since, and in Cloudflare’s database backups for up to 30 days.',
    '',
    `Made ${new Date().toLocaleString()}.`,
    '',
  ].join('\n');
  return new Blob([text], { type: 'text/plain' });
}

function RecoveryKeyBox({ value }: { value: string }) {
  return (
    <div className="recovery-box">
      <code className="recovery-key" aria-label="Recovery key">
        {value}
      </code>
      <div className="recovery-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void navigator.clipboard
              .writeText(value)
              .then(() => toast('Recovery key copied', { kind: 'success' }))
              .catch(() => toast('Couldn’t copy. Select the key and copy it yourself.', { kind: 'error' }))
          }
        >
          <Copy size={14} /> Copy
        </button>
        <button type="button" className="btn btn-sm" onClick={() => downloadBlob(recoveryFile(value), 'lumen-recovery-key.txt')}>
          <Download size={14} /> Download
        </button>
      </div>
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="encrypt-step">
      <p className="encrypt-step-title">{title}</p>
      {children}
    </div>
  );
}

const AUTO_LOCK = [
  [0, 'Never'],
  [15, 'After 15 minutes'],
  [60, 'After 1 hour'],
  [240, 'After 4 hours'],
  [1440, 'After 1 day'],
  [10080, 'After 1 week'],
] as const;

type Flow =
  | { kind: 'idle' }
  | { kind: 'passphrase' }
  | { kind: 'recovery'; prepared: PreparedSetup }
  | { kind: 'change' }
  | { kind: 'rotate' }
  | { kind: 'rotated'; key: string }
  | { kind: 'rekey' }
  | { kind: 'rekey-confirm'; prepared: PreparedSetup };

/** Settings → Security: turning encryption on, and managing the passphrase, recovery key and locking. */
export function EncryptionSettings({ Row }: { Row: ComponentType<{ label: string; hint?: ReactNode; children: ReactNode }> }) {
  const serverOn = useApp((s) => s.encryption.on);
  const vault = useVault((s) => s.state);
  const on = serverOn || vault === 'unlocked';
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const update = useSettings((s) => s.update);
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [c, setC] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const go = (next: Flow) => {
    setFlow(next);
    setA('');
    setB('');
    setC('');
    setSaved(false);
    setError(null);
  };

  const attempt = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>('input:not([hidden])')?.focus();
  }, [flow.kind]);

  const errorLine = error && (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
  const busyLine = busy && (
    <p className="encrypt-busy" role="status">
      <Spinner size={14} label={busy} /> {busy}
    </p>
  );

  if (!on) {
    if (flow.kind === 'passphrase') {
      return (
        <form
          ref={formRef}
          className="encrypt-flow"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              const problem = await passphraseProblem(a, b);
              if (problem) return setError(problem);
              setError(null);
              await attempt('Getting ready…', async () => {
                await flushAll();
                if (hasUnsaved()) throw new Error('Some edits haven’t reached the server yet. Connect to the internet and try again.');
                const large = await notesTooLarge();
                if (large.length) {
                  throw new Error(
                    `${large.length === 1 ? 'This note is' : 'These notes are'} too large to encrypt (over about 1.3 MB): ${large
                      .slice(0, 5)
                      .map((t) => `“${t}”`)
                      .join(', ')}. Split ${large.length === 1 ? 'it' : 'them'} into smaller notes first.`,
                  );
                }
                const prepared = await prepareSetup(a);
                go({ kind: 'recovery', prepared });
              });
            })();
          }}
        >
          <Step title="Step 1 of 2: Choose a passphrase">
            <p className="setting-hint">
              You’ll enter it once on each device you use. It never leaves your devices, so nobody can reset it for you: keep it in a
              password manager.
            </p>
            <UsernameHint />
            <NewPassphrase value={a} onChange={setA} again={b} onAgain={setB} />
          </Step>
          {errorLine}
          {busyLine}
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => go({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!!busy}>
              Continue
            </button>
          </div>
        </form>
      );
    }
    if (flow.kind === 'recovery') {
      return (
        <div className="encrypt-flow">
          <Step title="Step 2 of 2: Save your recovery key">
            <p className="setting-hint">
              If you forget your passphrase, this key is the only way back into your notes. Save it somewhere safe, away from this
              device. It’s shown only now.
            </p>
            <RecoveryKeyBox value={flow.prepared.recoveryKey} />
            <label className="check-row">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>I’ve saved my recovery key somewhere safe</span>
            </label>
          </Step>
          {errorLine}
          {busyLine}
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => go({ kind: 'idle' })}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!saved || !!busy}
              onClick={() =>
                void attempt('Turning on encryption…', async () => {
                  await flushAll();
                  if (hasUnsaved()) throw new Error('Some edits haven’t reached the server yet. Connect to the internet and try again.');
                  await flow.prepared.commit();
                  // Encrypted notes that still tell other websites when they're opened (each image of
                  // theirs loaded is a request with this device's address): those now wait for a click.
                  // Said when encrypting finishes, and changeable in Settings → Security.
                  if (useSettings.getState().remoteImages === 'load') useSettings.getState().update({ remoteImages: 'ask' });
                  // The encryption screen takes over from here and encrypts what's already saved.
                  useApp.setState({ settingsOpen: false, encryption: { ...useApp.getState().encryption, on: true, pending: Math.max(1, useApp.getState().encryption.pending) } });
                })
              }
            >
              <Lock size={14} /> Turn on encryption
            </button>
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="callout-card is-neutral">
          <LockKeyhole size={20} />
          <div>
            <strong>End-to-end encryption is off</strong>
            <p>
              Turn it on to encrypt notes on your devices before they’re saved, so your Cloudflare account only ever stores unreadable
              data. Covers note text, titles, tags, folder names, version history, images, files and drawings.
            </p>
          </div>
        </div>
        <Row
          label="End-to-end encryption"
          hint="You’ll choose a passphrase and save a recovery key. Lose both, and your notes can’t be recovered by anyone."
        >
          <button type="button" className="btn btn-sm btn-primary" onClick={() => go({ kind: 'passphrase' })}>
            <ShieldCheck size={14} /> Set up encryption
          </button>
        </Row>
      </>
    );
  }

  return (
    <>
      <div className="callout-card is-ok">
        <LockKeyhole size={20} />
        <div>
          <strong>End-to-end encryption is on</strong>
          <p>
            Note text, titles, tags, folder names, version history, images, files and drawings are encrypted on your devices before
            they’re saved; the server only ever stores ciphertext. Search runs on this device.
          </p>
        </div>
      </div>
      <Row label="Lock this device" hint="Removes the key from this browser. Your passphrase opens Lumen here again.">
        <button type="button" className="btn btn-sm" onClick={() => void lock()}>
          <Lock size={14} /> Lock now
        </button>
      </Row>
      <Row label="Lock automatically" hint="After this long without using Lumen on this device.">
        <select
          className="input input-sm select-input"
          value={autoLock}
          aria-label="Lock automatically"
          onChange={(e) => update({ autoLockMinutes: Number(e.target.value) })}
        >
          {AUTO_LOCK.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Row>

      {flow.kind === 'change' ? (
        <form
          ref={formRef}
          className="encrypt-flow"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              const problem = await passphraseProblem(b, c);
              if (problem) return setError(problem);
              setError(null);
              await attempt('Changing your passphrase…', async () => {
                await changePassphrase(a, b);
                go({ kind: 'idle' });
                toast('Passphrase changed. Use it next time you unlock, on any device.', { kind: 'success', timeout: 6000 });
              });
            })();
          }}
        >
          <Step title="Change passphrase">
            <UsernameHint />
            <SecretInput value={a} onChange={setA} label="Current passphrase" autoComplete="current-password" />
            <NewPassphrase value={b} onChange={setB} again={c} onAgain={setC} labels={['New passphrase', 'New passphrase again']} />
          </Step>
          {errorLine}
          {busyLine}
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => go({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!!busy}>
              Change passphrase
            </button>
          </div>
        </form>
      ) : (
        <Row label="Passphrase" hint="Devices already unlocked stay unlocked when it changes.">
          <button type="button" className="btn btn-sm" onClick={() => go({ kind: 'change' })}>
            <KeyRound size={14} /> Change
          </button>
        </Row>
      )}

      {flow.kind === 'rotate' ? (
        <form
          ref={formRef}
          className="encrypt-flow"
          onSubmit={(e) => {
            e.preventDefault();
            if (!a) return;
            void attempt('Making a new recovery key…', async () => {
              const key = await replaceRecoveryKey(a);
              go({ kind: 'rotated', key });
            });
          }}
        >
          <Step title="New recovery key">
            <p className="setting-hint">
              Lumen stops accepting your current recovery key once the new one is made. It still opens copies of your
              encryption settings from before then: on a device that hasn’t been online since, and in Cloudflare’s
              database backups for up to 30 days.
            </p>
            <UsernameHint />
            <SecretInput value={a} onChange={setA} label="Passphrase" autoComplete="current-password" />
          </Step>
          {errorLine}
          {busyLine}
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => go({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!!busy}>
              Make new key
            </button>
          </div>
        </form>
      ) : flow.kind === 'rotated' ? (
        <div className="encrypt-flow">
          <Step title="Your new recovery key">
            <p className="setting-hint">Save it somewhere safe, away from this device. It’s shown only now.</p>
            <RecoveryKeyBox value={flow.key} />
          </Step>
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => go({ kind: 'idle' })}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <Row
          label="Recovery key"
          hint="Make a new one if yours may have been seen. Lumen then stops accepting the old one, though it still opens older copies of your encryption settings. To shut those out too, replace the encryption key."
        >
          <button type="button" className="btn btn-sm" onClick={() => go({ kind: 'rotate' })}>
            <KeyRound size={14} /> New key
          </button>
        </Row>
      )}

      {flow.kind === 'rekey' ? (
        <form
          ref={formRef}
          className="encrypt-flow"
          onSubmit={(e) => {
            e.preventDefault();
            if (!a) return;
            void attempt('Preparing a new key…', async () => {
              go({ kind: 'rekey-confirm', prepared: await prepareKeyReplacement(a) });
            });
          }}
        >
          <Step title="Replace the encryption key">
            <p className="setting-hint">
              Every note, title, tag, folder name and saved version is encrypted again with a new key, on this device, and so are the keys
              of your images, files and drawings. The files themselves stay as they are, so a device that already had one of those
              keys can still open that file; old passphrases, recovery keys and copies of your encryption settings open no note,
              title or folder name, and no file or drawing added from now on. Your passphrase stays the same; you get a new
              recovery key. Other devices ask for the passphrase once.
            </p>
            <UsernameHint />
            <SecretInput value={a} onChange={setA} label="Passphrase" autoComplete="current-password" />
          </Step>
          {errorLine}
          {busyLine}
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => go({ kind: 'idle' })}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!!busy}>
              Continue
            </button>
          </div>
        </form>
      ) : flow.kind === 'rekey-confirm' ? (
        <div className="encrypt-flow">
          <Step title="Your new recovery key">
            <p className="setting-hint">It replaces your current one once the key is replaced. Save it somewhere safe, away from this device.</p>
            <RecoveryKeyBox value={flow.prepared.recoveryKey} />
            <label className="check-row">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I’ve saved my new recovery key somewhere safe
            </label>
          </Step>
          {errorLine}
          {busyLine}
          <div className="encrypt-actions">
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => go({ kind: 'idle' })}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!saved || !!busy}
              onClick={() =>
                void attempt('Replacing the key…', async () => {
                  await flow.prepared.commit();
                  go({ kind: 'idle' });
                  // The app shows the re-encryption until it's done (EncryptingScreen, mode 'rekey').
                  const enc = useApp.getState().encryption;
                  useApp.setState({ settingsOpen: false, encryption: { ...enc, rekey: Math.max(1, enc.rekey) } });
                })
              }
            >
              Replace key
            </button>
          </div>
        </div>
      ) : (
        <Row label="Encryption key" hint="Replace it if a passphrase or recovery key may have been seen. Your notes are encrypted again with a new key.">
          <button type="button" className="btn btn-sm" onClick={() => go({ kind: 'rekey' })}>
            <KeyRound size={14} /> Replace key
          </button>
        </Row>
      )}
    </>
  );
}
