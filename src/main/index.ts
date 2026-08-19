import { app, BrowserWindow, Menu } from 'electron';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, getRuntimeDatabasePath, type SqliteDatabase } from './db/connection';
import { runMigrations } from './db/migrations';
import { watchDatabase } from './dbWatcher';
import { registerIpcHandlers } from './ipc';
import { SettingsService } from './services/settingsService';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function attachDiagnostics(win: BrowserWindow): void {
  if (!process.env.TBOARD_RENDERER_DIAG) {
    return;
  }
  win.webContents.on('console-message', (_e, level, message) => console.log(`[renderer:${level}] ${message}`));
  win.webContents.on('render-process-gone', (_e, d) => console.log('[render-process-gone]', JSON.stringify(d)));
  win.webContents.on('did-fail-load', (_e, c, desc) => console.log('[did-fail-load]', c, desc));
}

/**
 * Opens the app window for the current mode:
 *   - LOCAL (default): the Electron preload injects window.tBoard (IPC) and the
 *     built renderer loads from disk.
 *   - REMOTE: the window loads the hosted VPS URL with NO preload, so
 *     window.tBoard is absent and the renderer takes its web path (login + HTTP
 *     client). The local IPC bridge is never exposed to a remote page.
 */
function openWindow(remoteUrl: string | null): BrowserWindow {
  const isRemote = remoteUrl !== null;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    webPreferences: {
      // Remote pages get no preload — they must not reach the local IPC surface.
      preload: isRemote ? undefined : path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  attachDiagnostics(win);
  win.once('ready-to-show', () => win.show());
  // In local mode we deny all new windows; in remote mode the hosted page is
  // trusted (it's the user's own server) but still opens externally, not new BWs.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  if (isRemote) {
    void win.loadURL(remoteUrl);
  } else if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

/** Rebuilds the window for the current persisted mode (local vs remote). */
function reopenForMode(db: SqliteDatabase): void {
  const remoteUrl = new SettingsService(db).getRemoteUrl();
  const old = mainWindow;
  mainWindow = openWindow(remoteUrl);
  if (old && !old.isDestroyed()) {
    old.close();
  }
}

function buildMenu(db: SqliteDatabase): void {
  const settings = new SettingsService(db);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Board',
      submenu: [
        {
          label: 'Use Local Board',
          // Escape hatch out of remote mode (a remote page can't call IPC).
          click: () => {
            settings.setRemoteUrl(null);
            reopenForMode(db);
          },
        },
        { type: 'separator' as const },
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    },
    { role: 'editMenu' as const },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  const dbPath = getRuntimeDatabasePath();
  const db = createDatabase(dbPath);
  runMigrations(db);
  // The local renderer can switch modes via IPC (enter a URL -> connect remote).
  registerIpcHandlers(db, { onRemoteUrlChanged: () => reopenForMode(db) });

  buildMenu(db);
  reopenForMode(db);

  // Live-update local-mode windows when the DB changes underneath them (e.g. an
  // agent via the MCP server). Remote mode uses SSE instead; a send here is a
  // harmless no-op for a preload-less remote window.
  const stopWatching = watchDatabase(dbPath, () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('db:changed');
      }
    }
  });
  app.on('will-quit', stopWatching);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      reopenForMode(db);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
