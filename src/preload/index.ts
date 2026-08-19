import { contextBridge, ipcRenderer } from 'electron';

import type { AddBoardInput, CardStatus, CreateCardInput, TBoardApi, UpdateCardInput, UploadFile } from '../shared/api';

const api: TBoardApi = {
  boards: {
    list: () => ipcRenderer.invoke('boards:list'),
    add: (input: AddBoardInput) => ipcRenderer.invoke('boards:add', input),
    remove: (id: number) => ipcRenderer.invoke('boards:remove', id),
    rename: (id: number, name: string) => ipcRenderer.invoke('boards:rename', id, name),
    branches: (boardId: number) => ipcRenderer.invoke('boards:branches', boardId),
    modules: (boardId: number) => ipcRenderer.invoke('boards:modules', boardId),
    pickRepoFolder: () => ipcRenderer.invoke('boards:pickRepoFolder'),
  },
  cards: {
    list: (boardId: number) => ipcRenderer.invoke('cards:list', boardId),
    create: (input: CreateCardInput) => ipcRenderer.invoke('cards:create', input),
    update: (id: number, input: UpdateCardInput) => ipcRenderer.invoke('cards:update', id, input),
    move: (id: number, status: CardStatus, afterCardId?: number | null) =>
      ipcRenderer.invoke('cards:move', id, status, afterCardId ?? null),
    remove: (id: number) => ipcRenderer.invoke('cards:remove', id),
  },
  settings: {
    getLastBoardId: () => ipcRenderer.invoke('settings:getLastBoardId'),
    setLastBoardId: (boardId: number | null) => ipcRenderer.invoke('settings:setLastBoardId', boardId),
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  },
  attachments: {
    list: (cardId: number) => ipcRenderer.invoke('attachments:list', cardId),
    upload: (cardId: number, files: UploadFile[]) => ipcRenderer.invoke('attachments:upload', cardId, files),
    remove: (id: number) => ipcRenderer.invoke('attachments:remove', id),
    open: (id: number) => ipcRenderer.invoke('attachments:open', id),
  },
  connection: {
    getRemoteUrl: () => ipcRenderer.invoke('settings:getRemoteUrl'),
    setRemoteUrl: (url: string | null) => ipcRenderer.invoke('settings:setRemoteUrl', url),
  },
  onDbChanged: (callback: () => void) => {
    // Wrap so the raw IpcRendererEvent is never handed to the renderer, and
    // return an unsubscribe that removes exactly this listener.
    const listener = (): void => callback();
    ipcRenderer.on('db:changed', listener);
    return () => {
      ipcRenderer.removeListener('db:changed', listener);
    };
  },
};

contextBridge.exposeInMainWorld('tBoard', api);
