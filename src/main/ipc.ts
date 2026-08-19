import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';

import type { CardStatus, ClipboardWriteResult, CommandPreviewInput, CreateCardInput, EvidenceType, RepoRole, RevealResult, UpdateCardInput } from '../shared/api';
import { getRuntimeCommandOutputRoot, getRuntimeDefaultWorkspaceRoot, type SqliteDatabase } from './db/connection';
import { CardService } from './services/cardService';
import { CommandService } from './services/commandService';
import { DiffService } from './services/diffService';
import { EvidenceService } from './services/evidenceService';
import { InventoryService } from './services/inventoryService';
import { ReleaseCopyService } from './services/releaseCopyService';
import { SettingsService } from './services/settingsService';

export function registerIpcHandlers(db: SqliteDatabase, evidenceRoot: string): void {
  const settings = new SettingsService(db);
  const inventory = new InventoryService(db);
  const diff = new DiffService(db);
  const evidence = new EvidenceService(db, evidenceRoot);
  const releaseCopy = new ReleaseCopyService(db);
  const cards = new CardService(db);
  const commands = new CommandService(db, getRuntimeCommandOutputRoot());

  ipcMain.handle('settings:getWorkspaceRoot', () => settings.getWorkspaceRoot());
  ipcMain.handle('settings:setWorkspaceRoot', (_event, workspaceRoot: string) => settings.setWorkspaceRoot(workspaceRoot));
  ipcMain.handle('settings:getDefaultWorkspaceRoot', () => getRuntimeDefaultWorkspaceRoot());

  ipcMain.handle('inventory:scanWorkspace', (_event, workspaceRoot?: string) => inventory.scanWorkspace(workspaceRoot));
  ipcMain.handle('inventory:listRepoMappings', () => inventory.listRepoMappings());
  ipcMain.handle('inventory:listComponentVariants', () => inventory.listComponentVariants());

  ipcMain.handle('diff:scanDiffs', () => diff.scanDiffs());
  ipcMain.handle('diff:listDiffOverviews', () => diff.listDiffOverviews());

  ipcMain.handle('evidence:importFiles', async (event, componentVariantId: number, type: EvidenceType) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      return { imported: [], warnings: [] };
    }

    return evidence.importFiles(componentVariantId, type, result.filePaths);
  });
  ipcMain.handle('evidence:listEvidence', () => evidence.listEvidence());
  ipcMain.handle('evidence:listEvidenceForVariant', (_event, componentVariantId: number) => evidence.listEvidenceForVariant(componentVariantId));

  ipcMain.handle('release:previewCopy', (_event, componentVariantId: number) => releaseCopy.previewCopy(componentVariantId));
  ipcMain.handle('release:applyCopy', (_event, pendingOperationId: number) => releaseCopy.applyCopy(pendingOperationId));

  ipcMain.handle('cards:createCard', (_event, input: CreateCardInput) => cards.createCard(input));
  ipcMain.handle('cards:listCards', () => cards.listCards());
  ipcMain.handle('cards:updateCard', (_event, id: number, input: UpdateCardInput) => cards.updateCard(id, input));
  ipcMain.handle('cards:moveCard', (_event, id: number, status: CardStatus) => cards.moveCard(id, status));

  ipcMain.handle('commands:gitStatus', (_event, repoMappingId: number, role: RepoRole) => commands.gitStatus(repoMappingId, role));
  ipcMain.handle('commands:preview', (_event, input: CommandPreviewInput) => commands.preview(input));
  ipcMain.handle('commands:apply', (_event, pendingOperationId: number) => commands.apply(pendingOperationId));
  ipcMain.handle('commands:listRuns', (_event, limit?: number | null) => commands.listRuns(limit));
  ipcMain.handle('commands:readRunOutput', (_event, runId: number) => commands.readRunOutput(runId));
  ipcMain.handle('commands:revealRunOutput', async (_event, runId: number): Promise<RevealResult> => {
    const dir = commands.resolveRunOutputDir(runId);
    if (!dir) {
      return { revealed: false, path: null, error: `No output directory found for run ${runId}.` };
    }
    const errorMessage = await shell.openPath(dir);
    if (errorMessage) {
      return { revealed: false, path: dir, error: errorMessage };
    }
    return { revealed: true, path: dir, error: null };
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
