/**
 * Back (a phone's back gesture or button, the browser's Back) as in an app: it first closes whatever
 * is open over the page, one thing at a time, newest first (a question, Settings, the switcher, the
 * drawer, a menu, a picture), then steps back through Lumen's own pages (see routing in store.ts),
 * and only from the first leaves Lumen.
 *
 * Each such thing adds a step to the browser's history as it opens (same address, so nothing
 * reloads), and Back taking that step closes it. Closed any other way (its button, Escape), its step
 * is taken back off, so history doesn't fill with steps that do nothing. One that stays open when
 * asked to close (a drawing whose unsaved changes are kept) puts its step back.
 *
 * Going to another page while something's open (a note picked in the switcher, a folder in the
 * drawer) first takes those steps off, so Back from the new page goes to the page before it.
 *
 * This is the one listener for Back and Forward: pages listen through onPageChange.
 */
import { useEffect, useRef } from 'react';

interface Layer {
  id: number;
  close: () => void;
  done: boolean;
  /** Its step is in history (it waits while steps are coming off: adding one then could lose them). */
  placed: boolean;
}

interface StepState {
  kb?: boolean;
  /** The thing open over the page that this step is for (none: a page's own step). */
  layer?: number;
  /** How many such steps are on top of the page's own step, this one included. */
  depth?: number;
}

const layers: Layer[] = [];
let seq = 0;
/** Steps back this module is taking itself (a thing closed some other way): their popstate isn't Back. */
let ownBacks = 0;
/** A page change waiting for the steps of things open over the page to come off first. */
let pendingPage: (() => void) | null = null;
/** Run once those steps are done: anything waiting goes after them, in the right place. */
let settled: Array<() => void> = [];
const pageListeners = new Set<() => void>();
/** A step taken off that never arrived (a browser that dropped it): nothing waits on it for long. */
let stall: ReturnType<typeof setTimeout> | undefined;

const stateOf = (state: unknown): StepState => (state && typeof state === 'object' ? (state as StepState) : {});
export const layerOf = (state: unknown): number => {
  const id = stateOf(state).layer;
  return typeof id === 'number' ? id : 0;
};
const depthOf = (state: unknown): number => {
  const depth = stateOf(state).depth;
  return typeof depth === 'number' && depth > 0 ? Math.floor(depth) : 0;
};

function whenSettled(fn: () => void) {
  if (ownBacks === 0 && !pendingPage) fn();
  else settled.push(fn);
}

function runSettled() {
  if (ownBacks > 0 || pendingPage) return;
  clearTimeout(stall);
  if (!settled.length) return;
  const run = settled;
  settled = [];
  run.forEach((fn) => fn());
}

/** Takes steps off (back by `by`), with a fallback if the browser never says it has. */
function stepBack(by: number) {
  clearTimeout(stall);
  stall = setTimeout(() => {
    ownBacks = 0;
    const page = pendingPage;
    pendingPage = null;
    page?.();
    runSettled();
  }, 1000);
  history.go(-by);
}

/**
 * Adds a Back step that calls `close`. Returns what to call when it closes some other way (its step is
 * then taken back off, if it's still the current one).
 */
export function pushLayer(close: () => void): () => void {
  const layer: Layer = { id: ++seq, close, done: false, placed: false };
  layers.push(layer);
  whenSettled(() => {
    if (layer.done) return;
    try {
      const state = stateOf(history.state);
      history.pushState({ ...state, kb: true, layer: layer.id, depth: depthOf(state) + 1 }, '');
      layer.placed = true;
    } catch {
      /* no history here (a sandboxed frame): Back just leaves */
    }
  });
  return () => {
    if (layer.done) return;
    layer.done = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    // Not in history yet, or a page change is taking these steps off already.
    if (!layer.placed || pendingPage || layerOf(history.state) !== layer.id) return;
    ownBacks++;
    stepBack(1);
  };
}

/**
 * Changes page (`go` pushes or replaces the history entry). With things open over the page, their
 * steps come off first, and they close: the new page's step goes where the old page's was, and Back
 * from it goes to the page before.
 */
export function changePage(go: () => void) {
  if (pendingPage) {
    const before = pendingPage;
    pendingPage = () => {
      before();
      go();
    };
    return;
  }
  if (ownBacks > 0) {
    settled.push(() => changePage(go));
    return;
  }
  const depth = depthOf(history.state);
  if (depth === 0) {
    go();
    return;
  }
  pendingPage = go;
  stepBack(depth);
}

/** Calls `fn` when Back or Forward changes page (not when they only close something open over it). */
export function onPageChange(fn: () => void): () => void {
  pageListeners.add(fn);
  return () => pageListeners.delete(fn);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    if (ownBacks > 0) {
      ownBacks--;
      runSettled();
      return;
    }
    // Everything open over the step Back landed on closes, newest first (not what's just opened,
    // whose step is still to come).
    const at = layerOf(e.state);
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer.placed || layer.id <= at) continue;
      layers.splice(i, 1);
      layer.done = true;
      layer.close();
    }
    const page = pendingPage;
    pendingPage = null;
    page?.();
    pageListeners.forEach((fn) => fn());
    runSettled();
  });
}

/**
 * Gives something shown while `open` a Back step that calls `close` (which may ask first, returning a
 * promise). If it's still open once that's done (closing refused, or the answer was to stay), its step
 * goes back on.
 */
export function useBackLayer(open: boolean, close: () => unknown) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let release: () => void = () => undefined;
    const arm = () => {
      release = pushLayer(() => {
        void Promise.resolve()
          .then(() => closeRef.current())
          .catch(() => undefined)
          .then(() =>
            // After React has drawn what closing changed, and after any step a question took off.
            setTimeout(() => whenSettled(() => alive && openRef.current && arm()), 0),
          );
      });
    };
    arm();
    return () => {
      alive = false;
      release();
    };
  }, [open]);
}
