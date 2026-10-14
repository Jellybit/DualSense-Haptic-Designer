// EXPERIMENTAL: stream the synth output to a Bluetooth-connected DualSense.
// The engine's 48 kHz output is decimated to 3 kHz (low-passed by block averaging),
// converted to unsigned 8-bit stereo and sent 32 frames at a time in report 0x32.
// Pacing follows the audio clock: blocks arrive from the worklet in real time.

import type { DualSense } from '../device/hid'
import type { HapticEngine } from './engine'
import { BT_HAPTICS_FRAMES, BT_HAPTICS_RATE } from '../device/outputReport'
import { SAMPLE_RATE } from './dsp'

const DECIMATE = SAMPLE_RATE / BT_HAPTICS_RATE // 16

export class BtHapticsStreamer {
  private off: (() => void) | null = null
  private acc = new Uint8Array(BT_HAPTICS_FRAMES * 2)
  private accFrames = 0
  private counter = 0
  private sumL = 0
  private sumR = 0
  private sumN = 0
  private inFlight = 0
  dropped = 0
  /** gain applied before 8-bit quantisation (the 8-bit path has little headroom) */
  gain = 1

  get active() {
    return !!this.off
  }

  start(engine: HapticEngine, ds: DualSense) {
    this.stop()
    this.off = engine.onBlock((L, R) => {
      for (let i = 0; i < L.length; i++) {
        this.sumL += L[i]
        this.sumR += R[i]
        if (++this.sumN === DECIMATE) {
          const l = Math.max(-1, Math.min(1, (this.sumL / DECIMATE) * this.gain))
          const r = Math.max(-1, Math.min(1, (this.sumR / DECIMATE) * this.gain))
          this.acc[this.accFrames * 2] = Math.round(128 + l * 127)
          this.acc[this.accFrames * 2 + 1] = Math.round(128 + r * 127)
          this.sumL = this.sumR = this.sumN = 0
          if (++this.accFrames === BT_HAPTICS_FRAMES) {
            this.flush(ds)
            this.accFrames = 0
          }
        }
      }
    })
  }

  private flush(ds: DualSense) {
    // Never queue more than a few packets — late haptics are worse than dropped ones.
    if (this.inFlight > 3) {
      this.dropped++
      return
    }
    const pkt = this.acc.slice()
    this.inFlight++
    ds.sendBtHaptics(pkt, this.counter++)
      .catch((e) => console.warn('BT haptics send failed', e))
      .finally(() => this.inFlight--)
  }

  stop() {
    this.off?.()
    this.off = null
    this.accFrames = 0
  }
}

export const btHaptics = new BtHapticsStreamer()
