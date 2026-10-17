// Platform adapter: the Electron preload API when present, browser fallbacks otherwise.
// In a browser tab (Chrome/Edge) there is no file system path access, so readFile always
// misses and saving falls back to the File System Access API or a plain download.
import type { Api } from '../../preload/index'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface OpenedFile {
  name: string
  path: string
  data: Uint8Array
}

export const isElectron = typeof window !== 'undefined' && !!(window as { api?: Api }).api

type PickerType = { description: string; accept: Record<string, string[]> }
interface PickerWindow {
  showOpenFilePicker?: (o: { types?: PickerType[]; multiple?: boolean }) => Promise<{ getFile(): Promise<File> }[]>
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[] }) => Promise<{
    name: string
    createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>
  }>
}

const pickerTypes = (filters: FileFilter[]): PickerType[] =>
  filters.map((f) => ({ description: f.name, accept: { 'application/octet-stream': f.extensions.map((e) => `.${e}`) } }))

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

function inputPick(filters: FileFilter[]): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',')
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

async function browserOpen(filters: FileFilter[]): Promise<OpenedFile | null> {
  const w = window as PickerWindow
  let file: File | null
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: pickerTypes(filters) })
      file = await h.getFile()
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  } else file = await inputPick(filters)
  return file ? { name: file.name, path: '', data: new Uint8Array(await file.arrayBuffer()) } : null
}

async function browserSave(defaultName: string, filters: FileFilter[], data: Uint8Array | string): Promise<string | null> {
  const blob = new Blob([data as BlobPart], { type: typeof data === 'string' ? 'application/json' : 'application/octet-stream' })
  const w = window as PickerWindow
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: defaultName, types: pickerTypes(filters) })
      const out = await h.createWritable()
      await out.write(blob)
      await out.close()
      return h.name
    } catch (e) {
      if (isAbort(e)) return null
      throw e
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = defaultName
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  return defaultName
}

export const platform: Api = isElectron
  ? (window as unknown as { api: Api }).api
  : {
      saveFile: browserSave,
      openFile: browserOpen,
      readFile: async () => null,
      assetsDir: async () => '',
      pathForFile: () => '',
      saveSettings: null,
    }

/** The bundled controller model: an Electron file path, or bytes fetched from the web build. */
export async function loadBundledModel(): Promise<OpenedFile | null> {
  if (isElectron) return platform.readFile(`${await platform.assetsDir()}/models/dualsense.glb`)
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}models/dualsense.glb`)
    if (!res.ok) return null
    return { name: 'dualsense.glb', path: '', data: new Uint8Array(await res.arrayBuffer()) }
  } catch {
    return null
  }
}
