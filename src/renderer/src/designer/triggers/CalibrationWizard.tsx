// Trigger travel calibration: the wall test. A strong Feedback effect starting at one
// zone is a wall on both triggers. The user eases a trigger in until touching the wall and
// holds; a steady reading is recorded. After 3 holds the wall moves to another zone (on
// the next full release). Zones 1-9 run in shuffled rounds until stopped, then a straight
// line through all holds gives the zone table.

import { useEffect, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import { encodeTrigger } from '../../device/triggerEffects'
import {
  DEFAULT_ZONES,
  fitLine,
  getCalibration,
  onCalibration,
  setCalibration,
  zonesFromFit,
  type LineFit,
  type WallHold,
} from '../../device/triggerCalibration'
import { loadLocal, saveLocal, useConnection, useTicker } from '../../store'
import { Card } from '../../ui/controls'
import { applyTrigger, triggerState } from './TriggerPanel'

type Side = 'L2' | 'R2'
const STRENGTH = 8
const HOLDS_PER_WALL = 3
const HOLDS_KEY = 'dshd.wallHolds' // kept between sessions so a long test can be resumed
// The zone 1 wall sits only ~5/255 in, so pressed/released are a couple of steps of the
// 0-255 reading (the trigger reads 0 at rest)
const PRESSED = 2.5 / 255 // above this the trigger counts as pressed
const RELEASED = 1.5 / 255
const CLIPPED = 0.99 // readings this high have hit the end of the sensor's range
const STEADY_MS = 700 // reading must stay within STEADY_RANGE for this long
const STEADY_RANGE = 0.012 // ~3 steps of the 0-255 reading

const restoreEffects = () => {
  void applyTrigger('L2', triggerState.L2)
  void applyTrigger('R2', triggerState.R2)
}
const setWall = (zone: number) => {
  const b = encodeTrigger({ type: 'feedback', position: zone, strength: STRENGTH })
  return dualSense.setTriggers(b, b)
}
const shuffled = () => {
  const z = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  for (let i = z.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[z[i], z[j]] = [z[j], z[i]]
  }
  return z
}
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–')
const byte = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 255)) : '–')
const median = (v: number[]) => {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function useTriggerCalibration() {
  const [cal, setCal] = useState(getCalibration)
  useEffect(() => onCalibration(() => setCal(getCalibration())) as unknown as () => void, [])
  return cal
}

interface Run {
  queue: number[]
  zone: number
  count: number // holds recorded at this wall
  phase: 'ready' | 'recorded' // ready: waiting for a steady touch; recorded: waiting for release
  window: { t: number; a: number; side: Side }[]
}

export function CalibrationWizard({ onClose }: { onClose: () => void }) {
  useTicker(20)
  const info = useConnection()
  const saved = useTriggerCalibration()
  const [running, setRunning] = useState(false)
  const [holds, setHolds] = useState<WallHold[]>(() => loadLocal<WallHold[]>(HOLDS_KEY, saved?.holds ?? []))
  const [msg, setMsg] = useState('')
  const run = useRef<Run | null>(null)
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => top.current?.scrollIntoView({ block: 'start' }), [])
  useEffect(() => saveLocal(HOLDS_KEY, holds), [holds])

  useEffect(
    () => () => {
      run.current = null
      restoreEffects()
    },
    [],
  )

  // Hold detection on every input report while running
  useEffect(() => {
    if (!running) return
    return dualSense.onInput((s) => {
      const r = run.current
      if (!r) return
      const t = performance.now()
      // whichever trigger is pressed further is the one being tested
      const side: Side = s.l2 >= s.r2 ? 'L2' : 'R2'
      const a = side === 'L2' ? s.l2 : s.r2
      if (r.phase === 'recorded') {
        if (Math.max(s.l2, s.r2) <= RELEASED) {
          r.phase = 'ready'
          r.window = []
          if (r.count >= HOLDS_PER_WALL) {
            if (!r.queue.length) r.queue = shuffled()
            r.zone = r.queue.shift()!
            r.count = 0
            void setWall(r.zone)
          }
        }
        return
      }
      if (a < PRESSED) {
        r.window = []
        return
      }
      r.window.push({ t, a, side })
      while (r.window.length && t - r.window[0].t > STEADY_MS) r.window.shift()
      const span = r.window.length ? t - r.window[0].t : 0
      const vals = r.window.map((w) => w.a)
      const steady = span >= STEADY_MS * 0.9 && Math.max(...vals) - Math.min(...vals) <= STEADY_RANGE && r.window.every((w) => w.side === side)
      if (steady) {
        const value = median(vals)
        setHolds((h) => [...h, { zone: r.zone, side, value }])
        r.count++
        r.phase = 'recorded'
        r.window = []
      }
    }) as unknown as () => void
  }, [running])

  const start = () => {
    const queue = shuffled()
    const zone = queue.shift()!
    run.current = { queue, zone, count: 0, phase: 'ready', window: [] }
    void setWall(zone)
    setRunning(true)
    setMsg('')
  }
  const stop = () => {
    run.current = null
    setRunning(false)
    restoreEffects()
  }

  // Readings at full pull are clipped by the sensor and would bend the line, so leave them out
  const fitHolds = holds.filter((h) => h.value < CLIPPED)
  const clipped = holds.length - fitHolds.length
  const fitAll = fitLine(fitHolds)
  const fitL = fitLine(fitHolds.filter((h) => h.side === 'L2'))
  const fitR = fitLine(fitHolds.filter((h) => h.side === 'R2'))

  const save = () => {
    if (!fitAll) return
    setCalibration({ zones: zonesFromFit(fitAll), fit: fitAll, holds, measuredAt: new Date().toISOString() })
    setMsg('Saved. The trigger graphs and zone labels now use this formula.')
  }

  const r = run.current
  const live = Math.max(dualSense.state.l2, dualSense.state.r2)
  const prompt = !r
    ? ''
    : r.phase === 'recorded'
      ? r.count >= HOLDS_PER_WALL
        ? 'Got 3. Release fully and the wall moves.'
        : `Got it (${r.count}/${HOLDS_PER_WALL}). Release, then touch the wall again.`
      : `Ease the trigger in until you touch the wall, then hold still (${r.count}/${HOLDS_PER_WALL}).`

  return (
    <>
    <div ref={top} />
    <Card
      title="Calibrate trigger travel (wall test)"
      right={
        <button className="small" onClick={() => { stop(); onClose() }}>
          Close
        </button>
      }
    >
      {!info && <div className="warnbox">Connect the controller (USB) to calibrate.</div>}
      <p className="small muted">
        Both triggers get a solid wall at a hidden zone. Slowly press either trigger until you feel the wall and hold there; a steady
        reading is recorded. After {HOLDS_PER_WALL} holds, fully release and the wall moves. Keep going as long as you like, then stop
        and look at the fit.
      </p>
      <div className="row">
        {running ? (
          <button onClick={stop}>Stop</button>
        ) : (
          <button className="primary" disabled={!info} onClick={start}>
            {holds.length ? 'Continue' : 'Start'}
          </button>
        )}
        <button disabled={running || !holds.length} onClick={() => setHolds([])}>
          Clear holds
        </button>
        <span className="mono small">
          reading {pct(live)} · {holds.length} holds
        </span>
      </div>
      <div style={{ position: 'relative', height: 14, background: 'var(--line)', borderRadius: 4, margin: '8px 0' }}>
        <div style={{ width: `${live * 100}%`, height: '100%', background: r?.phase === 'recorded' ? '#7aa2ff' : '#3ad6a8', borderRadius: 4 }} />
      </div>
      {prompt && <div style={{ margin: '6px 0' }}>{prompt}</div>}

      {holds.length > 0 && !running && (
        <>
          <Scatter holds={holds} fit={fitAll} />
          <FitSummary label="Both" fit={fitAll} />
          <FitSummary label="L2" fit={fitL} />
          <FitSummary label="R2" fit={fitR} />
          {clipped > 0 && <div className="small muted">{clipped} hold(s) at full pull (sensor maxed out) left out of the fit.</div>}
          <ZoneTable holds={holds} />
        </>
      )}
      {msg && <div className="small" style={{ margin: '6px 0' }}>{msg}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!fitAll || running} onClick={save}>
          Use this formula
        </button>
        <button disabled={!saved || running} onClick={() => setCalibration(null)}>
          Reset to uncalibrated
        </button>
        <span className="small muted">{saved ? `Calibrated ${new Date(saved.measuredAt).toLocaleString()}` : 'Not calibrated (zone z drawn at z×10%)'}</span>
      </div>
    </Card>
    </>
  )
}

function FitSummary({ label, fit }: { label: string; fit: LineFit | null }) {
  if (!fit) return null
  return (
    <div className="mono small">
      {label}: reading ≈ {pct(fit.intercept)} + {pct(fit.slope)} × zone (≈ {byte(fit.intercept)} + {(fit.slope * 255).toFixed(1)} × zone in
      0–255) · scatter ±{pct(fit.rms)} · {fit.n} holds
    </div>
  )
}

function ZoneTable({ holds }: { holds: WallHold[] }) {
  const cell = { textAlign: 'right' as const, paddingRight: 12 }
  return (
    <table className="small mono" style={{ borderCollapse: 'collapse', marginTop: 8 }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', paddingRight: 12 }}>zone</th>
          <th style={cell}>assumed</th>
          <th style={cell}>L2 median</th>
          <th style={cell}>R2 median</th>
          <th style={cell}>all median</th>
          <th style={cell}>0–255</th>
          <th style={cell}>holds</th>
        </tr>
      </thead>
      <tbody>
        {DEFAULT_ZONES.map((d, z) => {
          const at = holds.filter((h) => h.zone === z)
          if (!at.length) return null
          const all = median(at.map((h) => h.value))
          return (
            <tr key={z}>
              <td>{z}</td>
              <td className="muted" style={cell}>{pct(d)}</td>
              <td style={cell}>{pct(median(at.filter((h) => h.side === 'L2').map((h) => h.value)))}</td>
              <td style={cell}>{pct(median(at.filter((h) => h.side === 'R2').map((h) => h.value)))}</td>
              <td style={cell}>{pct(all)}</td>
              <td style={cell}>{byte(all)}</td>
              <td style={cell}>{at.length}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Every hold (zone vs reading), the fitted line and the uncalibrated z×10% guess. */
function Scatter({ holds, fit }: { holds: WallHold[]; fit: LineFit | null }) {
  const W = 420
  const H = 220
  const p = 28
  const x = (z: number) => p + ((W - 2 * p) * z) / 10
  const y = (v: number) => H - p - (H - 2 * p) * v
  return (
    <svg width={W} height={H} style={{ display: 'block', margin: '8px 0', background: '#11131a', borderRadius: 6 }}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={p} x2={W - p} y1={y(v)} y2={y(v)} stroke="#262a35" />
          <text x={2} y={y(v) + 3} fontSize={9} fill="#8b91a1">{v * 100}%</text>
        </g>
      ))}
      {DEFAULT_ZONES.map((_, z) => (
        <text key={z} x={x(z) - 3} y={H - 10} fontSize={9} fill="#8b91a1">{z}</text>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(10)} y2={y(1)} stroke="#555b6b" strokeDasharray="4 3" />
      {fit && <line x1={x(0)} y1={y(fit.intercept)} x2={x(10)} y2={y(fit.intercept + fit.slope * 10)} stroke="#7aa2ff" />}
      {holds.map((h, i) => (
        <circle key={i} cx={x(h.zone) + (h.side === 'L2' ? -3 : 3)} cy={y(h.value)} r={2.5} fill={h.side === 'L2' ? '#ffb347' : '#3ad6a8'} />
      ))}
      <text x={W - p - 90} y={14} fontSize={9} fill="#ffb347">● L2</text>
      <text x={W - p - 60} y={14} fontSize={9} fill="#3ad6a8">● R2</text>
      <text x={W - p - 30} y={14} fontSize={9} fill="#7aa2ff">— fit</text>
    </svg>
  )
}
