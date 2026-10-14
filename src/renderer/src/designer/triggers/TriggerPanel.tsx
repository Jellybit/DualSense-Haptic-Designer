// Adaptive trigger designer: per-trigger effect editor with live preview graph,
// live send to the controller, and a JSON preset library.

import { platform } from '../../platform'
import { useEffect, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import {
  defaultEffect,
  effectProfile,
  EFFECT_LABELS,
  EFFECT_MENU,
  encodeTrigger,
  toCurveEffect,
  type CurvePoint,
  type TriggerEffect,
  type TriggerEffectType,
} from '../../device/triggerEffects'
import { BUILTIN_PRESETS, makePreset, parsePresets, serializePresets, type TriggerPreset } from '../../export/presets'
import { loadLocal, saveLocal, useConnection } from '../../store'
import { Card, downloadName, Param } from '../../ui/controls'
import { travelToZone, zonesFor, zoneToTravel } from '../../device/triggerCalibration'
import { CalibrationWizard, useTriggerCalibration } from './CalibrationWizard'

type Side = 'L2' | 'R2'

export const triggerState: Record<Side, TriggerEffect> = {
  L2: toCurveEffect(loadLocal<TriggerEffect>('dshd.trig.L2', { type: 'off' })),
  R2: toCurveEffect(loadLocal<TriggerEffect>('dshd.trig.R2', { type: 'off' })),
}

export function applyTrigger(side: Side, e: TriggerEffect) {
  const bytes = encodeTrigger(e)
  return side === 'L2' ? dualSense.setTriggers(bytes, undefined) : dualSense.setTriggers(undefined, bytes)
}

/** Save the current L2/R2 setup as a trigger-preset JSON file. Returns the path or null. */
export async function exportTriggerJson(baseName: string): Promise<string | null> {
  const presets = [makePreset(`${baseName} L2`, 'L2', triggerState.L2), makePreset(`${baseName} R2`, 'R2', triggerState.R2)]
  return platform.saveFile(downloadName(`${baseName}.triggers`, 'json'), [{ name: 'JSON', extensions: ['json'] }], serializePresets(presets))
}

/** `embedded`: shown inside another panel that provides its own export button. */
export function TriggerPanel({ embedded = false }: { embedded?: boolean }) {
  const info = useConnection()
  const [effects, setEffects] = useState(triggerState)
  const [live, setLive] = useState(true)
  const [presets, setPresets] = useState<TriggerPreset[]>(() => loadLocal('dshd.userPresets', [] as TriggerPreset[]))
  const [msg, setMsg] = useState<string | null>(null)
  const [calibrating, setCalibrating] = useState(() => location.hash === '#calibrate')
  const calibration = useTriggerCalibration()

  const setEffect = (side: Side, effect: TriggerEffect) => {
    // presets and imports may hold the older slider-style effects
    const e = toCurveEffect(effect)
    triggerState[side] = e
    saveLocal(`dshd.trig.${side}`, e)
    setEffects({ ...triggerState })
  }

  // Live-send whenever an effect changes
  useEffect(() => {
    if (!live || !info) return
    void applyTrigger('L2', effects.L2)
    void applyTrigger('R2', effects.R2)
  }, [effects, live, info])

  const savePresets = (p: TriggerPreset[]) => {
    setPresets(p)
    saveLocal('dshd.userPresets', p)
  }

  const exportPresets = async () => {
    const all = presets.length ? presets : [makePreset('L2', 'L2', effects.L2), makePreset('R2', 'R2', effects.R2)]
    const path = await platform.saveFile(downloadName('trigger-presets', 'json'), [{ name: 'JSON', extensions: ['json'] }], serializePresets(all))
    if (path) setMsg(`Exported ${all.length} preset(s) to ${path}`)
  }

  const importPresets = async () => {
    const f = await platform.openFile([{ name: 'JSON', extensions: ['json'] }])
    if (!f) return
    try {
      const list = parsePresets(new TextDecoder().decode(f.data))
      savePresets([...presets, ...list])
      // a file with explicit L2/R2 entries (e.g. one exported from here) also loads onto the triggers
      const l2 = list.find((p) => p.trigger === 'L2')
      const r2 = list.find((p) => p.trigger === 'R2')
      if (l2) setEffect('L2', l2.effect)
      if (r2) setEffect('R2', r2.effect)
      setMsg(`Imported ${list.length} preset(s)${l2 || r2 ? ' and applied them to the triggers' : ''}`)
    } catch (e) {
      setMsg(`Import failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <>
      {!info && <div className="warnbox">Connect a controller to feel the effects. You can still design and export presets.</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Send changes live
        </label>
        <button
          onClick={() => {
            void applyTrigger('L2', effects.L2)
            void applyTrigger('R2', effects.R2)
          }}
          disabled={!info}
        >
          Apply now
        </button>
        <button
          onClick={() => {
            setEffect('L2', { type: 'off' })
            setEffect('R2', { type: 'off' })
          }}
        >
          Both off
        </button>
        <button onClick={() => setCalibrating((c) => !c)} title="Measure where the effect zones sit along the trigger's travel">
          Calibrate travel…
        </button>
        <div className="spacer" />
        <button onClick={() => void importPresets()}>Import JSON…</button>
        {!embedded && (
          <button className="primary" onClick={() => void exportPresets()}>
            Export JSON…
          </button>
        )}
      </div>
      {msg && <div className="muted small" style={{ marginBottom: 8 }}>{msg}</div>}
      {calibrating && <CalibrationWizard onClose={() => setCalibrating(false)} />}
      <div className="grid2">
        {(['L2', 'R2'] as Side[]).map((side) => (
          <TriggerEditor
            key={side}
            side={side}
            effect={effects[side]}
            zones={zonesFor(calibration, side)}
            onChange={(e) => setEffect(side, e)}
            onSavePreset={(name) => savePresets([...presets, makePreset(name, side, effects[side])])}
          />
        ))}
      </div>
      <Card title="Preset library">
        <div className="small muted" style={{ marginBottom: 6 }}>Built-in — click L2/R2 to load</div>
        <PresetRow list={BUILTIN_PRESETS} onLoad={(p, side) => setEffect(side, p.effect)} />
        <div className="small muted" style={{ margin: '10px 0 6px' }}>Yours (saved locally; export to share with your game)</div>
        {presets.length === 0 && <div className="muted small">No saved presets yet.</div>}
        <PresetRow list={presets} onLoad={(p, side) => setEffect(side, p.effect)} onDelete={(i) => savePresets(presets.filter((_, j) => j !== i))} />
      </Card>
    </>
  )
}

function PresetRow({ list, onLoad, onDelete }: { list: TriggerPreset[]; onLoad: (p: TriggerPreset, s: Side) => void; onDelete?: (i: number) => void }) {
  return (
    <div className="preset-list">
      {list.map((p, i) => (
        <span key={`${p.name}${i}`} className="row" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '3px 6px', gap: 4 }}>
          <span>{p.name}</span>
          <button className="small" onClick={() => onLoad(p, 'L2')}>L2</button>
          <button className="small" onClick={() => onLoad(p, 'R2')}>R2</button>
          {onDelete && (
            <button className="small danger" onClick={() => onDelete(i)}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

function TriggerEditor({ side, effect, zones, onChange, onSavePreset }: { side: Side; effect: TriggerEffect; zones: number[]; onChange: (e: TriggerEffect) => void; onSavePreset: (name: string) => void }) {
  const [name, setName] = useState('')
  const bytes = encodeTrigger(effect)
  const set = <K extends string>(k: K, v: unknown) => onChange({ ...effect, [k]: v } as TriggerEffect)

  return (
    <Card title={`${side} trigger`}>
      <div className="param">
        <label>Effect</label>
        <select value={effect.type} onChange={(e) => onChange(defaultEffect(e.target.value as TriggerEffectType))}>
          {EFFECT_MENU.map((t) => (
            <option key={t} value={t}>
              {EFFECT_LABELS[t]}
            </option>
          ))}
        </select>
        <span />
      </div>
      <EffectParams effect={effect} zones={zones} set={set} onChange={onChange} />
      <ProfileGraph effect={effect} side={side} zones={zones} onPoints={(points) => set('points', points)} />
      <div className="mono small muted" style={{ marginTop: 6 }}>
        bytes [{bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input type="text" placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={!name.trim()}
          onClick={() => {
            onSavePreset(name.trim())
            setName('')
          }}
        >
          Save preset
        </button>
        <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(bytes))}>Copy bytes</button>
      </div>
    </Card>
  )
}

const isCurve = (e: TriggerEffect): e is Extract<TriggerEffect, { type: 'forceCurve' | 'vibrationCurve' }> =>
  e.type === 'forceCurve' || e.type === 'vibrationCurve'

function EffectParams({ effect: e, zones, set, onChange }: { effect: TriggerEffect; zones: number[]; set: (k: string, v: unknown) => void; onChange: (e: TriggerEffect) => void }) {
  // zone start as a percentage of the trigger reading (calibrated, or the z×10% guess)
  const zone = (v: number) => `${Math.round(zoneToTravel(v, zones) * 100)}%`
  switch (e.type) {
    case 'off':
      return <p className="muted small">Trigger moves freely.</p>
    case 'forceCurve':
      return <p className="muted small">Draw the resistance along the trigger's travel. The blue blocks are what each zone gets (strength 0–8).</p>
    case 'vibrationCurve':
      return (
        <>
          <Param label="Frequency (Hz)" value={e.frequency} min={1} max={255} onChange={(v) => set('frequency', v)} />
          <p className="muted small">Draw the vibration strength along the trigger's travel. One frequency applies to the whole trigger.</p>
        </>
      )
    case 'weapon':
      return (
        <>
          <Param label="Start" value={e.start} min={2} max={7} onChange={(v) => onChange({ ...e, start: v, end: Math.max(e.end, v + 1) })} format={(v) => zone(v + 1)} />
          <Param label="Break point" value={e.end} min={e.start + 1} max={8} onChange={(v) => set('end', v)} format={(v) => zone(v + 1)} />
          <Param label="Strength" value={e.strength} min={1} max={8} onChange={(v) => set('strength', v)} />
        </>
      )
    case 'bow':
      return (
        <>
          <Param label="Start" value={e.start} min={0} max={8} onChange={(v) => onChange({ ...e, start: v, end: Math.max(e.end, v + 1) })} format={zone} />
          <Param label="End" value={e.end} min={e.start + 1} max={8} onChange={(v) => set('end', v)} format={(v) => zone(v + 1)} />
          <Param label="Strength" value={e.strength} min={1} max={8} onChange={(v) => set('strength', v)} />
          <Param label="Snap force" value={e.snapForce} min={1} max={8} onChange={(v) => set('snapForce', v)} />
        </>
      )
    case 'galloping':
      return (
        <>
          <Param label="Start" value={e.start} min={0} max={8} onChange={(v) => onChange({ ...e, start: v, end: Math.max(e.end, v + 1) })} format={zone} />
          <Param label="End" value={e.end} min={e.start + 1} max={9} onChange={(v) => set('end', v)} format={(v) => zone(v + 1)} />
          <Param label="First foot" value={e.firstFoot} min={0} max={6} onChange={(v) => onChange({ ...e, firstFoot: v, secondFoot: Math.max(e.secondFoot, v + 1) })} />
          <Param label="Second foot" value={e.secondFoot} min={e.firstFoot + 1} max={7} onChange={(v) => set('secondFoot', v)} />
          <Param label="Frequency (Hz)" value={e.frequency} min={1} max={255} onChange={(v) => set('frequency', v)} />
        </>
      )
    case 'machine':
      return (
        <>
          <Param label="Start" value={e.start} min={0} max={8} onChange={(v) => onChange({ ...e, start: v, end: Math.max(e.end, v + 1) })} format={zone} />
          <Param label="End" value={e.end} min={e.start + 1} max={9} onChange={(v) => set('end', v)} format={(v) => zone(v + 1)} />
          <Param label="Amplitude A" value={e.amplitudeA} min={0} max={7} onChange={(v) => set('amplitudeA', v)} />
          <Param label="Amplitude B" value={e.amplitudeB} min={0} max={7} onChange={(v) => set('amplitudeB', v)} />
          <Param label="Frequency (Hz)" value={e.frequency} min={1} max={255} onChange={(v) => set('frequency', v)} />
          <Param label="Period (×0.1 s)" value={e.period} min={0} max={100} onChange={(v) => set('period', v)} />
        </>
      )
    case 'raw':
      return (
        <div className="row">
          {e.bytes.map((b, i) => (
            <input
              key={i}
              type="text"
              className="mono"
              style={{ width: 42 }}
              value={b.toString(16).padStart(2, '0')}
              onChange={(ev) => {
                const v = parseInt(ev.target.value, 16)
                const next = [...e.bytes]
                next[i] = Number.isFinite(v) ? v & 0xff : 0
                set('bytes', next)
              }}
            />
          ))}
          <span className="muted small">byte 0 = mode (0x05 off, 0x21 feedback, 0x25 weapon, 0x26 vibration …)</span>
        </div>
      )
    default:
      return null
  }
}

/** Force/vibration vs trigger travel, with the live trigger position overlaid. Curve effects are edited here. */
function ProfileGraph({ effect, side, zones, onPoints }: { effect: TriggerEffect; side: Side; zones: number[]; onPoints?: (p: CurvePoint[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const effRef = useRef(effect)
  effRef.current = effect
  const zonesRef = useRef(zones)
  zonesRef.current = zones
  const editable = !!onPoints && isCurve(effect)
  const H = editable ? 180 : 120
  const [selected, setSelected] = useState<number | null>(null)
  const selRef = useRef(selected)
  selRef.current = selected
  const drag = useRef<number | null>(null)
  const points = isCurve(effect) ? effect.points : []
  // a new effect (or a preset) may have fewer points
  if (selected !== null && selected >= points.length) setSelected(null)

  // canvas geometry shared by drawing and pointer handling
  const PAD = 8
  const geo = () => {
    const W = ref.current?.clientWidth ?? 0
    return {
      W,
      // zone coordinate (0-10) <-> pixel x through the calibration; strength (0-8) <-> pixel y
      px: (z: number) => PAD + (W - 2 * PAD) * zoneToTravel(z, zonesRef.current),
      py: (y: number) => H - PAD - (y / 8) * (H - 2 * PAD),
      zoneAt: (x: number) => travelToZone(Math.min(1, Math.max(0, (x - PAD) / (W - 2 * PAD))), zonesRef.current),
      strengthAt: (y: number) => Math.min(8, Math.max(0, ((H - PAD - y) / (H - 2 * PAD)) * 8)),
    }
  }

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = ref.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      const { W, px, py } = geo()
      if (c.width !== W * dpr || c.height !== H * dpr) {
        c.width = W * dpr
        c.height = H * dpr
      }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const eff = effRef.current
      const { force, vibration } = effectProfile(eff, 200)
      // x is the analog trigger reading; zone coordinates map through the calibration
      const xOf = (t: number) => px(t * 10)
      // zones grid
      g.strokeStyle = '#262a35'
      for (let i = 0; i <= 10; i++) {
        const x = xOf(i / 10)
        g.beginPath()
        g.moveTo(x, PAD)
        g.lineTo(x, H - PAD)
        g.stroke()
      }
      const plot = (arr: number[], color: string, fill: string) => {
        g.beginPath()
        g.moveTo(PAD, H - PAD)
        arr.forEach((v, i) => g.lineTo(xOf(i / (arr.length - 1)), H - PAD - v * (H - 2 * PAD)))
        g.lineTo(W - PAD, H - PAD)
        g.closePath()
        g.fillStyle = fill
        g.fill()
        g.strokeStyle = color
        g.stroke()
      }
      plot(force, '#7aa2ff', 'rgba(77,124,255,0.25)')
      if (vibration.some((v) => v > 0)) {
        // vibration as a zig-zag band whose height is the vibration strength
        g.strokeStyle = '#ffb347'
        g.beginPath()
        vibration.forEach((v, i) => {
          const x = xOf(i / (vibration.length - 1))
          const y = H - PAD - v * (H - 2 * PAD) * (i % 2 ? 1 : 0.6)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        })
        g.stroke()
      }
      // the drawn curve and its points (the blocks/band above are what the trigger gets)
      if (isCurve(eff) && eff.points.length) {
        const pts = eff.points
        g.strokeStyle = 'rgba(255,255,255,0.85)'
        g.lineWidth = 1.5
        g.beginPath()
        g.moveTo(px(0), py(pts[0].y))
        for (const p of pts) g.lineTo(px(p.x), py(p.y))
        g.lineTo(px(10), py(pts[pts.length - 1].y))
        g.stroke()
        pts.forEach((p, i) => {
          const sel = i === selRef.current
          g.beginPath()
          g.arc(px(p.x), py(p.y), sel ? 6 : 4.5, 0, Math.PI * 2)
          g.fillStyle = sel ? '#ffffff' : '#1b1e27'
          g.fill()
          g.strokeStyle = sel ? '#7aa2ff' : '#ffffff'
          g.lineWidth = 2
          g.stroke()
        })
        g.lineWidth = 1
      }
      // live trigger position
      const pos = side === 'L2' ? dualSense.state.l2 : dualSense.state.r2
      if (dualSense.connected) {
        const x = PAD + (W - 2 * PAD) * pos
        g.strokeStyle = '#3ad6a8'
        g.lineWidth = 2
        g.beginPath()
        g.moveTo(x, PAD)
        g.lineTo(x, H - PAD)
        g.stroke()
        g.lineWidth = 1
      }
      g.fillStyle = '#8b91a1'
      g.font = '10px Segoe UI'
      g.fillText('rest', PAD + 2, H - PAD - 2)
      g.fillText('full pull', W - PAD - 42, H - PAD - 2)
    }
    draw()
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, H])

  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const setPoints = (pts: CurvePoint[]) => onPoints?.(pts)

  const onDown = (e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return
    const { x, y } = local(e)
    const { px, py, zoneAt, strengthAt } = geo()
    // grab the nearest point within reach, else add one here
    let hit = -1
    let best = 10
    points.forEach((p, i) => {
      const d = Math.hypot(px(p.x) - x, py(p.y) - y)
      if (d <= best) {
        best = d
        hit = i
      }
    })
    if (hit < 0) {
      const z = zoneAt(x)
      hit = points.findIndex((p) => p.x > z)
      if (hit < 0) hit = points.length
      setPoints([...points.slice(0, hit), { x: z, y: strengthAt(y) }, ...points.slice(hit)])
    }
    setSelected(hit)
    drag.current = hit
    ref.current!.setPointerCapture(e.pointerId)
    ref.current!.focus()
  }

  const onMove = (e: React.PointerEvent) => {
    const i = drag.current
    const eff = effRef.current
    if (i === null || !isCurve(eff)) return
    const { x, y } = local(e)
    const { zoneAt, strengthAt } = geo()
    const pts = eff.points
    // a point can't pass its neighbours
    const lo = i > 0 ? pts[i - 1].x : 0
    const hi = i < pts.length - 1 ? pts[i + 1].x : 10
    const next = [...pts]
    next[i] = { x: Math.min(hi, Math.max(lo, zoneAt(x))), y: strengthAt(y) }
    setPoints(next)
  }

  const deleteSelected = () => {
    if (selected === null) return
    setPoints(points.filter((_, i) => i !== selected))
    setSelected(null)
  }

  const sel = selected !== null ? points[selected] : null
  return (
    <>
      <canvas
        ref={ref}
        className="graph"
        tabIndex={editable ? 0 : undefined}
        style={{ height: H, marginTop: 8, cursor: editable ? 'crosshair' : undefined, touchAction: 'none', outline: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            deleteSelected()
          } else if (e.key === 'Escape') setSelected(null)
        }}
      />
      {editable && (
        <div className="row small" style={{ marginTop: 4, minHeight: 26 }}>
          {sel ? (
            <>
              <span className="mono">
                point at {Math.round(zoneToTravel(sel.x, zones) * 100)}% travel, strength {sel.y.toFixed(1)}
              </span>
              <button className="small danger" onClick={deleteSelected}>
                Delete point
              </button>
            </>
          ) : (
            <span className="muted">Click to add a point · drag a point to move it · click a point, then Delete to remove it</span>
          )}
        </div>
      )}
    </>
  )
}
