/**
 * Rules shared by everything that shows HTML from a note: the note renderer (markdown.ts) and
 * diagrams (mermaid.ts).
 *
 * - Nothing may sit over the app (a fake lock screen, say): no fixed or sticky positioning, however
 *   it's written (a CSS variable, `position: var(--p)`, isn't "fixed" to a check for "fixed"), and
 *   nothing that reaches the browser's top layer, above everything on the page (popovers, dialogs and
 *   the commands that open them).
 * - Under Settings → Images from other websites: Ask first, nothing loads from another site. Each
 *   address is read the way the browser reads it (`/\host/x.png` is another site), never by pattern.
 */

/** Attributes that open an element in the top layer, over the whole app. */
export const TOP_LAYER_ATTRS = ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor'];

/** Elements that open in the top layer. */
export const TOP_LAYER_TAGS = ['dialog'];

/** False for positioning that escapes the note (fixed, sticky, a variable, anything unknown). */
export function positionStaysInNote(value: string): boolean {
  return /^(?:|static|relative|absolute)$/.test(value.trim().toLowerCase());
}

/** Removes a box's own position if it could pin the box over the app. */
export function keepPositionInNote(el: Element) {
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!style || positionStaysInNote(style.getPropertyValue('position'))) return;
  style.removeProperty('position');
  if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
}

/**
 * Whether a srcset could load from another site. Each candidate as the browser reads it (a run of
 * non-space, less commas at either end), and each comma-separated part of it as well: splitting only
 * ever makes a candidate look more remote, never less.
 */
export function srcsetLoadsRemote(value: string, remote: (url: string) => boolean): boolean {
  for (const token of value.trim().split(/\s+/)) {
    const url = token.replace(/^,+|,+$/g, '');
    if (url && (remote(url) || url.split(',').some((part) => !!part && remote(part)))) return true;
  }
  return false;
}

/** CSS functions that load an address. */
const LOADS = /(?:^|[^\w-])(?:url|src|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade)\(/i;
const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s"']*))\s*\)/gi;
const CSS_STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

/** A CSS string's escapes undone (`\2f` is "/", `\/` is "/"). */
function cssUnescape(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})\s?|([^0-9a-f\n]))/gi, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : (ch ?? ''),
  );
}

/**
 * Whether CSS (a value, or a whole style attribute as written) could load from another site. Escapes
 * are undone first, as the browser undoes them (`u\72 l(` is url(). Any address in it counts: url(),
 * and the strings image-set() takes without url(). A loading function whose address can't be picked
 * out, or a backslash still left, counts as remote: nothing Lumen writes has either.
 */
export function cssLoadsRemote(css: string, remote: (url: string) => boolean): boolean {
  const text = cssUnescape(css);
  if (!LOADS.test(text)) return false;
  if (text.includes('\\')) return true;
  const urls: string[] = [];
  for (const m of text.matchAll(CSS_URL)) urls.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of text.matchAll(CSS_STRING)) urls.push(m[1] ?? m[2] ?? '');
  if (!urls.length) return true;
  return urls.some((u) => remote(u.trim()));
}

/** SVG attributes that take a CSS value, and so a url() (a mask, filter, paint or marker from elsewhere). */
const PRESENTATION = ['fill', 'stroke', 'mask', 'filter', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor'];

/**
 * Takes out everything in an element's inline style and SVG presentation attributes that could load
 * from another site: each declaration the style parser read, and then, if the attribute as written
 * still holds such an address (a declaration this parser couldn't read, which another browser
 * might), the whole attribute.
 */
export function dropRemoteCss(el: Element, remote: (url: string) => boolean) {
  for (const name of PRESENTATION) {
    const value = el.getAttribute(name);
    if (value !== null && cssLoadsRemote(value, remote)) el.removeAttribute(name);
  }
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (style?.length) {
    for (const prop of Array.from({ length: style.length }, (_, i) => style.item(i))) {
      if (cssLoadsRemote(style.getPropertyValue(prop), remote)) style.removeProperty(prop);
    }
  }
  const written = el.getAttribute('style');
  if (written !== null && (!written.trim() || cssLoadsRemote(written, remote))) el.removeAttribute('style');
}
