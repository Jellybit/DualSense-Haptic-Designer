// Turns raw controller IMU samples into a stable orientation + gravity vector.

import type { InputState } from '../device/inputReport'
import { Madgwick, quatConj, quatMul, rotateWorldToSensor, type Quat } from './madgwick'

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
  /** reference orientation captured on recenter (full: heading and tilt) */
  private ref: Quat = [1, 0, 0, 0]
  /** bumped on every recenter, so the 3D view can turn the model to face its camera */
  recenterCount = 0
  private lastTs: number | null = null
  private lastWall = 0
  /** gyro bias estimated while still (rad/s) */
  private bias: [number, number, number] = [0, 0, 0]
  private stillTime = 0
  /** smoothed linear acceleration magnitude, used to detect shakes */
  shake = 0
  private liftPeak = 0
  /** recent accel / raw gyro, smoothed over ~0.1 s, for Recenter Sensors */
  private aAvg: [number, number, number] = [0, 1, 0]
  private gAvg: [number, number, number] = [0, 0, 0]

  reset() {
    this.filter.reset()
    this.ref = [1, 0, 0, 0]
    this.lastTs = null
  }

  /**
   * Make the way the controller is held right now the "facing the camera" pose: the model
   * snaps to face the camera squarely and later turns and tilts are shown relative to this.
   * (Gravity for the scenes is unaffected; see gravityInController.)
   */
  recenter() {
    this.ref = [...this.filter.q] as Quat
    this.recenterCount++
  }

  /**
   * Re-find true down: turn the filter's estimate (by the smallest rotation, so heading is
   * kept) until its down matches what the accelerometer reads right now, and re-measure the
   * gyro drift. The filter itself carries on unchanged afterwards.
   * Returns false if the controller was moving, when the reading can't be trusted (nothing
   * changes then).
   */
  recenterSensors(): boolean {
    const a = this.aAvg
    const n = Math.hypot(...a)
    const spin = Math.hypot(this.gAvg[0] - this.bias[0], this.gAvg[1] - this.bias[1], this.gAvg[2] - this.bias[2])
    if (Math.abs(n - 1) > 0.15 || spin > 20 * DEG) return false
    // at rest the accelerometer reads 1 g pointing up, so down is its opposite
    const u: [number, number, number] = [-a[0] / n, -a[1] / n, -a[2] / n]
    const v = this.gravityInController
    // shortest rotation r (sensor frame) taking u to v; then q·r reads u as down
    const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
    let r: Quat
    if (dot < -0.9999) {
      // upside down: a half-turn about any axis perpendicular to down
      const ax = Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [u[2], 0, -u[0]]
      const m = Math.hypot(ax[0], ax[1], ax[2])
      r = [0, ax[0] / m, ax[1] / m, ax[2] / m]
    } else {
      const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      const w = 1 + dot
      const m = Math.hypot(w, c[0], c[1], c[2])
      r = [w / m, c[0] / m, c[1] / m, c[2] / m]
    }
    const q = quatMul(this.filter.q, r)
    const qn = Math.hypot(...q)
    this.filter.q = [q[0] / qn, q[1] / qn, q[2] / qn, q[3] / qn]
    // held still, the gyro should read zero: what it reads now is its drift
    this.bias = [...this.gAvg]
    this.stillTime = 0
    return true
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
    const k = Math.min(1, dt / 0.1)
    for (let i = 0; i < 3; i++) {
      this.aAvg[i] += (a[i] - this.aAvg[i]) * k
      this.gAvg[i] += (gRaw[i] - this.gAvg[i]) * k
    }

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

    // Upward acceleration beyond gravity: at rest the accelerometer reads 1 g opposite "down"
    const down = this.gravityInController
    const up = -(a[0] * down[0] + a[1] * down[1] + a[2] * down[2]) - 1
    this.liftPeak = Math.max(this.liftPeak, up)
  }

  /** Peak upward acceleration (g beyond gravity) since the last call; samples arrive faster than frames. */
  takeLift() {
    const v = this.liftPeak
    this.liftPeak = 0
    return v
  }

  /** Orientation relative to the recentered pose. */
  get quaternion(): Quat {
    return quatMul(quatConj(this.ref), this.filter.q)
  }

  /** World "down" expressed in the controller frame (unit vector). */
  get gravityInController(): [number, number, number] {
    return rotateWorldToSensor(this.filter.q, [0, -1, 0])
  }
}
