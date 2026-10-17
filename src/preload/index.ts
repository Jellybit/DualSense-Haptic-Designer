import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface OpenedFile {
  name: string
  path: string
  data: Uint8Array
}

// Portable exe: the settings file next to the exe is the source of truth. Load it into
// localStorage before the page's scripts run (some read their settings as they load)
const portableSettings = ipcRenderer.sendSync('settings:load') as Record<string, unknown> | null
if (portableSettings) {
  try {
    localStorage.clear()
    for (const [k, v] of Object.entries(portableSettings)) localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

const api = {
  saveFile: (defaultName: string, filters: FileFilter[], data: Uint8Array | string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', { defaultName, filters, data }),
  openFile: (filters: FileFilter[]): Promise<OpenedFile | null> => ipcRenderer.invoke('file:open', { filters }),
  readFile: (path: string): Promise<OpenedFile | null> => ipcRenderer.invoke('file:read', path),
  assetsDir: (): Promise<string> => ipcRenderer.invoke('app:assetsDir'),
  /** a dropped file's path on disk ('' if it has none) */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /** portable exe only: write the settings file (`sync` while the window is closing) */
  saveSettings: portableSettings
    ? (data: Record<string, unknown>, sync = false): void => {
        if (sync) ipcRenderer.sendSync('settings:saveSync', data)
        else ipcRenderer.send('settings:save', data)
      }
    : null,
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
