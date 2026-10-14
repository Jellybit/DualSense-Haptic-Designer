// Keep a copy of the last loaded sound so it comes back after a reload. A browser can't
// reopen a file from disk, and a dropped file has no path even in the desktop app, so the
// bytes themselves are stored (IndexedDB handles files of several MB).

const DB = 'dshd'
const STORE = 'files'
const KEY = 'lastSound'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveLastSound(name: string, data: Uint8Array): Promise<void> {
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ name, data: data.slice() }, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // storage unavailable (private window, blocked site data): the sound just won't come back
  }
}

export async function clearLastSound(): Promise<void> {
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    /* nothing stored */
  }
}

export async function loadLastSound(): Promise<{ name: string; data: Uint8Array } | null> {
  try {
    const db = await open()
    const v = await new Promise<{ name: string; data: Uint8Array } | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return v ?? null
  } catch {
    return null
  }
}
