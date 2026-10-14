import { useCallback, useEffect, useState } from 'react'
import { dualSense } from './device/hid'
import { hapticEngine, HapticEngine, type OutputDevice } from './haptics/engine'
import { btHaptics } from './haptics/btHaptics'
import { lightbar, loadLocal, saveLocal, tracker, useConnection, useTicker } from './store'
import { ControllerView, loadModelFromBytes, placeholderModel, type LoadedModel } from './viewer/ControllerView'
import { autoMap, defaultRig, knownRigFor, rigFitsModel, type RigMap } from './viewer/rig'
import { ControllerPanel } from './designer/ControllerPanel'
import { ClipsPanel } from './designer/clips/ClipsPanel'
import { ScenePanel } from './designer/scenes/ScenePanel'
import { WorkbenchPanel } from './designer/workbench/WorkbenchPanel'
import { Meter } from './ui/controls'

type Tab = 'workbench' | 'controller' | 'experiments'
type Experiment = 'scenes' | 'clips'

const TABS: { id: Tab; label: string }[] = [
  { id: 'workbench', label: 'Haptics & Triggers' },
  { id: 'controller', label: 'Controller & Model' },
  { id: 'experiments', label: 'Experiments' },
]

const MODEL_PATH_KEY = 'dshd.modelPath'
const RIG_KEY = 'dshd.rig'

export function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = loadLocal<string>('dshd.tab', 'workbench')
    return TABS.some((x) => x.id === t) ? (t as Tab) : 'workbench'
  })
  const [experiment, setExperiment] = useState<Experiment>(() => loadLocal('dshd.experiment', 'scenes'))
  const info = useConnection()
  const [model, setModel] = useState<LoadedModel>(() => placeholderModel())
  const [rig, setRigState] = useState<RigMap>(() => autoMap(loadLocal(RIG_KEY, defaultRig()), placeholderModel().nodeNames))
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
      const candidates = [last, `${await window.api.assetsDir()}/models/dualsense.glb`].filter(Boolean) as string[]
      for (const p of candidates) {
        const f = await window.api.readFile(p)
        if (f) {
          await applyModel(f.name, f.data, p)
          return
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyModel = async (name: string, data: Uint8Array, path?: string) => {
    try {
      const m = await loadModelFromBytes(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      setModel(m)
      // keep the saved rig if it belongs to this model; else use a ready-made rig for
      // known models; else auto-map by node names
      const saved = loadLocal(RIG_KEY, defaultRig())
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
    const f = await window.api.openFile([{ name: '3D model', extensions: ['glb', 'gltf', 'dae'] }])
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
      <div className="main">
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
          <ControllerView model={model} rig={rig} />
          <SideInfo />
        </div>
      </div>
    </div>
  )
}

function SideInfo() {
  useTicker(15)
  const s = dualSense.state
  const info = dualSense.info
  return (
    <div className="side-info">
      <div className="row">
        <button onClick={() => tracker.recenter()} disabled={!info} title="Hold the controller pointing at the screen, then click">
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

  useEffect(() => hapticEngine.onStatus(() => force((x) => x + 1)) as unknown as () => void, [])

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

  const routeLabel =
    hapticEngine.routing === 'dualsense'
      ? `haptics → ch 3/4 (${hapticEngine.channelCount}ch)`
      : `monitor → ch 1/2 (${hapticEngine.channelCount}ch)`

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
      <span className="muted small" title={hapticEngine.error ?? ''}>
        {hapticEngine.error ? `audio error: ${hapticEngine.error}` : routeLabel}
      </span>
      {hapticEngine.channelCount >= 4 && (
        <button className="small" onClick={() => hapticEngine.applyRouting(hapticEngine.routing === 'dualsense' ? 'monitor' : 'dualsense')}>
          {hapticEngine.routing === 'dualsense' ? 'Listen on spk' : 'Haptics'}
        </button>
      )}
      {info?.transport === 'bt' && (
        <button
          className={btHaptics.active ? 'active' : ''}
          title="Experimental: stream haptics over Bluetooth (report 0x32)"
          onClick={() => {
            if (btHaptics.active) btHaptics.stop()
            else btHaptics.start(hapticEngine, dualSense)
            force((x) => x + 1)
          }}
        >
          BT haptics {btHaptics.active ? 'on' : 'off'}
        </button>
      )}
    </span>
  )
}
