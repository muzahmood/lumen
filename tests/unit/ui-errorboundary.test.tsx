// @vitest-environment jsdom
/**
 * The error boundary (src/components/ErrorBoundary.tsx): a way out instead of a blank page. A note pane
 * that fails says so and can try again (by itself when another note opens); the whole app shows a
 * full-screen message; a dialog closes itself and reports why. A screen that failed to download is told
 * apart: offline (try again once back) or replaced by a new version (reload).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, byRole, click, queryByRole, render, server, settle, teardown, textOf } from './ui-shell-helpers';

let ErrorBoundary: typeof import('../../src/components/ErrorBoundary').ErrorBoundary;
const reload = vi.fn();

beforeEach(async () => {
  await boot({ encrypted: false });
  ({ ErrorBoundary } = await import('../../src/components/ErrorBoundary'));
  reload.mockReset();
  // The boundary logs what it caught; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // jsdom can't reload; what matters is that a reload was asked for.
  Object.defineProperty(window, 'location', { value: Object.assign(new URL(window.location.href), { reload }), configurable: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await teardown();
});

let failure: Error | null = null;
function Child() {
  if (failure) throw failure;
  return <p>All good</p>;
}
const chunkError = () => new TypeError('Failed to fetch dynamically imported module: /assets/NoteView-abc.js');

describe('a note pane that fails', () => {
  it('shows what’s inside it while nothing fails', async () => {
    failure = null;
    await render(
      <ErrorBoundary scope="pane" label="The note editor">
        <Child />
      </ErrorBoundary>,
    );
    expect(textOf(document.body)).toBe('All good');
  });

  it('says the note couldn’t be shown, as an alert, with Try again and Reload', async () => {
    failure = new Error('boom');
    const onReset = vi.fn();
    await render(
      <ErrorBoundary scope="pane" label="The note editor" onReset={onReset}>
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    const alert = byRole('alert');
    expect(textOf(alert)).toContain('This note couldn’t be shown');
    expect(textOf(alert)).toContain('Your edits are kept on this device');
    failure = null;
    await click(byRole('button', 'Try again'));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(textOf(document.body)).toBe('All good');
  });

  it('reloads from Reload', async () => {
    failure = new Error('boom');
    await render(
      <ErrorBoundary scope="pane">
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    await click(byRole('button', 'Reload'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('tries again by itself when another note opens', async () => {
    failure = new Error('boom');
    const view = await render(
      <ErrorBoundary scope="pane" resetKey="a">
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(queryByRole('alert')).not.toBeNull();
    failure = null;
    await view.rerender(
      <ErrorBoundary scope="pane" resetKey="b">
        <Child />
      </ErrorBoundary>,
    );
    expect(textOf(document.body)).toBe('All good');
  });

  it('says it’s offline when its code couldn’t be downloaded and the device is offline, without a Reload', async () => {
    failure = chunkError();
    server.intercept = (req) => (req.path === '/' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
    await render(
      <ErrorBoundary scope="pane" label="The note editor">
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(textOf(byRole('alert'))).toContain('You’re offline');
    expect(textOf(byRole('alert'))).toContain('The note editor isn’t saved on this device yet');
    expect(queryByRole('button', 'Reload')).toBeNull();
    expect(byRole('button', 'Try again')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('moves to the new version by itself when its code was replaced by one', async () => {
    failure = chunkError();
    await render(
      <ErrorBoundary scope="pane">
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(textOf(byRole('alert'))).toContain('Lumen has been updated');
    expect(queryByRole('button', 'Try again')).toBeNull();
  });
});

describe('the whole app failing', () => {
  it('fills the screen with what went wrong', async () => {
    failure = new Error('boom');
    await render(
      <ErrorBoundary scope="app">
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(textOf(byRole('heading'))).toBe('Something went wrong');
    expect(byRole('alert').classList.contains('splash')).toBe(true);
  });
});

describe('a dialog failing', () => {
  it('shows nothing and reports a message to show instead', async () => {
    failure = new Error('boom');
    const onFail = vi.fn();
    await render(
      <ErrorBoundary scope="dialog" label="Settings" onFail={onFail}>
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(textOf(document.body)).toBe('');
    expect(onFail).toHaveBeenCalledWith('Settings couldn’t open. Reloading usually fixes it; your edits are kept on this device.', 'other');
  });

  it('reports a new version without reloading by itself (a dialog may hold unsaved choices)', async () => {
    failure = chunkError();
    const onFail = vi.fn();
    await render(
      <ErrorBoundary scope="dialog" label="Version history" onFail={onFail}>
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(onFail).toHaveBeenCalledWith('Lumen has been updated. Reload to open version history.', 'updated');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports being offline', async () => {
    failure = chunkError();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const onFail = vi.fn();
    await render(
      <ErrorBoundary scope="dialog" label="Settings" onFail={onFail}>
        <Child />
      </ErrorBoundary>,
    );
    await settle();
    expect(onFail).toHaveBeenCalledWith('Settings isn’t saved on this device yet. It opens once you’re back online.', 'offline');
  });
});
