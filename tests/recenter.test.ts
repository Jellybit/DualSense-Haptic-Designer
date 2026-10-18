import { describe, expect, it } from 'vitest'
import { OrientationTracker } from '../src/renderer/src/orientation/tracker'
import { quatMul, type Quat } from '../src/renderer/src/orientation/madgwick'

const axisAngle = (x: number, y: number, z: number, deg: number): Quat => {
  const h = (deg * Math.PI) / 360
  return [Math.cos(h), x * Math.sin(h), y * Math.sin(h), z * Math.sin(h)]
}
const close = (a: Quat, b: Quat) => {
  // q and -q are the same rotation
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  expect(d).toBeCloseTo(1, 6)
}

describe('recenter', () => {
  it('makes the current pose, tilt included, face the camera', () => {
    const t = new OrientationTracker()
    const held = quatMul(axisAngle(0, 1, 0, 40), axisAngle(1, 0, 0, 25)) // turned and tilted
    t.filter.q = held
    t.recenter()
    close(t.quaternion, [1, 0, 0, 0])
    // a later tilt shows up relative to the recentered pose
    t.filter.q = quatMul(held, axisAngle(1, 0, 0, 30))
    close(t.quaternion, axisAngle(1, 0, 0, 30))
  })
})

describe('recenter sensors', () => {
  // feed still readings (accel in g, gyro in deg/s) so the smoothed values settle
  const feed = (t: OrientationTracker, accel: [number, number, number], gyro: [number, number, number] = [0, 0, 0]) => {
    let ts = 1
    for (let i = 0; i < 100; i++) {
      // 4 ms apart (the sensor clock ticks at 3 MHz)
      const s = { full: true, sensorTimestamp: (ts += 12000), accel, gyro } as never
      t.update(s)
    }
  }

  it('snaps down to the accelerometer and keeps heading', () => {
    const t = new OrientationTracker()
    t.filter.beta = 0 // stop the filter correcting by itself, to see the snap alone
    const heading = axisAngle(0, 1, 0, 50)
    t.filter.q = quatMul(heading, axisAngle(1, 0, 0, 35)) // wrongly believes it's tilted 35°
    feed(t, [0, 1, 0]) // actually lying flat
    t.filter.q = quatMul(heading, axisAngle(1, 0, 0, 35))
    expect(t.recenterSensors()).toBe(true)
    const d = t.gravityInController
    expect(d[0]).toBeCloseTo(0, 5)
    expect(d[1]).toBeCloseTo(-1, 5)
    expect(d[2]).toBeCloseTo(0, 5)
    close(t.filter.q, heading)
  })

  it('handles being upside down', () => {
    const t = new OrientationTracker()
    t.filter.beta = 0
    feed(t, [0, -1, 0])
    t.filter.q = [1, 0, 0, 0]
    expect(t.recenterSensors()).toBe(true)
    expect(t.gravityInController[1]).toBeCloseTo(1, 5)
  })

  it('refuses while the controller is moving', () => {
    const t = new OrientationTracker()
    feed(t, [0, 1.6, 0])
    const before = [...t.filter.q]
    expect(t.recenterSensors()).toBe(false)
    expect(t.filter.q).toEqual(before)
  })
})
