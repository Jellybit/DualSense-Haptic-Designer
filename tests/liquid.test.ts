import { describe, expect, it } from 'vitest'
import { LiquidSim } from '../src/renderer/src/designer/scenes/liquid'

const W = 16
const H = 7

function setup(amount = 0.5) {
  const sim = new LiquidSim('w', { amount, viscosity: 0.3, gain: 1 }, W, H)
  const splashes: { t: number; pan: number }[] = []
  const voices = new Map<string, number>()
  let t = 0
  const sink = {
    grain: (g: { pan: number }) => splashes.push({ t, pan: g.pan }),
    voice: (id: string, p: { amp: number } | null) => (p ? voices.set(id, p.amp) : voices.delete(id)),
  }
  const run = (sec: number, gx: number) => {
    for (let f = 0; f < sec * 60; f++, t += 1 / 60) {
      for (let s = 0; s < 6; s++) sim.step(1 / 360, { width: W, height: H, ax: gx * 981, ay: 0, shake: 0, finger: null, kick: false })
      sim.emit(sink, W, 1 / 60)
    }
  }
  return { sim, splashes, voices, run, now: () => t }
}

describe('liquid', () => {
  it('pools on the low side without compressing much and stays finite', () => {
    const { sim, run } = setup()
    run(2.5, -0.4)
    let maxX = 0
    for (let i = 0; i < sim.n; i++) {
      expect(Number.isFinite(sim.x[i])).toBe(true)
      maxX = Math.max(maxX, sim.x[i])
    }
    // half-full box tilted left: water should occupy roughly the left half (ideal 8 cm)
    expect(maxX).toBeGreaterThan(5.5)
    expect(maxX).toBeLessThan(9.5)
  })

  it('splashes once on arrival, not continuously while resting', () => {
    const { splashes, run, now } = setup()
    run(2, -0.4)
    const t0 = now()
    run(3, 0.4)
    const right = splashes.filter((s) => s.t >= t0 && s.pan > 0.5)
    expect(right.length).toBeGreaterThan(0)
    // all splashes on the right happen in the first ~second (arrival + rebound), then silence
    expect(right.every((s) => s.t - t0 < 1.2)).toBe(true)
  })

  it('slosh voice follows motion and fades when still', () => {
    const { voices, run } = setup()
    run(0.3, 0.5)
    expect(voices.get('slosh:w') ?? 0).toBeGreaterThan(0.05)
    run(4, 0.5)
    expect(voices.get('slosh:w') ?? 0).toBeLessThan(0.05)
  })
})

describe('liquid robustness', () => {
  it('ignores zero-length steps instead of producing NaN', () => {
    const sim = new LiquidSim('w', { amount: 0.5, viscosity: 0.3, gain: 1 }, W, H)
    const env = { width: W, height: H, ax: 300, ay: 0, shake: 0, finger: null, kick: false }
    sim.step(0, env)
    sim.step(1 / 360, env)
    for (let i = 0; i < sim.n; i++) expect(Number.isFinite(sim.x[i]) && Number.isFinite(sim.vx[i])).toBe(true)
  })
})
