// A grip motor's frequency graph: EQ curve, live spectra and clipping marks. Drawn full-size
// in each motor card and as a simplified mini above the 3D view (where Experiments has no EQ).

import { SAMPLE_RATE } from '../../haptics/dsp'
import { EQ_BANDS, EqChain, type EqSettings } from '../../haptics/eq'

export const F_MIN = 20
export const F_MAX = 20000
/** spectrum graph range: this many dB at the bottom, 0 dB at the top */
const SPEC_FLOOR_DB = -100
/** on a clipped frame, frequencies this close to the loudest one are marked */
const CLIP_SPREAD_DB = 6
const SPEC_FILL = ['rgba(90,169,255,0.45)', 'rgba(143,209,79,0.45)']

/** A motor's live signal; `gain` scales it to what the motor gets. */
export type MotorAnalyser = { node: AnalyserNode; gain: number } | null

/**
 * What the Haptics & Triggers tab is showing, for the minis above the 3D view: its motor EQs
 * and live signals. `eqs` is null while that tab isn't open.
 */
export const workbenchLive: {
  eqs: EqSettings[] | null
  analyser: (ch: number) => MotorAnalyser
  srcAnalyser: (ch: number) => AnalyserNode | null
} = { eqs: null, analyser: () => null, srcAnalyser: () => null }

const curveCtx = new OfflineAudioContext(1, 128, SAMPLE_RATE)
const W0 = 600
const freqs = new Float32Array(W0)
for (let i = 0; i < W0; i++) freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (W0 - 1))

/** Draws one motor's graph each frame; keeps the buffers and the fading clip marks between frames. */
export class MotorGraphPainter {
  private chain: EqChain | null = null
  private spec: Float32Array<ArrayBuffer> | null = null
  private srcSpec: Float32Array<ArrayBuffer> | null = null
  private wave: Float32Array<ArrayBuffer> | null = null
  /** per spectrum column (2 px): how red, fading after a clipped frame */
  private heat = new Float32Array(0)

  constructor(private ch: number) {}

  /** `eq` null: no EQ curve (Experiments). `mini`: no labels and lighter lines, for the small copy above the 3D view. */
  draw(c: HTMLCanvasElement, H: number, eq: EqSettings | null, mot: MotorAnalyser, src: AnalyserNode | null, mini = false) {
    if (eq) {
      if (!this.chain) this.chain = new EqChain(curveCtx, eq)
      this.chain.update(eq)
    }
    const dpr = window.devicePixelRatio || 1
    const W = c.clientWidth
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(H * dpr)
    }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const xOf = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W
    // grid
    g.strokeStyle = '#262a35'
    g.fillStyle = '#5d6475'
    g.font = '9px Segoe UI'
    for (const f of EQ_BANDS) {
      const x = xOf(f)
      g.beginPath()
      g.moveTo(x, 0)
      g.lineTo(x, H)
      g.stroke()
      if (!mini) g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 3)
    }
    const yDb = (db: number) => H / 2 - (db / 30) * (H / 2)
    g.beginPath()
    g.moveTo(0, yDb(0))
    g.lineTo(W, yDb(0))
    g.stroke()

    // live spectra: the file (faint) and this channel's output, 0 dB at the top so strong sounds stay on the graph
    const specY = (db: number) => H - Math.max(0, Math.min(1, (db - SPEC_FLOOR_DB) / -SPEC_FLOOR_DB)) * H
    const specDb = (buf: Float32Array, binHz: number, x: number) => buf[Math.min(buf.length - 1, Math.round((F_MIN * Math.pow(F_MAX / F_MIN, x / W)) / binHz))]
    const drawSpec = (an: AnalyserNode | null, buf: Float32Array<ArrayBuffer> | null, fill: string, boostDb = 0) => {
      if (!an) return buf
      if (!buf || buf.length !== an.frequencyBinCount) buf = new Float32Array(an.frequencyBinCount)
      an.getFloatFrequencyData(buf)
      const binHz = an.context.sampleRate / an.fftSize
      g.beginPath()
      g.moveTo(0, H)
      for (let x = 0; x < W; x += 2) g.lineTo(x, specY(specDb(buf, binHz, x) + boostDb))
      g.lineTo(W, H)
      g.closePath()
      g.fillStyle = fill
      g.fill()
      return buf
    }
    this.srcSpec = drawSpec(src, this.srcSpec, 'rgba(140,150,170,0.18)')
    const boostDb = mot ? 20 * Math.log10(Math.max(1e-6, mot.gain)) : 0
    this.spec = drawSpec(mot?.node ?? null, this.spec, SPEC_FILL[this.ch], boostDb)

    // Clipping: on frames where this motor's signal goes past full scale, the frequencies
    // carrying most of the energy right then (within CLIP_SPREAD_DB of the loudest) turn red
    const cols = Math.ceil(W / 2)
    if (this.heat.length !== cols) this.heat = new Float32Array(cols)
    const heat = this.heat
    for (let i = 0; i < cols; i++) heat[i] *= 0.8
    const spec = this.spec
    if (mot && spec) {
      const an = mot.node
      if (!this.wave || this.wave.length !== an.fftSize) this.wave = new Float32Array(an.fftSize)
      an.getFloatTimeDomainData(this.wave)
      let peak = 0
      for (let i = 0; i < this.wave.length; i++) peak = Math.max(peak, Math.abs(this.wave[i]))
      if (peak * mot.gain > 1) {
        const binHz = an.context.sampleRate / an.fftSize
        let loudest = -Infinity
        for (let i = 0; i < cols; i++) loudest = Math.max(loudest, specDb(spec, binHz, i * 2))
        for (let i = 0; i < cols; i++) if (specDb(spec, binHz, i * 2) >= loudest - CLIP_SPREAD_DB) heat[i] = 1
      }
    }
    for (let i = 0; i < cols; i++) {
      if (heat[i] < 0.03) continue
      g.fillStyle = `rgba(255,48,48,${(0.55 * heat[i]).toFixed(3)})`
      g.fillRect(i * 2, 0, 2, H)
    }

    // EQ curve
    if (!eq || !this.chain) return
    const resp = this.chain.response(freqs)
    g.strokeStyle = eq.mute ? '#555' : '#ffb347'
    g.lineWidth = mini ? 1.5 : 2
    g.beginPath()
    for (let i = 0; i < W0; i++) {
      const x = (i / (W0 - 1)) * W
      const y = Math.max(0, Math.min(H, yDb(resp[i])))
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
    g.lineWidth = 1
  }
}
