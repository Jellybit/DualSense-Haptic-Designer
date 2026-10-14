// Turns raw controller IMU samples into a stable orientation + gravity vector.

import type { InputState } from '../device/inputReport'
import { Madgwick, quatConj, quatMul, rotateWorldToSensor, yawOnly, type Quat } from './madgwick'

export interface AxisMap {
  /** for each target axis (x right, y up, z toward player): which raw sensor axis and sign */
  gyro: [AxisSel, AxisSel, AxisSel]
  accel: [AxisSel, AxisSel, AxisSel]
}
export interface AxisSel {
  axis: 0 | 1 | 2
  sign: 1 | -1
}

// DualSense IMU: gyro = [pitch(x), yaw(y), roll(z)]; accel y ≈ +1g when lying flat (face up).
export const DEFAULT_AXIS_MAP: AxisMap = {
  gyro: [
    { axis: 0, sign: 1 },
    { axis: 1, sign: 1 },
    { axis: 2, sign: 1 },
  ],
  accel: [
    { axis: 0, sign: 1 },
    { axis: 1, sign: 1 },
    { axis: 2, sign: 1 },
  ],
}

const DEG = Math.PI / 180

export class OrientationTracker {
  filter = new Madgwick(0.06)
  axisMap: AxisMap = structuredClone(DEFAULT_AXIS_MAP)
  /** reference orientation captured on recenter (yaw only) */
  private ref: Quat = [1, 0, 0, 0]
  private lastTs: number | null = null
  private lastWall = 0
  /** gyro bias estimated while still (rad/s) */
  private bias: [number, number, number] = [0, 0, 0]
  private stillTime = 0
  /** smoothed linear acceleration magnitude, used to detect shakes */
  shake = 0

  reset() {
    this.filter.reset()
    this.ref = [1, 0, 0, 0]
    this.lastTs = null
  }

  /** Make the current heading the "facing the screen" heading. */
  recenter() {
    this.ref = yawOnly(this.filter.q)
  }

  private remap(v: [number, number, number], m: [AxisSel, AxisSel, AxisSel]): [number, number, number] {
    return [v[m[0].axis] * m[0].sign, v[m[1].axis] * m[1].sign, v[m[2].axis] * m[2].sign]
  }

  update(s: InputState) {
    if (!s.full) return
    const now = performance.now()
    let dt: number
    if (this.lastTs !== null && s.sensorTimestamp) {
      // DualSense sensor timestamp ticks at 3 MHz (0.333 µs)
      const d = (s.sensorTimestamp - this.lastTs) >>> 0
      dt = d / 3_000_000
      if (dt <= 0 || dt > 0.1) dt = (now - this.lastWall) / 1000
    } else {
      dt = this.lastWall ? (now - this.lastWall) / 1000 : 0.004
    }
    this.lastTs = s.sensorTimestamp
    this.lastWall = now
    dt = Math.min(Math.max(dt, 0.0005), 0.05)

    const gRaw = this.remap(s.gyro, this.axisMap.gyro).map((v) => v * DEG) as [number, number, number]
    const a = this.remap(s.accel, this.axisMap.accel)

    // Auto gyro bias: when the controller is nearly still for a while, slowly learn the bias.
    const aMag = Math.hypot(...a)
    const lin = Math.abs(aMag - 1)
    this.shake = this.shake * 0.9 + lin * 0.1
    const gMag = Math.hypot(gRaw[0] - this.bias[0], gRaw[1] - this.bias[1], gRaw[2] - this.bias[2])
    if (lin < 0.03 && gMag < 3 * DEG) {
      this.stillTime += dt
      if (this.stillTime > 0.5) for (let i = 0; i < 3; i++) this.bias[i] += (gRaw[i] - this.bias[i]) * 0.01
    } else {
      this.stillTime = 0
    }
    const g: [number, number, number] = [gRaw[0] - this.bias[0], gRaw[1] - this.bias[1], gRaw[2] - this.bias[2]]
    this.filter.update(g, a, dt)
  }

  /** Orientation relative to the recentered heading. */
  get quaternion(): Quat {
    return quatMul(quatConj(this.ref), this.filter.q)
  }

  /** World "down" expressed in the controller frame (unit vector). */
  get gravityInController(): [number, number, number] {
    return rotateWorldToSensor(this.filter.q, [0, -1, 0])
  }
}
