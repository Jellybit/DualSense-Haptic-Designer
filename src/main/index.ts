import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const SONY_VID = 0x054c
const DUALSENSE_PIDS = new Set([0x0ce6, 0x0df2])

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#14151a',
    title: 'DualSense Haptic Designer',
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

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
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
  ipcMain.handle('app:assetsDir', () => (app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets')))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
