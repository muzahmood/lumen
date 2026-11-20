/**
 * What phones and low vision need from the stylesheet (src/styles/app.css, prose.css): tick boxes whose
 * edge stands out at least 3:1 from every surface they sit on (WCAG 1.4.11), in both themes and on
 * paper, and taps 44px across on touch screens (WCAG 2.5.5) without moving any button.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8');
const PROSE = readFileSync(new URL('../../src/styles/prose.css', import.meta.url), 'utf8');

/** The custom properties set directly in the first block whose selector line matches. */
function tokens(selector: RegExp): Record<string, string> {
  const start = APP.search(selector);
  expect(start, String(selector)).toBeGreaterThanOrEqual(0);
  const body = APP.slice(APP.indexOf('{', start) + 1, APP.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('tick boxes', () => {
  it('stand out at least 3:1 from every surface, light and dark', () => {
    for (const [theme, t] of [
      ['light', tokens(/^:root \{/m)],
      ['dark', tokens(/^\[data-theme='dark'\] \{/m)],
    ] as const) {
      for (const surface of ['--bg', '--bg-elevated', '--bg-sunken']) {
        expect(contrast(t['--control-edge'], t[surface]), `${theme} ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('use that edge everywhere they’re drawn (editor, reading view, Tasks), and on paper', () => {
    for (const rule of ['.cm-lp-task {', '.task-box {']) {
      const at = APP.indexOf(rule);
      expect(APP.slice(at, APP.indexOf('}', at)), rule).toContain('var(--control-edge)');
    }
    const at = PROSE.indexOf('.kb-prose .kb-task-box {');
    expect(PROSE.slice(at, PROSE.indexOf('}', at))).toContain('var(--control-edge');
    expect(APP).toMatch(/\n {4}--control-edge: #7d8b9b;/);
  });
});

describe('taps on a touch screen', () => {
  const coarse = APP.slice(APP.indexOf('@media (pointer: coarse) {'));

  it('reach 44px round icon buttons (28px drawn, 8px each side) without moving one placed elsewhere', () => {
    expect(coarse).toMatch(/:where\(\.icon-btn, \.seg-btn\) \{\s*position: relative;/);
    expect(coarse).toMatch(/\.icon-btn::after \{\s*inset: -8px;/);
    expect(coarse).toMatch(/\.seg-btn::after \{\s*inset: -7px 0;/);
  });

  it('make places in stacked lists 44px tall on a phone', () => {
    const phone = APP.slice(APP.indexOf('@media (pointer: coarse) and (max-width: 759px) {'));
    expect(phone).toMatch(/\.nav-item,\s*\.settings-nav-item \{\s*min-height: 44px;/);
  });
});
