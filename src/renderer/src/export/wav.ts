// WAV encode/decode (16-bit PCM).
//
// Haptic WAV conventions for game engines:
//  - "stereo": 2 ch, ch1 = left actuator, ch2 = right actuator. This is the layout used by
//    Sony's tooling and by Unity/Unreal/Wwise DualSense haptics paths that take a
//    vibration WAV.
//  - "quad": 4 ch matching the USB audio device directly: ch1/ch2 = speaker/headset
//    (silent), ch3/ch4 = left/right actuator. Play it straight to the controller's
//    audio endpoint on PC.

export type WavLayout = 'stereo' | 'quad'

export function encodeWav(L: Float32Array, R: Float32Array, sampleRate: number, layout: WavLayout = 'stereo'): Uint8Array {
  const channels = layout === 'quad' ? 4 : 2
  const frames = L.length
  const dataBytes = frames * channels * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, dataBytes, true)
  const q = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)))
  let o = 44
  for (let i = 0; i < frames; i++) {
    if (layout === 'quad') {
      v.setInt16(o, 0, true)
      v.setInt16(o + 2, 0, true)
      o += 4
    }
    v.setInt16(o, q(L[i]), true)
    v.setInt16(o + 2, q(R[i]), true)
    o += 4
  }
  return new Uint8Array(buf)
}

/** 16-bit PCM WAV with any number of channels (all arrays the same length). */
export function encodeWavChannels(channels: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const nCh = channels.length
  const frames = channels[0].length
  const dataBytes = frames * nCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, nCh, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * nCh * 2, true)
  v.setUint16(32, nCh * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, dataBytes, true)
  let o = 44
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nCh; c++) {
      v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767))), true)
      o += 2
    }
  return new Uint8Array(buf)
}

export interface DecodedAudio {
  sampleRate: number
  channels: Float32Array[]
}

/** Decode PCM WAV (8/16/24/32-bit int or 32-bit float). */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file')
  let o = 12
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = v.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      let format = v.getUint16(body, true)
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true) // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk')
      const bps = fmt.bits / 8
      const frames = Math.floor(Math.min(size, bytes.length - body) / (bps * fmt.channels))
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
      let p = body
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          let s: number
          if (fmt.format === 3 && fmt.bits === 32) s = v.getFloat32(p, true)
          else if (fmt.bits === 8) s = (v.getUint8(p) - 128) / 128
          else if (fmt.bits === 16) s = v.getInt16(p, true) / 32768
          else if (fmt.bits === 24) s = ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608)
          else if (fmt.bits === 32) s = v.getInt32(p, true) / 2147483648
          else throw new Error(`Unsupported WAV bit depth ${fmt.bits}`)
          chans[c][i] = s
          p += bps
        }
      }
      return { sampleRate: fmt.rate, channels: chans }
    }
    o = body + size + (size & 1)
  }
  throw new Error('WAV has no data chunk')
}

/** Linear-interpolation resample. Good enough for haptic-band content. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x
  const n = Math.round((x.length * to) / from)
  const y = new Float32Array(n)
  const r = from / to
  for (let i = 0; i < n; i++) {
    const p = i * r
    const i0 = Math.floor(p)
    const f = p - i0
    y[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? x[i0] ?? 0) * f
  }
  return y
}

/**
 * Pick L/R actuator channels from a decoded file: 4ch → ch3/ch4, 2ch → ch1/ch2, 1ch → both.
 */
export function hapticChannels(a: DecodedAudio): { L: Float32Array; R: Float32Array } {
  const c = a.channels
  if (c.length >= 4) return { L: c[2], R: c[3] }
  if (c.length >= 2) return { L: c[0], R: c[1] }
  return { L: c[0], R: c[0] }
}
