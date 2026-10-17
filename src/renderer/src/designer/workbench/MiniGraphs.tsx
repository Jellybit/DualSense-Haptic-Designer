// Simplified graphs above the 3D view, drawn live without labels or numbers.
// Haptics & Triggers: each grip motor's frequency graph (EQ + spectrum) and each trigger's profile.
// Experiments: each grip motor's live spectrum from the scenes / clip playback (no EQ there).

import { useEffect, useRef } from 'react'
import { getCalibration, zonesFor } from '../../device/triggerCalibration'
import { hapticEngine } from '../../haptics/engine'
import { drawTriggerProfile, triggerState } from '../triggers/TriggerPanel'
import { MotorGraphPainter, workbenchLive } from './motorGraph'

const MINI_H = 58

export function MiniGraphs({ mode }: { mode: 'workbench' | 'experiments' }) {
  const leftMotor = useRef<HTMLCanvasElement>(null)
  const rightMotor = useRef<HTMLCanvasElement>(null)
  const l2 = useRef<HTMLCanvasElement>(null)
  const r2 = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const motors = [leftMotor, rightMotor]
    const painters = [new MotorGraphPainter(0), new MotorGraphPainter(1)]
    const triggers = [
      { side: 'L2', ref: l2 },
      { side: 'R2', ref: r2 },
    ] as const
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (mode === 'experiments') {
        painters.forEach((p, ch) => {
          const c = motors[ch].current
          if (c) p.draw(c, MINI_H, null, hapticEngine.motorAnalyser(ch), null, true)
        })
        return
      }
      const eqs = workbenchLive.eqs
      if (eqs)
        painters.forEach((p, ch) => {
          const c = motors[ch].current
          if (c && eqs[ch]) p.draw(c, MINI_H, eqs[ch], workbenchLive.analyser(ch), workbenchLive.srcAnalyser(ch), true)
        })
      const cal = getCalibration()
      for (const { side, ref } of triggers) {
        if (ref.current) drawTriggerProfile(ref.current, MINI_H, triggerState[side], side, zonesFor(cal, side), { mini: true })
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [mode])

  const cell = (ref: React.RefObject<HTMLCanvasElement>, tag: string, side: 'l' | 'r', title: string) => (
    <div className="mini" title={title}>
      <canvas ref={ref} style={{ height: MINI_H }} />
      <span className={`mini-tag ${side}`}>{tag}</span>
    </div>
  )
  const motorTitle = mode === 'workbench' ? 'EQ and live spectrum' : 'live spectrum of what it gets'
  return (
    <div className="minigraphs">
      {cell(leftMotor, 'L', 'l', `Left grip motor: ${motorTitle}`)}
      {cell(rightMotor, 'R', 'r', `Right grip motor: ${motorTitle}`)}
      {mode === 'workbench' && cell(l2, 'L2', 'l', 'L2 trigger: force and vibration along the pull')}
      {mode === 'workbench' && cell(r2, 'R2', 'r', 'R2 trigger: force and vibration along the pull')}
    </div>
  )
}
