import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist/wght-italic.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/literata/opsz.css';
import '@fontsource-variable/literata/opsz-italic.css';
import './styles/app.css';
import './styles/prose.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { announceUpdate, diagnoseLoadFailure } from './lib/recovery';
import { clearCacheLeftBySignOut } from './lib/signout';
import { keepStorage } from './lib/utils';

// Excalidraw loads its fonts from this app (copied in at build time), not from a public CDN.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';

// iOS Safari zooms into any field with text under 16px when it gets focus, and stays zoomed.
// Capping the scale stops that; iOS still lets people pinch-zoom whatever this says.
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS) {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && !/maximum-scale/.test(viewport.getAttribute('content') ?? '')) {
    viewport.setAttribute('content', `${viewport.getAttribute('content')}, maximum-scale=1`);
  }
}

// A part of the app loaded on demand failed to download. This also covers libraries' own chunks
// (Excalidraw's font and image helpers, Mermaid), which handle the failure themselves, so never
// reload from here: a drawing or diagram could be mid-edit. If the cause is a new deploy, say so and
// let the person reload; the error still reaches its caller, and ErrorBoundary handles screens.
window.addEventListener('vite:preloadError', () => {
  void diagnoseLoadFailure().then((cause) => {
    if (cause === 'updated') announceUpdate();
  });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Signing out here last time couldn't empty the browser's cache of opened files (it was offline): now.
clearCacheLeftBySignOut();

// Installed as an app: what it keeps on the device (unsent edits, offline copies) is kept for good.
if (window.matchMedia?.('(display-mode: standalone)').matches) keepStorage();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}
