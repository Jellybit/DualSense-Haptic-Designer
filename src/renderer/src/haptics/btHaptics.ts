// EXPERIMENTAL: stream the synth output to a Bluetooth-connected DualSense.
// The engine's 48 kHz output is band-limited (25 Hz high-pass, 4th-order low-pass at 650 Hz
// by default), decimated to 3 kHz, soft-limited and dithered to signed 8-bit stereo. Blocks of
// 32 frames go out in one of two reports:
//   0x32 (default): one block every 10.67 ms, haptics only (SAxense, DS5Dongle).
//   0x39:           two blocks every 21.33 ms, alongside silent speaker audio. This is what a
//                   PS5 sends; DSZ (github.com/MaximumFreak/dsz) found it smoother and less
//                   delayed. But it starts the controller's microphone stream, and in testing
//                   it dropped the controller on a weak link; Steam then read the mic packets
//                   as button presses (keyboard popping up, windows minimizing). Opt-in only.
// The filter and limiter settings also follow DSZ. None of this touches the USB path.
//
// Pacing: the engine hands over audio in 5.3 ms blocks, which arrive unevenly (several at
// once, then a pause). Blocks go into a small queue and a steady clock sends them. If
// Bluetooth falls behind, the oldest audio is dropped so the vibration doesn't lag further
// and further. After 400 ms of silence the stream pauses and picks up with the next sound.

import type { DualSense } from '../device/hid'
import type { HapticEngine } from './engine'
import { BT_HAPTICS_FRAMES, BT_HAPTICS_RATE } from '../device/outputReport'
import { Biquad, SAMPLE_RATE } from './dsp'

export type BtPacketMode = '0x39' | '0x32'

const DECIMATE = SAMPLE_RATE / BT_HAPTICS_RATE // 16
const BLOCK_MS = (1000 * BT_HAPTICS_FRAMES) / BT_HAPTICS_RATE // 10.67
/** packets held back before sending starts, to ride out jitter */
const PREBUFFER = 2
/** most packets ever waiting; past this the oldest go (keeps latency down) */
const MAX_QUEUE = 6
/** sends allowed to be pending on Bluetooth at once */
const MAX_IN_FLIGHT = 3
/** silence this long pauses the stream */
const IDLE_MS = 400
const HIGHPASS_HZ = 25
export const BT_LOWPASS_DEFAULT = 650

/** 25 Hz high-pass, then a 4th-order Butterworth low-pass as two biquads (keeps the
 *  decimation from folding high content down into a harsh buzz). */
function bandLimit(lowpassHz: number) {
  const hp = new Biquad()
  hp.setHighpass(HIGHPASS_HZ)
  const lp = [0.541, 1.307].map((q) => {
    const b = new Biquad()
    b.setLowpass(lowpassHz, q)
    return b
  })
  return { hp, lp }
}

export interface BtHapticsStats {
  mode: BtPacketMode
  /** packets sent in the last second */
  sentPerSec: number
  /** average time a send took, ms */
  sendMs: number
  /** packets thrown away because Bluetooth fell behind (since start) */
  dropped: number
  /** clock ticks with nothing to send: the controller got a gap (since start) */
  gaps: number
  /** paused after a stretch of silence */
  idle: boolean
}

export class BtHapticsStreamer {
  private off: (() => void) | null = null
  private ds: DualSense | null = null
  private engine: HapticEngine | null = null
  private timer = 0
  private filters = [bandLimit(BT_LOWPASS_DEFAULT), bandLimit(BT_LOWPASS_DEFAULT)]
  private phase = 0
  private acc = new Uint8Array(BT_HAPTICS_FRAMES * 2)
  private accFrames = 0
  private accSilent = true
  /** 32-frame blocks waiting; null = a silent block */
  private queue: (Uint8Array | null)[] = []
  private started = false
  private nextDue = 0
  private seq = 0
  private counter = 0
  private inFlight = 0
  private lastSound = 0
  private idle = false
  /** send mic-off right after the next 0x39 report */
  private micOffPending = false
  private sentTimes: number[] = []
  private sendMsAvg = 0
  private dropped = 0
  private gaps = 0
  private _mode: BtPacketMode = '0x32'
  private _lowpass = BT_LOWPASS_DEFAULT
  /** gain applied before 8-bit quantisation (the 8-bit path has little headroom) */
  gain = 1

  get active() {
    return !!this.off
  }

  get mode() {
    return this._mode
  }

  /** Switch report type; restarts a running stream. */
  set mode(m: BtPacketMode) {
    if (m === this._mode) return
    const { engine, ds } = this
    const was = this.active
    this.stop()
    this._mode = m
    if (was && engine && ds) this.start(engine, ds)
  }

  get lowpass() {
    return this._lowpass
  }

  set lowpass(hz: number) {
    this._lowpass = hz
    for (const f of this.filters) for (const b of f.lp) b.setLowpass(hz, b === f.lp[0] ? 0.541 : 1.307)
  }

  /** blocks per report */
  private get perPacket() {
    return this._mode === '0x39' ? 2 : 1
  }

  get stats(): BtHapticsStats {
    const now = performance.now()
    this.sentTimes = this.sentTimes.filter((t) => now - t < 1000)
    return {
      mode: this._mode,
      sentPerSec: this.sentTimes.length,
      sendMs: this.sendMsAvg,
      dropped: this.dropped,
      gaps: this.gaps,
      idle: this.idle,
    }
  }

  start(engine: HapticEngine, ds: DualSense) {
    this.stop()
    this.engine = engine
    this.ds = ds
    this.dropped = this.gaps = 0
    this.idle = false
    this.micOffPending = true
    this.lastSound = performance.now()
    this.off = engine.onBlock((L, R) => {
      const [fl, fr] = this.filters
      for (let i = 0; i < L.length; i++) {
        // filter every sample, keep every 16th
        const l = fl.lp[1].process(fl.lp[0].process(fl.hp.process(L[i])))
        const r = fr.lp[1].process(fr.lp[0].process(fr.hp.process(R[i])))
        if (++this.phase < DECIMATE) continue
        this.phase = 0
        const a = toS8(softLimit(l * this.gain))
        const b = toS8(softLimit(r * this.gain))
        if (a || b) this.accSilent = false
        this.acc[this.accFrames * 2] = a
        this.acc[this.accFrames * 2 + 1] = b
        if (++this.accFrames === BT_HAPTICS_FRAMES) {
          this.queue.push(this.accSilent ? null : this.acc.slice())
          if (this.queue.length > MAX_QUEUE * this.perPacket) {
            this.queue.shift()
            this.dropped++
          }
          this.accFrames = 0
          this.accSilent = true
        }
      }
    })
    // the clock: check often, send exactly on the report grid
    this.timer = window.setInterval(() => this.tick(), 2)
  }

  private tick() {
    const n = this.perPacket
    const period = BLOCK_MS * n
    if (!this.started) {
      if (this.queue.length < PREBUFFER * n) return
      this.started = true
      this.nextDue = performance.now()
    }
    const now = performance.now()
    while (now >= this.nextDue) {
      this.nextDue += period
      // far behind (tab was in the background): restart the grid instead of bursting
      if (now - this.nextDue > 100) this.nextDue = now + period
      if (this.queue.length < n) {
        this.gaps++
        // ran dry: wait for a fresh prebuffer before going again
        this.started = false
        return
      }
      const blocks = this.queue.splice(0, n)
      if (blocks.every((b) => !b)) {
        if (this.idle) continue
        if (now - this.lastSound > IDLE_MS) {
          this.idle = true
          if (this._mode === '0x39') this.micOff()
          continue
        }
      } else {
        if (this.idle) this.micOffPending = true
        this.idle = false
        this.lastSound = now
      }
      if (this.inFlight >= MAX_IN_FLIGHT) {
        this.dropped++
        continue
      }
      this.send(blocks)
    }
  }

  private send(blocks: (Uint8Array | null)[]) {
    const ds = this.ds
    if (!ds) return
    const pkt = new Uint8Array(blocks.length * BT_HAPTICS_FRAMES * 2)
    blocks.forEach((b, k) => b && pkt.set(b, k * BT_HAPTICS_FRAMES * 2))
    const t0 = performance.now()
    this.inFlight++
    let p: Promise<void>
    if (this._mode === '0x39') {
      p = ds.sendBtHapticsAudio(pkt, this.seq++, this.counter)
      this.counter = (this.counter + 2) & 0xff
      if (this.micOffPending) {
        this.micOffPending = false
        this.micOff()
      }
    } else {
      p = ds.sendBtHaptics(pkt, this.counter)
      this.counter = (this.counter + 1) & 0xff
    }
    p.catch((e) => console.warn('BT haptics send failed', e)).finally(() => {
      this.inFlight--
      const t1 = performance.now()
      this.sentTimes.push(t1)
      this.sendMsAvg = this.sendMsAvg * 0.9 + (t1 - t0) * 0.1
    })
  }

  /** 0x39 reports make the controller stream its microphone back until told to stop. Sent
   *  twice (as DSZ does) in case Bluetooth drops one. */
  private micOff() {
    for (let i = 0; i < 2; i++) this.ds?.sendBtMicOff(this.seq++).catch((e) => console.warn('BT mic-off failed', e))
  }

  stop() {
    if (this.off && this._mode === '0x39' && !this.idle) this.micOff()
    this.off?.()
    this.off = null
    window.clearInterval(this.timer)
    this.timer = 0
    this.queue = []
    this.started = false
    this.accFrames = 0
    this.accSilent = true
    this.phase = 0
  }
}

/** Linear up to 0.7, then eases toward ±1, so peaks round off instead of clipping hard (DSZ). */
export function softLimit(v: number) {
  const a = Math.abs(v)
  if (a <= 0.7) return v
  return Math.sign(v) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3))
}

/** -1..1 → signed 8-bit (as a byte) with TPDF dither, so quiet detail turns into fine noise, not steps. */
function toS8(v: number) {
  // true silence stays silent: no dither hiss in the grips at rest
  if (Math.abs(v) < 1e-4) return 0
  const d = (Math.random() - Math.random()) / 127
  return Math.max(-127, Math.min(127, Math.round((v + d) * 127))) & 0xff
}

export const btHaptics = new BtHapticsStreamer()
