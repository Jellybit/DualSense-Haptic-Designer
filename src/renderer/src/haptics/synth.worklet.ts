/// <reference path="./worklet-globals.d.ts" />
// AudioWorklet processor: hosts the HapticMixer. Output: 1 output, 2 channels (L/R actuator).

import { HapticMixer, type MixerMessage } from './mixer'

const TAP_BLOCK = 1024

class HapticSynthProcessor extends AudioWorkletProcessor {
  private mixer = new HapticMixer(sampleRate)
  private tap = false
  private tapL = new Float32Array(TAP_BLOCK)
  private tapR = new Float32Array(TAP_BLOCK)
  private tapPos = 0
  private meterCounter = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<MixerMessage | MixerMessage[]>) => {
      const msgs = Array.isArray(e.data) ? e.data : [e.data]
      for (const m of msgs) {
        if (m.t === 'tap') {
          this.tap = m.on
          this.tapPos = 0
        } else this.mixer.handle(m)
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] ?? new Float32Array(L.length)
    const finished = this.mixer.process(L, R)
    for (const id of finished) this.port.postMessage({ t: 'ended', id })

    if (this.tap) {
      let i = 0
      while (i < L.length) {
        const n = Math.min(L.length - i, TAP_BLOCK - this.tapPos)
        this.tapL.set(L.subarray(i, i + n), this.tapPos)
        this.tapR.set(R.subarray(i, i + n), this.tapPos)
        this.tapPos += n
        i += n
        if (this.tapPos === TAP_BLOCK) {
          this.port.postMessage({ t: 'block', L: this.tapL, R: this.tapR }, [this.tapL.buffer, this.tapR.buffer])
          this.tapL = new Float32Array(TAP_BLOCK)
          this.tapR = new Float32Array(TAP_BLOCK)
          this.tapPos = 0
        }
      }
    }

    // ~30 Hz meter + playhead updates
    if (++this.meterCounter >= Math.round(sampleRate / 128 / 30)) {
      this.meterCounter = 0
      this.port.postMessage({ t: 'meter', l: this.mixer.peakL, r: this.mixer.peakR, pos: this.mixer.positions() })
    }
    return true
  }
}

registerProcessor('haptic-synth', HapticSynthProcessor)
