// @vitest-environment jsdom
/**
 * The dialogs every part of Lumen uses (src/components/ui.tsx): Modal (its name, Escape, the backdrop,
 * where focus goes and the Tab trap), the questions asked through DialogHost (confirm, choose, prompt,
 * and the hidden prompt for a backup's passphrase), and the lightbox that shows an image or diagram.
 */
import { byName, click, dialog, nameOf, pointerDown, press, pretendLayout, queryByName, settle, text, typeInto, unmountAll, mount } from './ui-note-helpers';
import { act, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DialogHost, Lightbox, Modal } from '../../src/components/ui';
import { chooseDialog, confirmDialog, noticeDialog, promptDialog, useApp } from '../../src/lib/store';

beforeAll(pretendLayout);

afterEach(async () => {
  await act(async () => useApp.setState({ dialog: null, lightbox: null }));
  await unmountAll();
  vi.unstubAllGlobals();
});

/** Waits out the animation frame dialogs move focus in. */
const frame = () => act(async () => new Promise<void>((r) => setTimeout(r, 30)));

function Example({ onClose, closeOnBackdrop, initialFocus }: { onClose: () => void; closeOnBackdrop?: boolean; initialFocus?: string }) {
  return (
    <Modal
      open
      title="Rename folder"
      description="Folders sort by name."
      onClose={onClose}
      closeOnBackdrop={closeOnBackdrop}
      initialFocus={initialFocus}
      footer={
        <>
          <button type="button">Cancel</button>
          <button type="button" className="btn-primary">
            Save
          </button>
        </>
      }
    >
      <input aria-label="Folder name" />
    </Modal>
  );
}

/** A button that opens the example dialog, as the app's buttons do. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      {open && <Example onClose={() => setOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------- modal --- */

describe('a dialog', () => {
  it('is a modal dialog named by its title, with the description and a Close button', async () => {
    await mount(<Example onClose={() => undefined} />);
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(nameOf(d)).toBe('Rename folder');
    expect(text(d)).toContain('Folders sort by name.');
    expect(byName('Close', 'button', d)).toBeTruthy();
  });

  it('is named by its label when it has no text title', async () => {
    await mount(
      <Modal open bare label="Settings" onClose={() => undefined}>
        <p>body</p>
      </Modal>,
    );
    expect(nameOf(dialog()!)).toBe('Settings');
  });

  it('closes on Escape, on its Close button and on a press outside it, but not on a press inside', async () => {
    const onClose = vi.fn();
    await mount(<Example onClose={onClose} />);
    await pointerDown(dialog()!.querySelector('input')!);
    expect(onClose).not.toHaveBeenCalled();
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(byName('Close', 'button', dialog()!));
    expect(onClose).toHaveBeenCalledTimes(2);
    await pointerDown(document.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('stays open on a press outside when it asks to (an editor with work in it)', async () => {
    const onClose = vi.fn();
    await mount(<Example onClose={onClose} closeOnBackdrop={false} />);
    await pointerDown(document.querySelector('.overlay')!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into itself on opening, or to the element it names', async () => {
    await mount(<Example onClose={() => undefined} />);
    await frame();
    expect(document.activeElement).toBe(dialog());
    await unmountAll();
    await mount(<Example onClose={() => undefined} initialFocus="input" />);
    await frame();
    expect(document.activeElement).toBe(dialog()!.querySelector('input'));
  });

  it('gives focus back to the button that opened it when it closes', async () => {
    await mount(<Opener />);
    const opener = byName('Open it', 'button');
    opener.focus();
    await click(opener);
    await frame();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await press('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab and Shift Tab inside it, going round from the last control to the first', async () => {
    await mount(<Example onClose={() => undefined} />);
    // The dialog takes focus in the next frame; moving it before then would race that.
    await frame();
    const d = dialog()!;
    const close = byName('Close', 'button', d);
    const save = byName('Save', 'button', d);
    save.focus();
    const forward = await press('Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const back = await press('Tab', { shift: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(save);
    // In between, Tab is left to the browser.
    d.querySelector('input')!.focus();
    expect((await press('Tab')).defaultPrevented).toBe(false);
  });

  it('keeps Shift Tab inside it right after opening, while focus is on the dialog itself', async () => {
    await mount(<Example onClose={() => undefined} />);
    await frame();
    expect(document.activeElement).toBe(dialog());
    const back = await press('Tab', { shift: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byName('Save', 'button', dialog()!));
  });

  it('has its description read out with its name', async () => {
    await mount(<Example onClose={() => undefined} />);
    const d = dialog()!;
    const ids = (d.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain('Folders sort by name.');
  });

  it('closes only the question on top when Escape is pressed, not the dialog it was asked from', async () => {
    const outerClosed = vi.fn();
    await mount(
      <>
        <Example onClose={outerClosed} />
        <DialogHost />
      </>,
    );
    let answer: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      answer = confirmDialog({ title: 'Download a readable copy?', confirmLabel: 'Download readable copy' });
    });
    expect(nameOf(dialog()!)).toBe('Download a readable copy?');
    await press('Escape');
    expect(await answer).toBe(false);
    expect(useApp.getState().dialog).toBeNull();
    expect(outerClosed).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------ the questions --- */

async function ask<T>(open: () => Promise<T>) {
  await mount(<DialogHost />);
  let result!: Promise<T>;
  await act(async () => {
    result = open();
  });
  let settled: { value: T } | null = null;
  void result.then((value) => (settled = { value }));
  return { result, answered: () => settled };
}

describe('a question (confirm)', () => {
  it('asks with its own words and buttons, and says yes only on the main button', async () => {
    const q = await ask(() =>
      confirmDialog({ title: 'Delete this note forever?', message: 'Its history goes with it.', confirmLabel: 'Delete forever', danger: true }),
    );
    const d = dialog()!;
    expect(nameOf(d)).toBe('Delete this note forever?');
    expect(text(d)).toContain('Its history goes with it.');
    const yes = byName('Delete forever', 'button', d);
    expect(yes.className).toContain('btn-danger');
    await click(yes);
    expect(await q.result).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('says no on Cancel, on Escape, on the Close button and on a press outside', async () => {
    for (const answer of [
      () => click(byName('Cancel', 'button', dialog()!)),
      () => press('Escape'),
      () => click(byName('Close', 'button', dialog()!)),
      () => pointerDown(document.querySelector('.overlay')!),
    ]) {
      const q = await ask(() => confirmDialog({ title: 'Empty the trash?', confirmLabel: 'Empty trash', danger: true }));
      await answer();
      expect(await q.result).toBe(false);
      expect(useApp.getState().dialog).toBeNull();
      await unmountAll();
    }
  });

  it('has its message read out with the question, not only its title', async () => {
    await ask(() => confirmDialog({ title: 'Delete this note forever?', message: 'Its history goes with it. This can’t be undone.', confirmLabel: 'Delete forever', danger: true }));
    const d = dialog()!;
    const ids = (d.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain('This can’t be undone.');
  });

  it('puts focus on the main button, so Enter answers it and nothing is chosen by accident before that', async () => {
    await ask(() => confirmDialog({ title: 'Restore this version?', confirmLabel: 'Restore version' }));
    await frame();
    expect(document.activeElement).toBe(byName('Restore version', 'button', dialog()!));
  });

  it('offers a third choice when asked with two answers (choose)', async () => {
    const pick = async (label: string) => {
      const q = await ask(() =>
        chooseDialog({ title: 'This drawing was changed somewhere else', confirmLabel: 'Save as a copy', altLabel: 'Replace theirs', cancelLabel: 'Keep editing' }),
      );
      await click(byName(label, 'button', dialog()!));
      const value = await q.result;
      await unmountAll();
      return value;
    };
    expect(await pick('Save as a copy')).toBe('confirm');
    expect(await pick('Replace theirs')).toBe('alt');
    expect(await pick('Keep editing')).toBeNull();
  });
});

describe('a notice', () => {
  it('has one button, nothing to decline, and is done with it or Escape', async () => {
    for (const close of [() => click(byName('Sign out', 'button', dialog()!)), () => press('Escape')]) {
      const q = await ask(() => noticeDialog({ title: 'Pictures and files opened here are still in this browser', confirmLabel: 'Sign out' }));
      expect([...dialog()!.querySelectorAll('.modal-footer button')].map((b) => b.textContent)).toEqual(['Sign out']);
      await close();
      await q.result;
      expect(dialog()).toBeNull();
    }
  });
});

describe('questions asked while one is showing', () => {
  it('wait their turn: each is shown, and answered, in order, and none is left unanswered', async () => {
    await mount(<DialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<'confirm' | 'alt' | null>;
    let third!: Promise<string | null>;
    await act(async () => {
      first = confirmDialog({ title: 'Move to the trash?', confirmLabel: 'Move' });
      second = chooseDialog({ title: 'Save what was shared?', confirmLabel: 'Save as a note', altLabel: 'Discard' });
      third = promptDialog({ title: 'New folder', confirmLabel: 'Create' });
    });
    await frame();
    expect(nameOf(dialog()!)).toBe('Move to the trash?');
    await click(byName('Move', 'button', dialog()!));
    expect(await first).toBe(true);
    await frame();
    expect(nameOf(dialog()!)).toBe('Save what was shared?');
    await click(byName('Discard', 'button', dialog()!));
    expect(await second).toBe('alt');
    await frame();
    expect(nameOf(dialog()!)).toBe('New folder');
    await press('Escape');
    expect(await third).toBeNull();
    expect(dialog()).toBeNull();
  });
});

describe('a question that asks for text (prompt)', () => {
  it('starts from the text given, focused and selected, and answers with what was typed', async () => {
    const q = await ask(() => promptDialog({ title: 'Rename folder', initial: 'Work', confirmLabel: 'Rename' }));
    await frame();
    const input = dialog()!.querySelector('input')!;
    expect(input.value).toBe('Work');
    expect(document.activeElement).toBe(input);
    expect(nameOf(input)).toBe('Rename folder');
    await typeInto(input, 'Projects');
    await click(byName('Rename', 'button', dialog()!));
    expect(await q.result).toBe('Projects');
  });

  it('can’t be answered with blank text, by its button or by Enter', async () => {
    const q = await ask(() => promptDialog({ title: 'New folder', placeholder: 'Folder name', confirmLabel: 'Create folder' }));
    const input = dialog()!.querySelector('input')!;
    expect(nameOf(input)).toBe('Folder name');
    await typeInto(input, '   ');
    const create = byName('Create folder', 'button', dialog()!) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await act(async () => input.form!.requestSubmit());
    await settle();
    expect(q.answered()).toBeNull();
    expect(dialog()).not.toBeNull();
    await typeInto(input, 'Ideas');
    expect(create.disabled).toBe(false);
    // Enter in the box submits its form.
    await act(async () => input.form!.requestSubmit());
    expect(await q.result).toBe('Ideas');
  });

  it('answers nothing (null) when cancelled', async () => {
    const q = await ask(() => promptDialog({ title: 'New folder', confirmLabel: 'Create folder' }));
    await typeInto(dialog()!.querySelector('input')!, 'Half typed');
    await press('Escape');
    expect(await q.result).toBeNull();
  });

  it('hides what is typed for a passphrase', async () => {
    await ask(() => promptDialog({ title: 'Unlock this backup', placeholder: 'Passphrase or recovery key', confirmLabel: 'Unlock', secret: true }));
    const input = dialog()!.querySelector('input')!;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });

  it('keeps a typed passphrase out of the page’s HTML, where a stray style rule could read it', async () => {
    await ask(() => promptDialog({ title: 'Unlock this backup', placeholder: 'Passphrase or recovery key', confirmLabel: 'Unlock', secret: true }));
    const input = dialog()!.querySelector('input')!;
    await typeInto(input, 'correct horse battery staple');
    expect(input.value).toBe('correct horse battery staple');
    expect(input.getAttribute('value')).not.toBe('correct horse battery staple');
    expect(document.body.innerHTML).not.toContain('correct horse battery staple');
  });

  it('opens a second question with its own starting text, not what was typed into the first', async () => {
    await mount(<DialogHost />);
    let first!: Promise<string | null>;
    await act(async () => {
      first = promptDialog({ title: 'Unlock this backup', confirmLabel: 'Unlock', secret: true });
    });
    await typeInto(dialog()!.querySelector('input')!, 'wrong guess');
    await click(byName('Unlock', 'button', dialog()!));
    expect(await first).toBe('wrong guess');
    await act(async () => {
      void promptDialog({ title: 'Unlock this backup', message: 'That didn’t open it.', confirmLabel: 'Unlock', secret: true });
    });
    expect(dialog()!.querySelector('input')!.value).toBe('');
  });
});

/* ---------------------------------------------------------- lightbox --- */

describe('the lightbox', () => {
  it('shows an image full size, named by its description, and zooms in, out and back', async () => {
    await mount(<Lightbox />);
    await act(async () => useApp.setState({ lightbox: { kind: 'image', src: 'https://example.com/cat.png', alt: 'A cat on a mat' } }));
    const d = dialog()!;
    expect(nameOf(d)).toBe('A cat on a mat');
    expect(d.querySelector('img')!.getAttribute('src')).toBe('https://example.com/cat.png');
    expect(d.querySelector('img')!.getAttribute('alt')).toBe('A cat on a mat');
    const zoom = () => d.querySelector('[data-tip="Reset zoom"]')!.textContent?.trim();
    expect(zoom()).toBe('100%');
    await click(byName('Zoom in', 'button', d));
    expect(zoom()).toBe('125%');
    await click(byName('Zoom out', 'button', d));
    await click(byName('Zoom out', 'button', d));
    expect(zoom()).toBe('80%');
    await click(d.querySelector('[data-tip="Reset zoom"]'));
    expect(zoom()).toBe('100%');
  });

  it('names the zoom reset button for what it does', async () => {
    await mount(<Lightbox />);
    await act(async () => useApp.setState({ lightbox: { kind: 'image', src: '/api/files/abcdef1', alt: 'chart' } }));
    const reset = dialog()!.querySelector('[data-tip="Reset zoom"]')!;
    expect(nameOf(reset)).toMatch(/reset zoom/i);
  });

  it('can’t be zoomed past six times or below a quarter', async () => {
    await mount(<Lightbox />);
    await act(async () => useApp.setState({ lightbox: { kind: 'image', src: '/api/files/abcdef1' } }));
    const d = dialog()!;
    for (let i = 0; i < 20; i++) await click(byName('Zoom in', 'button', d));
    expect(d.querySelector<HTMLElement>('.lightbox-content')!.style.width).toBe('600%');
    for (let i = 0; i < 30; i++) await click(byName('Zoom out', 'button', d));
    expect(d.querySelector<HTMLElement>('.lightbox-content')!.style.width).toBe('25%');
  });

  it('closes on Escape, on Close and on a click beside the picture', async () => {
    await mount(<Lightbox />);
    const open = () => act(async () => useApp.setState({ lightbox: { kind: 'image', src: '/api/files/abcdef1', alt: '' } }));
    await open();
    expect(nameOf(dialog()!)).toBe('Image');
    await press('Escape');
    expect(useApp.getState().lightbox).toBeNull();
    await open();
    await click(byName('Close', 'button', dialog()!));
    expect(useApp.getState().lightbox).toBeNull();
    await open();
    await click(document.querySelector('.lightbox-stage'));
    expect(useApp.getState().lightbox).toBeNull();
  });

  it('offers the original of an ordinary image, in a new tab that can’t reach back into Lumen', async () => {
    await mount(<Lightbox />);
    await act(async () => useApp.setState({ lightbox: { kind: 'image', src: '/api/files/abcdef1', alt: 'chart' } }));
    const link = byName('Open original', 'a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/files/abcdef1');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });

  it('offers a decrypted image’s original only when it’s a kind that can’t run anything (not SVG)', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response('x', { headers: { 'content-type': url.endsWith('svg') ? 'image/svg+xml' : 'image/png' } }));
    await mount(<Lightbox />);
    await act(async () => useApp.setState({ lightbox: { kind: 'image', src: 'blob:http://localhost/photo-png', alt: 'photo' } }));
    await settle();
    expect(queryByName('Open original', 'a')).not.toBeNull();
    await act(async () => useApp.setState({ lightbox: { kind: 'image', src: 'blob:http://localhost/drawing-svg', alt: 'drawing' } }));
    await settle();
    expect(queryByName('Open original', 'a')).toBeNull();
  });

  it('shows a diagram without an Open original link', async () => {
    await mount(<Lightbox />);
    await act(async () => useApp.setState({ lightbox: { kind: 'svg', html: '<svg role="img" aria-label="Flow"><g></g></svg>' } }));
    const d = dialog()!;
    expect(d.querySelector('.lightbox-svg svg')).not.toBeNull();
    expect(nameOf(d)).not.toBe('');
    expect(queryByName('Open original', 'a')).toBeNull();
  });
});
