// Adaptive-trigger effect encoders/decoders.
//
// Each trigger takes 11 bytes in the output report: [mode, p0..p9].
// The encodings follow Nielk1's widely used "TriggerEffectGenerator" reference
// (the same encodings Sony's own factory effects produce). Trigger travel is divided
// into 10 zones (0 = rest, 9 = fully pulled); most effects set a 3-bit force or
// amplitude per zone.

export const TriggerMode = {
  Off: 0x05,
  Feedback: 0x21,
  Bow: 0x22,
  Galloping: 0x23,
  Weapon: 0x25,
  Vibration: 0x26,
  Machine: 0x27,
  // "Simple"/"Limited" variants used by some titles; exposed through the raw editor
  SimpleFeedback: 0x01,
  SimpleWeapon: 0x02,
  SimpleVibration: 0x06,
  LimitedFeedback: 0x11,
  LimitedWeapon: 0x12,
} as const

/** Designer-level effect description (what presets store). */
export type TriggerEffect =
  | { type: 'off' }
  /** Constant resistance from `position` (0-9) to the end. strength 1-8 */
  | { type: 'feedback'; position: number; strength: number }
  /** Resistance between start (2-7) and end (start+1..8) that snaps like a gun trigger. strength 1-8 */
  | { type: 'weapon'; start: number; end: number; strength: number }
  /** Vibration from `position` (0-9) onwards. amplitude 1-8, frequency 1-255 Hz */
  | { type: 'vibration'; position: number; amplitude: number; frequency: number }
  /** Independent resistance per zone, each 0-8 (0 = none) */
  | { type: 'multiFeedback'; strengths: number[] }
  /** Linear ramp of resistance from start to end zone. strengths 1-8 */
  | { type: 'slope'; start: number; end: number; startStrength: number; endStrength: number }
  /** Independent vibration amplitude per zone 0-8, shared frequency */
  | { type: 'multiVibration'; frequency: number; amplitudes: number[] }
  /** Bow string: tension between start and end, then a snap back. */
  | { type: 'bow'; start: number; end: number; strength: number; snapForce: number }
  /** Galloping horse rhythm. */
  | { type: 'galloping'; start: number; end: number; firstFoot: number; secondFoot: number; frequency: number }
  /** Machine: alternating amplitudes A/B with a period. */
  | { type: 'machine'; start: number; end: number; amplitudeA: number; amplitudeB: number; frequency: number; period: number }
  /** Raw 11 bytes for experimentation. */
  | { type: 'raw'; bytes: number[] }

export type TriggerEffectType = TriggerEffect['type']

export const EFFECT_LABELS: Record<TriggerEffectType, string> = {
  off: 'Off',
  feedback: 'Feedback (resistance)',
  weapon: 'Weapon (click/snap)',
  vibration: 'Vibration',
  multiFeedback: 'Multi-position feedback',
  slope: 'Slope feedback',
  multiVibration: 'Multi-position vibration',
  bow: 'Bow',
  galloping: 'Galloping',
  machine: 'Machine',
  raw: 'Raw bytes',
}

export function defaultEffect(type: TriggerEffectType): TriggerEffect {
  switch (type) {
    case 'off': return { type }
    case 'feedback': return { type, position: 3, strength: 6 }
    case 'weapon': return { type, start: 3, end: 6, strength: 8 }
    case 'vibration': return { type, position: 2, amplitude: 6, frequency: 30 }
    case 'multiFeedback': return { type, strengths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 8] }
    case 'slope': return { type, start: 1, end: 9, startStrength: 1, endStrength: 8 }
    case 'multiVibration': return { type, frequency: 40, amplitudes: [0, 0, 2, 4, 6, 8, 6, 4, 2, 0] }
    case 'bow': return { type, start: 1, end: 6, strength: 6, snapForce: 8 }
    case 'galloping': return { type, start: 1, end: 9, firstFoot: 2, secondFoot: 5, frequency: 4 }
    case 'machine': return { type, start: 1, end: 9, amplitudeA: 4, amplitudeB: 7, frequency: 20, period: 8 }
    case 'raw': return { type, bytes: [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

function zoneBytes(mode: number, active: number, packed: number, tail: number[] = []): number[] {
  const out = [
    mode,
    active & 0xff,
    (active >> 8) & 0xff,
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 24) & 0xff,
    0, 0, 0, 0,
  ]
  tail.forEach((b, i) => (out[7 + i] = b & 0xff))
  return out
}

function multiFeedbackBytes(strengths: number[]): number[] {
  let active = 0
  let forces = 0
  for (let i = 0; i < 10; i++) {
    const s = clamp(strengths[i] ?? 0, 0, 8)
    if (s > 0) {
      forces = (forces | (((s - 1) & 7) << (3 * i))) >>> 0
      active |= 1 << i
    }
  }
  if (active === 0) return encodeTrigger({ type: 'off' })
  return zoneBytes(TriggerMode.Feedback, active, forces)
}

function multiVibrationBytes(frequency: number, amplitudes: number[]): number[] {
  let active = 0
  let amps = 0
  for (let i = 0; i < 10; i++) {
    const a = clamp(amplitudes[i] ?? 0, 0, 8)
    if (a > 0) {
      amps = (amps | (((a - 1) & 7) << (3 * i))) >>> 0
      active |= 1 << i
    }
  }
  const f = clamp(frequency, 0, 255)
  if (active === 0 || f === 0) return encodeTrigger({ type: 'off' })
  return zoneBytes(TriggerMode.Vibration, active, amps, [0, 0, f, 0])
}

/** Per-zone strengths for a slope; also used by the preview graph. */
export function slopeStrengths(start: number, end: number, s0: number, s1: number): number[] {
  const a = clamp(start, 0, 8)
  const b = clamp(end, a + 1, 9)
  const out = new Array(10).fill(0)
  for (let i = a; i <= b; i++) {
    const t = (i - a) / (b - a)
    out[i] = clamp(s0 + (s1 - s0) * t, 1, 8)
  }
  // Slope holds its end strength past the end zone, like Sony's factory effect
  for (let i = b + 1; i < 10; i++) out[i] = clamp(s1, 1, 8)
  return out
}

/** Encode an effect to the 11 bytes written into the output report. */
export function encodeTrigger(e: TriggerEffect): number[] {
  switch (e.type) {
    case 'off':
      return [TriggerMode.Off, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    case 'feedback': {
      const pos = clamp(e.position, 0, 9)
      const s = clamp(e.strength, 0, 8)
      if (s === 0) return encodeTrigger({ type: 'off' })
      const strengths = new Array(10).fill(0).map((_, i) => (i >= pos ? s : 0))
      return multiFeedbackBytes(strengths)
    }
    case 'weapon': {
      const start = clamp(e.start, 2, 7)
      const end = clamp(e.end, start + 1, 8)
      const s = clamp(e.strength, 0, 8)
      if (s === 0) return encodeTrigger({ type: 'off' })
      const zones = (1 << start) | (1 << end)
      return [TriggerMode.Weapon, zones & 0xff, (zones >> 8) & 0xff, s - 1, 0, 0, 0, 0, 0, 0, 0]
    }
    case 'vibration': {
      const pos = clamp(e.position, 0, 9)
      const a = clamp(e.amplitude, 0, 8)
      const amps = new Array(10).fill(0).map((_, i) => (i >= pos ? a : 0))
      return multiVibrationBytes(e.frequency, amps)
    }
    case 'multiFeedback':
      return multiFeedbackBytes(e.strengths)
    case 'slope':
      return multiFeedbackBytes(slopeStrengths(e.start, e.end, e.startStrength, e.endStrength))
    case 'multiVibration':
      return multiVibrationBytes(e.frequency, e.amplitudes)
    case 'bow': {
      const start = clamp(e.start, 0, 8)
      const end = clamp(e.end, start + 1, 8)
      const s = clamp(e.strength, 1, 8)
      const snap = clamp(e.snapForce, 1, 8)
      const zones = (1 << start) | (1 << end)
      const pair = ((s - 1) & 7) | (((snap - 1) & 7) << 3)
      return [TriggerMode.Bow, zones & 0xff, (zones >> 8) & 0xff, pair & 0xff, (pair >> 8) & 0xff, 0, 0, 0, 0, 0, 0]
    }
    case 'galloping': {
      const start = clamp(e.start, 0, 8)
      const end = clamp(e.end, start + 1, 9)
      const first = clamp(e.firstFoot, 0, 6)
      const second = clamp(e.secondFoot, first + 1, 7)
      const f = clamp(e.frequency, 1, 255)
      const zones = (1 << start) | (1 << end)
      const ratio = (second & 7) | ((first & 7) << 3)
      return [TriggerMode.Galloping, zones & 0xff, (zones >> 8) & 0xff, ratio, f, 0, 0, 0, 0, 0, 0]
    }
    case 'machine': {
      const start = clamp(e.start, 0, 8)
      const end = clamp(e.end, start + 1, 9)
      const pair = (clamp(e.amplitudeA, 0, 7) & 7) | ((clamp(e.amplitudeB, 0, 7) & 7) << 3)
      const zones = (1 << start) | (1 << end)
      return [TriggerMode.Machine, zones & 0xff, (zones >> 8) & 0xff, pair, clamp(e.frequency, 1, 255), clamp(e.period, 0, 255), 0, 0, 0, 0, 0]
    }
    case 'raw': {
      const out = new Array(11).fill(0)
      for (let i = 0; i < 11; i++) out[i] = clamp(e.bytes[i] ?? 0, 0, 255)
      return out
    }
  }
}

function unpackZones(b: number[]) {
  const active = b[1] | (b[2] << 8)
  const packed = (b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) >>> 0
  const values = new Array(10).fill(0)
  for (let i = 0; i < 10; i++) if (active & (1 << i)) values[i] = ((packed >>> (3 * i)) & 7) + 1
  return { active, values }
}

/** Best-effort decode of 11 bytes back into an effect (falls back to raw). */
export function decodeTrigger(bytes: number[]): TriggerEffect {
  const b = [...bytes, ...new Array(11).fill(0)].slice(0, 11)
  switch (b[0]) {
    case TriggerMode.Off:
      return { type: 'off' }
    case TriggerMode.Feedback:
      return { type: 'multiFeedback', strengths: unpackZones(b).values }
    case TriggerMode.Vibration:
      return { type: 'multiVibration', frequency: b[9], amplitudes: unpackZones(b).values }
    case TriggerMode.Weapon: {
      const zones = b[1] | (b[2] << 8)
      const set = [...Array(10).keys()].filter((i) => zones & (1 << i))
      if (set.length === 2) return { type: 'weapon', start: set[0], end: set[1], strength: b[3] + 1 }
      break
    }
  }
  return { type: 'raw', bytes: b }
}

/**
 * Approximate force (0..1) and vibration (0..1) along trigger travel, for the preview graph.
 * `samples` points from 0 (rest) to 1 (fully pulled).
 */
export function effectProfile(e: TriggerEffect, samples = 100): { force: number[]; vibration: number[] } {
  const force = new Array(samples).fill(0)
  const vibration = new Array(samples).fill(0)
  const zoneOf = (t: number) => Math.min(9, Math.floor(t * 10))
  const fillZones = (arr: number[], vals: number[]) => {
    for (let i = 0; i < samples; i++) arr[i] = vals[zoneOf(i / (samples - 1))] / 8
  }
  switch (e.type) {
    case 'feedback':
      fillZones(force, new Array(10).fill(0).map((_, i) => (i >= e.position ? e.strength : 0)))
      break
    case 'multiFeedback':
      fillZones(force, e.strengths)
      break
    case 'slope':
      fillZones(force, slopeStrengths(e.start, e.end, e.startStrength, e.endStrength))
      break
    case 'vibration':
      fillZones(vibration, new Array(10).fill(0).map((_, i) => (i >= e.position ? e.amplitude : 0)))
      break
    case 'multiVibration':
      fillZones(vibration, e.amplitudes)
      break
    case 'weapon':
    case 'bow': {
      // Resistance builds from start to end, then releases (snap). Measured against the
      // wall-test calibration: the snap is felt at the END of the end zone (Weapon and Bow),
      // and a Weapon's resistance also begins at the end of its start zone; a Bow's begins
      // at the start of its start zone.
      const begin = e.type === 'weapon' ? e.start + 1 : e.start
      const stop = e.end + 1
      for (let i = 0; i < samples; i++) {
        const z = (i / (samples - 1)) * 10
        force[i] = z >= begin && z < stop ? (e.strength / 8) * (0.5 + (0.5 * (z - begin)) / (stop - begin)) : 0
      }
      break
    }
    case 'galloping':
    case 'machine':
      for (let i = 0; i < samples; i++) {
        const z = (i / (samples - 1)) * 10
        vibration[i] = z >= e.start && z <= e.end ? (e.type === 'machine' ? Math.max(e.amplitudeA, e.amplitudeB) / 7 : 0.7) : 0
      }
      break
    case 'raw': {
      const d = decodeTrigger(e.bytes)
      if (d.type !== 'raw') return effectProfile(d, samples)
      break
    }
  }
  return { force, vibration }
}
