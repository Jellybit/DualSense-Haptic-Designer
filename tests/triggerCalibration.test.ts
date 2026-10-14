import { describe, expect, it } from 'vitest'
import { DEFAULT_ZONES, fitLine, zonesFor, zonesFromFit, zoneToTravel, type WallHold } from '../src/renderer/src/device/triggerCalibration'

describe('trigger calibration', () => {
  it('maps zones linearly by default and through a table', () => {
    expect(zoneToTravel(3)).toBeCloseTo(0.3)
    expect(zoneToTravel(10)).toBe(1)
    const zones = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((z) => z * 0.5)
    expect(zoneToTravel(4, zones)).toBeCloseTo(0.2)
    expect(zoneToTravel(9.5, zones)).toBeCloseTo((0.45 + 1) / 2)
  })

  it('fits a line through noisy wall holds', () => {
    const holds: WallHold[] = []
    for (let z = 1; z <= 9; z++) for (const d of [-0.01, 0, 0.01]) holds.push({ zone: z, side: 'R2', value: 0.05 + 0.12 * z + d })
    const fit = fitLine(holds)!
    expect(fit.intercept).toBeCloseTo(0.05)
    expect(fit.slope).toBeCloseTo(0.12)
    expect(fit.rms).toBeLessThan(0.01)
  })

  it('clamps the zone table to full pull', () => {
    const zones = zonesFromFit({ intercept: 0.05, slope: 0.12, rms: 0, n: 2 })
    expect(zones[2]).toBeCloseTo(0.29)
    expect(zones[9]).toBe(1)
    expect(fitLine([{ zone: 3, side: 'L2', value: 0.3 }])).toBeNull()
  })

  it("uses a trigger's own line, else the combined one, else the default", () => {
    const both = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85]
    const l2 = [0, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.8]
    const cal = { zones: both, sides: { L2: { fit: { intercept: 0, slope: 0.1, rms: 0, n: 9 }, zones: l2 } }, fit: { intercept: 0, slope: 0.1, rms: 0, n: 9 }, holds: [], measuredAt: '' }
    expect(zonesFor(cal, 'L2')).toBe(l2)
    expect(zonesFor(cal, 'R2')).toBe(both)
    expect(zonesFor(null, 'R2')).toBe(DEFAULT_ZONES)
  })
})
