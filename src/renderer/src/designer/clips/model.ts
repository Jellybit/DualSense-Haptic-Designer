// Haptic timeline data model + offline renderer.

import {
  Biquad,
  GrainVoice,
  impactGrain,
  rng,
  SAMPLE_RATE,
  softClip,
  tapGrain,
  thumpGrain,
  panGains,
  type Grain,
  type Material,
} from '../../haptics/dsp'
import type { TriggerEffect } from '../../device/triggerEffects'

export type ClipSource =
  /** Continuous oscillator with optional glide and pulse/AM */
  | { kind: 'tone'; wave: 'sine' | 'square' | 'triangle' | 'saw'; freqStart: number; freqEnd: number; amRate: number; amDepth: number }
  /** Band-pass noise texture (rumble, gravel, rain bed) */
  | { kind: 'noise'; freqStart: number; freqEnd: number; q: number; amRate: number; amDepth: number }
  /** Train of grains — footsteps, heartbeat, rain, clicks */
  | {
      kind: 'pulses'
      grain: 'tap' | 'thump' | 'impact'
      material: Material
      rateStart: number
      rateEnd: number
      /** 0..1 random timing jitter */
      jitter: number
      /** 0..1 random pan spread around the clip pan */
      spread: number
      /** play pairs of pulses (lub-dub) */
      doublet: boolean
      pitch: number
    }
  /** Imported audio (mono or stereo), resampled to 48 kHz */
  | { kind: 'sample'; name: string; L: number[]; R: number[] }

export interface Clip {
  id: string
  name: string
  track: number
  /** seconds */
  start: number
  duration: number
  /** 0..1 */
  gain: number
  attack: number
  release: number
  /** pan automation (-1 left grip .. 1 right grip) */
  panStart: number
  panEnd: number
  source: ClipSource
  color?: string
}

export interface TriggerKey {
  id: string
  time: number
  side: 'L' | 'R'
  effect: TriggerEffect
  presetName?: string
}

export interface HapticProject {
  version: 1
  name: string
  duration: number
  tracks: { name: string; mute: boolean; solo: boolean }[]
  clips: Clip[]
  triggerKeys: TriggerKey[]
}

export const uid = () => Math.random().toString(36).slice(2, 10)

export function newProject(): HapticProject {
  return {
    version: 1,
    name: 'Untitled haptics',
    duration: 4,
    tracks: [
      { name: 'Track 1', mute: false, solo: false },
      { name: 'Track 2', mute: false, solo: false },
      { name: 'Track 3', mute: false, solo: false },
    ],
    clips: [],
    triggerKeys: [],
  }
}

export const CLIP_PRESETS: { name: string; make: () => Omit<Clip, 'id' | 'track' | 'start'> }[] = [
  {
    name: 'Heartbeat',
    make: () => ({
      name: 'Heartbeat', duration: 2, gain: 0.9, attack: 0, release: 0, panStart: 0, panEnd: 0,
      source: { kind: 'pulses', grain: 'thump', material: 'soft', rateStart: 1.2, rateEnd: 1.2, jitter: 0, spread: 0, doublet: true, pitch: 1 },
    }),
  },
  {
    name: 'Footsteps L→R',
    make: () => ({
      name: 'Footsteps', duration: 1.5, gain: 0.7, attack: 0, release: 0, panStart: -1, panEnd: 1,
      source: { kind: 'pulses', grain: 'tap', material: 'wood', rateStart: 7, rateEnd: 7, jitter: 0.1, spread: 0.1, doublet: false, pitch: 1 },
    }),
  },
  {
    name: 'Rain',
    make: () => ({
      name: 'Rain', duration: 3, gain: 0.5, attack: 0.3, release: 0.5, panStart: 0, panEnd: 0,
      source: { kind: 'pulses', grain: 'tap', material: 'glass', rateStart: 40, rateEnd: 40, jitter: 1, spread: 1, doublet: false, pitch: 1.3 },
    }),
  },
  {
    name: 'Engine rumble',
    make: () => ({
      name: 'Engine', duration: 2, gain: 0.6, attack: 0.2, release: 0.3, panStart: 0, panEnd: 0,
      source: { kind: 'tone', wave: 'saw', freqStart: 40, freqEnd: 90, amRate: 12, amDepth: 0.5 },
    }),
  },
  {
    name: 'Gravel roll',
    make: () => ({
      name: 'Gravel', duration: 1.5, gain: 0.7, attack: 0.1, release: 0.2, panStart: -0.8, panEnd: 0.8,
      source: { kind: 'noise', freqStart: 120, freqEnd: 220, q: 1.5, amRate: 25, amDepth: 0.6 },
    }),
  },
  {
    name: 'Laser charge',
    make: () => ({
      name: 'Charge', duration: 1, gain: 0.6, attack: 0.05, release: 0.05, panStart: 0, panEnd: 0,
      source: { kind: 'tone', wave: 'sine', freqStart: 60, freqEnd: 400, amRate: 30, amDepth: 0.3 },
    }),
  },
  {
    name: 'Metal clang',
    make: () => ({
      name: 'Clang', duration: 0.4, gain: 1, attack: 0, release: 0, panStart: 0.6, panEnd: 0.6,
      source: { kind: 'pulses', grain: 'impact', material: 'metal', rateStart: 0.5, rateEnd: 0.5, jitter: 0, spread: 0, doublet: false, pitch: 1 },
    }),
  },
  {
    name: 'Buzz',
    make: () => ({
      name: 'Buzz', duration: 0.5, gain: 0.5, attack: 0.01, release: 0.05, panStart: 0, panEnd: 0,
      source: { kind: 'tone', wave: 'square', freqStart: 150, freqEnd: 150, amRate: 0, amDepth: 0 },
    }),
  },
]

function wave(kind: 'sine' | 'square' | 'triangle' | 'saw', ph: number) {
  const x = ph / (2 * Math.PI)
  const f = x - Math.floor(x)
  switch (kind) {
    case 'sine':
      return Math.sin(ph)
    case 'square':
      return f < 0.5 ? 0.7 : -0.7
    case 'triangle':
      return 1 - 4 * Math.abs(f - 0.5)
    case 'saw':
      return (2 * f - 1) * 0.8
  }
}

/** Render one clip into L/R (mixing). */
export function renderClip(c: Clip, L: Float32Array, R: Float32Array, sr = SAMPLE_RATE, seed = 1) {
  const start = Math.round(c.start * sr)
  const n = Math.round(c.duration * sr)
  const rand = rng(seed)
  const env = (i: number) => {
    const t = i / sr
    const a = c.attack > 0 ? Math.min(1, t / c.attack) : 1
    const r = c.release > 0 ? Math.min(1, (c.duration - t) / c.release) : 1
    // 1.5 ms anti-click fades
    const edge = Math.min(1, i / (0.0015 * sr), (n - i) / (0.0015 * sr))
    return Math.max(0, a * r * edge) * c.gain
  }
  const panAt = (i: number) => c.panStart + ((c.panEnd - c.panStart) * i) / Math.max(1, n)
  const s = c.source

  if (s.kind === 'tone' || s.kind === 'noise') {
    let ph = 0
    let am = 0
    const bp1 = new Biquad()
    const bp2 = new Biquad()
    for (let i = 0; i < n; i++) {
      const o = start + i
      if (o < 0 || o >= L.length) continue
      const t = i / Math.max(1, n)
      const f = s.freqStart * Math.pow(s.freqEnd / Math.max(1, s.freqStart), t)
      let v: number
      if (s.kind === 'tone') {
        ph += (2 * Math.PI * f) / sr
        v = wave(s.wave, ph)
      } else {
        if ((i & 63) === 0) {
          bp1.setBandpass(f, s.q, sr)
          bp2.setBandpass(f, s.q, sr)
        }
        v = bp2.process(bp1.process(rand() * 2 - 1)) * 3.5
      }
      if (s.amRate > 0 && s.amDepth > 0) {
        am += (2 * Math.PI * s.amRate) / sr
        v *= 1 - s.amDepth * (0.5 + 0.5 * Math.sin(am))
      }
      const [gl, gr] = panGains(panAt(i))
      const e = env(i)
      L[o] += v * e * gl
      R[o] += v * e * gr
    }
    return
  }

  if (s.kind === 'pulses') {
    // Integrate the (possibly gliding) rate to place pulses
    const grains: { at: number; g: Grain }[] = []
    let t = 0
    let phase = 0.999 // fire immediately
    const dt = 1 / sr
    let i = 0
    while (i < n) {
      const rate = s.rateStart + ((s.rateEnd - s.rateStart) * i) / Math.max(1, n)
      phase += rate * dt * 32
      i += 32
      t += 32 * dt
      if (phase >= 1) {
        phase -= 1
        const jitter = (rand() - 0.5) * s.jitter * (1 / Math.max(0.1, rate))
        const at = Math.max(0, Math.round((t + jitter) * sr))
        if (at >= n) continue
        const pan = Math.max(-1, Math.min(1, panAt(at) + (rand() * 2 - 1) * s.spread))
        const amp = 0.85 + rand() * 0.15
        const mk = (a: number): Grain =>
          s.grain === 'tap'
            ? tapGrain(a, pan, 230 * s.pitch)
            : s.grain === 'thump'
              ? thumpGrain(a, pan, 110 * s.pitch)
              : impactGrain(s.material, a, pan, s.pitch)
        grains.push({ at, g: mk(amp) })
        if (s.doublet) grains.push({ at: at + Math.round(0.18 * sr), g: mk(amp * 0.7) })
      }
    }
    const tmpL = new Float32Array(n + sr) // allow tails
    const tmpR = new Float32Array(n + sr)
    for (const { at, g } of grains) {
      const v = new GrainVoice(g, rand, sr)
      const len = Math.round(g.duration * sr) + 1
      v.render(tmpL, tmpR, Math.min(at, tmpL.length - len), Math.min(len, tmpL.length - at))
    }
    for (let k = 0; k < tmpL.length; k++) {
      const o = start + k
      if (o < 0 || o >= L.length) continue
      const e = k < n ? env(k) : 0
      if (e === 0 && k < n) continue
      // grain tails past the clip end ring out naturally
      const g = k < n ? e : c.gain
      L[o] += tmpL[k] * g
      R[o] += tmpR[k] * g
    }
    return
  }

  if (s.kind === 'sample') {
    for (let i = 0; i < Math.min(n, s.L.length); i++) {
      const o = start + i
      if (o < 0 || o >= L.length) continue
      const pan = panAt(i)
      // pan acts as balance for stereo samples
      const bl = pan > 0 ? 1 - pan : 1
      const br = pan < 0 ? 1 + pan : 1
      const e = env(i)
      L[o] += s.L[i] * e * bl
      R[o] += (s.R[i] ?? s.L[i]) * e * br
    }
  }
}

/** Render a whole project to stereo L/R actuator buffers. */
export function renderProject(p: HapticProject, sr = SAMPLE_RATE): { L: Float32Array; R: Float32Array } {
  const n = Math.max(1, Math.round(p.duration * sr))
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const anySolo = p.tracks.some((t) => t.solo)
  p.clips.forEach((c, idx) => {
    const tr = p.tracks[c.track]
    if (!tr || tr.mute || (anySolo && !tr.solo)) return
    renderClip(c, L, R, sr, idx + 1)
  })
  for (let i = 0; i < n; i++) {
    L[i] = softClip(L[i])
    R[i] = softClip(R[i])
  }
  return { L, R }
}
