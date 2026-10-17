// Scene designer: live "things inside the controller" simulation driven by real tilt,
// touchpad and buttons.

import { platform } from '../../platform'
import { useEffect, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import { hapticEngine } from '../../haptics/engine'
import type { Material } from '../../haptics/dsp'
import { loadLocal, PressTracker, saveLocal, tracker, useConnection, virtualTilt } from '../../store'
import { Card, downloadName, Param, Select } from '../../ui/controls'
import { confirmReset, onReset, RESET_LABELS, resetSection } from '../../resets'
import {
  defaultCritters,
  DEFAULT_DEPTH_FADE,
  defaultLiquid,
  defaultMarbles,
  SCENE_PRESETS,
  SceneSim,
  type CritterConfig,
  type EntityConfig,
  type LiquidConfig,
  type MarbleConfig,
  type SceneConfig,
  type SimInputs,
} from './sim'
import type { LiquidSim } from './liquid'

const MATERIALS: Material[] = ['wood', 'glass', 'metal', 'rubber', 'stone', 'soft']

export function ScenePanel() {
  const [cfg, setCfgState] = useState<SceneConfig>(() => loadLocal('dshd.scene', SCENE_PRESETS[4].make()))
  const [running, setRunning] = useState(true)
  const [master, setMasterState] = useState(() => loadLocal('dshd.scene.master', 1.5))
  const [msg, setMsg] = useState<string | null>(null)
  const info = useConnection()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const simRef = useRef<SceneSim | null>(null)
  const mouseFinger = useRef<{ x: number; y: number } | null>(null)
  const pending = useRef({ jump: false, kick: false, toss: false })

  const setCfg = (c: SceneConfig) => {
    setCfgState(c)
    saveLocal('dshd.scene', c)
  }
  useEffect(
    () =>
      onReset((s) => {
        if (s !== 'scene') return
        setCfgState(SCENE_PRESETS[4].make())
        setMasterState(1.5)
        setMsg(null)
      }),
    [],
  )

  // Master gain lives on the shared engine: apply it while the scene is open (and again if
  // the audio output restarts), and hand the engine back at 1 when leaving
  useEffect(() => {
    saveLocal('dshd.scene.master', master)
    hapticEngine.setMasterGain(master)
    const off = hapticEngine.onStatus(() => hapticEngine.setMasterGain(master))
    return () => {
      off()
      hapticEngine.setMasterGain(1)
    }
  }, [master])

  // Create the sim once; push config changes into it
  if (!simRef.current) {
    simRef.current = new SceneSim(cfg, {
      grain: (g) => hapticEngine.grain(g),
      voice: (id, p) => hapticEngine.voice(id, p),
    })
  }
  useEffect(() => {
    const sim = simRef.current!
    sim.cfg = cfg
    sim.rebuild()
  }, [cfg])

  useEffect(() => () => simRef.current?.silence(), [])

  // Main loop ------------------------------------------------------------------
  useEffect(() => {
    const sim = simRef.current!
    if (!running) {
      sim.silence()
      return
    }
    const presses = new PressTracker()
    let raf = 0
    let last = performance.now()
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = dualSense.state
      // Controller tilt when it is streaming; otherwise the right-drag virtual tilt
      const useController = dualSense.connected && s.full

      // Gravity in the box plane: controller x → box x, controller z (toward player) → box y
      let gx = virtualTilt.x
      let gy = virtualTilt.y
      if (useController) {
        const g = tracker.gravityInController
        gx = g[0]
        gy = g[2]
      }
      // Touchpad finger → box position (the touchpad roughly covers the box top-down)
      let finger = mouseFinger.current
      const t0 = s.touch[0]
      if (dualSense.connected && t0.active) finger = { x: t0.x / 1919, y: t0.y / 1079 }

      const inp: SimInputs = {
        gx,
        gy,
        shake: useController ? tracker.shake : 0,
        finger,
        jump: pending.current.jump || presses.pressed('cross', s.buttons.cross),
        kick: pending.current.kick || presses.pressed('square', s.buttons.square),
        lift: pending.current.toss ? 1 : useController ? tracker.takeLift() : 0,
      }
      pending.current = { jump: false, kick: false, toss: false }
      if (presses.pressed('triangle', s.buttons.triangle)) {
        sim.cfg.entities.forEach((e) => e.kind === 'marble' && (e.count = Math.min(12, e.count + 1)))
        sim.rebuild()
      }
      sim.step(dt, inp)
      draw(canvasRef.current, sim, inp)
    }
    loop()
    return () => {
      cancelAnimationFrame(raf)
      sim.silence()
    }
  }, [running])

  // Mouse: left-drag = finger; right-drag = virtual tilt
  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const box = boxRect(r.width, r.height, cfg)
    const x = (e.clientX - r.left - box.x) / box.w
    const y = (e.clientY - r.top - box.y) / box.h
    if (e.buttons & 2) {
      virtualTilt.x = Math.max(-1, Math.min(1, (x - 0.5) * 2)) * 0.8
      virtualTilt.y = Math.max(-1, Math.min(1, (y - 0.5) * 2)) * 0.8
    } else if (e.buttons & 1) {
      mouseFinger.current = { x, y }
    } else {
      mouseFinger.current = null
    }
  }

  const exportScene = async () => {
    const path = await platform.saveFile(downloadName(cfg.name, 'scene.json'), [{ name: 'Scene', extensions: ['json'] }], JSON.stringify(cfg, null, 2))
    if (path) setMsg(`Saved ${path}`)
  }
  const importScene = async () => {
    const f = await platform.openFile([{ name: 'Scene', extensions: ['json'] }])
    if (!f) return
    try {
      const c = JSON.parse(new TextDecoder().decode(f.data)) as SceneConfig
      if (c.version !== 1 || !Array.isArray(c.entities)) throw new Error('not a scene file')
      setCfg(c)
    } catch (e) {
      setMsg(`Open failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const updateEntity = (id: string, patch: Partial<EntityConfig>) =>
    setCfg({ ...cfg, entities: cfg.entities.map((e) => (e.id === id ? ({ ...e, ...patch } as EntityConfig) : e)) })
  const removeEntity = (id: string) => setCfg({ ...cfg, entities: cfg.entities.filter((e) => e.id !== id) })

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={running ? 'active' : 'primary'} onClick={() => setRunning(!running)}>
          {running ? '❚❚ Pause' : '▶ Run'}
        </button>
        <button onClick={() => (pending.current.jump = true)}>Jump</button>
        <button onClick={() => (pending.current.kick = true)}>Shake</button>
        <button onClick={() => (pending.current.toss = true)}>Toss</button>
        <div className="spacer" />
        <select value="" onChange={(e) => e.target.value && setCfg(SCENE_PRESETS[Number(e.target.value)].make())}>
          <option value="">Load preset…</option>
          {SCENE_PRESETS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={() => void importScene()}>Open…</button>
        <button onClick={() => void exportScene()}>Save…</button>
        <button onClick={() => confirmReset(RESET_LABELS.scene) && void resetSection('scene')}>{RESET_LABELS.scene}</button>
      </div>
      {msg && <div className="muted small" style={{ marginBottom: 8 }}>{msg}</div>}
      {!info && (
        <div className="warnbox">
          No controller: right-drag on the box to tilt it, left-drag to poke with a "finger". Haptics play on the selected audio output so you can still hear them.
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="scene"
        style={{ height: 340 }}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onPointerUp={() => (mouseFinger.current = null)}
        onPointerLeave={() => (mouseFinger.current = null)}
        onContextMenu={(e) => e.preventDefault()}
      />
      <p className="muted small">
        Tilt the controller to roll/slide things around · touch the touchpad to poke them · <kbd>✕</kbd> makes critters jump · <kbd>□</kbd> shakes the box ·{' '}
        <kbd>△</kbd> adds a marble · lift the controller quickly to toss everything up · physically shaking the controller also works.
      </p>

      <div className="grid2">
        <Card title="Box">
          <div className="param">
            <label>Name</label>
            <input type="text" value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} />
            <span />
          </div>
          <Param label="Width (cm)" value={cfg.width} min={6} max={30} step={0.5} onChange={(v) => setCfg({ ...cfg, width: v })} />
          <Param label="Depth (cm)" value={cfg.height} min={3} max={20} step={0.5} onChange={(v) => setCfg({ ...cfg, height: v })} />
          <Param label="Gravity" value={cfg.gravity} min={0} max={3} step={0.05} onChange={(v) => setCfg({ ...cfg, gravity: v })} format={(v) => `×${v.toFixed(2)}`} />
          <Select label="Wall material" value={cfg.wallMaterial} options={MATERIALS} onChange={(v) => setCfg({ ...cfg, wallMaterial: v })} />
          <Param label="Wall hit gain" value={cfg.wallGain} min={0} max={2} step={0.05} onChange={(v) => setCfg({ ...cfg, wallGain: v })} format={(v) => v.toFixed(2)} />
          <Param label="Top/bottom loudness" value={cfg.depthFade ?? DEFAULT_DEPTH_FADE} min={0} max={1} step={0.05} onChange={(v) => setCfg({ ...cfg, depthFade: v })} format={(v) => `±${(v * 10).toFixed(0)} dB`} />
          <Param label="Master gain" value={master} min={0} max={2} step={0.05} onChange={setMasterState} format={(v) => v.toFixed(2)} />
        </Card>
        <Card
          title="Things inside"
          right={
            <>
              <button onClick={() => setCfg({ ...cfg, entities: [...cfg.entities, defaultMarbles()] })}>+ Marbles</button>
              <button onClick={() => setCfg({ ...cfg, entities: [...cfg.entities, defaultCritters()] })}>+ Critters</button>
              <button onClick={() => setCfg({ ...cfg, entities: [...cfg.entities, defaultLiquid()] })}>+ Liquid</button>
            </>
          }
        >
          {cfg.entities.length === 0 && <p className="muted">The box is empty.</p>}
          {cfg.entities.map((e) => (
            <EntityEditor key={e.id} e={e} onChange={(p) => updateEntity(e.id, p)} onRemove={() => removeEntity(e.id)} />
          ))}
        </Card>
      </div>
    </>
  )
}

function EntityEditor({ e, onChange, onRemove }: { e: EntityConfig; onChange: (p: Partial<EntityConfig>) => void; onRemove: () => void }) {
  return (
    <details className="entity" open>
      <summary>
        <span className="swatch" style={{ background: e.color }} />
        {e.name} <span className="muted small">({e.kind})</span>
      </summary>
      <div className="row" style={{ margin: '6px 0' }}>
        <input type="text" value={e.name} onChange={(ev) => onChange({ name: ev.target.value })} />
        <input type="color" value={e.color} onChange={(ev) => onChange({ color: ev.target.value })} />
        <div className="spacer" />
        <button className="danger small" onClick={onRemove}>Remove</button>
      </div>
      {e.kind === 'marble' && <MarbleParams e={e} onChange={onChange} />}
      {e.kind === 'critter' && <CritterParams e={e} onChange={onChange} />}
      {e.kind === 'liquid' && <LiquidParams e={e} onChange={onChange} />}
    </details>
  )
}

function MarbleParams({ e, onChange }: { e: MarbleConfig; onChange: (p: Partial<MarbleConfig>) => void }) {
  return (
    <>
      <Param label="Count" value={e.count} min={1} max={12} onChange={(v) => onChange({ count: v })} />
      <Param label="Radius (cm)" value={e.radius} min={0.2} max={2} step={0.05} onChange={(v) => onChange({ radius: v })} format={(v) => v.toFixed(2)} />
      <Param label="Size variation" value={e.sizeVariation ?? 0} min={0} max={0.5} step={0.05} onChange={(v) => onChange({ sizeVariation: v })} format={(v) => `±${Math.round(v * 100)}%`} />
      <Param label="Mass" value={e.mass} min={0.2} max={5} step={0.1} onChange={(v) => onChange({ mass: v })} format={(v) => v.toFixed(1)} />
      <Param label="Bounciness" value={e.restitution} min={0} max={0.95} step={0.05} onChange={(v) => onChange({ restitution: v })} format={(v) => v.toFixed(2)} />
      <Param label="Rolling friction" value={e.rollingFriction} min={0} max={3} step={0.05} onChange={(v) => onChange({ rollingFriction: v })} format={(v) => v.toFixed(2)} />
      <Param label="Impact gain" value={e.impactGain} min={0} max={2} step={0.05} onChange={(v) => onChange({ impactGain: v })} format={(v) => v.toFixed(2)} />
      <Param label="Rolling gain" value={e.rollGain} min={0} max={2} step={0.05} onChange={(v) => onChange({ rollGain: v })} format={(v) => v.toFixed(2)} />
      <Param label="Pitch" value={e.pitch} min={0.3} max={3} step={0.05} onChange={(v) => onChange({ pitch: v })} format={(v) => `×${v.toFixed(2)}`} />
    </>
  )
}

function CritterParams({ e, onChange }: { e: CritterConfig; onChange: (p: Partial<CritterConfig>) => void }) {
  return (
    <>
      <Param label="Count" value={e.count} min={1} max={12} onChange={(v) => onChange({ count: v })} />
      <Param label="Size (cm)" value={e.radius} min={0.2} max={1.5} step={0.05} onChange={(v) => onChange({ radius: v })} format={(v) => v.toFixed(2)} />
      <Param label="Walk speed" value={e.speed} min={0.5} max={15} step={0.5} onChange={(v) => onChange({ speed: v })} format={(v) => `${v} cm/s`} />
      <Param label="Base steps / s" value={e.stepRate} min={1} max={25} step={0.5} onChange={(v) => onChange({ stepRate: v })} />
      <Param label="Hop on arrival" value={e.hopChance} min={0} max={1} step={0.05} onChange={(v) => onChange({ hopChance: v })} format={(v) => v.toFixed(2)} />
      <Param label="Step gain" value={e.stepGain} min={0} max={2} step={0.05} onChange={(v) => onChange({ stepGain: v })} format={(v) => v.toFixed(2)} />
      <Param label="Landing gain" value={e.landGain} min={0} max={2} step={0.05} onChange={(v) => onChange({ landGain: v })} format={(v) => v.toFixed(2)} />
      <Param label="Pitch" value={e.pitch} min={0.3} max={3} step={0.05} onChange={(v) => onChange({ pitch: v })} format={(v) => `×${v.toFixed(2)}`} />
      <Param label="Slip on tilt" value={e.slip} min={0} max={1} step={0.05} onChange={(v) => onChange({ slip: v })} format={(v) => v.toFixed(2)} />
      <label className="row small">
        <input type="checkbox" checked={e.shy} onChange={(ev) => onChange({ shy: ev.target.checked })} /> Run away from your finger
      </label>
    </>
  )
}

function LiquidParams({ e, onChange }: { e: LiquidConfig; onChange: (p: Partial<LiquidConfig>) => void }) {
  return (
    <>
      <Param label="Fill amount" value={e.amount} min={0.05} max={1} step={0.05} onChange={(v) => onChange({ amount: v })} format={(v) => `${Math.round(v * 100)}%`} />
      <Param label="Viscosity" value={e.viscosity} min={0} max={1} step={0.05} onChange={(v) => onChange({ viscosity: v })} format={(v) => v.toFixed(2)} />
      <Param label="Gain" value={e.gain} min={0} max={2} step={0.05} onChange={(v) => onChange({ gain: v })} format={(v) => v.toFixed(2)} />
    </>
  )
}

// --- drawing -----------------------------------------------------------------

function boxRect(W: number, H: number, cfg: SceneConfig) {
  const pad = 24
  const scale = Math.min((W - 2 * pad) / cfg.width, (H - 2 * pad) / cfg.height)
  const w = cfg.width * scale
  const h = cfg.height * scale
  return { x: (W - w) / 2, y: (H - h) / 2, w, h, scale }
}

function draw(c: HTMLCanvasElement | null, sim: SceneSim, inp: SimInputs) {
  if (!c) return
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth
  const H = c.clientHeight
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
  }
  const g = c.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, W, H)
  const cfg = sim.cfg
  const b = boxRect(W, H, cfg)

  // actuator zones
  const grdL = g.createLinearGradient(b.x, 0, b.x + b.w, 0)
  grdL.addColorStop(0, `rgba(90,169,255,${0.08 + hapticEngine.meter.l * 0.5})`)
  grdL.addColorStop(0.5, 'rgba(0,0,0,0)')
  grdL.addColorStop(1, `rgba(143,209,79,${0.08 + hapticEngine.meter.r * 0.5})`)
  g.fillStyle = grdL
  g.fillRect(b.x, b.y, b.w, b.h)

  g.strokeStyle = '#4a5160'
  g.lineWidth = 2
  g.strokeRect(b.x, b.y, b.w, b.h)
  g.fillStyle = '#8b91a1'
  g.font = '11px Segoe UI'
  g.fillText('L grip', b.x + 4, b.y + b.h + 14)
  g.fillText('R grip', b.x + b.w - 36, b.y + b.h + 14)
  g.fillText('triggers ↑', b.x + b.w / 2 - 26, b.y - 6)

  // liquids
  for (const l of sim.liquids) drawLiquid(g, l.sim, l.cfg.color, b, W, H, dpr)

  // bodies
  for (const body of sim.bodies) {
    const x = b.x + body.x * b.scale
    const y = b.y + body.y * b.scale
    const r = body.r * b.scale
    const lift = body.air > 0 ? Math.sin((1 - body.air / Math.max(0.01, body.airTotal)) * Math.PI) : 0
    if (body.cfg.kind === 'marble') {
      // higher flights rise further off the floor
      const yy = y - lift * r * (1 + body.airTotal * 6)
      if (lift > 0) {
        g.fillStyle = 'rgba(0,0,0,0.35)'
        g.beginPath()
        g.ellipse(x, y + r * 0.6, r * (1 - lift * 0.3), r * 0.4, 0, 0, Math.PI * 2)
        g.fill()
      }
      const grd = g.createRadialGradient(x - r * 0.35, yy - r * 0.35, r * 0.1, x, yy, r)
      grd.addColorStop(0, '#ffffff')
      grd.addColorStop(0.3, body.cfg.color)
      grd.addColorStop(1, '#00000088')
      g.fillStyle = grd
      g.beginPath()
      g.arc(x, yy, r * (1 + lift * 0.2), 0, Math.PI * 2)
      g.fill()
    } else {
      // shadow
      g.fillStyle = 'rgba(0,0,0,0.35)'
      g.beginPath()
      g.ellipse(x, y + r * 0.6, r * (1 - lift * 0.3), r * 0.4, 0, 0, Math.PI * 2)
      g.fill()
      const yy = y - lift * r * 2.5
      g.fillStyle = body.cfg.color
      g.beginPath()
      g.arc(x, yy, r * (1 + lift * 0.2), 0, Math.PI * 2)
      g.fill()
      // eyes facing heading
      const ex = Math.cos(body.heading)
      const ey = Math.sin(body.heading)
      g.fillStyle = '#111'
      for (const s of [-1, 1]) {
        g.beginPath()
        g.arc(x + ex * r * 0.45 - ey * r * 0.3 * s, yy + ey * r * 0.45 + ex * r * 0.3 * s, r * 0.16, 0, Math.PI * 2)
        g.fill()
      }
    }
    if (body.flash > 0) {
      g.strokeStyle = `rgba(255,255,255,${body.flash})`
      g.lineWidth = 2
      g.beginPath()
      g.arc(x, y, r + 4 * (1 - body.flash) + 2, 0, Math.PI * 2)
      g.stroke()
    }
  }

  // finger
  if (inp.finger) {
    g.strokeStyle = '#3ad6a8'
    g.lineWidth = 2
    g.beginPath()
    g.arc(b.x + inp.finger.x * b.w, b.y + inp.finger.y * b.h, 1.5 * b.scale, 0, Math.PI * 2)
    g.stroke()
  }

  // gravity arrow
  const gx = inp.gx
  const gy = inp.gy
  const cx = W - 46
  const cy = 46
  g.strokeStyle = '#3a3f4c'
  g.lineWidth = 1
  g.beginPath()
  g.arc(cx, cy, 30, 0, Math.PI * 2)
  g.stroke()
  g.strokeStyle = '#ffb347'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(cx, cy)
  g.lineTo(cx + gx * 30, cy + gy * 30)
  g.stroke()
  g.fillStyle = '#8b91a1'
  g.fillText('tilt', cx - 9, cy + 44)
}

// --- liquid rendering ----------------------------------------------------------
// Particles are drawn as solid discs on an offscreen canvas, then composited through an
// SVG "goo" filter (blur → alpha threshold) so neighbouring discs merge into one smooth
// body of liquid with rounded edges. Turbulent particles get foam flecks on top.

let liquidLayer: HTMLCanvasElement | null = null

function ensureGooFilter() {
  if (document.getElementById('dshd-goo')) return
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.innerHTML =
    '<filter id="dshd-goo" color-interpolation-filters="sRGB">' +
    '<feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur"/>' +
    // keep colour, sharpen alpha: a' = 24a - 10  → crisp merged edges
    '<feColorMatrix in="blur" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10"/>' +
    '</filter>'
  document.body.appendChild(svg)
}

function drawLiquid(
  g: CanvasRenderingContext2D,
  liq: LiquidSim,
  color: string,
  b: { x: number; y: number; w: number; h: number; scale: number },
  W: number,
  H: number,
  dpr: number,
) {
  ensureGooFilter()
  if (!liquidLayer) liquidLayer = document.createElement('canvas')
  const layer = liquidLayer
  if (layer.width !== Math.round(W * dpr) || layer.height !== Math.round(H * dpr)) {
    layer.width = Math.round(W * dpr)
    layer.height = Math.round(H * dpr)
  }
  const lg = layer.getContext('2d')!
  lg.setTransform(dpr, 0, 0, dpr, 0, 0)
  lg.clearRect(0, 0, W, H)

  // two passes: a light rim (full radius) under a deeper core (smaller radius); after the
  // goo blur this reads as a body of liquid with a brighter surface edge
  const r = Math.max(4, 0.5 * b.scale)
  const discs = (radius: number, fill: string) => {
    lg.fillStyle = fill
    lg.beginPath()
    for (let i = 0; i < liq.n; i++) {
      const x = b.x + liq.x[i] * b.scale
      const y = b.y + liq.y[i] * b.scale
      lg.moveTo(x + radius, y)
      lg.arc(x, y, radius, 0, Math.PI * 2)
    }
    lg.fill()
  }
  discs(r, mixColor(color, '#ffffff', 0.45))
  discs(r * 0.62, mixColor(color, '#000000', 0.25))

  g.save()
  // clip to the box so the blur can't bleed past the walls
  g.beginPath()
  g.rect(b.x, b.y, b.w, b.h)
  g.clip()
  g.globalAlpha = 0.82
  g.filter = 'url(#dshd-goo)'
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.drawImage(layer, 0, 0)
  g.filter = 'none'
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.globalAlpha = 1

  // highlights: a soft sheen on every particle, foam on the turbulent ones
  for (let i = 0; i < liq.n; i++) {
    const x = b.x + liq.x[i] * b.scale
    const y = b.y + liq.y[i] * b.scale
    const sp = Math.hypot(liq.vx[i], liq.vy[i])
    const sheen = Math.min(0.25, sp / 200)
    if (sheen > 0.02) {
      g.fillStyle = `rgba(255,255,255,${sheen})`
      g.fillRect(x - 1, y - 1, 2, 2)
    }
    const f = liq.foam[i]
    if (f > 0.15) {
      g.fillStyle = `rgba(235,245,255,${Math.min(0.9, f)})`
      g.beginPath()
      g.arc(x, y, 1 + f * 2.2, 0, Math.PI * 2)
      g.fill()
    }
  }

  // splash flashes on the walls that were hit: left, right, top, bottom
  const fl = liq.flash
  g.fillStyle = 'rgba(255,255,255,0.5)'
  if (fl[0] > 0) g.fillRect(b.x, b.y, 5 * fl[0] + 1, b.h)
  if (fl[1] > 0) g.fillRect(b.x + b.w - 5 * fl[1] - 1, b.y, 5 * fl[1] + 1, b.h)
  if (fl[2] > 0) g.fillRect(b.x, b.y, b.w, 5 * fl[2] + 1)
  if (fl[3] > 0) g.fillRect(b.x, b.y + b.h - 5 * fl[3] - 1, b.w, 5 * fl[3] + 1)
  g.restore()
}

/** Blend two #rrggbb colours. */
function mixColor(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`
}
