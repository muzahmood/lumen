// @vitest-environment jsdom
/**
 * Menus, toasts and the small controls of src/components/ui.tsx: a menu button and its menu (keys,
 * closing, the filter box long menus get, Enter on a single match that never picks a destructive
 * action), the toasts that report what happened (with Undo and similar), segmented choices and icon
 * buttons, each as a keyboard or screen-reader user meets them.
 */
import { FAKE_TIMERS, advance, allByName, byName, click, mount, nameOf, pointerDown, press, queryByName, settle, text, typeInto, unmountAll } from './ui-note-helpers';
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconButton, MenuButton, Segmented, Toasts, type MenuItem } from '../../src/components/ui';
import { toast, useApp } from '../../src/lib/store';

afterEach(async () => {
  await act(async () => useApp.setState({ toasts: [] }));
  await unmountAll();
  vi.useRealTimers();
});

/** Waits out the animation frame a menu moves focus in. */
const frame = () => act(async () => new Promise<void>((r) => setTimeout(r, 30)));
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => allByName(/.*/, '[role^="menuitem"]', menu()!);

function folders(n: number, picked: string[]): MenuItem[] {
  return [
    { heading: 'Move to' },
    ...Array.from({ length: n }, (_, i) => ({ label: `Folder ${i + 1}`, onSelect: () => picked.push(`Folder ${i + 1}`) })),
    { separator: true },
    { label: 'Move to trash', danger: true, onSelect: () => picked.push('trash') },
  ];
}

describe('a menu button', () => {
  it('says it opens a menu, and whether it is open', async () => {
    await mount(<MenuButton label="More" icon={<span />} items={[{ label: 'Duplicate', onSelect: () => undefined }]} />);
    const button = byName('More', 'button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(nameOf(menu()!)).toBe('More');
    expect(items().map(nameOf)).toEqual(['Duplicate']);
  });

  it('runs the item chosen and closes the menu', async () => {
    const picked: string[] = [];
    await mount(<MenuButton label="More" icon={<span />} items={folders(3, picked)} />);
    await click(byName('More', 'button'));
    await click(byName('Folder 2', '[role^="menuitem"]'));
    expect(picked).toEqual(['Folder 2']);
    expect(menu()).toBeNull();
  });

  it('can’t run a disabled item', async () => {
    const run = vi.fn();
    await mount(<MenuButton label="More" icon={<span />} items={[{ label: 'Paste', disabled: true, onSelect: run }]} />);
    await click(byName('More', 'button'));
    const paste = byName<HTMLButtonElement>('Paste', '[role^="menuitem"]');
    expect(paste.disabled).toBe(true);
    await click(paste);
    expect(run).not.toHaveBeenCalled();
  });

  it('closes on Escape and on a press outside it, without running anything', async () => {
    const picked: string[] = [];
    await mount(<MenuButton label="More" icon={<span />} items={folders(3, picked)} />);
    await click(byName('More', 'button'));
    await press('Escape');
    expect(menu()).toBeNull();
    await click(byName('More', 'button'));
    await pointerDown(document.body);
    expect(menu()).toBeNull();
    expect(picked).toEqual([]);
  });

  it('closes when its own button is pressed again', async () => {
    await mount(<MenuButton label="More" icon={<span />} items={[{ label: 'Duplicate' }]} />);
    const button = byName('More', 'button');
    await click(button);
    expect(menu()).not.toBeNull();
    // A real press: pointerdown, then click once the browser has let the page update.
    await pointerDown(button);
    await settle();
    await click(button);
    expect(menu()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves focus into the menu, and between its items with the arrow keys, going round', async () => {
    await mount(<MenuButton label="More" icon={<span />} items={[{ label: 'One' }, { separator: true }, { label: 'Two' }, { label: 'Three' }]} />);
    await click(byName('More', 'button'));
    await frame();
    expect(nameOf(document.activeElement!)).toBe('One');
    await press('ArrowDown');
    expect(nameOf(document.activeElement!)).toBe('Two');
    await press('ArrowUp');
    await press('ArrowUp');
    expect(nameOf(document.activeElement!)).toBe('Three');
    await press('ArrowDown');
    expect(nameOf(document.activeElement!)).toBe('One');
  });

  it('gives focus back to its button when the menu closes with Escape', async () => {
    await mount(<MenuButton label="More" icon={<span />} items={[{ label: 'One' }, { label: 'Two' }]} />);
    const button = byName('More', 'button');
    button.focus();
    await click(button);
    await frame();
    expect(menu()!.contains(document.activeElement)).toBe(true);
    await press('Escape');
    expect(document.activeElement).toBe(button);
  });

  it('shows a check beside the chosen item and its hint', async () => {
    await mount(
      <MenuButton
        label="View options"
        icon={<span />}
        items={[
          { label: 'Sort by title', checked: true },
          { label: 'Sort by date', hint: 'Newest first' },
        ]}
      />,
    );
    await click(byName('View options', 'button'));
    expect(byName(/^Sort by title/, '[role^="menuitem"]').classList).toContain('is-checked');
    expect(text(byName(/^Sort by date/, '[role^="menuitem"]'))).toContain('Newest first');
  });
});

describe('a long menu’s filter box', () => {
  it('appears only when there are more than ten choices', async () => {
    await mount(<MenuButton label="Move" icon={<span />} items={folders(9, [])} />);
    await click(byName('Move', 'button'));
    // Nine folders and Move to trash: ten choices.
    expect(menu()!.querySelector('input')).toBeNull();
    await unmountAll();
    await mount(<MenuButton label="Move" icon={<span />} items={folders(10, [])} />);
    await click(byName('Move', 'button'));
    await frame();
    const filter = byName<HTMLInputElement>('Filter this menu', 'input');
    expect(document.activeElement).toBe(filter);
  });

  it('narrows the menu to what matches, in any case, and says when nothing does', async () => {
    await mount(<MenuButton label="Move" icon={<span />} items={folders(12, [])} />);
    await click(byName('Move', 'button'));
    await typeInto(byName('Filter this menu', 'input'), 'FOLDER 1');
    expect(items().map(nameOf)).toEqual(['Folder 1', 'Folder 10', 'Folder 11', 'Folder 12']);
    // Headings and separators go while filtering.
    expect(text(menu()!)).not.toContain('Move to');
    await typeInto(byName('Filter this menu', 'input'), 'zzz');
    expect(items()).toHaveLength(0);
    expect(text(menu()!)).toContain('Nothing matches');
  });

  it('picks the one match on Enter', async () => {
    const picked: string[] = [];
    await mount(<MenuButton label="Move" icon={<span />} items={folders(12, picked)} />);
    await click(byName('Move', 'button'));
    const filter = byName('Filter this menu', 'input');
    await typeInto(filter, 'folder 7');
    await press('Enter', {}, filter);
    expect(picked).toEqual(['Folder 7']);
    expect(menu()).toBeNull();
  });

  it('never picks a destructive action on Enter, even as the only match: it goes to it instead', async () => {
    const picked: string[] = [];
    await mount(<MenuButton label="Move" icon={<span />} items={folders(12, picked)} />);
    await click(byName('Move', 'button'));
    const filter = byName('Filter this menu', 'input');
    await typeInto(filter, 'trash');
    await press('Enter', {}, filter);
    expect(picked).toEqual([]);
    expect(menu()).not.toBeNull();
    expect(nameOf(document.activeElement!)).toBe('Move to trash');
  });

  it('goes to the first match on Enter when several match, and to the items with the arrow keys', async () => {
    const picked: string[] = [];
    await mount(<MenuButton label="Move" icon={<span />} items={folders(12, picked)} />);
    await click(byName('Move', 'button'));
    // The menu focuses its filter box in the next frame; moving focus before then would race that.
    await frame();
    const filter = byName('Filter this menu', 'input');
    await typeInto(filter, 'folder 1');
    await press('Enter', {}, filter);
    expect(picked).toEqual([]);
    expect(nameOf(document.activeElement!)).toBe('Folder 1');
    filter.focus();
    await press('ArrowUp', {}, filter);
    expect(nameOf(document.activeElement!)).toBe('Folder 12');
  });
});

/* ------------------------------------------------------------- toasts --- */

describe('toasts', () => {
  it('are announced politely to screen readers', async () => {
    await mount(<Toasts />);
    await act(async () => void toast('Link copied', { kind: 'success' }));
    const region = document.querySelector('.toasts')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(text(region)).toContain('Link copied');
  });

  it('run their action once, then go', async () => {
    const undo = vi.fn();
    const forever = vi.fn();
    await mount(<Toasts />);
    await act(
      async () =>
        void toast('Moved to trash', { more: [{ label: 'Delete forever', danger: true, run: forever }], action: { label: 'Undo', run: undo } }),
    );
    // The main action comes last; a destructive one is styled as such.
    const buttons = Array.from(document.querySelectorAll('.toast button.toast-action')).map(nameOf);
    expect(buttons).toEqual(['Delete forever', 'Undo']);
    expect(byName('Delete forever', 'button').classList).toContain('is-danger');
    await click(byName('Undo', 'button'));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(forever).not.toHaveBeenCalled();
    expect(queryByName('Undo', 'button')).toBeNull();
  });

  it('can be dismissed', async () => {
    await mount(<Toasts />);
    await act(async () => void toast('Note restored'));
    await click(byName('Dismiss', 'button'));
    expect(text()).not.toContain('Note restored');
  });

  it('go by themselves: a few seconds, longer with an action or for an error, longer still with several actions', async () => {
    vi.useFakeTimers(FAKE_TIMERS as never);
    await mount(<Toasts />);
    await act(async () => {
      toast('Saved');
      toast('Couldn’t save', { kind: 'error' });
      toast('Moved', { action: { label: 'Undo', run: () => undefined } });
    });
    await advance(3300);
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Couldn’t save', 'Moved']);
    await advance(3000);
    expect(useApp.getState().toasts).toEqual([]);
    await act(async () => void toast('Trash', { more: [{ label: 'Delete forever', run: () => undefined }], action: { label: 'Undo', run: () => undefined } }));
    await advance(7000);
    expect(useApp.getState().toasts).toHaveLength(1);
    await advance(1100);
    expect(useApp.getState().toasts).toHaveLength(0);
    await act(async () => void toast('Stays', { timeout: 0 }));
    await advance(60_000);
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Stays']);
  });

  it('show at most four at once, the oldest going first', async () => {
    await mount(<Toasts />);
    await act(async () => {
      for (const m of ['one', 'two', 'three', 'four', 'five']) toast(m);
    });
    expect(Array.from(document.querySelectorAll('.toast-msg')).map((m) => m.textContent)).toEqual(['two', 'three', 'four', 'five']);
  });
});

/* ------------------------------------------------- choices and buttons --- */

function ViewChoice({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState<'edit' | 'split' | 'read'>('edit');
  return (
    <Segmented
      label="View"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      options={[
        { value: 'edit', label: 'Edit', icon: <svg />, hideLabel: true },
        { value: 'split', label: 'Split', icon: <svg />, hideLabel: true },
        { value: 'read', label: 'Read' },
      ]}
    />
  );
}

describe('a segmented choice', () => {
  it('is a named group of radio buttons, each named even when only its icon shows', async () => {
    await mount(<ViewChoice />);
    const group = document.querySelector('[role="radiogroup"]')!;
    expect(nameOf(group)).toBe('View');
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(radios.map(nameOf)).toEqual(['Edit', 'Split', 'Read']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('changes on a click', async () => {
    const onChange = vi.fn();
    await mount(<ViewChoice onChange={onChange} />);
    await click(byName('Read', '[role="radio"]'));
    expect(onChange).toHaveBeenCalledWith('read');
    expect(byName('Read', '[role="radio"]').getAttribute('aria-checked')).toBe('true');
    expect(byName('Edit', '[role="radio"]').getAttribute('aria-checked')).toBe('false');
  });

  it('moves the choice with the arrow keys, as a radio group does', async () => {
    const onChange = vi.fn();
    await mount(<ViewChoice onChange={onChange} />);
    const edit = byName('Edit', '[role="radio"]');
    edit.focus();
    await press('ArrowRight', {}, edit);
    expect(onChange).toHaveBeenCalledWith('split');
  });
});

describe('an icon button', () => {
  it('is named by its label, with the label and shortcut as its tooltip', async () => {
    await mount(
      <IconButton label="Show sidebar" shortcut="Ctrl \">
        <svg />
      </IconButton>,
    );
    const b = byName('Show sidebar', 'button');
    expect(b.getAttribute('data-tip')).toBe('Show sidebar');
    expect(b.getAttribute('data-tip-kbd')).toBe('Ctrl \\');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.hasAttribute('aria-pressed')).toBe(false);
  });

  it('says whether it is on when it is a toggle', async () => {
    const { rerender } = await mount(
      <IconButton label="Pin to top" active={false}>
        <svg />
      </IconButton>,
    );
    expect(byName('Pin to top', 'button').getAttribute('aria-pressed')).toBe('false');
    await rerender(
      <IconButton label="Pin to top" active>
        <svg />
      </IconButton>,
    );
    expect(byName('Pin to top', 'button').getAttribute('aria-pressed')).toBe('true');
  });
});
