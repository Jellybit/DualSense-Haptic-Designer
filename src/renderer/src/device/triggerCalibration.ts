// Trigger travel calibration: where each of the 10 effect zones actually sits along the
// trigger's analog travel. Effect zones are trigger-motor positions, not analog-sensor
// percent, so without this the graph can only guess (zone z ≈ z/10 of travel).
//
// Measured with a wall test: a strong Feedback effect from zone z is a wall; the user eases
// the trigger in until touching it and holds. A straight line fitted through many holds
// gives the zone table.

import { loadLocal, saveLocal } from '../store'

export interface TriggerCalibration {
  /** Analog travel (0..1) where zone z (0-9) begins, non-decreasing. */
  zones: number[]
  /** The fitted line the table came from, and the raw holds */
  fit: LineFit
  holds: WallHold[]
  measuredAt: string
}

/** Uncalibrated assumption: zone z starts at z/10. */
export const DEFAULT_ZONES = Array.from({ length: 10 }, (_, z) => z / 10)

/** One recorded wall touch: the wall's zone and where the finger settled against it. */
export interface WallHold {
  zone: number
  side: 'L2' | 'R2'
  /** analog 0..1 */
  value: number
}

/** Least-squares line value = intercept + slope × zone. */
export interface LineFit {
  intercept: number
  slope: number
  /** root-mean-square residual, analog 0..1 */
  rms: number
  n: number
}

export function fitLine(holds: WallHold[]): LineFit | null {
  const n = holds.length
  if (n < 2) return null
  const mx = holds.reduce((s, h) => s + h.zone, 0) / n
  const my = holds.reduce((s, h) => s + h.value, 0) / n
  let sxx = 0
  let sxy = 0
  for (const h of holds) {
    sxx += (h.zone - mx) ** 2
    sxy += (h.zone - mx) * (h.value - my)
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const rms = Math.sqrt(holds.reduce((s, h) => s + (h.value - (intercept + slope * h.zone)) ** 2, 0) / n)
  return { intercept, slope, rms, n }
}

/** Zone table (zone 0-9 start positions) from a fitted line, clamped to 0..1 and non-decreasing. */
export function zonesFromFit(fit: LineFit): number[] {
  let prev = 0
  return DEFAULT_ZONES.map((_, z) => (prev = Math.min(1, Math.max(prev, fit.intercept + fit.slope * z))))
}

/**
 * Analog travel (0..1) for a fractional zone coordinate 0..10. Zone 10 means "end of
 * zone 9" = full pull.
 */
export function zoneToTravel(z: number, zones: number[] = DEFAULT_ZONES): number {
  const pts = [...zones, 1]
  const c = Math.min(10, Math.max(0, z))
  const i = Math.min(9, Math.floor(c))
  return pts[i] + (pts[i + 1] - pts[i]) * (c - i)
}

// --- shared store ------------------------------------------------------------

const KEY = 'dshd.triggerCalibration'
let current: TriggerCalibration | null = loadLocal<TriggerCalibration | null>(KEY, null)
const listeners = new Set<() => void>()

export function getCalibration(): TriggerCalibration | null {
  return current
}

export function setCalibration(c: TriggerCalibration | null) {
  current = c
  saveLocal(KEY, c)
  listeners.forEach((f) => f())
}

export function onCalibration(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The active zone table (calibrated, or the z/10 default). */
export function activeZones(): number[] {
  return current?.zones ?? DEFAULT_ZONES
}
