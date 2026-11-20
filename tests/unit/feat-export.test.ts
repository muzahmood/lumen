// @vitest-environment jsdom
/**
 * Export (src/lib/exportNote.ts): a note as Markdown (a .md, or a .zip with its images, files and
 * drawings so links work outside Lumen) and as a print layout for Save as PDF. Fetching, rendering and
 * the store are stubbed; the zip is read back with fflate.
 */
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  assetBytes: vi.fn(async (url: string): Promise<Uint8Array> => new TextEncoder().encode(`bytes of ${url}`)),
  renderMarkdown: vi.fn((_md: string, _env: { resolveTitle: (t: string) => string | null }, _opts: unknown) => ''),
  hydrateAssetsNow: vi.fn(async () => undefined),
  hydrateMermaid: vi.fn(async () => undefined),
  notes: {} as Record<string, { id: string; title: string; deleted_at: number | null }>,
}));

vi.mock('../../src/lib/api', () => ({ api: { assetBytes: h.assetBytes } }));
vi.mock('../../src/lib/assets', () => ({ decryptingAssets: () => false, hydrateAssetsNow: h.hydrateAssetsNow }));
vi.mock('../../src/lib/backup', () => ({ frontMatter: (n: { title: string }) => `---\ntitle: ${JSON.stringify(n.title)}\n---\n` }));
vi.mock('../../src/lib/markdown', () => ({ renderMarkdown: h.renderMarkdown }));
vi.mock('../../src/lib/mermaid', () => ({ hydrateMermaid: h.hydrateMermaid }));
vi.mock('../../src/lib/store', () => ({ useApp: { getState: () => ({ notes: h.notes, drawingRevs: {} }) } }));

const { defaultPaper, exportMarkdown, noteAttachments, printNote } = await import('../../src/lib/exportNote');

const note = (title: string, content: string, tags: string[] = []) => ({ id: 'n1', title, content, tags, created_at: 0, updated_at: Date.UTC(2026, 10, 17, 9) });
const opts = { attachments: true, frontMatter: false };

async function unzip(blob: Blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.notes = {};
  h.assetBytes.mockImplementation(async (url: string) => new TextEncoder().encode(`bytes of ${url}`));
});

describe('what a note links to', () => {
  it('lists each image, file and drawing once, however often it’s linked', () => {
    const md = '![a](/api/files/abc123/photo%20one.png) ![a again](/api/files/abc123/photo%20one.png) [📎 r.pdf](/api/files/def456/r.pdf)\n![d](/api/drawings/dr0001.svg?v=3) ![d](/api/drawings/dr0001.svg)';
    expect(noteAttachments(md)).toEqual([
      { kind: 'file', id: 'abc123', path: 'attachments/abc123-photo-one.png', fetch: '/api/files/abc123' },
      { kind: 'file', id: 'def456', path: 'attachments/def456-r.pdf', fetch: '/api/files/def456' },
      { kind: 'drawing', id: 'dr0001', path: 'drawings/dr0001.svg', fetch: '/api/drawings/dr0001.svg', scene: { path: 'drawings/dr0001.excalidraw', fetch: '/api/drawings/dr0001/scene' } },
    ]);
  });

  it('names a file safely even when its name is badly encoded or missing', () => {
    expect(noteAttachments('![x](/api/files/abc123/%E0%A4%A.png) ![y](/api/files/zzz999)').map((a) => a.path)).toEqual(['attachments/abc123-file', 'attachments/zzz999-file']);
  });

  it('ignores ids too short to be Lumen’s', () => {
    expect(noteAttachments('![x](/api/files/abc/x.png) ![d](/api/drawings/ab.svg)')).toEqual([]);
  });
});

describe('exporting as Markdown', () => {
  it('writes a .md with the title as a heading and links back to this Lumen', async () => {
    const out = await exportMarkdown(note('Plan: Q1/Q2', 'See [other](/note/abc123def) and ![p](/api/files/abc123/p.png)'), { attachments: false, frontMatter: false });
    expect(out.filename).toBe('Plan Q1 Q2.md');
    expect(out.missing).toBe(0);
    expect(await out.blob.text()).toBe(`# Plan: Q1/Q2\n\nSee [other](${location.origin}/note/abc123def) and ![p](${location.origin}/api/files/abc123/p.png)`);
  });

  it('doesn’t add a heading when the note starts with one, or has no title', async () => {
    expect(await (await exportMarkdown(note('T', '\n# Already\nx'), { attachments: false, frontMatter: false })).blob.text()).toBe('\n# Already\nx');
    const untitled = await exportMarkdown(note('  ', 'body'), { attachments: false, frontMatter: false });
    expect([untitled.filename, await untitled.blob.text()]).toEqual(['Untitled.md', 'body']);
  });

  it('puts the front matter first when asked', async () => {
    expect(await (await exportMarkdown(note('T', 'x'), { attachments: false, frontMatter: true })).blob.text()).toBe('---\ntitle: "T"\n---\n# T\n\nx');
  });

  it('zips the note with its files and drawings, pointing its links at the copies', async () => {
    const md = '![p](/api/files/abc123/my%20photo.png)\n![p](/api/files/abc123/my%20photo.png)\n![d](/api/drawings/dr0001.svg?v=2)\n[n](/note/abc123def)';
    const out = await exportMarkdown(note('Trip', md), opts);
    expect(out.filename).toBe('Trip.zip');
    const files = await unzip(out.blob);
    expect(Object.keys(files).sort()).toEqual(['Trip.md', 'attachments/abc123-my-photo.png', 'drawings/dr0001.excalidraw', 'drawings/dr0001.svg']);
    expect(files['Trip.md']).toBe(
      `# Trip\n\n![p](attachments/abc123-my-photo.png)\n![p](attachments/abc123-my-photo.png)\n![d](drawings/dr0001.svg)\n[n](${location.origin}/note/abc123def)`,
    );
    expect(files['attachments/abc123-my-photo.png']).toBe('bytes of /api/files/abc123');
  });

  it('keeps links to files it couldn’t fetch pointing at Lumen, and counts them', async () => {
    h.assetBytes.mockImplementation(async (url: string) => {
      if (url.includes('gone00')) throw new Error('404');
      if (url.endsWith('/scene')) throw new Error('no scene');
      return new Uint8Array([1]);
    });
    const out = await exportMarkdown(note('T', '![a](/api/files/gone00/a.png) ![d](/api/drawings/dr0001.svg)'), opts);
    expect(out.missing).toBe(1);
    const files = await unzip(out.blob);
    expect(Object.keys(files).sort()).toEqual(['T.md', 'drawings/dr0001.svg']);
    expect(files['T.md']).toBe(`# T\n\n![a](${location.origin}/api/files/gone00/a.png) ![d](drawings/dr0001.svg)`);
  });
});

describe('the paper size offered', () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
    vi.restoreAllMocks();
  });

  const cases: Array<[string, string, string]> = [
    ['America/New_York', 'en-US', 'letter'],
    ['America/Toronto', 'fr-CA', 'letter'],
    ['America/Mexico_City', 'es-MX', 'letter'],
    ['America/Argentina/Buenos_Aires', 'es-AR', 'a4'],
    ['America/Sao_Paulo', 'pt-BR', 'a4'],
    ['America/Chicago', 'en', 'letter'],
    ['Europe/London', 'en-US', 'a4'],
    ['Asia/Karachi', 'en-US', 'a4'],
  ];
  for (const [zone, language, paper] of cases) {
    it(`is ${paper} in ${zone} with ${language}`, () => {
      process.env.TZ = zone;
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
      expect(defaultPaper()).toBe(paper);
    });
  }
});

describe('the print layout', () => {
  const pdf = { paper: 'letter' as const, title: true, details: true, breaks: false, accent: '#1e4e80' };

  beforeEach(() => {
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
    document.title = 'Lumen';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.export-print, style[data-export-page]').forEach((el) => el.remove());
    document.body.className = '';
  });

  it('lays the note out with its title and details, escaped, and opens the print window', async () => {
    h.renderMarkdown.mockReturnValue('<p>Body</p>');
    const before = vi.fn();
    await printNote(note('<b>Plan</b> & co', 'Body', ['work', '<x>']), pdf, before);
    const root = document.querySelector('.export-print')!;
    expect(root.querySelector('h1.export-title')!.textContent).toBe('<b>Plan</b> & co');
    expect(root.querySelector('h1 b')).toBeNull();
    expect(root.querySelector('.export-details')!.textContent).toMatch(/^Last edited .+ · #work #<x>$/);
    expect(document.head.querySelector('style[data-export-page]')!.textContent).toContain('size: letter');
    expect(document.title).toBe('b Plan b & co');
    expect(document.body.classList.contains('is-exporting')).toBe(true);
    expect(before).toHaveBeenCalledBefore(window.print as never);
    expect(window.print).toHaveBeenCalledTimes(1);
  });

  it('makes paper-friendly links, drops editing buttons and opens folded sections', async () => {
    h.renderMarkdown.mockReturnValue(
      '<p><a href="/note/abc123def">Other</a> <a class="kb-wikilink is-missing" href="#">Not yet</a> <a href="https://x.test/">Web</a></p>' +
        '<details><summary>More</summary>Hidden</details><button>Copy</button><div class="kb-block-edit">Edit</div>',
    );
    await printNote(note('T', 'x'), { ...pdf, title: false, details: false, paper: 'a4' });
    const root = document.querySelector('.export-print')!;
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([`${location.origin}/note/abc123def`, 'https://x.test/']);
    expect(root.textContent).toContain('Not yet');
    expect(root.querySelector('button, .kb-block-edit, h1, .export-details')).toBeNull();
    expect((root.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(document.head.querySelector('style[data-export-page]')!.textContent).toContain('size: A4');
  });

  it('links [[titles]] to notes in any case, skipping notes in the trash', async () => {
    h.notes = {
      a: { id: 'a', title: ' Roadmap ', deleted_at: null },
      b: { id: 'b', title: 'roadmap', deleted_at: null },
      c: { id: 'c', title: 'Old', deleted_at: 5 },
    };
    await printNote(note('T', 'x'), pdf);
    const { resolveTitle } = h.renderMarkdown.mock.calls[0][1];
    expect([resolveTitle('ROADMAP'), resolveTitle('old'), resolveTitle('nothing')]).toEqual(['a', null, null]);
  });

  it('holds back images from other websites when Settings say ask first, as reading view does', async () => {
    const { useSettings } = await import('../../src/lib/settings');
    try {
      useSettings.setState({ remoteImages: 'ask' });
      await printNote(note('T', 'x'), pdf);
      expect(h.renderMarkdown.mock.calls[0][2]).toMatchObject({ remoteImages: 'ask' });
      useSettings.setState({ remoteImages: 'load' });
      await printNote(note('T', 'x'), pdf);
      expect(h.renderMarkdown.mock.calls[1][2]).toMatchObject({ remoteImages: 'load' });
    } finally {
      useSettings.setState({ remoteImages: 'load' });
    }
  });

  it('puts the page back as it was once printing is over, and clears a copy an earlier export left', async () => {
    const stale = document.createElement('div');
    stale.className = 'export-print';
    document.body.appendChild(stale);
    await printNote(note('Report', 'x'), pdf);
    expect(document.querySelectorAll('.export-print')).toHaveLength(1);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('.export-print')).toBeNull();
    expect(document.head.querySelector('style[data-export-page]')).toBeNull();
    expect(document.body.classList.contains('is-exporting')).toBe(false);
    expect(document.title).toBe('Lumen');
  });
});
