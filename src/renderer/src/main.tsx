import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

// If the preload failed to load, window.tBoard is undefined and every IPC call
// would throw. Surface that as a clear message rather than a blank screen.
const preloadReady = typeof window !== 'undefined' && Boolean(window.tBoard);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {preloadReady ? (
        <App />
      ) : (
        <div className="fatal">
          <h1>tBoard could not start</h1>
          <p>
            The preload bridge did not load, so the app cannot reach its data layer. This is usually a
            build/configuration problem rather than something you did.
          </p>
          <p>Try rebuilding (<code>npm run build</code>) and relaunching. If it persists, check the main-process log.</p>
        </div>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
