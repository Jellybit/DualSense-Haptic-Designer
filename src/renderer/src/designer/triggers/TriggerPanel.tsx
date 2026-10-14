// Adaptive trigger designer: per-trigger effect editor with live preview graph,
// live send to the controller, and a JSON preset library.

import { platform } from '../../platform'
import { useEffect, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import {
  defaultEffect,
  effectProfile,
  EFFECT_LABELS,
  encodeTrigger,
  type TriggerEffect,
  type TriggerEffectType,
} from '../../device/triggerEffects'
import { BUILTIN_PRESETS, makePreset, parsePresets, serializePresets, type TriggerPreset } from '../../export/presets'
import { loadLocal, saveLocal, useConnection } from '../../store'
import { Card, downloadName, Param } from '../../ui/controls'
import { DEFAULT_ZONES, zoneToTravel } from '../../device/triggerCalibration'
import { CalibrationWizard, useTriggerCalibration } from './CalibrationWizard'

type Side = 'L2' | 'R2'

export const triggerState: Record<Side, TriggerEffect> = {
  L2: loadLocal<TriggerEffect>('dshd.trig.L2', { type: 'off' }),
  R2: loadLocal<TriggerEffect>('dshd.trig.R2', { type: 'off' }),
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
  const zones = useTriggerCalibration()?.zones ?? DEFAULT_ZONES

  const setEffect = (side: Side, e: TriggerEffect) => {
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
            zones={zones}
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
          {(Object.keys(EFFECT_LABELS) as TriggerEffectType[]).map((t) => (
            <option key={t} value={t}>
              {EFFECT_LABELS[t]}
            </option>
          ))}
        </select>
        <span />
      </div>
      <EffectParams effect={effect} zones={zones} set={set} onChange={onChange} />
      <ProfileGraph effect={effect} side={side} zones={zones} />
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

function EffectParams({ effect: e, zones, set, onChange }: { effect: TriggerEffect; zones: number[]; set: (k: string, v: unknown) => void; onChange: (e: TriggerEffect) => void }) {
  // zone start as a percentage of the trigger reading (calibrated, or the z×10% guess)
  const zone = (v: number) => `${Math.round(zoneToTravel(v, zones) * 100)}%`
  switch (e.type) {
    case 'off':
      return <p className="muted small">Trigger moves freely.</p>
    case 'feedback':
      return (
        <>
          <Param label="Start position" value={e.position} min={0} max={9} onChange={(v) => set('position', v)} format={zone} />
          <Param label="Strength" value={e.strength} min={1} max={8} onChange={(v) => set('strength', v)} />
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
    case 'vibration':
      return (
        <>
          <Param label="Start position" value={e.position} min={0} max={9} onChange={(v) => set('position', v)} format={zone} />
          <Param label="Amplitude" value={e.amplitude} min={1} max={8} onChange={(v) => set('amplitude', v)} />
          <Param label="Frequency (Hz)" value={e.frequency} min={1} max={255} onChange={(v) => set('frequency', v)} />
        </>
      )
    case 'slope':
      return (
        <>
          <Param label="Start" value={e.start} min={0} max={8} onChange={(v) => onChange({ ...e, start: v, end: Math.max(e.end, v + 1) })} format={zone} />
          <Param label="End" value={e.end} min={e.start + 1} max={9} onChange={(v) => set('end', v)} format={zone} />
          <Param label="Start strength" value={e.startStrength} min={1} max={8} onChange={(v) => set('startStrength', v)} />
          <Param label="End strength" value={e.endStrength} min={1} max={8} onChange={(v) => set('endStrength', v)} />
        </>
      )
    case 'multiFeedback':
      return <ZoneEditor values={e.strengths} zones={zones} onChange={(v) => set('strengths', v)} label="force" />
    case 'multiVibration':
      return (
        <>
          <Param label="Frequency (Hz)" value={e.frequency} min={1} max={255} onChange={(v) => set('frequency', v)} />
          <ZoneEditor values={e.amplitudes} zones={zones} onChange={(v) => set('amplitudes', v)} label="amp" />
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
          <Param label="End" value={e.end} min={e.start + 1} max={9} onChange={(v) => set('end', v)} format={zone} />
          <Param label="First foot" value={e.firstFoot} min={0} max={6} onChange={(v) => onChange({ ...e, firstFoot: v, secondFoot: Math.max(e.secondFoot, v + 1) })} />
          <Param label="Second foot" value={e.secondFoot} min={e.firstFoot + 1} max={7} onChange={(v) => set('secondFoot', v)} />
          <Param label="Frequency (Hz)" value={e.frequency} min={1} max={255} onChange={(v) => set('frequency', v)} />
        </>
      )
    case 'machine':
      return (
        <>
          <Param label="Start" value={e.start} min={0} max={8} onChange={(v) => onChange({ ...e, start: v, end: Math.max(e.end, v + 1) })} format={zone} />
          <Param label="End" value={e.end} min={e.start + 1} max={9} onChange={(v) => set('end', v)} format={zone} />
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
  }
}

function ZoneEditor({ values, zones, onChange, label }: { values: number[]; zones: number[]; onChange: (v: number[]) => void; label: string }) {
  return (
    <div className="zones" style={{ margin: '8px 0' }}>
      {values.map((v, i) => (
        <div className="z" key={i}>
          <input
            type="range"
            min={0}
            max={8}
            value={v}
            style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 80 }}
            onChange={(e) => {
              const next = [...values]
              next[i] = Number(e.target.value)
              onChange(next)
            }}
          />
          <span>{v}</span>
          <span>{Math.round(zones[i] * 100)}%</span>
        </div>
      ))}
      <div className="small muted" style={{ gridColumn: '1 / -1' }}>
        {label} per zone (0 = none)
      </div>
    </div>
  )
}

/** Force/vibration vs trigger travel, with the live trigger position overlaid. */
function ProfileGraph({ effect, side, zones }: { effect: TriggerEffect; side: Side; zones: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const effRef = useRef(effect)
  effRef.current = effect
  const zonesRef = useRef(zones)
  zonesRef.current = zones

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = ref.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      const W = c.clientWidth
      const H = 120
      if (c.width !== W * dpr) {
        c.width = W * dpr
        c.height = H * dpr
      }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const pad = 6
      const { force, vibration } = effectProfile(effRef.current, 200)
      // x is the analog trigger reading; zone coordinates map through the calibration
      const xOf = (t: number) => pad + (W - 2 * pad) * zoneToTravel(t * 10, zonesRef.current)
      // zones grid
      g.strokeStyle = '#262a35'
      for (let i = 0; i <= 10; i++) {
        const x = xOf(i / 10)
        g.beginPath()
        g.moveTo(x, pad)
        g.lineTo(x, H - pad)
        g.stroke()
      }
      const plot = (arr: number[], color: string, fill: string) => {
        g.beginPath()
        g.moveTo(pad, H - pad)
        arr.forEach((v, i) => g.lineTo(xOf(i / (arr.length - 1)), H - pad - v * (H - 2 * pad)))
        g.lineTo(W - pad, H - pad)
        g.closePath()
        g.fillStyle = fill
        g.fill()
        g.strokeStyle = color
        g.stroke()
      }
      plot(force, '#7aa2ff', 'rgba(77,124,255,0.25)')
      if (vibration.some((v) => v > 0)) {
        // draw vibration as a zig-zag band
        g.strokeStyle = '#ffb347'
        g.beginPath()
        vibration.forEach((v, i) => {
          const x = xOf(i / (vibration.length - 1))
          const y = H - pad - v * (H - 2 * pad) * (i % 2 ? 1 : 0.6)
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        })
        g.stroke()
      }
      // live trigger position
      const pos = side === 'L2' ? dualSense.state.l2 : dualSense.state.r2
      if (dualSense.connected) {
        const x = pad + (W - 2 * pad) * pos
        g.strokeStyle = '#3ad6a8'
        g.lineWidth = 2
        g.beginPath()
        g.moveTo(x, pad)
        g.lineTo(x, H - pad)
        g.stroke()
        g.lineWidth = 1
      }
      g.fillStyle = '#8b91a1'
      g.font = '10px Segoe UI'
      g.fillText('rest', pad + 2, H - pad - 2)
      g.fillText('full pull', W - pad - 42, H - pad - 2)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [side])

  return <canvas ref={ref} className="graph" style={{ height: 120, marginTop: 8 }} />
}
