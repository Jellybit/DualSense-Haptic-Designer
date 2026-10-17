import { useCallback, useEffect, useState } from 'react'
import { dualSense } from './device/hid'
import { hapticEngine, HapticEngine, type OutputDevice } from './haptics/engine'
import { btHaptics } from './haptics/btHaptics'
import { lightbar, loadLocal, recenter, saveLocal, useConnection, useTicker } from './store'
import { ButtonHint } from './ui/ButtonHint'
import { ControllerView, loadModelFromBytes, placeholderModel, type LoadedModel } from './viewer/ControllerView'
import { autoMap, defaultRig, knownRigFor, migrateRig, rigFitsModel, type RigMap } from './viewer/rig'
import { ControllerPanel } from './designer/ControllerPanel'
import { ClipsPanel } from './designer/clips/ClipsPanel'
import { ScenePanel } from './designer/scenes/ScenePanel'
import { WorkbenchPanel } from './designer/workbench/WorkbenchPanel'
import { MiniGraphs } from './designer/workbench/MiniGraphs'
import { Meter } from './ui/controls'
import { loadBundledModel, platform } from './platform'
import { confirmReset, resetAll } from './resets'

type Tab = 'workbench' | 'controller' | 'experiments'
type Experiment = 'scenes' | 'clips'

const TABS: { id: Tab; label: string }[] = [
  { id: 'workbench', label: 'Haptics & Triggers' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'controller', label: 'Controller & Model' },
]

const MODEL_PATH_KEY = 'dshd.modelPath'
const RIG_KEY = 'dshd.rig'

export function App() {
  const [tab, setTab] = useState<Tab>(() => {
    if (location.hash === '#calibrate') return 'workbench'
    const t = loadLocal<string>('dshd.tab', 'workbench')
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'workbench'
  })
  const [experiment, setExperiment] = useState<Experiment>(() => loadLocal('dshd.experiment', 'scenes'))
  // width of the 3D view panel, set by dragging its left edge
  const [sideW, setSideW] = useState(() => loadLocal(SIDE_W_KEY, SIDE_W_DEFAULT))
  const dragSide = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setSideW(clampSide(window.innerWidth - ev.clientX))
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      saveLocal(SIDE_W_KEY, clampSide(window.innerWidth - ev.clientX))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const info = useConnection()
  const [model, setModel] = useState<LoadedModel>(() => placeholderModel())
  const [rig, setRigState] = useState<RigMap>(() => autoMap(migrateRig(loadLocal(RIG_KEY, defaultRig())), placeholderModel().nodeNames))
  const [modelError, setModelError] = useState<string | null>(null)
  const [connError, setConnError] = useState<string | null>(null)

  const setRig = useCallback((r: RigMap) => {
    setRigState(r)
    saveLocal(RIG_KEY, r)
  }, [])

  useEffect(() => saveLocal('dshd.tab', tab), [tab])
  useEffect(() => saveLocal('dshd.experiment', experiment), [experiment])

  // Auto-reconnect to a previously permitted controller; load the last model or assets/models/dualsense.glb
  useEffect(() => {
    void dualSense.autoConnect().catch(() => {})
    void (async () => {
      const last = loadLocal<string | null>(MODEL_PATH_KEY, null)
      const f = (last ? await platform.readFile(last) : null) ?? (await loadBundledModel())
      if (f) await applyModel(f.name, f.data, f.path || undefined)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyModel = async (name: string, data: Uint8Array, path?: string) => {
    try {
      const m = await loadModelFromBytes(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      setModel(m)
      // keep the saved rig if it belongs to this model; else use a ready-made rig for
      // known models; else auto-map by node names
      const saved = migrateRig(loadLocal(RIG_KEY, defaultRig()))
      const known = knownRigFor(m.nodeNames)
      if (rigFitsModel(saved, m.nodeNames)) setRig(saved)
      else if (known) setRig(known.rig(m.root))
      else setRig(autoMap(saved, m.nodeNames))
      setModelError(null)
      if (path) saveLocal(MODEL_PATH_KEY, path)
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadModel = async () => {
    const f = await platform.openFile([{ name: '3D model', extensions: ['glb', 'gltf', 'dae'] }])
    if (f) await applyModel(f.name, f.data, f.path)
  }

  const usePlaceholder = () => {
    const m = placeholderModel()
    setModel(m)
    setRig(autoMap(defaultRig(), m.nodeNames))
    saveLocal(MODEL_PATH_KEY, null)
  }

  const connect = async () => {
    setConnError(null)
    try {
      await dualSense.requestAndConnect()
    } catch (e) {
      setConnError(e instanceof Error ? e.message : String(e))
    }
  }

  // Bluetooth haptics streaming follows the connection type
  useEffect(() => {
    if (info?.transport !== 'bt') btHaptics.stop()
  }, [info])

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">DualSense Haptic Designer</span>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button
          title="Reset the motor, trigger and scene settings (and unload the sound). Keeps calibration, the 3D model and audio devices."
          onClick={() => confirmReset('Reset all settings') && void resetAll()}
        >
          Reset All
        </button>
        <AudioControls />
        <span className="status">
          <span className={`dot ${info ? 'on' : ''}`} />
          {info ? `${info.name}${info.edge ? ' (Edge)' : ''} · ${info.transport.toUpperCase()}` : 'No controller'}
        </span>
        {info ? (
          <button onClick={() => void dualSense.disconnect()}>Disconnect</button>
        ) : (
          <button className="primary" onClick={() => void connect()}>
            Connect DualSense
          </button>
        )}
      </div>
      <div className="main" style={{ gridTemplateColumns: `minmax(0, 1fr) ${clampSide(sideW)}px` }}>
        <div className="workspace">
          {connError && <div className="errbox">{connError}</div>}
          {tab === 'workbench' && <WorkbenchPanel />}
          {tab === 'experiments' && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="muted">Experiments:</span>
                <button className={experiment === 'scenes' ? 'active' : ''} onClick={() => setExperiment('scenes')}>
                  Interactive scenes
                </button>
                <button className={experiment === 'clips' ? 'active' : ''} onClick={() => setExperiment('clips')}>
                  Haptic clip composer
                </button>
              </div>
              {experiment === 'scenes' && <ScenePanel />}
              {experiment === 'clips' && <ClipsPanel />}
            </>
          )}
          {tab === 'controller' && (
            <ControllerPanel
              model={model}
              rig={rig}
              setRig={setRig}
              onLoadModel={() => void loadModel()}
              onPlaceholder={usePlaceholder}
              modelError={modelError}
            />
          )}
        </div>
        <div className="sidepanel">
          <div
            className="side-splitter"
            onPointerDown={dragSide}
            onDoubleClick={() => {
              setSideW(SIDE_W_DEFAULT)
              saveLocal(SIDE_W_KEY, SIDE_W_DEFAULT)
            }}
            title="Drag to resize the 3D view · double-click to reset"
          />
          {(tab === 'workbench' || tab === 'experiments') && <MiniGraphs key={tab} mode={tab} />}
          <ButtonHint />
          <ControllerView model={model} rig={rig} />
          <SideInfo />
        </div>
      </div>
    </div>
  )
}

const SIDE_W_KEY = 'dshd.sideWidth'
const SIDE_W_DEFAULT = 420
/** keep the 3D view at least 260 px and leave the tab content at least 480 px */
function clampSide(w: number) {
  return Math.round(Math.max(260, Math.min(w, window.innerWidth - 480)))
}

const BT_HAPTICS_WARNING = `Bluetooth vibration is experimental, and it can feel drastically worse than over USB.

It uses a format worked out by community projects (8-bit at 3 kHz; USB is 16-bit at 48 kHz). Sony's own Bluetooth format isn't public. A weak or busy Bluetooth connection can also add delay and make it choppy. It only carries the Experiments tab's vibration, not the sound on Haptics & Triggers.

For designing grip vibration, connect the controller by USB.

Turn on Bluetooth vibration anyway?`

/** Live numbers for the experimental Bluetooth haptics stream: is it keeping up? */
function BtHapticsReadout() {
  useTicker(4)
  const s = btHaptics.stats
  return (
    <span
      className="muted small mono"
      title="Packets sent per second (should be ~94) · how long each send takes · gaps (the stream ran dry) · drops (Bluetooth fell behind)"
    >
      {s.sentPerSec}/s · {s.sendMs.toFixed(1)} ms · gaps {s.gaps} · drops {s.dropped}
    </span>
  )
}

function SideInfo() {
  useTicker(15)
  const s = dualSense.state
  const info = dualSense.info
  return (
    <div className="side-info">
      <div className="row">
        <button onClick={() => recenter('Recenter')} disabled={!info} title="Hold the controller pointing at the screen, then click (or press Options, Create, L3 or R3 on the controller)">
          Recenter
        </button>
        <span className="muted small">
          {info ? `${dualSense.reportRate} Hz · battery ${s.battery}%${s.charging ? ' ⚡' : ''}` : 'The model follows the controller once connected'}
        </span>
      </div>
      <Meter label="L" value={hapticEngine.meter.l} cls="l" />
      <Meter label="R" value={hapticEngine.meter.r} cls="r" />
      <div className="row small muted">
        <span>L2 {Math.round(s.l2 * 100)}%</span>
        <span>R2 {Math.round(s.r2 * 100)}%</span>
        <span className="spacer" />
        <span>
          lightbar <span className="swatch" style={{ background: `rgb(${lightbar.rgb.join(',')})` }} />
        </span>
      </div>
    </div>
  )
}

function AudioControls() {
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [sink, setSink] = useState<string>(() => loadLocal('dshd.sink', ''))
  const [, force] = useState(0)
  const info = useConnection()

  const refresh = useCallback(async () => {
    try {
      const list = await HapticEngine.listOutputs()
      setDevices(list)
      return list
    } catch {
      return []
    }
  }, [])

  useEffect(
    () =>
      hapticEngine.onStatus(() => {
        force((x) => x + 1)
        // the output may have been switched elsewhere (Connect to Controller Vibration)
        setSink(hapticEngine.sinkId)
        void refresh()
      }) as unknown as () => void,
    [refresh],
  )

  // Start the engine; prefer the DualSense audio endpoint when present.
  useEffect(() => {
    void (async () => {
      const list = await refresh()
      const ds = list.find((d) => d.isDualSense)
      const chosen = list.some((d) => d.deviceId === sink) ? sink : ds?.deviceId ?? ''
      setSink(chosen)
      await hapticEngine.start(chosen)
    })()
    const onChange = () => void refresh()
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When a USB controller connects, its audio endpoint appears shortly after; switch to it.
  useEffect(() => {
    if (info?.transport !== 'usb') return
    const t = window.setTimeout(async () => {
      const list = await refresh()
      const ds = list.find((d) => d.isDualSense)
      if (ds && ds.deviceId !== hapticEngine.sinkId) {
        setSink(ds.deviceId)
        saveLocal('dshd.sink', ds.deviceId)
        await hapticEngine.start(ds.deviceId)
      }
    }, 1500)
    return () => window.clearTimeout(t)
  }, [info, refresh])

  const choose = async (id: string) => {
    setSink(id)
    saveLocal('dshd.sink', id)
    await hapticEngine.start(id)
  }

  return (
    <span className="row">
      <span className={`dot ${hapticEngine.running ? (hapticEngine.routing === 'dualsense' ? 'on' : 'warn') : ''}`} />
      <select value={sink} onChange={(e) => void choose(e.target.value)} title="Haptic audio output">
        <option value="">System default output</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.isDualSense ? '🎮 ' : ''}
            {d.label}
          </option>
        ))}
      </select>
      {hapticEngine.error && (
        <span className="muted small" title={hapticEngine.error}>
          audio error: {hapticEngine.error}
        </span>
      )}
      {info?.transport === 'bt' && (
        <button
          className={btHaptics.active ? 'active' : ''}
          title="Experimental: stream haptics over Bluetooth (report 0x32)"
          onClick={() => {
            if (btHaptics.active) btHaptics.stop()
            else if (window.confirm(BT_HAPTICS_WARNING)) btHaptics.start(hapticEngine, dualSense)
            force((x) => x + 1)
          }}
        >
          BT haptics {btHaptics.active ? 'on' : 'off'}
        </button>
      )}
      {info?.transport === 'bt' && btHaptics.active && <BtHapticsReadout />}
    </span>
  )
}
