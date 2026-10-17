// Adaptive trigger designer: per-trigger effect editor with live preview graph,
// live send to the controller, and a JSON preset library.

import { platform } from '../../platform'
import { useEffect, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import {
  defaultEffect,
  effectProfile,
  EFFECT_GROUPS,
  EFFECT_LABELS,
  effectGroup,
  encodeTrigger,
  curveFrequency,
  toCurveEffect,
  zoneFrequencies,
  type CurvePoint,
  type TriggerEffect,
  type TriggerEffectType,
} from '../../device/triggerEffects'
import { makePreset, parsePresets, serializePresets } from '../../export/presets'
import { loadLocal, saveLocal, useConnection } from '../../store'
import { Card, downloadName, Param } from '../../ui/controls'
import { getCalibration, travelToZone, zonesFor, zoneToTravel } from '../../device/triggerCalibration'
import { CalibrationWizard, useTriggerCalibration } from './CalibrationWizard'
import { confirmReset, onReset, RESET_LABELS, resetSection } from '../../resets'

export type Side = 'L2' | 'R2'

export const triggerState: Record<Side, TriggerEffect> = {
  L2: toCurveEffect(loadLocal<TriggerEffect>('dshd.trig.L2', { type: 'off' })),
  R2: toCurveEffect(loadLocal<TriggerEffect>('dshd.trig.R2', { type: 'off' })),
}

/** The zone (0-9) the trigger is in now, through the calibration. */
function currentZone(side: Side): number {
  const analog = side === 'L2' ? dualSense.state.l2 : dualSense.state.r2
  return Math.min(9, Math.floor(travelToZone(analog, zonesFor(getCalibration(), side))))
}

// Reset Trigger Settings: both triggers off, even when this panel isn't on screen
onReset((s) => {
  if (s !== 'trigger') return
  triggerState.L2 = { type: 'off' }
  triggerState.R2 = { type: 'off' }
  void applyTrigger('L2', triggerState.L2)
  void applyTrigger('R2', triggerState.R2)
})

/** Both triggers off on the controller (the saved effects are kept). */
export function releaseTriggers() {
  const off = encodeTrigger({ type: 'off' })
  return dualSense.setTriggers(off, off)
}

export function applyTrigger(side: Side, e: TriggerEffect) {
  const bytes = encodeTrigger(e, currentZone(side))
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
  useEffect(
    () =>
      onReset((s) => {
        if (s !== 'trigger') return
        setEffects({ ...triggerState })
        setLive(true)
        setMsg(null)
      }),
    [],
  )
  const [msg, setMsg] = useState<string | null>(null)
  const [calibrating, setCalibrating] = useState(() => location.hash === '#calibrate')
  const calibration = useTriggerCalibration()

  const setEffect = (side: Side, effect: TriggerEffect) => {
    // imports may hold the older slider-style effects
    const e = toCurveEffect(effect)
    triggerState[side] = e
    saveLocal(`dshd.trig.${side}`, e)
    setEffects({ ...triggerState })
  }

  // The trigger effects only apply while this tab is open: release them when it closes
  // (after any child cleanup, e.g. the calibration wizard restoring the effects)
  useEffect(() => () => void window.setTimeout(() => void releaseTriggers(), 0), [])

  // Live-send whenever an effect changes
  useEffect(() => {
    if (!live || !info) return
    void applyTrigger('L2', effects.L2)
    void applyTrigger('R2', effects.R2)
  }, [effects, live, info])

  // Vibration curves have a frequency per zone but the controller takes one per effect, so
  // re-send when the trigger moves into a zone with a different frequency (not while the
  // calibration wizard owns the triggers)
  useEffect(() => {
    if (!live || !info || calibrating) return
    const sent: Record<Side, number> = { L2: -1, R2: -1 }
    return dualSense.onInput(() => {
      for (const side of ['L2', 'R2'] as Side[]) {
        const e = triggerState[side]
        if (e.type !== 'vibrationCurve') continue
        const freq = zoneFrequencies(e)[currentZone(side)]
        if (freq !== sent[side]) {
          sent[side] = freq
          void applyTrigger(side, e)
        }
      }
    }) as unknown as () => void
  }, [live, info, calibrating])

  const exportJson = async () => {
    const path = await exportTriggerJson('triggers')
    if (path) setMsg(`Exported L2 and R2 to ${path}`)
  }

  /** Load a trigger JSON file's L2/R2 effects onto the triggers (an entry for both applies to both). */
  const importJson = async () => {
    const f = await platform.openFile([{ name: 'JSON', extensions: ['json'] }])
    if (!f) return
    try {
      const list = parsePresets(new TextDecoder().decode(f.data))
      const l2 = list.find((p) => p.trigger === 'L2') ?? list.find((p) => p.trigger === 'both')
      const r2 = list.find((p) => p.trigger === 'R2') ?? list.find((p) => p.trigger === 'both')
      if (l2) setEffect('L2', l2.effect)
      if (r2) setEffect('R2', r2.effect)
      setMsg(l2 || r2 ? `Loaded ${[l2 && 'L2', r2 && 'R2'].filter(Boolean).join(' and ')} from ${f.name}` : `No trigger effects found in ${f.name}`)
    } catch (e) {
      setMsg(`Import failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <>
      {!info && <div className="warnbox">Connect a controller to feel the effects. You can still design and export trigger effects.</div>}
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
        <button title="Both triggers back to Off" onClick={() => confirmReset(RESET_LABELS.trigger) && void resetSection('trigger')}>
          {RESET_LABELS.trigger}
        </button>
        <button onClick={() => setCalibrating((c) => !c)} title="Measure where the effect zones sit along the trigger's travel">
          Calibrate travel…
        </button>
        <div className="spacer" />
        <button onClick={() => void importJson()}>Import JSON…</button>
        {!embedded && (
          <button className="primary" onClick={() => void exportJson()}>
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
          />
        ))}
      </div>
    </>
  )
}

function TriggerEditor({ side, effect, zones, onChange }: { side: Side; effect: TriggerEffect; zones: number[]; onChange: (e: TriggerEffect) => void }) {
  const bytes = encodeTrigger(effect)
  const set = <K extends string>(k: K, v: unknown) => onChange({ ...effect, [k]: v } as TriggerEffect)
  const group = EFFECT_GROUPS.find((g) => g.id === effectGroup(effect.type))!

  return (
    <Card title={`${side} trigger`}>
      <div className="row" style={{ marginBottom: 6 }}>
        <select
          value={group.id}
          title="Effect"
          onChange={(e) => onChange(defaultEffect(EFFECT_GROUPS.find((g) => g.id === e.target.value)!.types[0]))}
        >
          {EFFECT_GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
        {group.types.length > 1 && (
          <select value={effect.type} title="Type" onChange={(e) => onChange(defaultEffect(e.target.value as TriggerEffectType))}>
            {group.types.map((t) => (
              <option key={t} value={t}>
                {EFFECT_LABELS[t]}
              </option>
            ))}
          </select>
        )}
      </div>
      <EffectParams effect={effect} zones={zones} set={set} onChange={onChange} />
      <ProfileGraph effect={effect} side={side} zones={zones} onPoints={(points) => set('points', points)} />
      <div className="mono small muted" style={{ marginTop: 6 }}>
        bytes [{bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]
      </div>
      <div className="row" style={{ marginTop: 8 }}>
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
        <p className="muted small">
          Draw the vibration strength along the trigger's travel. Frequency is set per point: select a point to change it. It
          blends between points and changes zone by zone as you press.
        </p>
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

/**
 * Draw a trigger's force/vibration profile against its travel, with the live trigger position.
 * `mini`: the simplified copy above the 3D view (no text, no point handles).
 */
export function drawTriggerProfile(c: HTMLCanvasElement, H: number, eff: TriggerEffect, side: Side, zones: number[], opts: { mini?: boolean; selected?: number | null } = {}) {
  const mini = !!opts.mini
  const PAD = mini ? 3 : 8
  const dpr = window.devicePixelRatio || 1
  const W = c.clientWidth
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
  }
  // zone coordinate (0-10) -> pixel x through the calibration; strength (0-8) -> pixel y
  const px = (z: number) => PAD + (W - 2 * PAD) * zoneToTravel(z, zones)
  const py = (y: number) => H - PAD - (y / 8) * (H - 2 * PAD)
  const g = c.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, W, H)
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
  // vibration curves: each zone's frequency along the top
  if (!mini && eff.type === 'vibrationCurve') {
    const freqs = zoneFrequencies(eff)
    g.fillStyle = '#c9a25f'
    g.font = '10px Segoe UI'
    g.textAlign = 'center'
    freqs.forEach((fz, z) => {
      if (px(z + 1) - px(z) >= 16) g.fillText(String(fz), (px(z) + px(z + 1)) / 2, PAD + 9)
    })
    g.textAlign = 'start'
  }
  // the drawn curve and its points (the blocks/band above are what the trigger gets)
  if (isCurve(eff) && eff.points.length) {
    const pts = eff.points
    g.strokeStyle = 'rgba(255,255,255,0.85)'
    g.lineWidth = mini ? 1 : 1.5
    g.beginPath()
    g.moveTo(px(0), py(pts[0].y))
    for (const p of pts) g.lineTo(px(p.x), py(p.y))
    g.lineTo(px(10), py(pts[pts.length - 1].y))
    g.stroke()
    if (!mini)
      pts.forEach((p, i) => {
        const sel = i === opts.selected
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
  if (!mini) {
    g.fillStyle = '#8b91a1'
    g.font = '10px Segoe UI'
    g.fillText('rest', PAD + 2, H - PAD - 2)
    g.fillText('full pull', W - PAD - 42, H - PAD - 2)
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
      if (ref.current) drawTriggerProfile(ref.current, H, effRef.current, side, zonesRef.current, { selected: selRef.current })
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
      const eff = effRef.current
      const pt: CurvePoint = { x: z, y: strengthAt(y) }
      if (eff.type === 'vibrationCurve') pt.f = Math.round(curveFrequency(eff.points, z, eff.frequency))
      setPoints([...points.slice(0, hit), pt, ...points.slice(hit)])
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
    next[i] = { ...pts[i], x: Math.min(hi, Math.max(lo, zoneAt(x))), y: strengthAt(y) }
    setPoints(next)
  }

  const deleteSelected = () => {
    if (selected === null) return
    setPoints(points.filter((_, i) => i !== selected))
    setSelected(null)
  }

  const sel = selected !== null ? points[selected] : null
  const vib = effect.type === 'vibrationCurve' ? effect : null
  const setSelectedFrequency = (hz: number) => {
    if (selected === null) return
    setPoints(points.map((p, i) => (i === selected ? { ...p, f: hz } : p)))
  }
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
              <div className="spacer" />
              <button className="small danger" onClick={deleteSelected}>
                Delete point
              </button>
              {vib && (
                <div style={{ flexBasis: '100%' }}>
                  <Param label="Frequency (Hz)" value={sel.f ?? vib.frequency} min={1} max={255} onChange={setSelectedFrequency} />
                </div>
              )}
            </>
          ) : (
            <span className="muted">Click to add a point · drag a point to move it · click a point, then Delete to remove it</span>
          )}
        </div>
      )}
    </>
  )
}
