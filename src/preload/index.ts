import { contextBridge, ipcRenderer } from 'electron'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface OpenedFile {
  name: string
  path: string
  data: Uint8Array
}

const api = {
  saveFile: (defaultName: string, filters: FileFilter[], data: Uint8Array | string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', { defaultName, filters, data }),
  openFile: (filters: FileFilter[]): Promise<OpenedFile | null> => ipcRenderer.invoke('file:open', { filters }),
  readFile: (path: string): Promise<OpenedFile | null> => ipcRenderer.invoke('file:read', path),
  assetsDir: (): Promise<string> => ipcRenderer.invoke('app:assetsDir'),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
