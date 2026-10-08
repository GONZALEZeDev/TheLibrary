/**
 * Entry point of the webview — temporary placeholder. It proves the toolchain works end to end;
 * the real composition root (adapters, services, i18n, router) replaces it later in milestone M1.
 *
 * @packageDocumentation
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('index.html must contain <div id="root">');
}

createRoot(rootElement).render(
  <StrictMode>
    <p>TheLibrary — foundation in progress.</p>
  </StrictMode>,
);
