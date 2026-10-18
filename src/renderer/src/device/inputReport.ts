// Parsing of DualSense input reports.
// Layout follows Linux drivers/hid/hid-playstation.c `struct dualsense_input_report`.
// WebHID delivers `data` WITHOUT the report-ID byte, so offsets below are relative
// to the start of that struct.
//
//   USB report 0x01 (63 data bytes): struct starts at data[0]
//   BT  report 0x31 (77 data bytes): data[0] is a sequence/tag byte, struct at data[1]
//   BT  report 0x01 (9 data bytes):  "simple" mode before calibration is read; sticks,
//                                    buttons and triggers only (different layout)

export type ButtonName =
  | 'cross' | 'circle' | 'square' | 'triangle'
  | 'l1' | 'r1' | 'l2' | 'r2' | 'l3' | 'r3'
  | 'create' | 'options' | 'ps' | 'touchpad' | 'mute'
  | 'dpadUp' | 'dpadDown' | 'dpadLeft' | 'dpadRight'
  | 'fnLeft' | 'fnRight' | 'paddleLeft' | 'paddleRight'

export const BUTTON_NAMES: ButtonName[] = [
  'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
  'create', 'options', 'ps', 'touchpad', 'mute',
  'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight',
  'fnLeft', 'fnRight', 'paddleLeft', 'paddleRight',
]

export interface TouchPoint {
  active: boolean
  id: number
  /** 0..1919 */
  x: number
  /** 0..1079 */
  y: number
}

export interface InputState {
  /** -1..1, +x right */
  leftStick: { x: number; y: number }
  /** -1..1, +y down (raw HID convention) */
  rightStick: { x: number; y: number }
  /** 0..1 analog trigger travel */
  l2: number
  r2: number
  buttons: Record<ButtonName, boolean>
  /** raw (or calibrated if a calibration is supplied) gyro, deg/s, [pitch(x), yaw(y), roll(z)] */
  gyro: [number, number, number]
  /** accel in g, [x, y, z] */
  accel: [number, number, number]
  /** sensor timestamp in microseconds (wraps), 0 if unavailable */
  sensorTimestamp: number
  touch: [TouchPoint, TouchPoint]
  /** 0..100 */
  battery: number
  charging: boolean
  /** true when the full report (with IMU/touch) is available */
  full: boolean
}

export interface ImuCalibration {
  gyro: { bias: number; numer: number; denom: number }[]
  accel: { bias: number; numer: number; denom: number }[]
}

/** Resolution of calibrated values, as in hid-playstation. */
export const GYRO_RES_PER_DEG_S = 1024
export const ACC_RES_PER_G = 8192

export function emptyInputState(): InputState {
  const buttons = {} as Record<ButtonName, boolean>
  for (const b of BUTTON_NAMES) buttons[b] = false
  return {
    leftStick: { x: 0, y: 0 },
    rightStick: { x: 0, y: 0 },
    l2: 0,
    r2: 0,
    buttons,
    gyro: [0, 0, 0],
    accel: [0, 1, 0],
    sensorTimestamp: 0,
    touch: [
      { active: false, id: 0, x: 0, y: 0 },
      { active: false, id: 0, x: 0, y: 0 },
    ],
    battery: 0,
    charging: false,
    full: false,
  }
}

const axis = (v: number) => Math.max(-1, Math.min(1, (v - 128) / 127))

function applyHat(hat: number, s: InputState) {
  // 0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW 8=released
  s.buttons.dpadUp = hat === 0 || hat === 1 || hat === 7
  s.buttons.dpadRight = hat === 1 || hat === 2 || hat === 3
  s.buttons.dpadDown = hat === 3 || hat === 4 || hat === 5
  s.buttons.dpadLeft = hat === 5 || hat === 6 || hat === 7
}

function applyButtons(b0: number, b1: number, b2: number, s: InputState) {
  applyHat(b0 & 0x0f, s)
  s.buttons.square = !!(b0 & 0x10)
  s.buttons.cross = !!(b0 & 0x20)
  s.buttons.circle = !!(b0 & 0x40)
  s.buttons.triangle = !!(b0 & 0x80)
  s.buttons.l1 = !!(b1 & 0x01)
  s.buttons.r1 = !!(b1 & 0x02)
  s.buttons.l2 = !!(b1 & 0x04)
  s.buttons.r2 = !!(b1 & 0x08)
  s.buttons.create = !!(b1 & 0x10)
  s.buttons.options = !!(b1 & 0x20)
  s.buttons.l3 = !!(b1 & 0x40)
  s.buttons.r3 = !!(b1 & 0x80)
  s.buttons.ps = !!(b2 & 0x01)
  s.buttons.touchpad = !!(b2 & 0x02)
  s.buttons.mute = !!(b2 & 0x04)
  // DualSense Edge only
  s.buttons.fnLeft = !!(b2 & 0x10)
  s.buttons.fnRight = !!(b2 & 0x20)
  s.buttons.paddleLeft = !!(b2 & 0x40)
  s.buttons.paddleRight = !!(b2 & 0x80)
}

function calibrate(raw: number, c: { bias: number; numer: number; denom: number } | undefined, fallbackScale: number) {
  if (!c || c.denom === 0) return raw * fallbackScale
  return ((raw - c.bias) * c.numer) / c.denom
}

/** Parse the full input struct starting at `o` within `d`. */
function parseFull(d: DataView, o: number, s: InputState, cal?: ImuCalibration) {
  s.leftStick.x = axis(d.getUint8(o + 0))
  s.leftStick.y = axis(d.getUint8(o + 1))
  s.rightStick.x = axis(d.getUint8(o + 2))
  s.rightStick.y = axis(d.getUint8(o + 3))
  s.l2 = d.getUint8(o + 4) / 255
  s.r2 = d.getUint8(o + 5) / 255
  applyButtons(d.getUint8(o + 7), d.getUint8(o + 8), d.getUint8(o + 9), s)

  // Uncalibrated fallback: the sensor's native resolution is ~16.4 LSB per deg/s
  // (±2000 dps over int16) and ~8192 LSB per g.
  for (let i = 0; i < 3; i++) {
    const g = d.getInt16(o + 15 + i * 2, true)
    const a = d.getInt16(o + 21 + i * 2, true)
    s.gyro[i] = calibrate(g, cal?.gyro[i], GYRO_RES_PER_DEG_S / 16.384) / GYRO_RES_PER_DEG_S
    s.accel[i] = calibrate(a, cal?.accel[i], 1) / ACC_RES_PER_G
  }
  s.sensorTimestamp = d.getUint32(o + 27, true)

  for (let i = 0; i < 2; i++) {
    const p = o + 32 + i * 4
    const contact = d.getUint8(p)
    const b1 = d.getUint8(p + 1)
    const b2 = d.getUint8(p + 2)
    const b3 = d.getUint8(p + 3)
    const t = s.touch[i]
    t.active = !(contact & 0x80)
    t.id = contact & 0x7f
    t.x = b1 | ((b2 & 0x0f) << 8)
    t.y = (b2 >> 4) | (b3 << 4)
  }

  const status = d.getUint8(o + 52)
  const cap = status & 0x0f
  const chg = (status & 0xf0) >> 4
  s.charging = chg === 0x1
  s.battery = chg === 0x2 ? 100 : Math.min(cap * 10 + 5, 100)
  s.full = true
}

/** BT "simple" report 0x01, sent before the calibration feature report is read. */
function parseSimpleBt(d: DataView, s: InputState) {
  s.leftStick.x = axis(d.getUint8(0))
  s.leftStick.y = axis(d.getUint8(1))
  s.rightStick.x = axis(d.getUint8(2))
  s.rightStick.y = axis(d.getUint8(3))
  applyButtons(d.getUint8(4), d.getUint8(5), d.getUint8(6), s)
  s.l2 = d.getUint8(7) / 255
  s.r2 = d.getUint8(8) / 255
  s.full = false
}

/**
 * Parse a WebHID input report into `out` (mutated, also returned).
 * Returns null for unknown reports.
 */
export function parseInputReport(
  reportId: number,
  data: DataView,
  out: InputState,
  cal?: ImuCalibration,
): InputState | null {
  if (reportId === 0x01 && data.byteLength >= 63) {
    parseFull(data, 0, out, cal)
    return out
  }
  if (reportId === 0x31 && data.byteLength >= 54) {
    // Low nibble of data[0] is the packet type: 1 = controller state (0 on some firmware).
    // While Bluetooth haptics run in report 0x39 the controller also sends microphone audio
    // as 0x31 reports of another type (31 x2 ...); read as state, it's phantom button presses.
    const kind = data.getUint8(0) & 0x0f
    if (kind > 1) return null
    parseFull(data, 1, out, cal)
    return out
  }
  if (reportId === 0x01 && data.byteLength >= 9) {
    parseSimpleBt(data, out)
    return out
  }
  return null
}

/**
 * Parse the calibration feature report 0x05 (hid-playstation dualsense_get_calibration_data).
 * `buf` must start with the report-ID byte (0x05); pass `hasReportId=false` if it does not.
 */
export function parseCalibration(bytes: Uint8Array, hasReportId = true): ImuCalibration {
  const buf = hasReportId ? bytes : Uint8Array.from([0x05, ...bytes])
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const s16 = (o: number) => dv.getInt16(o, true)

  const gyroPitchBias = s16(1)
  const gyroYawBias = s16(3)
  const gyroRollBias = s16(5)
  const gyroPitchPlus = s16(7)
  const gyroPitchMinus = s16(9)
  const gyroYawPlus = s16(11)
  const gyroYawMinus = s16(13)
  const gyroRollPlus = s16(15)
  const gyroRollMinus = s16(17)
  const gyroSpeedPlus = s16(19)
  const gyroSpeedMinus = s16(21)
  const accXPlus = s16(23)
  const accXMinus = s16(25)
  const accYPlus = s16(27)
  const accYMinus = s16(29)
  const accZPlus = s16(31)
  const accZMinus = s16(33)

  const speed2x = gyroSpeedPlus + gyroSpeedMinus
  const gyro = [
    { bias: gyroPitchBias, numer: speed2x * GYRO_RES_PER_DEG_S, denom: gyroPitchPlus - gyroPitchMinus },
    { bias: gyroYawBias, numer: speed2x * GYRO_RES_PER_DEG_S, denom: gyroYawPlus - gyroYawMinus },
    { bias: gyroRollBias, numer: speed2x * GYRO_RES_PER_DEG_S, denom: gyroRollPlus - gyroRollMinus },
  ]
  const acc = (plus: number, minus: number) => {
    const range2g = plus - minus
    return { bias: plus - range2g / 2, numer: 2 * ACC_RES_PER_G, denom: range2g }
  }
  const accel = [acc(accXPlus, accXMinus), acc(accYPlus, accYMinus), acc(accZPlus, accZMinus)]

  // Guard against garbage calibration (seen on some clones): fall back to identity.
  const sane = [...gyro, ...accel].every((c) => c.denom !== 0 && Math.abs(c.numer / c.denom) < 1e4)
  if (!sane) {
    return {
      gyro: [0, 1, 2].map(() => ({ bias: 0, numer: GYRO_RES_PER_DEG_S, denom: 16 })),
      accel: [0, 1, 2].map(() => ({ bias: 0, numer: 1, denom: 1 })),
    }
  }
  return { gyro, accel }
}
