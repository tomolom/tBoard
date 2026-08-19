import { app, BrowserWindow } from 'electron';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase, getRuntimeDatabasePath } from './db/connection';
import { runMigrations } from './db/migrations';
import { registerIpcHandlers } from './ipc';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  const db = createDatabase(getRuntimeDatabasePath());
  runMigrations(db);
  registerIpcHandlers(db);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
