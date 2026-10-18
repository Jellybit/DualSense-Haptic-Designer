// Haptic DSP building blocks. Pure TypeScript (no DOM) so the same code runs in the
// AudioWorklet (live) and on the main thread (offline render / WAV export).
//
// DualSense voice-coil actuators respond roughly from 20 Hz to ~1 kHz with the
// strongest sensation around 80-300 Hz. Short, enveloped sine "grains" in that band
// feel like crisp taps and impacts; band-limited noise feels like rolling/texture.

export const SAMPLE_RATE = 48000

export type Material = 'wood' | 'glass' | 'metal' | 'rubber' | 'stone' | 'soft'

export interface Grain {
  /** start frequency, Hz */
  freq: number
  /** end frequency (exponential glide over `duration`) */
  freqEnd?: number
  /** seconds */
  duration: number
  /** attack seconds */
  attack?: number
  /** exponential decay time constant, seconds (amplitude falls to 1/e) */
  decay: number
  /** 0..1 */
  amp: number
  /** -1 (left grip) .. 1 (right grip) */
  pan: number
  /** 0..1 amount of noise transient mixed in */
  noise?: number
  /** second partial ratio (e.g. 2.76 for metallic ring) */
  partial?: number
  /** delay before start, seconds (lets callers schedule sub-block timing) */
  delay?: number
}

export const MATERIALS: Record<Material, { freq: number; freqEnd: number; decay: number; noise: number; partial?: number; duration: number }> = {
  wood: { freq: 190, freqEnd: 150, decay: 0.018, noise: 0.35, duration: 0.07 },
  glass: { freq: 340, freqEnd: 330, decay: 0.04, noise: 0.15, partial: 2.4, duration: 0.14 },
  metal: { freq: 260, freqEnd: 255, decay: 0.09, noise: 0.1, partial: 2.76, duration: 0.3 },
  rubber: { freq: 85, freqEnd: 60, decay: 0.03, noise: 0.05, duration: 0.09 },
  stone: { freq: 150, freqEnd: 110, decay: 0.012, noise: 0.5, duration: 0.05 },
  soft: { freq: 60, freqEnd: 45, decay: 0.05, noise: 0.0, duration: 0.12 },
}

export function impactGrain(material: Material, amp: number, pan: number, pitchScale = 1): Grain {
  const m = MATERIALS[material]
  return {
    freq: m.freq * pitchScale,
    freqEnd: m.freqEnd * pitchScale,
    duration: m.duration,
    attack: 0.0015,
    decay: m.decay,
    amp,
    pan,
    noise: m.noise,
    partial: m.partial,
  }
}

/** Short crisp tap — footsteps of a tiny critter. */
export function tapGrain(amp: number, pan: number, freq = 230): Grain {
  return { freq, freqEnd: freq * 0.8, duration: 0.03, attack: 0.001, decay: 0.007, amp, pan, noise: 0.15 }
}

/** Low thump with pitch drop — landing, heartbeat. */
export function thumpGrain(amp: number, pan: number, freq = 110): Grain {
  return { freq, freqEnd: freq * 0.45, duration: 0.12, attack: 0.003, decay: 0.035, amp, pan }
}

export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan))
  const a = ((p + 1) * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
}

/** Small deterministic PRNG (mulberry32) so offline renders are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** RBJ biquad band-pass (constant 0 dB peak gain). */
export class Biquad {
  private b0 = 0
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  setBandpass(freq: number, q: number, sr = SAMPLE_RATE) {
    const w = (2 * Math.PI * Math.max(10, Math.min(freq, sr * 0.45))) / sr
    const alpha = Math.sin(w) / (2 * Math.max(0.1, q))
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b1 = 0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(w)) / a0
    this.a2 = (1 - alpha) / a0
  }

  setLowpass(freq: number, q = 0.707, sr = SAMPLE_RATE) {
    const w = (2 * Math.PI * Math.max(10, Math.min(freq, sr * 0.45))) / sr
    const alpha = Math.sin(w) / (2 * q)
    const cw = Math.cos(w)
    const a0 = 1 + alpha
    this.b0 = (1 - cw) / 2 / a0
    this.b1 = (1 - cw) / a0
    this.b2 = this.b0
    this.a1 = (-2 * cw) / a0
    this.a2 = (1 - alpha) / a0
  }

  setHighpass(freq: number, q = 0.707, sr = SAMPLE_RATE) {
    const w = (2 * Math.PI * Math.max(10, Math.min(freq, sr * 0.45))) / sr
    const alpha = Math.sin(w) / (2 * q)
    const cw = Math.cos(w)
    const a0 = 1 + alpha
    this.b0 = (1 + cw) / 2 / a0
    this.b1 = -(1 + cw) / a0
    this.b2 = this.b0
    this.a1 = (-2 * cw) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/** A grain being rendered. */
export class GrainVoice {
  private t = 0
  private phase = 0
  private phase2 = 0
  private delaySamples: number
  private readonly total: number
  private readonly gl: number
  private readonly gr: number
  private readonly k: number
  private noiseLp = new Biquad()
  done = false

  constructor(
    private g: Grain,
    private rand: () => number,
    private sr = SAMPLE_RATE,
  ) {
    this.delaySamples = Math.round((g.delay ?? 0) * sr)
    this.total = Math.max(1, Math.round(g.duration * sr))
    ;[this.gl, this.gr] = panGains(g.pan)
    const end = g.freqEnd ?? g.freq
    this.k = Math.log(Math.max(1, end) / Math.max(1, g.freq)) / this.total
    this.noiseLp.setLowpass(Math.max(200, g.freq * 3), 0.7, sr)
  }

  /** Mix into L/R starting at `offset` for `n` samples. */
  render(L: Float32Array, R: Float32Array, offset: number, n: number) {
    const g = this.g
    const attack = Math.max(1, (g.attack ?? 0.002) * this.sr)
    const decayK = 1 / Math.max(1e-4, g.decay * this.sr)
    const noise = g.noise ?? 0
    for (let i = 0; i < n; i++) {
      if (this.delaySamples > 0) {
        this.delaySamples--
        continue
      }
      if (this.t >= this.total) {
        this.done = true
        return
      }
      const t = this.t
      const f = g.freq * Math.exp(this.k * t)
      this.phase += (2 * Math.PI * f) / this.sr
      let s = Math.sin(this.phase)
      if (g.partial) {
        this.phase2 += (2 * Math.PI * f * g.partial) / this.sr
        s = s * 0.75 + Math.sin(this.phase2) * 0.25 * Math.exp(-t * decayK * 1.6)
      }
      if (noise > 0) {
        // noise transient decays 3x faster than the body
        const nz = this.noiseLp.process(this.rand() * 2 - 1) * Math.exp(-t * decayK * 3)
        s = s * (1 - noise) + nz * noise * 2
      }
      const env = Math.min(1, t / attack) * Math.exp(-t * decayK)
      // fade the last 2 ms to avoid clicks
      const tail = Math.min(1, (this.total - t) / (0.002 * this.sr))
      const v = s * env * tail * g.amp
      L[offset + i] += v * this.gl
      R[offset + i] += v * this.gr
      this.t++
    }
  }
}

/** Continuous textured voice — rolling, sliding, buzzing, sloshing. Params are smoothed. */
export interface ContinuousParams {
  kind: 'noise' | 'tone'
  /** centre frequency (noise band / tone) */
  freq: number
  /** 0..1 */
  amp: number
  pan: number
  /** band-pass Q for noise */
  q?: number
  /** amplitude modulation (Hz) and depth (0..1) — gives "grainy" rolling */
  amRate?: number
  amDepth?: number
}

export class ContinuousVoice {
  private cur: ContinuousParams
  private target: ContinuousParams
  private bp = new Biquad()
  private bp2 = new Biquad()
  private phase = 0
  private amPhase = 0
  private sinceFilter = 0
  released = false
  done = false

  constructor(
    p: ContinuousParams,
    private rand: () => number,
    private sr = SAMPLE_RATE,
  ) {
    this.cur = { ...p, amp: 0 }
    this.target = { ...p }
    this.updateFilter()
  }

  set(p: ContinuousParams) {
    this.target = { ...p }
    this.cur.kind = p.kind
  }

  release() {
    this.released = true
    this.target = { ...this.target, amp: 0 }
  }

  private updateFilter() {
    this.bp.setBandpass(this.cur.freq, this.cur.q ?? 2, this.sr)
    this.bp2.setBandpass(this.cur.freq, this.cur.q ?? 2, this.sr)
  }

  render(L: Float32Array, R: Float32Array, offset: number, n: number) {
    // one-pole smoothing ~10 ms
    const a = 1 - Math.exp(-1 / (0.01 * this.sr))
    for (let i = 0; i < n; i++) {
      const c = this.cur
      const tg = this.target
      c.amp += (tg.amp - c.amp) * a
      c.freq += (tg.freq - c.freq) * a
      c.pan += (tg.pan - c.pan) * a
      c.amRate = (c.amRate ?? 0) + ((tg.amRate ?? 0) - (c.amRate ?? 0)) * a
      c.amDepth = tg.amDepth ?? 0
      c.q = tg.q
      if (++this.sinceFilter >= 64) {
        this.sinceFilter = 0
        if (c.kind === 'noise') this.updateFilter()
      }
      let s: number
      if (c.kind === 'noise') {
        // two cascaded band-passes for a narrower, more "rumbly" band; gain compensated
        s = this.bp2.process(this.bp.process(this.rand() * 2 - 1)) * 3.5
      } else {
        this.phase += (2 * Math.PI * c.freq) / this.sr
        if (this.phase > 1e6) this.phase -= 2 * Math.PI * Math.floor(this.phase / (2 * Math.PI))
        s = Math.sin(this.phase)
      }
      if (c.amRate && c.amDepth) {
        this.amPhase += (2 * Math.PI * c.amRate) / this.sr
        s *= 1 - c.amDepth * (0.5 + 0.5 * Math.sin(this.amPhase))
      }
      const [gl, gr] = panGains(c.pan)
      const v = s * c.amp
      L[offset + i] += v * gl
      R[offset + i] += v * gr
    }
    if (this.released && this.cur.amp < 1e-4) this.done = true
  }
}

/** Soft limiter so stacked grains never hard-clip the actuators. */
export function softClip(x: number) {
  return Math.tanh(x)
}
