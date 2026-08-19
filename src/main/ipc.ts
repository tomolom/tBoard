import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';

import type {
  AddBoardInput,
  CardStatus,
  ClipboardWriteResult,
  CreateCardInput,
  UpdateCardInput,
  UploadFile,
} from '../shared/api';
import type { SqliteDatabase } from './db/connection';
import { resolveAttachmentsDir } from '../shared/appPaths';
import { AttachmentService } from './services/attachmentService';
import { BoardService } from './services/boardService';
import { CardService } from './services/cardService';
import { listBranches } from './services/gitBranches';
import { listModules } from './services/repoModules';
import { SettingsService } from './services/settingsService';

export type IpcOptions = {
  /** Called after the renderer sets a remote URL, so main can reload the window. */
  onRemoteUrlChanged?: () => void;
};

export function registerIpcHandlers(db: SqliteDatabase, options: IpcOptions = {}): void {
  const settings = new SettingsService(db);
  const boards = new BoardService(db);
  const cards = new CardService(db);
  const attachments = new AttachmentService(db, resolveAttachmentsDir());
  void attachments.cleanupTempFiles();

  ipcMain.handle('boards:list', () => boards.listBoards());
  ipcMain.handle('boards:add', (_event, input: AddBoardInput) => boards.addBoard(input));
  ipcMain.handle('boards:remove', (_event, id: number) => boards.removeBoard(id));
  ipcMain.handle('boards:rename', (_event, id: number, name: string) => boards.renameBoard(id, name));
  ipcMain.handle('boards:branches', (_event, boardId: number) => {
    const board = boards.getBoard(boardId);
    if (!board) {
      return { branches: [], current: null, error: `Board ${boardId} was not found.` };
    }
    return listBranches(board.repoPath);
  });
  ipcMain.handle('boards:modules', (_event, boardId: number) => {
    const board = boards.getBoard(boardId);
    if (!board) {
      return [];
    }
    return listModules(board.repoPath);
  });

  // Opens a native folder picker and returns the chosen path (or null).
  ipcMain.handle('boards:pickRepoFolder', async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory'] as Array<'openDirectory'> };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('cards:list', (_event, boardId: number) => cards.listCards(boardId));
  ipcMain.handle('cards:create', (_event, input: CreateCardInput) => cards.createCard(input));
  ipcMain.handle('cards:update', (_event, id: number, input: UpdateCardInput) => cards.updateCard(id, input));
  ipcMain.handle('cards:move', (_event, id: number, status: CardStatus, afterCardId?: number | null) =>
    cards.moveCard(id, status, afterCardId ?? null),
  );
  ipcMain.handle('cards:remove', (_event, id: number) => cards.removeCard(id));

  ipcMain.handle('settings:getLastBoardId', () => settings.getLastBoardId());
  ipcMain.handle('settings:setLastBoardId', (_event, boardId: number | null) => settings.setLastBoardId(boardId));

  ipcMain.handle('settings:getRemoteUrl', () => settings.getRemoteUrl());
  ipcMain.handle('settings:setRemoteUrl', (_event, url: unknown): { ok: boolean; error: string | null } => {
    try {
      settings.setRemoteUrl(typeof url === 'string' || url === null ? url : null);
      options.onRemoteUrlChanged?.();
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('attachments:list', (_event, cardId: number) => attachments.list(cardId));
  ipcMain.handle('attachments:upload', async (_event, cardId: number, files: UploadFile[]) => {
    const created = [];
    for (const file of files) {
      created.push(await attachments.createFromBuffer(cardId, file.name, file.type, Buffer.from(file.data), 'user'));
    }
    return created;
  });
  ipcMain.handle('attachments:remove', (_event, id: number) => attachments.remove(id));
  ipcMain.handle('attachments:open', async (_event, id: number) => {
    const row = attachments.getRow(id);
    if (!row) {
      return;
    }
    // Open only the containment-checked stored path; the original name never
    // influences the filesystem path.
    await shell.openPath(attachments.resolveFilePath(row.stored_name));
  });

  ipcMain.handle('clipboard:writeText', (_event, text: unknown): ClipboardWriteResult => {
    if (typeof text !== 'string') {
      return { copied: false, error: 'Clipboard text must be a string.' };
    }
    try {
      clipboard.writeText(text);
      return { copied: true, error: null };
    } catch (error) {
      return { copied: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
