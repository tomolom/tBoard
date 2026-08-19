import { contextBridge, ipcRenderer } from 'electron';

import type { CardStatus, CommandPreviewInput, CreateCardInput, EvidenceType, RepoRole, TBoardApi, UpdateCardInput } from '../shared/api';

const api: TBoardApi = {
  settings: {
    getWorkspaceRoot: () => ipcRenderer.invoke('settings:getWorkspaceRoot'),
    setWorkspaceRoot: (workspaceRoot: string) => ipcRenderer.invoke('settings:setWorkspaceRoot', workspaceRoot),
    getDefaultWorkspaceRoot: () => ipcRenderer.invoke('settings:getDefaultWorkspaceRoot'),
  },
  inventory: {
    scanWorkspace: (workspaceRoot?: string) => ipcRenderer.invoke('inventory:scanWorkspace', workspaceRoot),
    listRepoMappings: () => ipcRenderer.invoke('inventory:listRepoMappings'),
    listComponentVariants: () => ipcRenderer.invoke('inventory:listComponentVariants'),
  },
  diff: {
    scanDiffs: () => ipcRenderer.invoke('diff:scanDiffs'),
    listDiffOverviews: () => ipcRenderer.invoke('diff:listDiffOverviews'),
  },
  evidence: {
    importFiles: (componentVariantId: number, type: EvidenceType) => ipcRenderer.invoke('evidence:importFiles', componentVariantId, type),
    listEvidence: () => ipcRenderer.invoke('evidence:listEvidence'),
    listEvidenceForVariant: (componentVariantId: number) => ipcRenderer.invoke('evidence:listEvidenceForVariant', componentVariantId),
  },
  release: {
    previewCopy: (componentVariantId: number) => ipcRenderer.invoke('release:previewCopy', componentVariantId),
    applyCopy: (pendingOperationId: number) => ipcRenderer.invoke('release:applyCopy', pendingOperationId),
  },
  cards: {
    createCard: (input: CreateCardInput) => ipcRenderer.invoke('cards:createCard', input),
    listCards: () => ipcRenderer.invoke('cards:listCards'),
    updateCard: (id: number, input: UpdateCardInput) => ipcRenderer.invoke('cards:updateCard', id, input),
    moveCard: (id: number, status: CardStatus) => ipcRenderer.invoke('cards:moveCard', id, status),
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  },
  commands: {
    gitStatus: (repoMappingId: number, role: RepoRole) => ipcRenderer.invoke('commands:gitStatus', repoMappingId, role),
    preview: (input: CommandPreviewInput) => ipcRenderer.invoke('commands:preview', input),
    apply: (pendingOperationId: number) => ipcRenderer.invoke('commands:apply', pendingOperationId),
    listRuns: (limit?: number | null) => ipcRenderer.invoke('commands:listRuns', limit),
    readRunOutput: (runId: number) => ipcRenderer.invoke('commands:readRunOutput', runId),
    revealRunOutput: (runId: number) => ipcRenderer.invoke('commands:revealRunOutput', runId),
  },
};

contextBridge.exposeInMainWorld('tBoard', api);
