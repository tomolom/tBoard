import { contextBridge, ipcRenderer } from 'electron';

import type { AddBoardInput, CardStatus, CreateCardInput, TBoardApi, UpdateCardInput } from '../shared/api';

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
};

contextBridge.exposeInMainWorld('tBoard', api);
