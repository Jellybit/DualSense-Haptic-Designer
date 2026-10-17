import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const SONY_VID = 0x054c
const DUALSENSE_PIDS = new Set([0x0ce6, 0x0df2])

// Portable exe (electron-builder sets PORTABLE_EXECUTABLE_DIR): the settings live in one file
// next to the exe, and Chromium's own cache in Temp, so nothing is left in AppData
const portableDir = process.env['PORTABLE_EXECUTABLE_DIR']
const settingsFile = portableDir ? join(portableDir, 'DualSense Haptic Designer.settings.json') : null
if (portableDir) app.setPath('userData', join(app.getPath('temp'), 'DualSense Haptic Designer'))

/** The portable settings (key -> value): {} when the file is missing or unreadable; null when not portable. */
ipcMain.on('settings:load', (e) => {
  if (!settingsFile) {
    e.returnValue = null
    return
  }
  try {
    const o = JSON.parse(readFileSync(settingsFile, 'utf8'))
    e.returnValue = o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    e.returnValue = {}
  }
})
const writeSettings = (data: unknown) => {
  if (!settingsFile) return
  try {
    writeFileSync(settingsFile, JSON.stringify(data, null, 2))
  } catch {
    // read-only folder: the settings just aren't kept
  }
}
ipcMain.on('settings:save', (_e, data: unknown) => writeSettings(data))
// when the window closes: write before it goes
ipcMain.on('settings:saveSync', (e, data: unknown) => {
  writeSettings(data)
  e.returnValue = true
})

const assetsDir = () => (app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets'))

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#14151a',
    title: 'DualSense Haptic Designer',
    // the title bar and taskbar icon (the exe's own icon comes from the build). The .ico holds
    // every size, so Windows doesn't have to shrink a big image down to 16 px itself
    icon: join(assetsDir(), 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  })

  // --- WebHID: auto-pick the DualSense in the device chooser ---------------------
  win.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault()
    const ds = details.deviceList.find((d) => d.vendorId === SONY_VID && DUALSENSE_PIDS.has(d.productId))
    callback(ds?.deviceId ?? '')
  })

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })

  // DSHD_START=calibrate opens straight into the trigger calibration (see the .bat files)
  const hash = process.env['DSHD_START'] ?? ''
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? '#' + hash : ''))
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

app.whenReady().then(() => {
  const ses = session.defaultSession
  // HID + media (audio-output device labels / setSinkId) permissions
  ses.setPermissionCheckHandler((_wc, permission) => ['hid', 'media', 'speaker-selection', 'audioCapture'].includes(permission))
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['hid', 'media', 'speaker-selection', 'audioCapture'].includes(permission)))
  ses.setDevicePermissionHandler((details) => details.deviceType === 'hid' && (details.device as { vendorId?: number }).vendorId === SONY_VID)

  // --- File IPC -------------------------------------------------------------------
  ipcMain.handle('file:save', async (_e, opts: { defaultName: string; filters: Electron.FileFilter[]; data: Uint8Array | string }) => {
    const res = await dialog.showSaveDialog({ defaultPath: opts.defaultName, filters: opts.filters })
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data))
    return res.filePath
  })
  ipcMain.handle('file:open', async (_e, opts: { filters: Electron.FileFilter[] }) => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: opts.filters })
    if (res.canceled || res.filePaths.length === 0) return null
    const p = res.filePaths[0]
    const data = await readFile(p)
    return { name: basename(p), path: p, data: new Uint8Array(data) }
  })
  ipcMain.handle('file:read', async (_e, path: string) => {
    try {
      const data = await readFile(path)
      return { name: basename(path), path, data: new Uint8Array(data) }
    } catch {
      return null
    }
  })
  ipcMain.handle('app:assetsDir', () => assetsDir())

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
