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
