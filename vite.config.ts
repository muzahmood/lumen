import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * @vscode/markdown-it-katex requires KaTeX as it loads, though Lumen always passes it its own, which
 * loads on demand (src/lib/renderExtras.ts). Answered here with an empty module, so the code every
 * note needs doesn't carry KaTeX (about 270 kB) for the few notes with maths, nor a second copy of it
 * beside the one Mermaid loads.
 */
function katexPluginStub(): Plugin {
  const stub = '\0lumen-katex-unused';
  return {
    name: 'lumen-katex-plugin-stub',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'katex' && importer && /[\\/]@vscode[\\/]markdown-it-katex[\\/]/.test(importer)) return stub;
      return null;
    },
    load(id) {
      return id === stub ? 'export default {};' : null;
    },
  };
}

/**
 * Serves Excalidraw's fonts from this app instead of a public CDN, so drawings make
 * no third-party requests, work offline, and fit the strict Content Security Policy.
 * The app points Excalidraw at /excalidraw-assets/ (see src/main.tsx).
 */
function excalidrawFonts(): Plugin {
  const source = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url));
  const prefix = '/excalidraw-assets/fonts/';
  return {
    name: 'lumen-excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith(prefix)) return next();
        const file = normalize(join(source, decodeURIComponent(url.slice(prefix.length))));
        if (!file.startsWith(source + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    // Excalidraw always lists a public CDN (esm.sh) as a second source for every font. Point that
    // fallback at this app too, so the build contains no third-party font URLs at all.
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/prod/') || !code.includes('ASSETS_FALLBACK_URL')) return null;
      const patched = code.replace(
        /"ASSETS_FALLBACK_URL",`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`\)/,
        '"ASSETS_FALLBACK_URL",(typeof window<"u"?window.location.origin:"http://localhost")+"/excalidraw-assets/")',
      );
      if (patched === code) this.warn('Excalidraw font fallback not found; drawings may try to load fonts from esm.sh.');
      return { code: patched, map: null };
    },
    writeBundle(options) {
      cpSync(source, join(options.dir ?? 'dist', 'excalidraw-assets', 'fonts'), { recursive: true });
    },
  };
}

/**
 * Writes this build's list of hashed files into the service worker (public/sw.js), so that when a
 * new version activates it can delete the previous versions' files from the device's cache: the
 * bundle's /assets/, and the Excalidraw fonts copied to /excalidraw-assets/ (most named by a hash of
 * their contents, so each Excalidraw upgrade brings new names).
 */
function swAssetList(): Plugin {
  const placeholder = 'const BUILD_ASSETS = null;';
  let outDir = 'dist';
  let assets: string[] = [];
  return {
    name: 'lumen-sw-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      assets = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/'))
        .map((f) => `/${f}`)
        .sort();
    },
    // After everything (including the copy of public/ and of Excalidraw's fonts) has been written.
    closeBundle() {
      const fonts = join(outDir, 'excalidraw-assets');
      if (existsSync(fonts)) {
        const files = readdirSync(fonts, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
        assets = [...assets, ...files.map((d) => `/${relative(outDir, join(d.parentPath, d.name)).split(sep).join('/')}`)].sort();
      }
      const file = join(outDir, 'sw.js');
      // No list (a failed build, which never deploys): leave sw.js pruning nothing rather than everything.
      if (!assets.length || !existsSync(file)) return;
      const code = readFileSync(file, 'utf8');
      if (!code.includes(placeholder)) {
        console.warn('lumen-sw-assets: BUILD_ASSETS placeholder not found in sw.js; old cached files won’t be pruned.');
        return;
      }
      const list = `const BUILD_ASSETS = ${JSON.stringify(assets)};`;
      writeFileSync(file, code.replace(placeholder, () => list));
    },
  };
}

/**
 * The files Excalidraw's font-subsetting worker imports (followed transitively from its worker entry),
 * mapped to the chunk each goes in. They're kept out of the drawing editor's chunks so the worker never
 * loads the editor (React, the DOM), which would crash it and push subsetting onto the main thread,
 * where the CSP forbids eval. They go in two chunks: the font WASM (about 1.8 MB, only needed when
 * fonts are subset, as on export) on its own, and the few small helpers the editor also imports in
 * another. In one chunk, opening the editor would download the WASM with them.
 */
function excalidrawWorkerFiles(): Map<string, string> {
  const dir = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/dist/prod/', import.meta.url));
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(join(dir, file))) return;
    seen.add(file);
    const code = readFileSync(join(dir, file), 'utf8');
    for (const m of code.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) visit(m[1]);
  };
  visit('subset-worker.chunk.js');
  seen.delete('subset-worker.chunk.js');
  const chunks = new Map([...seen].map((file) => [file, statSync(join(dir, file)).size > 100_000 ? 'excalidraw-fonts' : 'excalidraw-fonts-shared']));
  // The editor loads subsetting with import(). Left to itself the bundler folds these two small entry
  // files into the editor's chunk, and their static import of the WASM along with them.
  for (const entry of ['subset-shared.chunk.js', 'subset-worker.chunk.js']) {
    if (existsSync(join(dir, entry))) chunks.set(entry, 'excalidraw-fonts');
  }
  return chunks;
}

const workerFiles = excalidrawWorkerFiles();
const inWorkerChunk = (chunk: string) => (id: string) =>
  /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]/.test(id) && workerFiles.get(basename(id)) === chunk;

export default defineConfig({
  plugins: [react(), katexPluginStub(), excalidrawFonts(), swAssetList()],
  define: {
    // Excalidraw reads this at runtime.
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // The helpers' group goes first (higher priority): otherwise the WASM group, which takes its
          // modules' dependencies along, would capture them too.
          groups: [
            { name: 'excalidraw-fonts-shared', test: inWorkerChunk('excalidraw-fonts-shared'), priority: 2 },
            { name: 'excalidraw-fonts', test: inWorkerChunk('excalidraw-fonts'), priority: 1 },
          ],
        },
      },
    },
  },
});
