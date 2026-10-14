import { describe, expect, it } from 'vitest'
import { curveStrengths, curveValue, encodeTrigger, zoneFrequencies, pointsFromStrengths, toCurveEffect, type TriggerEffect } from '../src/renderer/src/device/triggerEffects'
import { travelToZone, zoneToTravel } from '../src/renderer/src/device/triggerCalibration'

describe('trigger curves', () => {
  it('interpolates straight lines and holds flat outside the points', () => {
    const pts = [{ x: 2, y: 0 }, { x: 6, y: 8 }]
    expect(curveValue(pts, 0)).toBe(0)
    expect(curveValue(pts, 4)).toBe(4)
    expect(curveValue(pts, 9)).toBe(8)
    // two points at the same x make a vertical step
    expect(curveValue([{ x: 3, y: 0 }, { x: 3, y: 8 }], 2.5)).toBe(0)
    expect(curveValue([{ x: 3, y: 0 }, { x: 3, y: 8 }], 3.5)).toBe(8)
  })

  it('samples each zone at its centre', () => {
    expect(curveStrengths([{ x: 0, y: 0 }, { x: 10, y: 8 }])).toEqual([0, 1, 2, 3, 4, 4, 5, 6, 7, 8].map((_, z) => Math.round(((z + 0.5) / 10) * 8)))
  })

  it('round-trips per-zone strengths through points', () => {
    const s = [0, 0, 3, 6, 8, 8, 6, 3, 0, 0]
    const pts = pointsFromStrengths(s)
    expect(curveStrengths(pts)).toEqual(s)
    expect(pts.length).toBeLessThan(10)
  })

  it('converts old slider effects to curves with the same bytes', () => {
    for (const old of [
      { type: 'feedback', position: 3, strength: 6 },
      { type: 'slope', start: 1, end: 9, startStrength: 1, endStrength: 8 },
      { type: 'multiVibration', frequency: 35, amplitudes: [0, 0, 3, 6, 8, 8, 6, 3, 0, 0] },
      { type: 'vibration', position: 3, amplitude: 8, frequency: 18 },
    ] as TriggerEffect[]) {
      const c = toCurveEffect(old)
      expect(c.type === 'forceCurve' || c.type === 'vibrationCurve').toBe(true)
      expect(encodeTrigger(c)).toEqual(encodeTrigger(old))
    }
    expect(toCurveEffect({ type: 'weapon', start: 3, end: 6, strength: 8 }).type).toBe('weapon')
    // Bow feels identical to Weapon, so it loads as one
    expect(toCurveEffect({ type: 'bow', start: 1, end: 6, strength: 6, snapForce: 8 })).toEqual({ type: 'weapon', start: 2, end: 6, strength: 6 })
  })

  it('inverts the calibration mapping', () => {
    const zones = [0, 0.03, 0.15, 0.27, 0.38, 0.5, 0.62, 0.74, 0.86, 0.97]
    for (const z of [0.5, 2.25, 6.8, 9.5]) expect(travelToZone(zoneToTravel(z, zones), zones)).toBeCloseTo(z)
  })

  it('interpolates vibration frequency per point and applies it per zone', () => {
    const e = { type: 'vibrationCurve' as const, frequency: 30, points: [{ x: 0, y: 8, f: 20 }, { x: 10, y: 8, f: 220 }] }
    const fz = zoneFrequencies(e)
    expect(fz[0]).toBe(30) // 20 + 200 * 0.05
    expect(fz[9]).toBe(210)
    // byte 9 carries the frequency of the zone the trigger is in
    expect(encodeTrigger(e, 0)[9]).toBe(30)
    expect(encodeTrigger(e, 9)[9]).toBe(210)
    // points without their own frequency use the effect's
    expect(zoneFrequencies({ frequency: 45, points: [{ x: 2, y: 4 }] })).toEqual(new Array(10).fill(45))
  })
})
