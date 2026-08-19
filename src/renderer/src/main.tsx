import React, { type JSX } from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { WebApp } from './WebApp';
import './styles.css';

// Electron injects window.tBoard via the preload bridge. When it's present we're
// the desktop app. When it's absent we're either (a) served in a browser by the
// web server — the normal web case, handled by WebApp (session check + login +
// HTTP client) — or (b) a genuinely broken Electron preload. We distinguish by
// protocol: file:// with no bridge is a broken preload; http(s):// is web mode.
const hasPreload = typeof window !== 'undefined' && Boolean(window.tBoard);
const isWeb = typeof window !== 'undefined' && window.location.protocol.startsWith('http');

function Root(): JSX.Element {
  if (hasPreload) {
    return <App />;
  }
  if (isWeb) {
    return <WebApp />;
  }
  return (
    <div className="fatal">
      <h1>tBoard could not start</h1>
      <p>
        The preload bridge did not load, so the app cannot reach its data layer. This is usually a
        build/configuration problem rather than something you did.
      </p>
      <p>Try rebuilding (<code>npm run build</code>) and relaunching. If it persists, check the main-process log.</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
