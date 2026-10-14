import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav, encodeWavChannels, hapticChannels, resample } from '../src/renderer/src/export/wav'
import { GrainVoice, panGains, rng, SAMPLE_RATE } from '../src/renderer/src/haptics/dsp'
import { HapticMixer } from '../src/renderer/src/haptics/mixer'
import { CLIP_PRESETS, newProject, renderProject, uid } from '../src/renderer/src/designer/clips/model'
import { Madgwick, rotateWorldToSensor } from '../src/renderer/src/orientation/madgwick'
import { SceneSim, SCENE_PRESETS } from '../src/renderer/src/designer/scenes/sim'

const peakOf = (...xs: Float32Array[]) => xs.reduce((m, x) => x.reduce((a, v) => Math.max(a, Math.abs(v)), m), 0)

describe('wav', () => {
  it('round-trips stereo', () => {
    const L = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.5)
    const R = Float32Array.from({ length: 100 }, (_, i) => Math.cos(i / 7) * 0.3)
    const a = decodeWav(encodeWav(L, R, 48000, 'stereo'))
    expect(a.sampleRate).toBe(48000)
    expect(a.channels.length).toBe(2)
    expect(a.channels[0][10]).toBeCloseTo(L[10], 3)
    expect(a.channels[1][50]).toBeCloseTo(R[50], 3)
  })

  it('quad layout puts haptics on channels 3/4', () => {
    const L = new Float32Array([0.5, 0.5])
    const R = new Float32Array([-0.25, -0.25])
    const a = decodeWav(encodeWav(L, R, 48000, 'quad'))
    expect(a.channels.length).toBe(4)
    expect(a.channels[0][0]).toBe(0)
    expect(a.channels[1][0]).toBe(0)
    const h = hapticChannels(a)
    expect(h.L[0]).toBeCloseTo(0.5, 3)
    expect(h.R[0]).toBeCloseTo(-0.25, 3)
  })

  it('writes N-channel WAVs in channel order', () => {
    const chans = [0.1, 0.2, 0.3, 0.4].map((v) => new Float32Array(10).fill(v))
    const a = decodeWav(encodeWavChannels(chans, 48000))
    expect(a.channels.length).toBe(4)
    a.channels.forEach((c, i) => expect(c[5]).toBeCloseTo((i + 1) / 10, 3))
  })

  it('resamples length', () => {
    expect(resample(new Float32Array(441), 44100, 48000).length).toBe(480)
  })
})

describe('dsp', () => {
  it('equal-power pan', () => {
    const [l, r] = panGains(0)
    expect(l * l + r * r).toBeCloseTo(1, 6)
    expect(panGains(-1)[1]).toBeCloseTo(0, 6)
    expect(panGains(1)[0]).toBeCloseTo(0, 6)
  })

  it('grain renders, pans and finishes', () => {
    const L = new Float32Array(SAMPLE_RATE / 5)
    const R = new Float32Array(SAMPLE_RATE / 5)
    const v = new GrainVoice({ freq: 200, duration: 0.05, decay: 0.02, amp: 1, pan: -1 }, rng(1))
    v.render(L, R, 0, L.length)
    expect(v.done).toBe(true)
    expect(Math.max(...L.map(Math.abs))).toBeGreaterThan(0.3)
    expect(Math.max(...R.map(Math.abs))).toBeLessThan(1e-6)
  })

  it('mixer output is soft-clipped', () => {
    const m = new HapticMixer()
    for (let i = 0; i < 20; i++) m.addGrain({ freq: 100, duration: 0.05, decay: 1, amp: 1, pan: 0 })
    const L = new Float32Array(128)
    const R = new Float32Array(128)
    for (let k = 0; k < 10; k++) m.process(L, R)
    expect(Math.max(...L.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('every clip preset renders audible, bounded output', () => {
    for (const preset of CLIP_PRESETS) {
      const p = newProject()
      p.clips.push({ ...preset.make(), id: uid(), track: 0, start: 0 })
      p.duration = 3
      const { L, R } = renderProject(p)
      const peak = peakOf(L, R)
      expect(peak, preset.name).toBeGreaterThan(0.05)
      expect(peak, preset.name).toBeLessThanOrEqual(1)
      expect(L.every(Number.isFinite), preset.name).toBe(true)
    }
  })
})

describe('madgwick', () => {
  it('converges to gravity from accel alone', () => {
    const f = new Madgwick(0.5)
    // controller rolled 90° so +x points up: accel reads +1g on x
    for (let i = 0; i < 4000; i++) f.update([0, 0, 0], [1, 0, 0], 0.004)
    const down = rotateWorldToSensor(f.q, [0, -1, 0])
    expect(down[0]).toBeCloseTo(-1, 1)
  })

  it('integrates gyro rotation', () => {
    const f = new Madgwick(0)
    // 90 deg/s about y for 1 s
    for (let i = 0; i < 250; i++) f.update([0, Math.PI / 2, 0], [0, 1, 0], 0.004)
    const yawAngle = 2 * Math.atan2(f.q[2], f.q[0])
    expect(yawAngle).toBeCloseTo(Math.PI / 2, 2)
  })
})

describe('scene sim', () => {
  it('marbles roll toward the tilted side and produce haptics', () => {
    const grains: number[] = []
    const voices = new Set<string>()
    const sim = new SceneSim(SCENE_PRESETS[0].make(), {
      grain: (g) => grains.push(g.pan),
      voice: (id, p) => (p ? voices.add(id) : voices.delete(id)),
    })
    for (let i = 0; i < 240; i++) sim.step(1 / 60, { gx: -0.5, gy: 0, shake: 0, finger: null, jump: false, kick: false })
    // everything ended up near the left wall
    for (const b of sim.bodies) expect(b.x).toBeLessThan(sim.cfg.width / 2)
    // impacts happened and were panned to the left
    expect(grains.length).toBeGreaterThan(0)
    expect(grains.filter((p) => p < 0).length).toBeGreaterThan(grains.length / 2)
  })

  it('critters walk and emit footsteps', () => {
    let steps = 0
    const sim = new SceneSim(SCENE_PRESETS[1].make(), { grain: () => steps++, voice: () => {} })
    for (let i = 0; i < 120; i++) sim.step(1 / 60, { gx: 0, gy: 0, shake: 0, finger: null, jump: false, kick: false })
    expect(steps).toBeGreaterThan(10)
  })
})
