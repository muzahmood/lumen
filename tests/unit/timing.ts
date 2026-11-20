/**
 * Timing guards ("stays quick on …"): hostile or huge input mustn't make Lumen freeze, as a
 * quadratic loop or a backtracking regex would. Their limits were set on a fast desktop with little
 * else running. Deploys run the suite on a build server with 2 slower vCPUs and the rest of the
 * suite running alongside, where everything takes several times as long, and fixed limits failed
 * there (and so blocked the deploy) although nothing was wrong.
 *
 * So a guard over its limit isn't failed straight away: a fixed reference task is timed on this
 * machine, now, and the limit is scaled by how much slower than on that desktop it runs. A real
 * blow-up is tens to thousands of times over its limit on any machine, so it still fails; a busy or
 * slow machine doesn't.
 */
import { expect } from 'vitest';

/** How long RUNS referenceTask()s take on the desktop the limits were set on (median of batches). */
const REFERENCE_MS = 180;
/**
 * Long enough (~0.2 s) to span many of the operating system's time slices: a short task can fit in
 * one slice and run at full speed on a machine whose cores are shared by many processes, which a
 * guarded task taking seconds can't.
 */
const RUNS = 40;

let sink = 0;

/** Ordinary text work of the kind the guarded code does: building strings, regexes, splitting, maps. */
function referenceTask() {
  let text = '';
  for (let i = 0; i < 3000; i++) text += `- [ ] line ${i} with **bold**, ==mark==, $x_${i}$ and [[Note ${i % 97}|alias]]\n`;
  let n = 0;
  for (let round = 0; round < 3; round++) {
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\*\*([^*]+)\*\*|==([^=]+)==/g)) n += m[0].length;
    const lines = text.split('\n').map((l) => l.trim().toLowerCase());
    const seen = new Map<string, number>();
    for (const l of lines) seen.set(l.slice(0, 12), (seen.get(l.slice(0, 12)) ?? 0) + 1);
    n += seen.size + lines.filter((l) => l.includes('7')).join('|').length;
  }
  sink += n;
}

/** How many times slower than that desktop this machine is running right now (at least 1). */
export function slowdown(): number {
  const start = performance.now();
  for (let i = 0; i < RUNS; i++) referenceTask();
  return Math.max(1, (performance.now() - start) / REFERENCE_MS) + (sink < 0 ? 1 : 0);
}

/** `elapsed` (ms) is within `limitMs`, allowing for this machine's speed when it's over. */
export function expectQuick(elapsed: number, limitMs: number): void {
  if (elapsed < limitMs) return;
  const factor = slowdown();
  expect(
    elapsed,
    `took ${Math.round(elapsed)} ms, over ${limitMs} ms × ${factor.toFixed(1)} (how much slower this machine is running than the one the limit was set on)`,
  ).toBeLessThan(limitMs * factor);
}
