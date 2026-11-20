// @vitest-environment jsdom
/**
 * The encryption screens (src/components/Encryption.tsx): the unlock screen (passphrase, or the
 * recovery key and a new passphrase), the progress screen while a library is encrypted or re-encrypted,
 * and Settings → Security's set-up steps, passphrase change, new recovery key and key replacement.
 *
 * The vault and the encryption jobs are stand-ins (their own tests are e2ee-*.test.ts), failing with
 * the vault's own words, so these test the screens: rules checked before the vault is asked, a recovery
 * key shown once and only after it can't be skipped, nothing secret left in the page's markup or on
 * screen once it's done with, errors said out loud, and buttons held while work is under way.
 */
import {
  byName,
  choose,
  click,
  clipboard,
  fakeServer,
  mount,
  nameOf,
  queryByName,
  settle,
  text,
  typeInto,
  unmountAll,
  useServer,
  type FakeServer,
} from './ui-note-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const vault = vi.hoisted(() => ({
  unlockWithPassphrase: vi.fn(),
  recoverWithKey: vi.fn(),
  prepareSetup: vi.fn(),
  changePassphrase: vi.fn(),
  replaceRecoveryKey: vi.fn(),
  prepareKeyReplacement: vi.fn(),
  lock: vi.fn(),
  takeLockNotice: vi.fn(),
  vaultKey: vi.fn(),
}));
vi.mock('../../src/lib/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/vault')>()),
  ...vault,
}));
const jobs = vi.hoisted(() => ({
  encryptLibrary: vi.fn(),
  encryptAttachments: vi.fn(),
  rekeyLibrary: vi.fn(),
  notesTooLarge: vi.fn(),
}));
vi.mock('../../src/lib/e2ee', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/e2ee')>()),
  ...jobs,
}));
const saving = vi.hoisted(() => ({ flushAll: vi.fn(), hasUnsaved: vi.fn() }));
vi.mock('../../src/lib/saver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/saver')>()),
  ...saving,
}));
const signout = vi.hoisted(() => ({ signOutOfDevice: vi.fn() }));
vi.mock('../../src/lib/signout', () => signout);
const loading = vi.hoisted(() => ({ loadAll: vi.fn() }));
vi.mock('../../src/lib/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/store')>()),
  ...loading,
}));
const downloads = vi.hoisted(() => [] as Array<{ blob: Blob; name: string }>);
vi.mock('../../src/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/utils')>()),
  downloadBlob: (blob: Blob, name: string) => void downloads.push({ blob, name }),
}));

import { EncryptingScreen, EncryptionSettings, UnlockScreen } from '../../src/components/Encryption';
import { useSettings } from '../../src/lib/settings';
import { useApp } from '../../src/lib/store';
import { useVault } from '../../src/lib/vault';


const PASS = 'correct horse battery';
const NEXT = 'purple monkey dishwasher';
const RECOVERY = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-2345-6789-ABCD-EFGH-JKLM-NPQR-STUV';
const NEW_RECOVERY = 'ZZZZ-YYYY-XXXX-WWWW-VVVV-UUUU-TTTT-SSSS-RRRR-QQQQ-PPPP-NNNN-MMMM';

const WRONG_PASS = 'That passphrase didn’t unlock your notes. Check it and try again, or use your recovery key.';
const NOT_A_KEY = 'That isn’t a recovery key. It’s 52 letters and digits in groups of four.';
const WRONG_CURRENT = 'Your current passphrase isn’t right.';
const WRONG_PASSPHRASE = 'That passphrase isn’t right.';
const TOO_SHORT = 'Use at least 10 characters. A few unrelated words work well.';
const NO_MATCH = 'The two passphrases don’t match.';

let server: FakeServer;

/** A promise the test settles when it chooses. */
function later<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  server = fakeServer();
  useServer(server);
  for (const fn of [...Object.values(vault), ...Object.values(jobs), ...Object.values(saving), ...Object.values(signout), ...Object.values(loading)]) fn.mockReset();
  vault.takeLockNotice.mockReturnValue(null);
  vault.vaultKey.mockReturnValue({ type: 'secret' } as unknown as CryptoKey);
  saving.flushAll.mockResolvedValue(undefined);
  saving.hasUnsaved.mockReturnValue(false);
  jobs.notesTooLarge.mockResolvedValue([]);
  loading.loadAll.mockResolvedValue(undefined);
  clipboard.written.length = 0;
  clipboard.fail = false;
  downloads.length = 0;
  useVault.setState({ state: 'off' });
  useApp.setState({ toasts: [], settingsOpen: true, encryption: { on: false, pending: 0, rekey: 0, attachments: 0 }, attachmentsDeferred: false });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const toasts = () => useApp.getState().toasts.map((t) => t.message);
const field = (name: string) => byName<HTMLInputElement>(name, 'input, textarea');
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;

/** Nothing typed as a secret appears in any attribute or in the page's markup. */
function expectNotInMarkup(...secrets: string[]) {
  for (const s of secrets) {
    for (const el of document.querySelectorAll('input, textarea')) expect(el.getAttribute('value')).not.toBe(s);
    expect(document.body.innerHTML).not.toContain(s);
  }
}

/** Everything a person could read or that's typed into a field still on the page. */
function onScreen(): string {
  const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map((el) => el.value);
  return `${document.body.textContent} ${values.join(' ')}`;
}

/* ------------------------------------------------------------ unlock --- */

describe('the unlock screen', () => {
  it('asks for the passphrase, with the field named and focused, and hidden as it is typed', async () => {
    await mount(<UnlockScreen />);
    expect(document.querySelector('h1')?.textContent).toBe('Unlock your notes');
    const input = field('Passphrase');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('current-password');
    expect(document.activeElement).toBe(input);
    expect(byName('Unlock', 'button[type="submit"]')).toBeTruthy();
  });

  it('does nothing when Unlock is pressed with nothing typed', async () => {
    await mount(<UnlockScreen />);
    await click(byName('Unlock'));
    await settle();
    expect(vault.unlockWithPassphrase).not.toHaveBeenCalled();
  });

  it('unlocks with what was typed, holding the button while it works', async () => {
    const run = later();
    vault.unlockWithPassphrase.mockReturnValue(run.promise);
    await mount(<UnlockScreen />);
    await typeInto(field('Passphrase'), PASS);
    await click(byName('Unlock'));
    expect(vault.unlockWithPassphrase).toHaveBeenCalledWith(PASS);
    const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    expect(text(button)).toContain('Unlocking…');
    await click(button);
    expect(vault.unlockWithPassphrase).toHaveBeenCalledTimes(1);
    run.resolve();
    await settle();
  });

  it('says out loud when the passphrase is wrong, and lets it be tried again', async () => {
    vault.unlockWithPassphrase.mockRejectedValue(new Error(WRONG_PASS));
    await mount(<UnlockScreen />);
    await typeInto(field('Passphrase'), 'wrong words here');
    await click(byName('Unlock'));
    await settle();
    expect(alertText()).toBe(WRONG_PASS);
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    vault.unlockWithPassphrase.mockResolvedValue(undefined);
    await typeInto(field('Passphrase'), PASS);
    await click(byName('Unlock'));
    expect(alertText()).toBeNull();
    expect(vault.unlockWithPassphrase).toHaveBeenLastCalledWith(PASS);
  });

  it('never puts the passphrase into the page’s markup', async () => {
    await mount(<UnlockScreen />);
    await typeInto(field('Passphrase'), PASS);
    expectNotInMarkup(PASS);
    await click(byName('Show'));
    expect(field('Passphrase').type).toBe('text');
    expect(byName('Hide').getAttribute('aria-pressed')).toBe('true');
    expectNotInMarkup(PASS);
  });

  it('says why the device was locked when the key was replaced elsewhere', async () => {
    vault.takeLockNotice.mockReturnValue('Your encryption key was replaced on another device. Unlock with your passphrase to continue.');
    await mount(<UnlockScreen />);
    const notice = document.querySelector('.unlock-notice')!;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('replaced on another device');
    expect(vault.takeLockNotice).toHaveBeenCalledTimes(1);
  });

  it('switches to the recovery key, asking for a new passphrase twice', async () => {
    await mount(<UnlockScreen />);
    await click(byName('Forgot your passphrase?'));
    expect(document.querySelector('h1')?.textContent).toBe('Use your recovery key');
    const key = field('Recovery key');
    expect(key.tagName).toBe('TEXTAREA');
    expect(field('New passphrase').type).toBe('password');
    expect(field('New passphrase again').type).toBe('password');
    expect(field('New passphrase').autocomplete).toBe('new-password');
    expect(byName('Unlock and save passphrase')).toBeTruthy();
  });

  it('checks the new passphrase before trying the recovery key', async () => {
    await mount(<UnlockScreen />);
    await click(byName('Forgot your passphrase?'));
    await typeInto(field('Recovery key'), RECOVERY);
    await typeInto(field('New passphrase'), 'short');
    await typeInto(field('New passphrase again'), 'short');
    await click(byName('Unlock and save passphrase'));
    expect(alertText()).toBe(TOO_SHORT);
    await typeInto(field('New passphrase'), NEXT);
    await typeInto(field('New passphrase again'), `${NEXT}!`);
    await click(byName('Unlock and save passphrase'));
    expect(alertText()).toBe(NO_MATCH);
    expect(vault.recoverWithKey).not.toHaveBeenCalled();
  });

  it('refuses an easy-to-guess new passphrase before trying the recovery key', async () => {
    await mount(<UnlockScreen />);
    await click(byName('Forgot your passphrase?'));
    await typeInto(field('Recovery key'), RECOVERY);
    await typeInto(field('New passphrase'), 'aaaaaaaaaaaaaaaa');
    await typeInto(field('New passphrase again'), 'aaaaaaaaaaaaaaaa');
    await click(byName('Unlock and save passphrase'));
    await settle();
    expect(alertText()).toMatch(/^That passphrase could be guessed in /);
    expect(vault.recoverWithKey).not.toHaveBeenCalled();
    expect(byName('Unlock and save passphrase')).toHaveProperty('disabled', false);
  });

  it('unlocks with the recovery key and the new passphrase, and says the new one works everywhere', async () => {
    vault.recoverWithKey.mockResolvedValue(undefined);
    await mount(<UnlockScreen />);
    await click(byName('Forgot your passphrase?'));
    await typeInto(field('Recovery key'), RECOVERY);
    await typeInto(field('New passphrase'), NEXT);
    await typeInto(field('New passphrase again'), NEXT);
    await click(byName('Unlock and save passphrase'));
    await settle();
    expect(vault.recoverWithKey).toHaveBeenCalledWith(RECOVERY, NEXT);
    expect(toasts()).toContain('Unlocked. Your new passphrase works on every device.');
  });

  it('says so when what was typed isn’t a recovery key', async () => {
    vault.recoverWithKey.mockRejectedValue(new Error(NOT_A_KEY));
    await mount(<UnlockScreen />);
    await click(byName('Forgot your passphrase?'));
    await typeInto(field('Recovery key'), 'not a key');
    await typeInto(field('New passphrase'), NEXT);
    await typeInto(field('New passphrase again'), NEXT);
    await click(byName('Unlock and save passphrase'));
    await settle();
    expect(alertText()).toBe(NOT_A_KEY);
    expect(toasts()).toEqual([]);
  });

  it('never puts the recovery key or the new passphrase into an attribute', async () => {
    await mount(<UnlockScreen />);
    await click(byName('Forgot your passphrase?'));
    await typeInto(field('Recovery key'), RECOVERY);
    await typeInto(field('New passphrase'), NEXT);
    await typeInto(field('New passphrase again'), NEXT);
    expect(field('Recovery key').getAttribute('value')).toBeNull();
    for (const el of document.querySelectorAll('[value]')) expect(el.getAttribute('value')).not.toMatch(new RegExp(`${NEXT}|${RECOVERY}`));
    expect(document.body.innerHTML).not.toContain(NEXT);
  });

  it('drops the lock notice and any error when switching to the recovery key', async () => {
    vault.takeLockNotice.mockReturnValue('Your encryption key was replaced on another device. Unlock with your passphrase to continue.');
    vault.unlockWithPassphrase.mockRejectedValue(new Error(WRONG_PASS));
    await mount(<UnlockScreen />);
    await typeInto(field('Passphrase'), 'wrong words here');
    await click(byName('Unlock'));
    await settle();
    await click(byName('Forgot your passphrase?'));
    expect(alertText()).toBeNull();
    expect(document.querySelector('.unlock-notice')).toBeNull();
  });

  it('forgets a passphrase typed before switching to the recovery key and back', async () => {
    await mount(<UnlockScreen />);
    await typeInto(field('Passphrase'), PASS);
    await click(byName('Forgot your passphrase?'));
    await typeInto(field('Recovery key'), RECOVERY);
    await click(byName('Use your passphrase instead'));
    expect(field('Passphrase').value).toBe('');
    await click(byName('Forgot your passphrase?'));
    expect(field('Recovery key').value).toBe('');
  });

  it('signs out of this device from the unlock screen', async () => {
    server.intercept = (req) =>
      req.path === '/api/me' ? new Response(JSON.stringify({ via: 'local' }), { headers: { 'content-type': 'application/json' } }) : undefined;
    await mount(<UnlockScreen />);
    await click(byName('Sign out of this device'));
    await settle();
    expect(signout.signOutOfDevice).toHaveBeenCalledWith(true);
  });

  it('still offers to sign out when the server can’t say who is signed in', async () => {
    server.offline = true;
    await mount(<UnlockScreen />);
    await click(byName('Sign out of this device'));
    await settle();
    expect(signout.signOutOfDevice).toHaveBeenCalledWith(false);
  });

  it('is the page’s main landmark', async () => {
    const { container } = await mount(<UnlockScreen />);
    expect(container.firstElementChild?.tagName).toBe('MAIN');
  });
});

/* -------------------------------------------------------- converting --- */

describe('the encrypting screen', () => {
  it('encrypts the library with the device’s key, showing how far it has got', async () => {
    const run = later();
    let report: (done: number, total: number) => void = () => undefined;
    jobs.encryptLibrary.mockImplementation((_key: CryptoKey, progress: typeof report) => {
      report = progress;
      return run.promise;
    });
    const { container } = await mount(<EncryptingScreen />);
    await settle();
    expect(jobs.encryptLibrary).toHaveBeenCalledWith(vault.vaultKey(), expect.any(Function));
    expect(container.querySelector('h1')?.textContent).toBe('Encrypting your notes');
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Starting…');
    await settle();
    report(3, 12);
    await settle();
    expect(status.textContent).toContain('3 of 12');
    expect(container.querySelector<HTMLElement>('.progress-bar div')!.style.width).toBe('25%');
    run.resolve();
    await settle();
    expect(loading.loadAll).toHaveBeenCalledWith(true);
    expect(toasts().some((t) => t.startsWith('Your notes are end-to-end encrypted.'))).toBe(true);
  });

  it('starts nothing without the key', async () => {
    vault.vaultKey.mockReturnValue(null);
    await mount(<EncryptingScreen />);
    await settle();
    expect(jobs.encryptLibrary).not.toHaveBeenCalled();
  });

  it('runs once even when the screen is shown twice', async () => {
    const run = later();
    jobs.encryptLibrary.mockReturnValue(run.promise);
    await mount(<EncryptingScreen />);
    await mount(<EncryptingScreen />);
    await settle();
    expect(jobs.encryptLibrary).toHaveBeenCalledTimes(1);
    run.resolve();
    await settle();
  });

  it('pauses on an error, says nothing was lost, and tries again on request', async () => {
    jobs.encryptLibrary.mockRejectedValueOnce(new Error('Can’t reach the server. Check your connection.'));
    const { container } = await mount(<EncryptingScreen />);
    await settle();
    expect(container.querySelector('h1')?.textContent).toBe('Encryption paused');
    expect(text(container)).toContain('Can’t reach the server. Check your connection.');
    expect(text(container)).toContain('Nothing was lost.');
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('false');
    expect(queryByName('Continue for now')).toBeNull();
    jobs.encryptLibrary.mockResolvedValueOnce(undefined);
    await click(byName('Try again'));
    await settle();
    expect(jobs.encryptLibrary).toHaveBeenCalledTimes(2);
    expect(toasts().some((t) => t.startsWith('Your notes are end-to-end encrypted.'))).toBe(true);
  });

  it('says, once encrypted, what else keeps the notes private, and offers locking this device by itself', async () => {
    useSettings.setState({ remoteImages: 'ask', autoLockMinutes: 0 });
    jobs.encryptLibrary.mockResolvedValueOnce(undefined);
    await mount(<EncryptingScreen />);
    await settle();
    const done = useApp.getState().toasts.find((t) => t.message.startsWith('Your notes are end-to-end encrypted.'))!;
    expect(done.message).toBe(
      'Your notes are end-to-end encrypted. Images from other websites now load only when you click them. This device stays unlocked until you lock it.',
    );
    expect(done.action?.label).toBe('Lock after 1 hour unused');
    done.action!.run();
    expect(useSettings.getState().autoLockMinutes).toBe(60);
  });

  it('offers no lock time when this device already has one', async () => {
    useSettings.setState({ remoteImages: 'load', autoLockMinutes: 15 });
    jobs.encryptLibrary.mockResolvedValueOnce(undefined);
    await mount(<EncryptingScreen />);
    await settle();
    const done = useApp.getState().toasts.find((t) => t.message.startsWith('Your notes are end-to-end encrypted'))!;
    expect(done.message).toBe('Your notes are end-to-end encrypted.');
    expect(done.action).toBeUndefined();
  });

  it('re-encrypts with a new key, and says what no key could open', async () => {
    jobs.rekeyLibrary.mockResolvedValue({ unreadable: 2 });
    const { container } = await mount(<EncryptingScreen mode="rekey" />);
    expect(container.querySelector('h1')?.textContent).toBe('Encrypting your notes with the new key');
    await settle();
    expect(jobs.rekeyLibrary).toHaveBeenCalledTimes(1);
    expect(toasts()[0]).toContain('except 2 items no key could decrypt');
  });

  it('lets files wait for later when encrypting them fails', async () => {
    jobs.encryptAttachments.mockRejectedValue(new Error('Storage is full for today.'));
    const { container } = await mount(<EncryptingScreen mode="attachments" />);
    await settle();
    expect(container.querySelector('h1')?.textContent).toBe('Encryption paused');
    expect(text(container)).toContain('Your notes are already encrypted');
    await click(byName('Continue for now'));
    expect(useApp.getState().attachmentsDeferred).toBe(true);
  });

  it('says how many files were already missing', async () => {
    jobs.encryptAttachments.mockResolvedValue({ missing: 1 });
    await mount(<EncryptingScreen mode="attachments" />);
    await settle();
    expect(toasts()[0]).toContain('One was already missing from storage');
  });
});

/* ---------------------------------------------------------- settings --- */

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <span className="setting-label">{label}</span>
      {hint && <span className="setting-hint">{hint}</span>}
      <div className="setting-control">{children}</div>
    </div>
  );
}

const showSettings = () => mount(<EncryptionSettings Row={Row} />);
const prepared = (recoveryKey = RECOVERY) => ({ recoveryKey, commit: vi.fn().mockResolvedValue(undefined) });

describe('setting up encryption', () => {
  async function stepOne() {
    await showSettings();
    expect(text()).toContain('End-to-end encryption is off');
    await click(byName(/Set up encryption/));
  }

  it('asks for a passphrase twice, focusing the first field', async () => {
    await stepOne();
    expect(text()).toContain('Step 1 of 2: Choose a passphrase');
    expect(document.activeElement).toBe(field('Passphrase'));
    expect(field('Passphrase').autocomplete).toBe('new-password');
    expect(field('Passphrase again').type).toBe('password');
  });

  it('refuses a passphrase under 10 characters before anything is prepared', async () => {
    await stepOne();
    await typeInto(field('Passphrase'), 'too short');
    await typeInto(field('Passphrase again'), 'too short');
    await click(byName('Continue'));
    await settle();
    expect(alertText()).toBe(TOO_SHORT);
    expect(saving.flushAll).not.toHaveBeenCalled();
    expect(vault.prepareSetup).not.toHaveBeenCalled();
  });

  it('refuses a passphrase long enough but easy to guess, showing how long it would take as it’s typed', async () => {
    await stepOne();
    await typeInto(field('Passphrase'), 'password1234');
    await typeInto(field('Passphrase again'), 'password1234');
    await settle();
    expect(text()).toContain('Very weak. Guessed at once for someone with a copy of your encryption settings');
    await click(byName('Continue'));
    await settle();
    expect(alertText()).toBe(
      'That passphrase could be guessed in under a second by someone with a copy of your encryption settings. Add more unrelated words, or use a suggested one.',
    );
    expect(saving.flushAll).not.toHaveBeenCalled();
    expect(vault.prepareSetup).not.toHaveBeenCalled();
  });

  it('suggests a strong passphrase: shown to save, filled into both fields, and used', async () => {
    vault.prepareSetup.mockResolvedValue(prepared());
    await stepOne();
    await click(byName(/Suggest a strong passphrase/));
    await settle();
    const shown = byName('Suggested passphrase', 'code').textContent!;
    expect(shown.split('-')).toHaveLength(6);
    expect(field('Passphrase').value).toBe(shown);
    expect(field('Passphrase again').value).toBe(shown);
    expect(text()).toContain('Strong.');
    expect(text()).toContain('Save it in your password manager, or write it down');
    // Never in an attribute, where a stray style rule could read it.
    for (const el of document.querySelectorAll('input')) expect(el.getAttribute('value')).not.toBe(shown);
    // Another, then that one is used.
    await click(byName(/Another/));
    await settle();
    const next = byName('Suggested passphrase', 'code').textContent!;
    expect(next).not.toBe(shown);
    await click(byName('Continue'));
    await settle();
    expect(vault.prepareSetup).toHaveBeenCalledWith(next);
  });

  it('stops showing a suggestion once the passphrase is changed by hand', async () => {
    await stepOne();
    await click(byName(/Suggest a strong passphrase/));
    await settle();
    await typeInto(field('Passphrase'), 'my own words instead of yours');
    await settle();
    expect(document.querySelector('[aria-label="Suggested passphrase"]')).toBeNull();
    expect(byName(/Suggest a strong passphrase/)).toBeTruthy();
  });

  it('refuses two passphrases that don’t match', async () => {
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), `${PASS} `);
    await click(byName('Continue'));
    await settle();
    expect(alertText()).toBe(NO_MATCH);
    expect(vault.prepareSetup).not.toHaveBeenCalled();
  });

  it('waits for unsaved edits to reach the server first', async () => {
    saving.hasUnsaved.mockReturnValue(true);
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    expect(saving.flushAll).toHaveBeenCalled();
    expect(alertText()).toContain('Some edits haven’t reached the server yet.');
    expect(vault.prepareSetup).not.toHaveBeenCalled();
  });

  it('names the notes too large to encrypt', async () => {
    jobs.notesTooLarge.mockResolvedValue(['Huge log']);
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    expect(alertText()).toContain('This note is too large to encrypt (over about 1.3 MB): “Huge log”.');
    expect(vault.prepareSetup).not.toHaveBeenCalled();
  });

  it('holds its buttons while getting ready', async () => {
    const ready = later<ReturnType<typeof prepared>>();
    vault.prepareSetup.mockReturnValue(ready.promise);
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    expect(document.querySelector('.encrypt-busy')?.textContent).toContain('Getting ready…');
    expect(byName('Continue')).toHaveProperty('disabled', true);
    expect(byName('Cancel')).toHaveProperty('disabled', true);
    ready.resolve(prepared());
    await settle();
  });

  it('shows the recovery key once, and only turns encryption on after it’s marked saved', async () => {
    useSettings.setState({ remoteImages: 'load' });
    const setup = prepared();
    vault.prepareSetup.mockResolvedValue(setup);
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    expect(vault.prepareSetup).toHaveBeenCalledWith(PASS);
    expect(text()).toContain('Step 2 of 2: Save your recovery key');
    expect(byName('Recovery key', 'code').textContent).toBe(RECOVERY);
    // The passphrase fields are gone, and the passphrase with them.
    expect(onScreen()).not.toContain(PASS);
    const turnOn = byName(/Turn on encryption/);
    expect(turnOn).toHaveProperty('disabled', true);
    await click(turnOn);
    expect(setup.commit).not.toHaveBeenCalled();

    const saved = byName<HTMLInputElement>('I’ve saved my recovery key somewhere safe', 'input');
    expect(saved.type).toBe('checkbox');
    await click(saved);
    expect(turnOn).toHaveProperty('disabled', false);
    await click(turnOn);
    await settle();
    expect(saving.flushAll).toHaveBeenCalled();
    expect(setup.commit).toHaveBeenCalledTimes(1);
    // Images from other websites would tell them when an encrypted note is opened: they now wait for a click.
    expect(useSettings.getState().remoteImages).toBe('ask');
    expect(useApp.getState().settingsOpen).toBe(false);
    expect(useApp.getState().encryption.on).toBe(true);
    expect(useApp.getState().encryption.pending).toBeGreaterThanOrEqual(1);
  });

  it('drops the prepared key on Cancel, turning nothing on', async () => {
    const setup = prepared();
    vault.prepareSetup.mockResolvedValue(setup);
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    await click(byName('I’ve saved my recovery key somewhere safe', 'input'));
    await click(byName('Cancel'));
    expect(onScreen()).not.toContain(RECOVERY);
    expect(setup.commit).not.toHaveBeenCalled();
    expect(text()).toContain('End-to-end encryption is off');
    // Starting again asks for a passphrase afresh, with the box unticked next time.
    await click(byName(/Set up encryption/));
    expect(field('Passphrase').value).toBe('');
  });

  it('stays on the recovery key when turning encryption on fails, saying why', async () => {
    const setup = prepared();
    setup.commit.mockRejectedValue(new Error('Encryption was turned on from another device. Reload to unlock with that passphrase.'));
    vault.prepareSetup.mockResolvedValue(setup);
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    await click(byName('I’ve saved my recovery key somewhere safe', 'input'));
    await click(byName(/Turn on encryption/));
    await settle();
    expect(alertText()).toContain('turned on from another device');
    expect(useApp.getState().settingsOpen).toBe(true);
    expect(useApp.getState().encryption.on).toBe(false);
  });

  it('copies and downloads the recovery key', async () => {
    vault.prepareSetup.mockResolvedValue(prepared());
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    await click(byName('Continue'));
    await settle();
    await click(byName(/Copy/));
    await settle();
    expect(clipboard.written).toEqual([RECOVERY]);
    expect(toasts()).toContain('Recovery key copied');
    clipboard.fail = true;
    await click(byName(/Copy/));
    await settle();
    expect(toasts()).toContain('Couldn’t copy. Select the key and copy it yourself.');
    await click(byName(/Download/));
    expect(downloads[0].name).toBe('lumen-recovery-key.txt');
    expect(await downloads[0].blob.text()).toContain(RECOVERY);
  });

  it('never puts the passphrase into the page’s markup', async () => {
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await typeInto(field('Passphrase again'), PASS);
    expectNotInMarkup(PASS);
  });

  it('goes back on Cancel at step 1, keeping nothing typed', async () => {
    await stepOne();
    await typeInto(field('Passphrase'), PASS);
    await click(byName('Cancel'));
    expect(onScreen()).not.toContain(PASS);
    await click(byName(/Set up encryption/));
    expect(field('Passphrase').value).toBe('');
  });
});

describe('managing encryption while it is on', () => {
  beforeEach(() => {
    useVault.setState({ state: 'unlocked' });
    useApp.setState({ encryption: { on: true, pending: 0, rekey: 0, attachments: 0 } });
  });

  it('says encryption is on and locks the device on request', async () => {
    await showSettings();
    expect(text()).toContain('End-to-end encryption is on');
    await click(byName(/Lock now/));
    expect(vault.lock).toHaveBeenCalledTimes(1);
  });

  it('sets when the device locks itself', async () => {
    await showSettings();
    const select = byName<HTMLSelectElement>('Lock automatically', 'select');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Never', 'After 15 minutes', 'After 1 hour', 'After 4 hours', 'After 1 day', 'After 1 week']);
    await choose(select, '240');
    expect(useSettings.getState().autoLockMinutes).toBe(240);
  });

  describe('changing the passphrase', () => {
    it('checks the new passphrase before trying the current one', async () => {
      await showSettings();
      await click(byName(/^Change$/));
      expect(document.activeElement).toBe(field('Current passphrase'));
      await typeInto(field('Current passphrase'), PASS);
      await typeInto(field('New passphrase'), 'short');
      await typeInto(field('New passphrase again'), 'short');
      await click(byName('Change passphrase'));
      expect(alertText()).toBe(TOO_SHORT);
      await typeInto(field('New passphrase'), NEXT);
      await typeInto(field('New passphrase again'), 'something else entirely');
      await click(byName('Change passphrase'));
      expect(alertText()).toBe(NO_MATCH);
      expect(vault.changePassphrase).not.toHaveBeenCalled();
    });

    it('refuses a new passphrase that’s easy to guess', async () => {
      await showSettings();
      await click(byName(/^Change$/));
      await typeInto(field('Current passphrase'), PASS);
      await typeInto(field('New passphrase'), 'qwertyuiopasdfgh');
      await typeInto(field('New passphrase again'), 'qwertyuiopasdfgh');
      await click(byName('Change passphrase'));
      await settle();
      expect(alertText()).toMatch(/^That passphrase could be guessed in .+ Add more unrelated words, or use a suggested one.$/);
      expect(vault.changePassphrase).not.toHaveBeenCalled();
    });

    it('says when the current passphrase is wrong', async () => {
      vault.changePassphrase.mockRejectedValue(new Error(WRONG_CURRENT));
      await showSettings();
      await click(byName(/^Change$/));
      await typeInto(field('Current passphrase'), 'not it at all');
      await typeInto(field('New passphrase'), NEXT);
      await typeInto(field('New passphrase again'), NEXT);
      await click(byName('Change passphrase'));
      await settle();
      expect(alertText()).toBe(WRONG_CURRENT);
      expect(byName('Change passphrase')).toHaveProperty('disabled', false);
    });

    it('changes it, then clears the form and says so', async () => {
      const run = later();
      vault.changePassphrase.mockReturnValue(run.promise);
      await showSettings();
      await click(byName(/^Change$/));
      await typeInto(field('Current passphrase'), PASS);
      await typeInto(field('New passphrase'), NEXT);
      await typeInto(field('New passphrase again'), NEXT);
      await click(byName('Change passphrase'));
      expect(vault.changePassphrase).toHaveBeenCalledWith(PASS, NEXT);
      expect(byName('Change passphrase')).toHaveProperty('disabled', true);
      expect(byName('Cancel')).toHaveProperty('disabled', true);
      expectNotInMarkup(PASS, NEXT);
      run.resolve();
      await settle();
      expect(toasts()).toContain('Passphrase changed. Use it next time you unlock, on any device.');
      expect(queryByName('Current passphrase', 'input')).toBeNull();
      expect(onScreen()).not.toContain(NEXT);
      expect(onScreen()).not.toContain(PASS);
    });

    it('drops what was typed on Cancel', async () => {
      await showSettings();
      await click(byName(/^Change$/));
      await typeInto(field('Current passphrase'), PASS);
      await click(byName('Cancel'));
      expect(onScreen()).not.toContain(PASS);
      await click(byName(/^Change$/));
      expect(field('Current passphrase').value).toBe('');
    });
  });

  describe('a new recovery key', () => {
    it('needs the passphrase, and says when it is wrong', async () => {
      vault.replaceRecoveryKey.mockRejectedValue(new Error(WRONG_PASSPHRASE));
      await showSettings();
      await click(byName(/New key/));
      await click(byName('Make new key'));
      expect(vault.replaceRecoveryKey).not.toHaveBeenCalled();
      await typeInto(field('Passphrase'), 'wrong one here');
      await click(byName('Make new key'));
      await settle();
      expect(alertText()).toBe(WRONG_PASSPHRASE);
    });

    it('shows the new key once, until Done', async () => {
      vault.replaceRecoveryKey.mockResolvedValue(NEW_RECOVERY);
      await showSettings();
      await click(byName(/New key/));
      await typeInto(field('Passphrase'), PASS);
      await click(byName('Make new key'));
      await settle();
      expect(vault.replaceRecoveryKey).toHaveBeenCalledWith(PASS);
      expect(byName('Recovery key', 'code').textContent).toBe(NEW_RECOVERY);
      expect(onScreen()).not.toContain(PASS);
      await click(byName('Done'));
      expect(onScreen()).not.toContain(NEW_RECOVERY);
      expect(byName(/New key/)).toBeTruthy();
    });
  });

  describe('replacing the encryption key', () => {
    it('needs the passphrase, and says when it is wrong', async () => {
      vault.prepareKeyReplacement.mockRejectedValue(new Error(WRONG_PASSPHRASE));
      await showSettings();
      await click(byName(/^Replace key$/));
      await click(byName('Continue'));
      expect(vault.prepareKeyReplacement).not.toHaveBeenCalled();
      await typeInto(field('Passphrase'), 'wrong one here');
      await click(byName('Continue'));
      await settle();
      expect(alertText()).toBe(WRONG_PASSPHRASE);
    });

    it('replaces it only once the new recovery key is marked saved', async () => {
      const replacement = prepared(NEW_RECOVERY);
      vault.prepareKeyReplacement.mockResolvedValue(replacement);
      await showSettings();
      await click(byName(/^Replace key$/));
      await typeInto(field('Passphrase'), PASS);
      await click(byName('Continue'));
      await settle();
      expect(byName('Recovery key', 'code').textContent).toBe(NEW_RECOVERY);
      expect(onScreen()).not.toContain(PASS);
      const replace = byName('Replace key', 'button.btn-primary');
      expect(replace).toHaveProperty('disabled', true);
      const saved = byName<HTMLInputElement>('I’ve saved my new recovery key somewhere safe', 'input');
      await click(saved);
      await click(replace);
      await settle();
      expect(replacement.commit).toHaveBeenCalledTimes(1);
      expect(useApp.getState().settingsOpen).toBe(false);
      expect(useApp.getState().encryption.rekey).toBeGreaterThanOrEqual(1);
      expect(onScreen()).not.toContain(NEW_RECOVERY);
    });

    it('replaces nothing on Cancel', async () => {
      const replacement = prepared(NEW_RECOVERY);
      vault.prepareKeyReplacement.mockResolvedValue(replacement);
      await showSettings();
      await click(byName(/^Replace key$/));
      await typeInto(field('Passphrase'), PASS);
      await click(byName('Continue'));
      await settle();
      await click(byName('Cancel'));
      expect(replacement.commit).not.toHaveBeenCalled();
      expect(onScreen()).not.toContain(NEW_RECOVERY);
      expect(useApp.getState().encryption.rekey).toBe(0);
    });
  });

  it('shows one task at a time, starting the next one empty', async () => {
    await showSettings();
    await click(byName(/^Change$/));
    await typeInto(field('Current passphrase'), PASS);
    await click(byName(/New key/));
    expect(queryByName('Current passphrase', 'input')).toBeNull();
    expect(field('Passphrase').value).toBe('');
    expect(onScreen()).not.toContain(PASS);
  });

  it('names every field and button', async () => {
    await showSettings();
    for (const open of [/^Change$/, /New key/, /^Replace key$/]) {
      await click(byName(open));
      for (const el of document.querySelectorAll<HTMLElement>('input:not([hidden]), select, button')) expect(nameOf(el)).not.toBe('');
      await click(byName('Cancel'));
    }
  });
});

