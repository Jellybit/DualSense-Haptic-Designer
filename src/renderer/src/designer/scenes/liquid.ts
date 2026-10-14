// Particle liquid for the scene box (2D, top-down).
//
// Simulation: "double density relaxation" (Clavet, Beaudoin & Poulin 2005), the classic
// particle-based viscoelastic fluid used in games. Each step: apply gravity → predict
// positions → push neighbours apart/together toward a rest density (with a "near" term
// that prevents clumping) → collide with walls → derive velocity from the position change.
//
// Haptics come from the flow itself, not from a scripted wobble:
//  - slosh:  low rumble, amplitude ∝ how much water is moving, panned to where it moves
//  - churn:  brighter noise ∝ turbulence (how differently neighbours move)
//  - splash: wall impacts accumulated per wall per step → a wet thump on that side

import type { ContinuousParams, Grain } from '../../haptics/dsp'

export interface LiquidParams {
  /** 0..1 how full the box is */
  amount: number
  /** 0 = water, 1 = syrup */
  viscosity: number
  gain: number
}

export interface LiquidEnv {
  width: number
  height: number
  /** in-plane gravity, cm/s² */
  ax: number
  ay: number
  shake: number
  /** finger position in cm, or null */
  finger: { x: number; y: number } | null
  kick: boolean
}

export interface LiquidSink {
  grain(g: Grain): void
  voice(id: string, p: ContinuousParams | null): void
}

/** interaction radius (cm) */
const H = 0.85
/** particles per cm² at rest */
const DENSITY = 3.2
const MAX_PARTICLES = 700

export class LiquidSim {
  n = 0
  x = new Float32Array(MAX_PARTICLES)
  y = new Float32Array(MAX_PARTICLES)
  vx = new Float32Array(MAX_PARTICLES)
  vy = new Float32Array(MAX_PARTICLES)
  private px = new Float32Array(MAX_PARTICLES)
  private py = new Float32Array(MAX_PARTICLES)
  /** per-particle turbulence 0..1, used for foam rendering */
  foam = new Float32Array(MAX_PARTICLES)
  /** wall flash for drawing: left, right, top, bottom */
  flash = [0, 0, 0, 0]
  private rho0 = 1
  private seed = 7
  private lastSplash = [0, 0, 0, 0]
  private time = 0
  // accumulated wall impacts during a frame: momentum and x-centroid
  private wallHit = [0, 0, 0, 0]
  private wallHitX = [0, 0, 0, 0]
  /** slow average of wall momentum: steady pressure of resting water, not a splash */
  private wallAvg = [0, 0, 0, 0]
  // stats for the haptic voices
  private turbulence = 0

  constructor(
    public id: string,
    public params: LiquidParams,
    width: number,
    height: number,
  ) {
    this.respawn(width, height)
  }

  private rand() {
    this.seed = (this.seed * 16807) % 2147483647
    return this.seed / 2147483647
  }

  /** Fill the box (or adjust the particle count) for the current amount. */
  respawn(width: number, height: number) {
    const target = Math.min(MAX_PARTICLES, Math.max(20, Math.round(width * height * this.params.amount * DENSITY)))
    if (target === this.n) return
    if (target < this.n) {
      this.n = target
      return
    }
    // Add particles on a jittered grid in the box centre region, without overlap
    const spacing = 1 / Math.sqrt(DENSITY)
    for (let i = this.n; i < target; i++) {
      this.x[i] = spacing + this.rand() * (width - 2 * spacing)
      this.y[i] = spacing + this.rand() * (height - 2 * spacing)
      this.vx[i] = 0
      this.vy[i] = 0
    }
    this.n = target
    // rest density of a regular packing at DENSITY, so the fluid neither collapses nor explodes
    let rho = 0
    const r = Math.ceil(H / spacing)
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++) {
        if (!a && !b) continue
        const q = Math.hypot(a, b) * spacing / H
        if (q < 1) rho += (1 - q) * (1 - q)
      }
    this.rho0 = rho
  }

  // --- spatial hash ---------------------------------------------------------
  private cellStart = new Int32Array(0)
  private cellNext = new Int32Array(MAX_PARTICLES)
  private cols = 0
  private rows = 0

  private buildGrid(width: number, height: number) {
    this.cols = Math.max(1, Math.ceil(width / H))
    this.rows = Math.max(1, Math.ceil(height / H))
    const cells = this.cols * this.rows
    if (this.cellStart.length !== cells) this.cellStart = new Int32Array(cells)
    this.cellStart.fill(-1)
    for (let i = 0; i < this.n; i++) {
      // a non-finite particle would corrupt the cell lists (and hang the neighbour loops)
      if (!Number.isFinite(this.x[i]) || !Number.isFinite(this.y[i])) {
        this.x[i] = width / 2
        this.y[i] = height / 2
        this.vx[i] = this.vy[i] = 0
      }
      const c = this.cellOf(this.x[i], this.y[i])
      this.cellNext[i] = this.cellStart[c]
      this.cellStart[c] = i
    }
  }

  private cellOf(x: number, y: number) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / H)))
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / H)))
    return cy * this.cols + cx
  }

  /** Call fn(j, dx, dy, r) for every neighbour j of i within H (j > i only when `half`). */
  private forNeighbours(i: number, half: boolean, fn: (j: number, dx: number, dy: number, r: number) => void) {
    const xi = this.x[i]
    const yi = this.y[i]
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(xi / H)))
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(yi / H)))
    for (let oy = -1; oy <= 1; oy++) {
      const yy = cy + oy
      if (yy < 0 || yy >= this.rows) continue
      for (let ox = -1; ox <= 1; ox++) {
        const xx = cx + ox
        if (xx < 0 || xx >= this.cols) continue
        for (let j = this.cellStart[yy * this.cols + xx]; j !== -1; j = this.cellNext[j]) {
          if (j === i || (half && j < i)) continue
          const dx = this.x[j] - xi
          const dy = this.y[j] - yi
          const r2 = dx * dx + dy * dy
          if (r2 >= H * H || r2 < 1e-12) continue
          fn(j, dx, dy, Math.sqrt(r2))
        }
      }
    }
  }

  step(dt: number, env: LiquidEnv) {
    // velocities are derived as Δx/dt, so a zero/negative step would produce NaN
    if (!(dt > 1e-5)) return
    this.time += dt
    const { width: W, height: Hh } = env
    const n = this.n
    const visc = this.params.viscosity
    // relaxation stiffness in position units (cm); tuned for H = 0.85 at ~2.8 ms steps
    // (stiff enough to stay near-incompressible under strong tilt, soft enough not to jitter)
    const k = 0.5
    const kNear = 0.8

    // 1. external forces
    for (let i = 0; i < n; i++) {
      this.vx[i] += env.ax * dt
      this.vy[i] += env.ay * dt
    }
    if (env.kick || env.shake > 0.25) {
      const s = env.kick ? 60 : env.shake * 40
      for (let i = 0; i < n; i++) {
        this.vx[i] += (this.rand() - 0.5) * s
        this.vy[i] += (this.rand() - 0.5) * s * 0.7
      }
    }
    if (env.finger) {
      const reach = 1.6
      for (let i = 0; i < n; i++) {
        const dx = this.x[i] - env.finger.x
        const dy = this.y[i] - env.finger.y
        const d = Math.hypot(dx, dy)
        if (d < reach && d > 1e-4) {
          const push = (reach - d) * 30
          this.vx[i] += (dx / d) * push
          this.vy[i] += (dy / d) * push
        }
      }
    }

    // 2. viscosity (XSPH-style velocity smoothing between neighbours) + turbulence measure
    this.buildGrid(W, Hh)
    const smooth = 0.02 + visc * 0.25
    let turb = 0
    for (let i = 0; i < n; i++) {
      let sx = 0
      let sy = 0
      let wsum = 0
      this.forNeighbours(i, false, (j, _dx, _dy, r) => {
        const w = 1 - r / H
        sx += (this.vx[j] - this.vx[i]) * w
        sy += (this.vy[j] - this.vy[i]) * w
        wsum += w
      })
      if (wsum > 0) {
        this.vx[i] += (sx / wsum) * smooth
        this.vy[i] += (sy / wsum) * smooth
        const t = Math.hypot(sx, sy) / wsum
        this.foam[i] = this.foam[i] * 0.85 + Math.min(1, t / 25) * 0.15
        turb += t
      }
    }
    this.turbulence = n ? turb / n : 0

    // 3. predict positions
    for (let i = 0; i < n; i++) {
      this.px[i] = this.x[i]
      this.py[i] = this.y[i]
      this.x[i] += this.vx[i] * dt
      this.y[i] += this.vy[i] * dt
    }

    // 4. double density relaxation
    this.buildGrid(W, Hh)
    for (let i = 0; i < n; i++) {
      let rho = 0
      let rhoNear = 0
      this.forNeighbours(i, false, (_j, _dx, _dy, r) => {
        const q = 1 - r / H
        rho += q * q
        rhoNear += q * q * q
      })
      const P = k * (rho - this.rho0)
      const PNear = kNear * rhoNear
      let dxi = 0
      let dyi = 0
      this.forNeighbours(i, false, (j, dx, dy, r) => {
        const q = 1 - r / H
        const D = (P * q + PNear * q * q) * 0.5
        const ux = (dx / r) * D
        const uy = (dy / r) * D
        this.x[j] += ux * 0.5
        this.y[j] += uy * 0.5
        dxi -= ux * 0.5
        dyi -= uy * 0.5
      })
      this.x[i] += dxi
      this.y[i] += dyi
    }

    // 5. walls (record impacts for splashes) and velocity update
    const pad = 0.12
    for (let i = 0; i < n; i++) {
      let vx = (this.x[i] - this.px[i]) / dt
      let vy = (this.y[i] - this.py[i]) / dt
      if (this.x[i] < pad) {
        this.hit(0, -vx, this.x[i])
        this.x[i] = pad
        vx = Math.abs(vx) * 0.1
      } else if (this.x[i] > W - pad) {
        this.hit(1, vx, this.x[i])
        this.x[i] = W - pad
        vx = -Math.abs(vx) * 0.1
      }
      if (this.y[i] < pad) {
        this.hit(2, -vy, this.x[i])
        this.y[i] = pad
        vy = Math.abs(vy) * 0.1
      } else if (this.y[i] > Hh - pad) {
        this.hit(3, vy, this.x[i])
        this.y[i] = Hh - pad
        vy = -Math.abs(vy) * 0.1
      }
      // keep the solver stable under violent shaking
      const sp = Math.hypot(vx, vy)
      const max = 120
      if (sp > max) {
        vx *= max / sp
        vy *= max / sp
      }
      this.vx[i] = vx
      this.vy[i] = vy
    }
  }

  /**
   * Two-way coupling with a round body: particles inside it are pushed to its surface and
   * take on some of its velocity; the body gets a little drag from the water it moves.
   */
  pushOut(b: { x: number; y: number; r: number; vx: number; vy: number }) {
    const R = b.r + 0.2
    let dragX = 0
    let dragY = 0
    let touched = 0
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - b.x
      const dy = this.y[i] - b.y
      const d2 = dx * dx + dy * dy
      if (d2 >= R * R) continue
      const d = Math.sqrt(d2) || 1e-4
      this.x[i] = b.x + (dx / d) * R
      this.y[i] = b.y + (dy / d) * R
      this.vx[i] += (b.vx - this.vx[i]) * 0.5
      this.vy[i] += (b.vy - this.vy[i]) * 0.5
      dragX += this.vx[i] - b.vx
      dragY += this.vy[i] - b.vy
      touched++
    }
    if (touched) {
      const k = Math.min(0.08, touched * 0.004) * (0.5 + this.params.viscosity)
      b.vx += (dragX / touched) * k
      b.vy += (dragY / touched) * k
    }
  }

  private hit(side: number, speed: number, x: number) {
    if (speed <= 0) return
    this.wallHit[side] += speed
    this.wallHitX[side] += speed * x
  }

  /** Emit haptics for the frame (call once per rendered frame, after the substeps). */
  emit(sink: LiquidSink, width: number, frameDt: number) {
    const n = this.n
    const gain = this.params.gain
    const visc = this.params.viscosity
    const pan = (x: number) => Math.max(-1, Math.min(1, (x / width) * 2 - 1))
    for (let s = 0; s < 4; s++) this.flash[s] = Math.max(0, this.flash[s] - frameDt * 4)

    // Splashes: total normal momentum that hit each wall this frame
    for (let side = 0; side < 4; side++) {
      const m = this.wallHit[side]
      const x = m > 0 ? this.wallHitX[side] / m : 0
      this.wallHit[side] = 0
      this.wallHitX[side] = 0
      // splash = onset: momentum well above the steady pressure of water resting on the wall
      const avg = this.wallAvg[side]
      this.wallAvg[side] = avg * 0.85 + m * 0.15
      const excess = m - avg * 1.6
      // per-particle normalisation so the threshold doesn't depend on fill amount
      const strength = excess / Math.max(1, n * 0.15)
      if (strength < 8 || this.time - this.lastSplash[side] < 0.12) continue
      this.lastSplash[side] = this.time
      this.flash[side] = Math.min(1, strength / 40)
      const amp = Math.min(1, Math.pow(strength / 45, 0.8)) * gain * (1 - visc * 0.5)
      const p = side === 0 ? -1 : side === 1 ? 1 : pan(x)
      // a wet thump: low body + a lot of filtered noise, slower decay for syrup
      sink.grain({ freq: 75 - visc * 20, freqEnd: 45, duration: 0.22 + visc * 0.15, attack: 0.008, decay: 0.05 + visc * 0.05, amp, pan: p, noise: 0.6 })
    }

    // Slosh: kinetic energy and momentum-weighted position
    let ke = 0
    let wx = 0
    for (let i = 0; i < n; i++) {
      const v2 = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i]
      ke += v2
      wx += v2 * this.x[i]
    }
    const meanSpeed = n ? Math.sqrt(ke / n) : 0
    const centre = ke > 1e-6 ? wx / ke : width / 2
    const fill = 0.4 + Math.min(1, this.params.amount) * 0.6
    const sloshAmp = Math.min(1, meanSpeed / 35) * gain * fill
    const sloshKey = `slosh:${this.id}`
    if (sloshAmp > 0.01) {
      sink.voice(sloshKey, {
        kind: 'noise',
        freq: 40 + meanSpeed * 0.8 - visc * 10,
        q: 1.3,
        amp: sloshAmp,
        pan: pan(centre),
        amRate: 5 + meanSpeed * 0.15,
        amDepth: 0.35 + visc * 0.3,
      })
    } else sink.voice(sloshKey, null)

    // Churn: turbulence → brighter, bubbly texture (water only; syrup barely churns)
    const churnAmp = Math.min(1, this.turbulence / 18) * gain * 0.55 * (1 - visc * 0.8)
    const churnKey = `churn:${this.id}`
    if (churnAmp > 0.01) {
      sink.voice(churnKey, {
        kind: 'noise',
        freq: 170 + this.turbulence * 3,
        q: 2.5,
        amp: churnAmp,
        pan: pan(centre),
        amRate: 18 + this.turbulence,
        amDepth: 0.7,
      })
    } else sink.voice(churnKey, null)
  }

  silence(sink: LiquidSink) {
    sink.voice(`slosh:${this.id}`, null)
    sink.voice(`churn:${this.id}`, null)
  }
}
