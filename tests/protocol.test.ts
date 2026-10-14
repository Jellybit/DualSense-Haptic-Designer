import { describe, expect, it } from 'vitest'
import { crc32, crc32Seeded } from '../src/renderer/src/device/crc32'
import { decodeTrigger, effectProfile, encodeTrigger, slopeStrengths } from '../src/renderer/src/device/triggerEffects'
import { buildBtHaptics, buildBtOutput, buildCommon, buildUsbOutput } from '../src/renderer/src/device/outputReport'
import { emptyInputState, parseCalibration, parseInputReport } from '../src/renderer/src/device/inputReport'
import { makePreset, parsePresets, serializePresets } from '../src/renderer/src/export/presets'

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0xcbf43926)
  })
  it('seeded variant equals CRC of the prefixed buffer', () => {
    const data = [1, 2, 3, 4, 5]
    expect(crc32Seeded(0xa2, data)).toBe(crc32([0xa2, ...data]))
  })
  it('matches SAxense precomputed seed state (~0xEADA2D49 after 0xA2)', () => {
    // SAxense starts from ~0xEADA2D49, i.e. the raw register after hashing [0xA2].
    // CRC of the empty payload must therefore be ~(~0xEADA2D49) = 0xEADA2D49.
    expect(crc32Seeded(0xa2, [])).toBe(0xeada2d49)
  })
})

describe('trigger effects', () => {
  it('encodes Off', () => {
    expect(encodeTrigger({ type: 'off' })).toEqual([0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('encodes Feedback(position 0, strength 8) like the reference generator', () => {
    // all 10 zones active (0x3FF), force 7 in every 3-bit slot
    const b = encodeTrigger({ type: 'feedback', position: 0, strength: 8 })
    expect(b[0]).toBe(0x21)
    expect(b[1] | (b[2] << 8)).toBe(0x3ff)
    const packed = (b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) >>> 0
    expect(packed).toBe(0x3fffffff)
  })

  it('encodes Weapon start/end/strength', () => {
    expect(encodeTrigger({ type: 'weapon', start: 2, end: 5, strength: 8 })).toEqual([0x25, 0x24, 0x00, 7, 0, 0, 0, 0, 0, 0, 0])
  })

  it('encodes Vibration with frequency at byte 9', () => {
    const b = encodeTrigger({ type: 'vibration', position: 5, amplitude: 4, frequency: 40 })
    expect(b[0]).toBe(0x26)
    expect(b[1] | (b[2] << 8)).toBe(0b1111100000)
    expect(b[9]).toBe(40)
  })

  it('round-trips multi-feedback through decode', () => {
    const strengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0]
    const d = decodeTrigger(encodeTrigger({ type: 'multiFeedback', strengths }))
    expect(d).toEqual({ type: 'multiFeedback', strengths })
  })

  it('slope ramps between strengths', () => {
    expect(slopeStrengths(0, 9, 1, 8)).toEqual([1, 2, 3, 4, 5, 5, 6, 7, 8, 8].map((_, i) => Math.round(1 + (7 * i) / 9)))
  })

  it('profile graph is zero before feedback start', () => {
    const { force } = effectProfile({ type: 'feedback', position: 5, strength: 8 }, 100)
    expect(force[10]).toBe(0)
    expect(force[90]).toBe(1)
  })

  it('preset JSON round-trips bytes', () => {
    const list = [
      makePreset('Pistol', 'R2', { type: 'weapon', start: 4, end: 7, strength: 8 }),
      makePreset('Ramp', 'L2', { type: 'forceCurve', points: [{ x: 1, y: 0 }, { x: 9, y: 8 }] }),
      makePreset('Gallop', 'both', { type: 'galloping', start: 0, end: 9, firstFoot: 2, secondFoot: 5, frequency: 3 }),
    ]
    const back = parsePresets(serializePresets(list))
    expect(back.map((p) => p.raw)).toEqual(list.map((p) => encodeTrigger(p.effect)))
  })
})

describe('output reports', () => {
  it('switches the controller audio between headphone jack and speaker', () => {
    const sp = buildCommon({ audioOutput: 'speaker' })
    expect(sp[0] & 0xa0).toBe(0xa0) // audio control + speaker volume valid
    expect(sp[1] & 0x80).toBe(0x80) // audio control 2 valid
    expect([sp[5], sp[7], sp[37]]).toEqual([0x64, 0x30, 0x02])
    const hp = buildCommon({ audioOutput: 'headphones' })
    expect(hp[0]).toBe(0x80)
    expect(hp[7]).toBe(0)
  })

  it('places trigger blocks and flags in the common block', () => {
    const c = buildCommon({ rightTrigger: [0x21, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], leftTrigger: [0x26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], lightbar: [1, 2, 3] })
    expect(c.length).toBe(47)
    expect(c[0]).toBe(0x0c)
    expect(c[1]).toBe(0x04)
    expect(c[10]).toBe(0x21)
    expect(c[20]).toBe(10)
    expect(c[21]).toBe(0x26)
    expect([c[44], c[45], c[46]]).toEqual([1, 2, 3])
  })

  it('pads USB report to the descriptor size', () => {
    expect(buildUsbOutput({}, 63).length).toBe(63)
  })

  it('BT output report carries a valid CRC', () => {
    const data = buildBtOutput({ lightbar: [255, 0, 0] }, 3)
    expect(data.length).toBe(77)
    expect(data[0]).toBe(0x30)
    expect(data[1]).toBe(0x10)
    const full = [0x31, ...data]
    const crc = crc32Seeded(0xa2, full, 0, 74)
    expect(data[73] | (data[74] << 8) | (data[75] << 16) | (data[76] << 24)).toBe(crc | 0)
  })

  it('BT haptics report matches the SAxense layout', () => {
    const samples = new Uint8Array(64).map((_, i) => i)
    const d = buildBtHaptics(samples, 9)
    const full = [0x32, ...d]
    expect(full.length).toBe(141)
    expect(full.slice(1, 13)).toEqual([0x00, 0x91, 7, 0xfe, 0, 0, 0, 0, 0xff, 9, 0x92, 64])
    expect(full[13]).toBe(0)
    expect(full[76]).toBe(63)
    const crc = crc32Seeded(0xa2, full, 0, 137)
    expect((full[137] | (full[138] << 8) | (full[139] << 16) | (full[140] << 24)) >>> 0).toBe(crc)
  })
})

describe('input report', () => {
  const usbReport = () => {
    const d = new Uint8Array(63)
    d[0] = 255 // LX full right
    d[1] = 0 // LY full up
    d[2] = 128
    d[3] = 128
    d[4] = 128 // L2 ~half
    d[5] = 255 // R2 full
    d[7] = 0x20 | 0x08 // cross + hat=8 (released)
    d[8] = 0x01 | 0x20 // L1 + options
    d[9] = 0x02 // touchpad click
    // accel y = +8192 (1 g)
    new DataView(d.buffer).setInt16(23, 8192, true)
    // touch point 0 active at (1000, 500)
    d[32] = 0x05
    d[33] = 1000 & 0xff
    d[34] = ((1000 >> 8) & 0x0f) | ((500 & 0x0f) << 4)
    d[35] = 500 >> 4
    d[36] = 0x80 // touch 1 inactive
    d[52] = 0x05 // battery 50%, discharging
    return d
  }

  it('parses sticks, triggers, buttons, touch, battery', () => {
    const s = parseInputReport(0x01, new DataView(usbReport().buffer), emptyInputState())!
    expect(s.leftStick.x).toBeCloseTo(1, 1)
    expect(s.leftStick.y).toBeCloseTo(-1, 1)
    expect(s.r2).toBe(1)
    expect(s.l2).toBeCloseTo(0.5, 1)
    expect(s.buttons.cross).toBe(true)
    expect(s.buttons.circle).toBe(false)
    expect(s.buttons.dpadUp).toBe(false)
    expect(s.buttons.l1).toBe(true)
    expect(s.buttons.options).toBe(true)
    expect(s.buttons.touchpad).toBe(true)
    expect(s.accel[1]).toBeCloseTo(1, 3)
    expect(s.touch[0]).toEqual({ active: true, id: 5, x: 1000, y: 500 })
    expect(s.touch[1].active).toBe(false)
    expect(s.battery).toBe(55)
    expect(s.full).toBe(true)
  })

  it('parses BT 0x31 with a 1-byte offset', () => {
    const usb = usbReport()
    const bt = new Uint8Array(77)
    bt.set(usb, 1)
    const s = parseInputReport(0x31, new DataView(bt.buffer), emptyInputState())!
    expect(s.buttons.cross).toBe(true)
    expect(s.touch[0].x).toBe(1000)
  })

  it('decodes d-pad hat', () => {
    const d = usbReport()
    d[7] = 0x01 // NE
    const s = parseInputReport(0x01, new DataView(d.buffer), emptyInputState())!
    expect(s.buttons.dpadUp && s.buttons.dpadRight).toBe(true)
    expect(s.buttons.dpadDown || s.buttons.dpadLeft).toBe(false)
  })

  it('applies calibration', () => {
    const buf = new Uint8Array(41)
    const v = new DataView(buf.buffer)
    buf[0] = 0x05
    // gyro biases 0; plus/minus ±8000; speed ±500
    for (const o of [7, 11, 15]) v.setInt16(o, 8000, true)
    for (const o of [9, 13, 17]) v.setInt16(o, -8000, true)
    v.setInt16(19, 500, true)
    v.setInt16(21, 500, true)
    // accel ±8192
    for (const o of [23, 27, 31]) v.setInt16(o, 8192, true)
    for (const o of [25, 29, 33]) v.setInt16(o, -8192, true)
    const cal = parseCalibration(buf)
    const d = usbReport()
    new DataView(d.buffer).setInt16(15, 1600, true) // gyro x raw
    const s = parseInputReport(0x01, new DataView(d.buffer), emptyInputState(), cal)!
    // 1600 raw * (1000 / 16000) = 100 deg/s
    expect(s.gyro[0]).toBeCloseTo(100, 3)
    expect(s.accel[1]).toBeCloseTo(1, 3)
  })
})
