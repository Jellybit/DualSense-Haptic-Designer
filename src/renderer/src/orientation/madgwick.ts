// Madgwick IMU (gyro + accelerometer) orientation filter.
// Quaternion convention: [w, x, y, z], rotating sensor frame -> world frame.
// Sensor frame used here (after axis remapping): +x right, +y up, +z toward the player.

export type Quat = [number, number, number, number]

export class Madgwick {
  q: Quat = [1, 0, 0, 0]
  /** filter gain; higher trusts accel more (less drift, more jitter) */
  beta: number

  constructor(beta = 0.08) {
    this.beta = beta
  }

  reset() {
    this.q = [1, 0, 0, 0]
  }

  /**
   * @param g gyro in rad/s
   * @param a accel in any unit (normalized internally)
   * @param dt seconds
   */
  update(g: [number, number, number], a: [number, number, number], dt: number) {
    let [q0, q1, q2, q3] = this.q
    const [gx, gy, gz] = g
    let [ax, ay, az] = a

    // Rate of change from gyroscope
    let qDot1 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz)
    let qDot2 = 0.5 * (q0 * gx + q2 * gz - q3 * gy)
    let qDot3 = 0.5 * (q0 * gy - q1 * gz + q3 * gx)
    let qDot4 = 0.5 * (q0 * gz + q1 * gy - q2 * gx)

    const aNorm = Math.hypot(ax, ay, az)
    if (aNorm > 1e-6) {
      ax /= aNorm
      ay /= aNorm
      az /= aNorm
      // Gradient descent corrective step. Reference gravity direction is world +y (up),
      // i.e. a resting accelerometer reads +1g on the axis pointing up.
      // f = R(q)^T * [0,1,0] - a
      const f1 = 2 * (q1 * q2 + q0 * q3) - ax
      const f2 = 1 - 2 * (q1 * q1 + q3 * q3) - ay
      const f3 = 2 * (q2 * q3 - q0 * q1) - az
      // Jacobian^T * f
      let s0 = 2 * q3 * f1 - 2 * q1 * f3
      let s1 = 2 * q2 * f1 - 4 * q1 * f2 - 2 * q0 * f3
      let s2 = 2 * q1 * f1 + 2 * q3 * f3
      let s3 = 2 * q0 * f1 - 4 * q3 * f2 + 2 * q2 * f3
      const sNorm = Math.hypot(s0, s1, s2, s3)
      if (sNorm > 1e-9) {
        s0 /= sNorm
        s1 /= sNorm
        s2 /= sNorm
        s3 /= sNorm
        qDot1 -= this.beta * s0
        qDot2 -= this.beta * s1
        qDot3 -= this.beta * s2
        qDot4 -= this.beta * s3
      }
    }

    q0 += qDot1 * dt
    q1 += qDot2 * dt
    q2 += qDot3 * dt
    q3 += qDot4 * dt
    const n = Math.hypot(q0, q1, q2, q3)
    this.q = [q0 / n, q1 / n, q2 / n, q3 / n]
  }
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ]
}

export function quatConj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]]
}

/** Rotate a world vector into the sensor frame (v' = q* v q). */
export function rotateWorldToSensor(q: Quat, v: [number, number, number]): [number, number, number] {
  const p: Quat = [0, v[0], v[1], v[2]]
  const r = quatMul(quatMul(quatConj(q), p), q)
  return [r[1], r[2], r[3]]
}

/** Remove the yaw component (rotation about world +y) from q. */
export function yawOnly(q: Quat): Quat {
  const [w, , y] = q
  const n = Math.hypot(w, y) || 1
  return [w / n, 0, y / n, 0]
}
