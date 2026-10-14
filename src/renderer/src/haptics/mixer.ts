// Real-time haptic mixer: grains + continuous voices + buffer playback.
// Runs inside the AudioWorklet; also usable offline.

import { ContinuousVoice, GrainVoice, rng, softClip, SAMPLE_RATE, type ContinuousParams, type Grain } from './dsp'

export type MixerMessage =
  | { t: 'grain'; g: Grain }
  | { t: 'grains'; gs: Grain[] }
  | { t: 'voice'; id: string; p: ContinuousParams | null }
  | { t: 'voicesOff' }
  | { t: 'play'; id: string; L: Float32Array; R: Float32Array; offset?: number; loop?: boolean }
  | { t: 'stop'; id?: string }
  | { t: 'gain'; v: number }
  | { t: 'tap'; on: boolean }

interface Playback {
  L: Float32Array
  R: Float32Array
  pos: number
  loop: boolean
}

export class HapticMixer {
  private grains: GrainVoice[] = []
  private voices = new Map<string, ContinuousVoice>()
  private playbacks = new Map<string, Playback>()
  private rand = rng(1234)
  gain = 1
  /** peak meter, decays */
  peakL = 0
  peakR = 0

  constructor(private sr = SAMPLE_RATE) {}

  handle(m: MixerMessage) {
    switch (m.t) {
      case 'grain':
        this.addGrain(m.g)
        break
      case 'grains':
        m.gs.forEach((g) => this.addGrain(g))
        break
      case 'voice': {
        const v = this.voices.get(m.id)
        if (m.p === null) v?.release()
        else if (v && !v.released) v.set(m.p)
        else this.voices.set(m.id, new ContinuousVoice(m.p, this.rand, this.sr))
        break
      }
      case 'voicesOff':
        this.voices.forEach((v) => v.release())
        break
      case 'play':
        this.playbacks.set(m.id, { L: m.L, R: m.R, pos: m.offset ?? 0, loop: !!m.loop })
        break
      case 'stop':
        if (m.id) this.playbacks.delete(m.id)
        else {
          this.playbacks.clear()
          this.grains = []
          this.voices.clear()
        }
        break
      case 'gain':
        this.gain = m.v
        break
    }
  }

  addGrain(g: Grain) {
    if (this.grains.length > 256) this.grains.shift() // hard cap on polyphony
    this.grains.push(new GrainVoice(g, this.rand, this.sr))
  }

  /** Playback positions (samples) — used for playheads. */
  positions(): Record<string, number> {
    const o: Record<string, number> = {}
    this.playbacks.forEach((p, id) => (o[id] = p.pos))
    return o
  }

  process(L: Float32Array, R: Float32Array): string[] {
    const n = L.length
    L.fill(0)
    R.fill(0)
    for (const g of this.grains) g.render(L, R, 0, n)
    this.grains = this.grains.filter((g) => !g.done)
    this.voices.forEach((v, id) => {
      v.render(L, R, 0, n)
      if (v.done) this.voices.delete(id)
    })
    const finished: string[] = []
    this.playbacks.forEach((p, id) => {
      for (let i = 0; i < n; i++) {
        if (p.pos >= p.L.length) {
          if (p.loop && p.L.length > 0) p.pos = 0
          else break
        }
        L[i] += p.L[p.pos]
        R[i] += p.R[p.pos]
        p.pos++
      }
      if (!p.loop && p.pos >= p.L.length) {
        finished.push(id)
        this.playbacks.delete(id)
      }
    })
    let pl = this.peakL * 0.97
    let pr = this.peakR * 0.97
    for (let i = 0; i < n; i++) {
      L[i] = softClip(L[i] * this.gain)
      R[i] = softClip(R[i] * this.gain)
      pl = Math.max(pl, Math.abs(L[i]))
      pr = Math.max(pr, Math.abs(R[i]))
    }
    this.peakL = pl
    this.peakR = pr
    return finished
  }
}
