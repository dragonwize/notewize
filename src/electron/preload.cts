import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { MenuAction, NoteWizeApi, Settings } from '../shared/ipc.js';

const api: NoteWizeApi = {
  getInitialState: () => ipcRenderer.invoke('notewize:get-initial-state'),
  getSettings: () => ipcRenderer.invoke('notewize:get-settings'),
  updateSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('notewize:update-settings', patch),
  saveImage: (dirPath: string, fileName: string, data: ArrayBuffer) =>
    ipcRenderer.invoke('notewize:save-image', dirPath, fileName, data),
  openExternal: (url: string) => ipcRenderer.invoke('notewize:open-external', url),
  openFolderDialog: () => ipcRenderer.invoke('notewize:open-folder-dialog'),
  readFolder: (folderPath: string) => ipcRenderer.invoke('notewize:read-folder', folderPath),
  readFile: (filePath: string) => ipcRenderer.invoke('notewize:read-file', filePath),
  createNote: (folderPath: string, content: string) =>
    ipcRenderer.invoke('notewize:create-note', folderPath, content),
  renameNoteForTitle: (filePath: string, content: string) =>
    ipcRenderer.invoke('notewize:rename-note-for-title', filePath, content),
  deleteFile: (filePath: string) => ipcRenderer.invoke('notewize:delete-file', filePath),
  onMenuAction: (callback: (action: MenuAction) => void) => {
    const listener = (_event: IpcRendererEvent, action: MenuAction) => {
      callback(action);
    };
    ipcRenderer.on('notewize:menu-action', listener);
    return () => {
      ipcRenderer.removeListener('notewize:menu-action', listener);
    };
  }
};

contextBridge.exposeInMainWorld('notewize', api);
