// Live input readout, IMU axis setup, model loading/rig mapping, lightbar and test signals.

import { useEffect, useRef, useState } from 'react'
import { dualSense } from '../device/hid'
import { BUTTON_NAMES } from '../device/inputReport'
import { hapticEngine } from '../haptics/engine'
import { impactGrain } from '../haptics/dsp'
import { lightbar, loadLocal, recenter, saveLocal, tracker, useConnection, useTicker } from '../store'
import { DEFAULT_AXIS_MAP, type AxisSel } from '../orientation/tracker'
import { Card, Param } from '../ui/controls'
import type { LoadedModel } from '../viewer/ControllerView'
import { autoMap, defaultRig, knownRigFor, pickState, PIVOT_MODES, RIG_CONTROLS, type PivotMode, type RigControl, type RigEntry, type RigMap } from '../viewer/rig'

interface Props {
  model: LoadedModel
  rig: RigMap
  setRig: (r: RigMap) => void
  onLoadModel: () => void
  onPlaceholder: () => void
  modelError: string | null
}

export function ControllerPanel(props: Props) {
  return (
    <>
      <div className="grid2">
        <LiveInputs />
        <div>
          <ImuCard />
          <OutputsCard />
        </div>
      </div>
      <ModelCard {...props} />
    </>
  )
}

function LiveInputs() {
  useTicker(30)
  const info = useConnection()
  const s = dualSense.state
  const f = (v: number, d = 2) => (v >= 0 ? ' ' : '') + v.toFixed(d)
  return (
    <Card title="Live input">
      {!info && <div className="warnbox">Connect a DualSense (USB recommended) to see live input.</div>}
      <div className="btn-grid" style={{ marginBottom: 10 }}>
        {BUTTON_NAMES.filter((b) => info?.edge || !/^(fn|paddle)/.test(b)).map((b) => (
          <div key={b} className={`btn-ind ${s.buttons[b] ? 'on' : ''}`}>
            {b}
          </div>
        ))}
      </div>
      <div className="grid2">
        <div className="mono small">
          <div>LS {f(s.leftStick.x)} {f(s.leftStick.y)}</div>
          <div>RS {f(s.rightStick.x)} {f(s.rightStick.y)}</div>
          <div>gyro °/s {s.gyro.map((v) => f(v, 0).padStart(5)).join(' ')}</div>
          <div>accel g {s.accel.map((v) => f(v, 2)).join(' ')}</div>
          <div>
            touch {s.touch.map((t, i) => (t.active ? `#${i}(${t.x},${t.y})` : `#${i} -`)).join('  ')}
          </div>
          {info && <div>report {dualSense.reportRate} Hz {s.full ? '' : '(simple BT mode)'}</div>}
        </div>
        <div>
          <div className="small muted">L2</div>
          <div className="bar" style={{ marginBottom: 6 }}>
            <div style={{ width: `${s.l2 * 100}%` }} />
          </div>
          <div className="small muted">R2</div>
          <div className="bar">
            <div style={{ width: `${s.r2 * 100}%` }} />
          </div>
        </div>
      </div>
    </Card>
  )
}

function AxisPicker({ label, sel, onChange }: { label: string; sel: AxisSel; onChange: (s: AxisSel) => void }) {
  return (
    <span className="row small">
      <span className="muted" style={{ width: 14 }}>{label}</span>
      <select value={`${sel.sign}${sel.axis}`} onChange={(e) => onChange({ sign: e.target.value[0] === '-' ? -1 : 1, axis: Number(e.target.value.slice(1)) as 0 | 1 | 2 })}>
        {['10', '11', '12', '-10', '-11', '-12'].map((v) => (
          <option key={v} value={v}>
            {v.startsWith('-') ? '−' : '+'}
            {'xyz'[Number(v.slice(-1))]}
          </option>
        ))}
      </select>
    </span>
  )
}

function ImuCard() {
  const [, force] = useState(0)
  const m = tracker.axisMap
  const set = (kind: 'gyro' | 'accel', i: number, s: AxisSel) => {
    m[kind][i] = s
    saveLocal('dshd.axisMap', m)
    force((x) => x + 1)
  }
  return (
    <Card
      title="Motion (IMU)"
      right={
        <>
          <button onClick={() => recenter('Recenter')}>Recenter</button>
          <button onClick={() => tracker.reset()}>Reset</button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        Orientation is fused from gyro + accelerometer (Madgwick). Yaw slowly drifts — press <b>Recenter</b> (or Options, Create, L3 or R3 on the controller) while pointing the controller at the screen. If the
        model tilts the wrong way, flip the axis mapping below.
      </p>
      <div className="row">
        <span className="muted small" style={{ width: 44 }}>gyro</span>
        {[0, 1, 2].map((i) => (
          <AxisPicker key={i} label={'xyz'[i]} sel={m.gyro[i]} onChange={(s) => set('gyro', i, s)} />
        ))}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <span className="muted small" style={{ width: 44 }}>accel</span>
        {[0, 1, 2].map((i) => (
          <AxisPicker key={i} label={'xyz'[i]} sel={m.accel[i]} onChange={(s) => set('accel', i, s)} />
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Param label="Filter gain (β)" value={tracker.filter.beta} min={0.005} max={0.3} step={0.005} onChange={(v) => { tracker.filter.beta = v; force((x) => x + 1) }} format={(v) => v.toFixed(3)} />
        <button
          onClick={() => {
            tracker.axisMap = structuredClone(DEFAULT_AXIS_MAP)
            saveLocal('dshd.axisMap', tracker.axisMap)
            force((x) => x + 1)
          }}
        >
          Default axes
        </button>
      </div>
    </Card>
  )
}

/** Delay Vibration: one beat per count; the test plays on the count of 3 */
const COUNT_BEAT_MS = 800

function OutputsCard() {
  const [color, setColor] = useState(() => `#${lightbar.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`)
  const [leds, setLeds] = useState(0b00100)
  const info = useConnection()

  // Delay Vibration: count "blip, blip, BLEEP" on a light and play the test on the third,
  // so there's time to pick up the controller after clicking
  const [delay, setDelay] = useState(() => loadLocal('dshd.testDelay', false))
  const [light, setLight] = useState<'off' | 'blip' | 'go'>('off')
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
  const run = (test: () => void) => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
    if (!delay) return test()
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms))
    at(0, () => setLight('blip'))
    at(150, () => setLight('off'))
    at(COUNT_BEAT_MS, () => setLight('blip'))
    at(COUNT_BEAT_MS + 150, () => setLight('off'))
    at(2 * COUNT_BEAT_MS, () => {
      setLight('go')
      test()
    })
    at(2 * COUNT_BEAT_MS + 700, () => setLight('off'))
  }

  const applyColor = (hex: string) => {
    setColor(hex)
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
    lightbar.rgb = rgb
    void dualSense.update({ lightbar: rgb })
  }

  const testSide = (pan: number) => hapticEngine.grain(impactGrain('wood', 0.9, pan))
  const sweep = () => {
    for (let i = 0; i <= 12; i++) {
      const g = impactGrain('glass', 0.7, -1 + (i / 12) * 2)
      g.delay = i * 0.06
      hapticEngine.grain(g)
    }
  }
  const tone = (freq: number) => hapticEngine.grain({ freq, duration: 0.6, attack: 0.02, decay: 10, amp: 0.7, pan: 0 })

  return (
    <Card title="Outputs & tests">
      <div className="row">
        <span className="muted">Lightbar</span>
        <input type="color" value={color} onChange={(e) => applyColor(e.target.value)} disabled={!info} />
        <span className="muted" style={{ marginLeft: 12 }}>Player LEDs</span>
        {[0, 1, 2, 3, 4].map((i) => (
          <input
            key={i}
            type="checkbox"
            checked={!!(leds & (1 << i))}
            disabled={!info}
            onChange={() => {
              const v = leds ^ (1 << i)
              setLeds(v)
              void dualSense.update({ playerLeds: v })
            }}
          />
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <span className="muted">Haptics test</span>
        <label className="row" title="Count down on the light (blip, blip, BLEEP) and vibrate on the third, so you have time to pick up the controller">
          <input
            type="checkbox"
            checked={delay}
            onChange={(e) => {
              setDelay(e.target.checked)
              saveLocal('dshd.testDelay', e.target.checked)
            }}
          />
          Delay Vibration
        </label>
        <span className={`countdown ${light === 'off' ? '' : light}`} />
        <button onClick={() => run(() => testSide(-1))}>Left tap</button>
        <button onClick={() => run(() => testSide(1))}>Right tap</button>
        <button onClick={() => run(sweep)}>Sweep L→R</button>
        <button onClick={() => run(() => tone(60))}>60 Hz</button>
        <button onClick={() => run(() => tone(160))}>160 Hz</button>
        <button onClick={() => run(() => tone(320))}>320 Hz</button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <span className="muted">Legacy rumble</span>
        <button disabled={!info} onClick={() => run(() => { void dualSense.send({ rumbleLeft: 200, rumbleRight: 0 }); setTimeout(() => void dualSense.send({ rumbleLeft: 0, rumbleRight: 0 }), 300) })}>Heavy</button>
        <button disabled={!info} onClick={() => run(() => { void dualSense.send({ rumbleLeft: 0, rumbleRight: 200 }); setTimeout(() => void dualSense.send({ rumbleLeft: 0, rumbleRight: 0 }), 300) })}>Light</button>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Haptic tests go through the audio engine (USB: channels 3/4 of the controller's audio device). If you feel nothing over USB, choose the 🎮 DualSense device
        in the output menu at the top.
      </p>
    </Card>
  )
}

function ModelCard({ model, rig, setRig, onLoadModel, onPlaceholder, modelError }: Props) {
  useTicker(10)
  // picking callbacks fire later, so read the latest rig through a ref
  const rigRef = useRef(rig)
  rigRef.current = rig
  const s = dualSense.state
  const setEntry = (c: RigControl, patch: Partial<RigEntry>) => {
    const cur = rigRef.current
    setRig({ ...cur, entries: { ...cur.entries, [c]: { ...cur.entries[c], ...patch } } })
  }
  const active = (c: RigControl) =>
    c === 'l2' ? s.l2 > 0.05 : c === 'r2' ? s.r2 > 0.05 : c === 'leftStick' ? Math.hypot(s.leftStick.x, s.leftStick.y) > 0.2 : c === 'rightStick' ? Math.hypot(s.rightStick.x, s.rightStick.y) > 0.2 : c === 'lightbar' ? false : s.buttons[c]

  return (
    <Card
      title="3D model & rig mapping"
      right={
        <>
          <button className="primary" onClick={onLoadModel}>Load model…</button>
          <button onClick={onPlaceholder}>Use placeholder</button>
          {knownRigFor(model.nodeNames) ? (
            <button onClick={() => setRig(knownRigFor(model.nodeNames)!.rig(model.root))} title={knownRigFor(model.nodeNames)!.name}>
              Reset to model preset
            </button>
          ) : (
            <button onClick={() => setRig(autoMap({ ...defaultRig(), modelRotation: rig.modelRotation }, model.nodeNames))}>Auto-map</button>
          )}
        </>
      }
    >
      {modelError && <div className="errbox">{modelError}</div>}
      <p className="muted small" style={{ marginTop: 0 }}>
        Recommended format: <b>.glb</b>. Each button, stick and trigger must be its own named node with its origin at the hinge/pivot. Put the file at{' '}
        <span className="mono">assets/models/dualsense.glb</span> to load it automatically. Model is {model.isPlaceholder ? 'the built-in placeholder' : 'loaded'} ·{' '}
        {model.nodeNames.length} nodes. <b>Pick</b> a control, then click its part on the 3D model (drag still orbits); <kbd>Shift</kbd>+click adds/removes extra parts that move with it (e.g. a button's glyph). Merged meshes are split into pieces named <span className="mono">mesh#n</span>. Hovering a row outlines its part; rows light up while the control is held, so you can verify each mapping. Motions use controller axes: x = right, y = up out of the face, z = toward you.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">Model rotation fix (°)</span>
        {[0, 1, 2].map((i) => (
          <input
            key={i}
            type="number"
            step={90}
            value={rig.modelRotation[i]}
            onChange={(e) => {
              const r = [...rig.modelRotation] as [number, number, number]
              r[i] = Number(e.target.value)
              setRig({ ...rig, modelRotation: r })
            }}
          />
        ))}
        <span className="muted small">X / Y / Z — the face should point up, triggers away from you</span>
      </div>
      <table className="rig">
        <thead>
          <tr>
            <th>Control</th>
            <th>Node</th>
            <th>Motion</th>
            <th>Axis</th>
            <th>Amount</th>
            <th>Pivot</th>
            <th>Invert</th>
          </tr>
        </thead>
        <tbody>
          {RIG_CONTROLS.map((c) => {
            const e = rig.entries[c]
            return (
              <tr
                key={c}
                className={active(c) || pickState.control === c ? 'hit' : ''}
                onMouseEnter={() => (pickState.highlight = e.node)}
                onMouseLeave={() => (pickState.highlight = null)}
              >
                <td>{c}</td>
                <td className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  <button
                    className={pickState.control === c ? 'active small' : 'small'}
                    title="Then click the part on the 3D model"
                    onClick={() => (pickState.control === c ? pickState.cancel() : pickState.start(c, (ctrl, node, add) => {
                            const cur = rigRef.current.entries[ctrl]
                            if (add && cur.node) {
                              const extra = cur.extra ?? []
                              setEntry(ctrl, { extra: extra.includes(node) ? extra.filter((x) => x !== node) : [...extra, node] })
                            } else setEntry(ctrl, { node, extra: [] })
                          }))}
                  >
                    {pickState.control === c ? 'Click part…' : 'Pick'}
                  </button>
                  {!!e.extra?.length && (
                    <span className="muted small" title={e.extra.join(', ')} onMouseEnter={() => (pickState.highlight = e.extra![0])}>
                      +{e.extra.length}
                    </span>
                  )}
                  <select value={e.node ?? ''} onChange={(ev) => setEntry(c, { node: ev.target.value || null })}>
                    <option value="">— none —</option>
                    {model.nodeNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select value={e.motion} onChange={(ev) => setEntry(c, { motion: ev.target.value as RigEntry['motion'] })}>
                    <option value="press">press</option>
                    <option value="hinge">hinge</option>
                    <option value="tilt">tilt</option>
                    <option value="color">color</option>
                  </select>
                </td>
                <td>
                  <select value={e.axis} onChange={(ev) => setEntry(c, { axis: ev.target.value as RigEntry['axis'] })}>
                    <option>x</option>
                    <option>y</option>
                    <option>z</option>
                  </select>
                </td>
                <td>
                  <input type="number" step={e.motion === 'press' ? 0.02 : 1} value={e.amount} onChange={(ev) => setEntry(c, { amount: Number(ev.target.value) })} />
                </td>
                <td>
                  <select value={e.pivot ?? 'auto'} disabled={e.motion !== 'hinge' && e.motion !== 'tilt'} onChange={(ev) => setEntry(c, { pivot: ev.target.value as PivotMode })}>
                    {PIVOT_MODES.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input type="checkbox" checked={!!e.invert} onChange={(ev) => setEntry(c, { invert: ev.target.checked })} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
