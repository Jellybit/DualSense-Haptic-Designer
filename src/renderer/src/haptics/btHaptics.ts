// EXPERIMENTAL: stream the synth output to a Bluetooth-connected DualSense.
// The engine's 48 kHz output is low-passed (4th-order, 1.2 kHz) and decimated to 3 kHz,
// dithered to signed 8-bit stereo and sent 32 frames at a time in report 0x32.
//
// Pacing: the engine hands over audio in ~21 ms blocks, which would make bursts of two
// packets and then a gap. The controller wants one packet every 10.67 ms, so packets go
// into a small queue and a steady clock sends them. If Bluetooth falls behind, the oldest
// audio is dropped so the vibration doesn't lag further and further.

import type { DualSense } from '../device/hid'
import type { HapticEngine } from './engine'
import { BT_HAPTICS_FRAMES, BT_HAPTICS_RATE } from '../device/outputReport'
import { Biquad, SAMPLE_RATE } from './dsp'

const DECIMATE = SAMPLE_RATE / BT_HAPTICS_RATE // 16
const PACKET_MS = (1000 * BT_HAPTICS_FRAMES) / BT_HAPTICS_RATE // 10.67
/** packets held back before sending starts, to ride out jitter */
const PREBUFFER = 2
/** most packets ever waiting; past this the oldest go (keeps latency down) */
const MAX_QUEUE = 6
/** sends allowed to be pending on Bluetooth at once */
const MAX_IN_FLIGHT = 3

/** 4th-order Butterworth low-pass as two biquads: keeps the decimation from folding high content down. */
function antiAlias() {
  return [0.541, 1.307].map((q) => {
    const b = new Biquad()
    b.setLowpass(1200, q)
    return b
  })
}

export interface BtHapticsStats {
  /** packets sent in the last second */
  sentPerSec: number
  /** average time a send took, ms */
  sendMs: number
  /** packets thrown away because Bluetooth fell behind (since start) */
  dropped: number
  /** clock ticks with nothing to send: the controller got a gap (since start) */
  gaps: number
}

export class BtHapticsStreamer {
  private off: (() => void) | null = null
  private timer = 0
  private filters = [antiAlias(), antiAlias()]
  private phase = 0
  private acc = new Uint8Array(BT_HAPTICS_FRAMES * 2)
  private accFrames = 0
  private queue: Uint8Array[] = []
  private started = false
  private nextDue = 0
  private counter = 0
  private inFlight = 0
  private sentTimes: number[] = []
  private sendMsAvg = 0
  private dropped = 0
  private gaps = 0
  /** gain applied before 8-bit quantisation (the 8-bit path has little headroom) */
  gain = 1

  get active() {
    return !!this.off
  }

  get stats(): BtHapticsStats {
    const now = performance.now()
    this.sentTimes = this.sentTimes.filter((t) => now - t < 1000)
    return { sentPerSec: this.sentTimes.length, sendMs: this.sendMsAvg, dropped: this.dropped, gaps: this.gaps }
  }

  start(engine: HapticEngine, ds: DualSense) {
    this.stop()
    this.dropped = this.gaps = 0
    this.off = engine.onBlock((L, R) => {
      const [fl, fr] = this.filters
      for (let i = 0; i < L.length; i++) {
        // filter every sample, keep every 16th
        const l = fl[1].process(fl[0].process(L[i]))
        const r = fr[1].process(fr[0].process(R[i]))
        if (++this.phase < DECIMATE) continue
        this.phase = 0
        this.acc[this.accFrames * 2] = toS8(l * this.gain)
        this.acc[this.accFrames * 2 + 1] = toS8(r * this.gain)
        if (++this.accFrames === BT_HAPTICS_FRAMES) {
          this.queue.push(this.acc.slice())
          if (this.queue.length > MAX_QUEUE) {
            this.queue.shift()
            this.dropped++
          }
          this.accFrames = 0
        }
      }
    })
    // the clock: check often, send exactly on the 10.67 ms grid
    this.timer = window.setInterval(() => this.tick(ds), 2)
  }

  private tick(ds: DualSense) {
    if (!this.started) {
      if (this.queue.length < PREBUFFER) return
      this.started = true
      this.nextDue = performance.now()
    }
    const now = performance.now()
    while (now >= this.nextDue) {
      this.nextDue += PACKET_MS
      // far behind (tab was in the background): restart the grid instead of bursting
      if (now - this.nextDue > 100) this.nextDue = now + PACKET_MS
      const pkt = this.queue.shift()
      if (!pkt) {
        this.gaps++
        // ran dry: wait for a fresh prebuffer before going again
        this.started = false
        return
      }
      if (this.inFlight >= MAX_IN_FLIGHT) {
        this.dropped++
        continue
      }
      this.send(ds, pkt)
    }
  }

  private send(ds: DualSense, pkt: Uint8Array) {
    const t0 = performance.now()
    this.inFlight++
    ds.sendBtHaptics(pkt, this.counter++)
      .catch((e) => console.warn('BT haptics send failed', e))
      .finally(() => {
        this.inFlight--
        const t1 = performance.now()
        this.sentTimes.push(t1)
        this.sendMsAvg = this.sendMsAvg * 0.9 + (t1 - t0) * 0.1
      })
  }

  stop() {
    this.off?.()
    this.off = null
    window.clearInterval(this.timer)
    this.timer = 0
    this.queue = []
    this.started = false
    this.accFrames = 0
    this.phase = 0
  }
}

/** -1..1 → signed 8-bit (as a byte) with TPDF dither, so quiet detail turns into fine noise, not steps. */
function toS8(v: number) {
  // true silence stays silent: no dither hiss in the grips at rest
  if (Math.abs(v) < 1e-4) return 0
  const d = (Math.random() - Math.random()) / 127
  return Math.max(-128, Math.min(127, Math.round((v + d) * 127))) & 0xff
}

export const btHaptics = new BtHapticsStreamer()
