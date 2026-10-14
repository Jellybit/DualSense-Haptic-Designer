// "Inside the controller" scene simulator.
//
// A top-down 2D box lying in the controller's face plane. Box x = controller left→right
// (maps to the left/right actuators), box y = controller far→near (top edge = triggers,
// bottom edge = toward the player). Gravity in the box is the component of real gravity
// in that plane, so tilting the physical controller makes things roll/slide/stumble.
//
// The sim produces haptic events through a HapticSink:
//   - impacts  → short material grains, amplitude ∝ impulse, panned by x
//   - rolling  → continuous band-passed noise per marble, gain/pitch ∝ speed
//   - footsteps→ alternating tiny taps at the critter's stride rate
//   - landings → low thumps
//   - liquid   → particle fluid (liquid.ts): slosh rumble, turbulent churn, wall splashes

import { LiquidSim } from './liquid'
import { impactGrain, tapGrain, thumpGrain, rng, type ContinuousParams, type Grain, type Material } from '../../haptics/dsp'

export interface HapticSink {
  grain(g: Grain): void
  voice(id: string, p: ContinuousParams | null): void
}

export interface MarbleConfig {
  id: string
  kind: 'marble'
  name: string
  count: number
  /** cm */
  radius: number
  /** grams-ish; relative */
  mass: number
  /** 0..1 */
  restitution: number
  /** rolling resistance, 1/s velocity damping */
  rollingFriction: number
  material: Material
  impactGain: number
  rollGain: number
  /** rolling texture pitch multiplier */
  pitch: number
  color: string
}

export interface CritterConfig {
  id: string
  kind: 'critter'
  name: string
  count: number
  radius: number
  /** cm/s */
  speed: number
  /** steps per second at full speed */
  stepRate: number
  /** chance per second to hop spontaneously */
  hopChance: number
  stepGain: number
  landGain: number
  pitch: number
  /** how strongly tilt drags critters (0 = glued on, 1 = slides like a puck) */
  slip: number
  /** run from the finger on the touchpad */
  shy: boolean
  color: string
}

export interface LiquidConfig {
  id: string
  kind: 'liquid'
  name: string
  /** 0..1 how full */
  amount: number
  /** 0..1 */
  viscosity: number
  gain: number
  color: string
}

export type EntityConfig = MarbleConfig | CritterConfig | LiquidConfig

export interface SceneConfig {
  version: 1
  name: string
  /** box size in cm (DualSense body is ~16 × 7 cm between the grips) */
  width: number
  height: number
  /** gravity multiplier (1 = real) */
  gravity: number
  wallMaterial: Material
  /** wall hit loudness multiplier */
  wallGain: number
  entities: EntityConfig[]
}

let idc = 0
const nid = (p: string) => `${p}${Date.now().toString(36)}${(idc++).toString(36)}`

export function defaultMarbles(): MarbleConfig {
  return {
    id: nid('m'), kind: 'marble', name: 'Marbles', count: 3, radius: 0.8, mass: 1, restitution: 0.55,
    rollingFriction: 0.25, material: 'glass', impactGain: 1, rollGain: 0.6, pitch: 1, color: '#7cc7ff',
  }
}

export function defaultCritters(): CritterConfig {
  return {
    id: nid('c'), kind: 'critter', name: 'Critters', count: 4, radius: 0.45, speed: 4, stepRate: 9,
    hopChance: 0.15, stepGain: 0.55, landGain: 0.8, pitch: 1, slip: 0.35, shy: true, color: '#ffb347',
  }
}

export function defaultLiquid(): LiquidConfig {
  return { id: nid('l'), kind: 'liquid', name: 'Water', amount: 0.5, viscosity: 0.3, gain: 0.7, color: '#3f8cff' }
}

export const SCENE_PRESETS: { name: string; make: () => SceneConfig }[] = [
  {
    name: 'Marble box (Ball Count)',
    make: () => ({
      version: 1, name: 'Marble box', width: 16, height: 7, gravity: 1, wallMaterial: 'wood', wallGain: 1,
      entities: [{ ...defaultMarbles(), count: 4, material: 'wood' }],
    }),
  },
  {
    name: 'Critters inside',
    make: () => ({
      version: 1, name: 'Critters', width: 16, height: 7, gravity: 1, wallMaterial: 'stone', wallGain: 0.6,
      entities: [defaultCritters()],
    }),
  },
  {
    name: 'Steel ball bearing',
    make: () => ({
      version: 1, name: 'Ball bearing', width: 16, height: 7, gravity: 1, wallMaterial: 'metal', wallGain: 1,
      entities: [{ ...defaultMarbles(), name: 'Bearing', count: 1, radius: 0.6, mass: 3, restitution: 0.4, material: 'metal', rollGain: 0.8, pitch: 1.4, color: '#c0c6d0' }],
    }),
  },
  {
    name: 'Water bottle',
    make: () => ({
      version: 1, name: 'Water', width: 16, height: 7, gravity: 1, wallMaterial: 'soft', wallGain: 0.3,
      entities: [defaultLiquid()],
    }),
  },
  {
    name: 'Playroom mix',
    make: () => ({
      version: 1, name: 'Playroom', width: 16, height: 7, gravity: 1, wallMaterial: 'rubber', wallGain: 0.8,
      entities: [defaultCritters(), { ...defaultMarbles(), count: 2, material: 'rubber', color: '#ff6b9a' }],
    }),
  },
]

// ---------------------------------------------------------------------------

interface Body {
  key: string
  cfg: MarbleConfig | CritterConfig
  x: number
  y: number
  vx: number
  vy: number
  r: number
  m: number
  // critter state
  heading: number
  stepPhase: number
  foot: number
  air: number
  airTotal: number
  wanderT: number
  lastImpact: number
  /** recent impact flash for drawing */
  flash: number
}

interface LiquidState {
  cfg: LiquidConfig
  sim: LiquidSim
}

export interface SimInputs {
  /** gravity in box plane, units of g: x right, y toward the player */
  gx: number
  gy: number
  /** shake intensity 0..? (linear accel magnitude in g) */
  shake: number
  /** finger position on touchpad mapped to 0..1 box coords, or null */
  finger: { x: number; y: number } | null
  /** one-shot: make critters jump */
  jump: boolean
  /** one-shot: kick everything upward/random */
  kick: boolean
}

const G_CM = 981

export class SceneSim {
  bodies: Body[] = []
  liquids: LiquidState[] = []
  time = 0
  private rand = rng(42)
  private voicesOn = new Set<string>()

  constructor(
    public cfg: SceneConfig,
    private sink: HapticSink,
  ) {
    this.rebuild()
  }

  /** Re-spawn bodies after config change, keeping positions where possible. */
  rebuild() {
    const old = new Map(this.bodies.map((b) => [b.key, b]))
    const bodies: Body[] = []
    for (const e of this.cfg.entities) {
      if (e.kind === 'liquid') continue
      for (let i = 0; i < e.count; i++) {
        const key = `${e.id}:${i}`
        const prev = old.get(key)
        const r = e.radius
        const b: Body = prev ?? {
          key,
          cfg: e,
          x: r + this.rand() * (this.cfg.width - 2 * r),
          y: r + this.rand() * (this.cfg.height - 2 * r),
          vx: 0,
          vy: 0,
          r,
          m: 1,
          heading: this.rand() * Math.PI * 2,
          stepPhase: this.rand(),
          foot: 0,
          air: 0,
          airTotal: 0,
          wanderT: 0,
          lastImpact: 0,
          flash: 0,
        }
        b.cfg = e
        b.r = e.radius
        b.m = e.kind === 'marble' ? e.mass : 0.3
        b.x = Math.min(Math.max(b.x, r), this.cfg.width - r)
        b.y = Math.min(Math.max(b.y, r), this.cfg.height - r)
        bodies.push(b)
      }
    }
    // silence voices of removed bodies
    const keep = new Set(bodies.map((b) => b.key))
    for (const k of [...this.voicesOn]) {
      if (k.startsWith('roll:') && !keep.has(k.slice(5))) {
        this.sink.voice(k, null)
        this.voicesOn.delete(k)
      }
    }
    this.bodies = bodies

    const oldL = new Map(this.liquids.map((l) => [l.cfg.id, l]))
    this.liquids = this.cfg.entities
      .filter((e): e is LiquidConfig => e.kind === 'liquid')
      .map((cfg) => {
        const prev = oldL.get(cfg.id)
        const sim = prev?.sim ?? new LiquidSim(cfg.id, cfg, this.cfg.width, this.cfg.height)
        sim.params = cfg
        sim.respawn(this.cfg.width, this.cfg.height)
        return { cfg, sim }
      })
    for (const [id, l] of oldL) if (!this.liquids.some((x) => x.cfg.id === id)) l.sim.silence(this.sink)
  }

  silence() {
    for (const k of this.voicesOn) this.sink.voice(k, null)
    this.voicesOn.clear()
    for (const l of this.liquids) l.sim.silence(this.sink)
  }

  /** x (cm) → pan -1..1 */
  private pan(x: number) {
    return Math.max(-1, Math.min(1, (x / this.cfg.width) * 2 - 1))
  }

  private impact(b: Body, speed: number, material: Material, gain: number, delay = 0) {
    // Ignore resting micro-contacts
    if (speed < 2.5 || this.time - b.lastImpact < 0.015) return
    b.lastImpact = this.time
    const amp = Math.min(1, Math.pow(speed / 60, 0.8)) * gain * Math.min(1.5, 0.6 + b.m * 0.4)
    if (amp < 0.02) return
    const pitch = b.cfg.kind === 'marble' ? b.cfg.pitch * Math.pow(0.8 / b.r, 0.3) : b.cfg.pitch
    const g = impactGrain(material, amp, this.pan(b.x), pitch)
    g.delay = delay
    this.sink.grain(g)
    b.flash = 1
  }

  step(dt: number, inp: SimInputs) {
    if (!(dt > 0)) return
    const sub = Math.max(1, Math.ceil(dt / 0.004))
    const h = dt / sub
    for (let i = 0; i < sub; i++) this.substep(h, inp, i === 0)
    this.stepLiquids(dt, inp)
    this.updateVoices()
  }

  private substep(dt: number, inp: SimInputs, first: boolean) {
    this.time += dt
    const W = this.cfg.width
    const H = this.cfg.height
    const ax = inp.gx * G_CM * this.cfg.gravity
    const ay = inp.gy * G_CM * this.cfg.gravity
    const tiltMag = Math.hypot(inp.gx, inp.gy)

    for (const b of this.bodies) {
      b.flash = Math.max(0, b.flash - dt * 6)
      if (b.cfg.kind === 'marble') {
        const c = b.cfg
        // Solid rolling sphere: a = 5/7 g sinθ
        b.vx += ax * (5 / 7) * dt
        b.vy += ay * (5 / 7) * dt
        const damp = Math.exp(-c.rollingFriction * dt)
        b.vx *= damp
        b.vy *= damp
        if (first && inp.kick) {
          b.vx += (this.rand() - 0.5) * 120
          b.vy += (this.rand() - 0.5) * 80
        }
        if (first && inp.shake > 0.25) {
          b.vx += (this.rand() - 0.5) * inp.shake * 60
          b.vy += (this.rand() - 0.5) * inp.shake * 40
        }
      } else {
        this.critterStep(b, b.cfg, dt, inp, ax, ay, tiltMag, first)
      }

      if (inp.finger && first) {
        const fx = inp.finger.x * W
        const fy = inp.finger.y * H
        const dx = b.x - fx
        const dy = b.y - fy
        const d = Math.hypot(dx, dy)
        const reach = 1.5 + b.r
        if (d < reach && d > 1e-3) {
          // finger pushes things away
          const push = (reach - d) * 40
          b.vx += (dx / d) * push
          b.vy += (dy / d) * push
        }
      }

      b.x += b.vx * dt
      b.y += b.vy * dt

      // walls
      const wallMat = this.cfg.wallMaterial
      const e = b.cfg.kind === 'marble' ? b.cfg.restitution : 0.2
      const hitGain = (b.cfg.kind === 'marble' ? b.cfg.impactGain : 0.25) * this.cfg.wallGain
      if (b.x < b.r) {
        this.impact(b, -b.vx, wallMat, hitGain)
        b.x = b.r
        b.vx = -b.vx * e
        if (b.cfg.kind === 'critter') b.heading = Math.PI - b.heading
      } else if (b.x > W - b.r) {
        this.impact(b, b.vx, wallMat, hitGain)
        b.x = W - b.r
        b.vx = -b.vx * e
        if (b.cfg.kind === 'critter') b.heading = Math.PI - b.heading
      }
      if (b.y < b.r) {
        this.impact(b, -b.vy, wallMat, hitGain)
        b.y = b.r
        b.vy = -b.vy * e
        if (b.cfg.kind === 'critter') b.heading = -b.heading
      } else if (b.y > H - b.r) {
        this.impact(b, b.vy, wallMat, hitGain)
        b.y = H - b.r
        b.vy = -b.vy * e
        if (b.cfg.kind === 'critter') b.heading = -b.heading
      }
    }

    // body-body collisions
    const n = this.bodies.length
    for (let i = 0; i < n; i++) {
      const a = this.bodies[i]
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j]
        if (a.air > 0 || b.air > 0) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const rr = a.r + b.r
        const d2 = dx * dx + dy * dy
        if (d2 >= rr * rr || d2 < 1e-9) continue
        const d = Math.sqrt(d2)
        const nx = dx / d
        const ny = dy / d
        const overlap = rr - d
        const im = 1 / a.m + 1 / b.m
        a.x -= (nx * overlap * (1 / a.m)) / im
        a.y -= (ny * overlap * (1 / a.m)) / im
        b.x += (nx * overlap * (1 / b.m)) / im
        b.y += (ny * overlap * (1 / b.m)) / im
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
        if (vn >= 0) continue
        const ea = a.cfg.kind === 'marble' ? a.cfg.restitution : 0.3
        const eb = b.cfg.kind === 'marble' ? b.cfg.restitution : 0.3
        const e = Math.min(ea, eb)
        const jimp = (-(1 + e) * vn) / im
        a.vx -= (jimp * nx) / a.m
        a.vy -= (jimp * ny) / a.m
        b.vx += (jimp * nx) / b.m
        b.vy += (jimp * ny) / b.m
        // Click between the two: use the harder material, pan at contact point
        const mat = a.cfg.kind === 'marble' ? a.cfg.material : b.cfg.kind === 'marble' ? b.cfg.material : 'soft'
        const gain = ((a.cfg.kind === 'marble' ? a.cfg.impactGain : 0.3) + (b.cfg.kind === 'marble' ? b.cfg.impactGain : 0.3)) / 2
        const mid: Body = { ...a, x: (a.x + b.x) / 2 }
        this.impact(mid, -vn, mat, gain * 0.9)
        a.lastImpact = b.lastImpact = this.time
        a.flash = b.flash = 1
        if (a.cfg.kind === 'critter') a.heading += Math.PI * (0.5 + this.rand())
        if (b.cfg.kind === 'critter') b.heading += Math.PI * (0.5 + this.rand())
      }
    }

  }

  private critterStep(b: Body, c: CritterConfig, dt: number, inp: SimInputs, ax: number, ay: number, tiltMag: number, first: boolean) {
    // Airborne (hopping)
    if (b.air > 0) {
      b.air -= dt
      if (b.air <= 0) {
        b.air = 0
        const g = thumpGrain(c.landGain * Math.min(1, 0.5 + b.airTotal), this.pan(b.x), 120 * c.pitch)
        this.sink.grain(g)
        b.flash = 1
      }
      return
    }

    if (first && (inp.jump || inp.kick || (inp.shake > 0.35 && this.rand() < 0.6))) {
      this.hop(b, c, inp.kick ? 0.5 : 0.35)
      return
    }
    if (first && this.rand() < c.hopChance * dt * 4) {
      this.hop(b, c, 0.25)
      return
    }

    // Wander: occasionally change heading
    b.wanderT -= dt
    if (b.wanderT <= 0) {
      b.wanderT = 0.4 + this.rand() * 1.6
      b.heading += (this.rand() - 0.5) * 1.8
    }

    // Flee the finger
    let speedMul = 1
    if (inp.finger && c.shy) {
      const fx = inp.finger.x * this.cfg.width
      const fy = inp.finger.y * this.cfg.height
      const dx = b.x - fx
      const dy = b.y - fy
      const d = Math.hypot(dx, dy)
      if (d < 5) {
        const away = Math.atan2(dy, dx)
        // steer toward away direction
        const diff = Math.atan2(Math.sin(away - b.heading), Math.cos(away - b.heading))
        b.heading += diff * Math.min(1, dt * 10)
        speedMul = 2.2
      }
    }

    // Tilt: critters lean into the slope; steep tilt makes them slip and scramble
    const slipping = tiltMag > 0.35
    if (slipping) speedMul *= 1.6
    const target = c.speed * speedMul
    const wantVx = Math.cos(b.heading) * target
    const wantVy = Math.sin(b.heading) * target
    const grip = slipping ? 3 : 12
    b.vx += (wantVx - b.vx) * Math.min(1, grip * dt) + ax * c.slip * dt * (slipping ? 1 : 0.15)
    b.vy += (wantVy - b.vy) * Math.min(1, grip * dt) + ay * c.slip * dt * (slipping ? 1 : 0.15)

    // Footsteps: stride rate scales with actual speed
    const v = Math.hypot(b.vx, b.vy)
    const rate = c.stepRate * Math.min(2.5, v / Math.max(0.1, c.speed))
    b.stepPhase += rate * dt
    if (b.stepPhase >= 1) {
      b.stepPhase -= 1
      b.foot ^= 1
      // left/right feet sit slightly apart, gives a subtle stereo patter
      const footOffset = (b.foot ? 1 : -1) * 0.12
      const amp = c.stepGain * (0.75 + this.rand() * 0.25) * (slipping ? 1.2 : 1)
      this.sink.grain(tapGrain(amp, Math.max(-1, Math.min(1, this.pan(b.x) + footOffset)), (210 + this.rand() * 40) * c.pitch))
    }
  }

  private hop(b: Body, c: CritterConfig, height: number) {
    b.air = height
    b.airTotal = height
    // push-off tap
    this.sink.grain(tapGrain(c.stepGain * 0.9, this.pan(b.x), 170 * c.pitch))
    const dir = b.heading + (this.rand() - 0.5)
    b.vx = Math.cos(dir) * c.speed * 1.5
    b.vy = Math.sin(dir) * c.speed * 1.5
  }

  /** Liquids run at their own fixed step (~2.8 ms): the position-based solver needs small steps to stay incompressible. */
  private stepLiquids(dt: number, inp: SimInputs) {
    if (!this.liquids.length || !(dt > 0)) return
    const sub = Math.max(1, Math.ceil(dt / 0.0028))
    const h = dt / sub
    const W = this.cfg.width
    const Hh = this.cfg.height
    for (const l of this.liquids) {
      for (let i = 0; i < sub; i++) {
        l.sim.step(h, {
          width: W,
          height: Hh,
          ax: inp.gx * G_CM * this.cfg.gravity,
          ay: inp.gy * G_CM * this.cfg.gravity,
          shake: i === 0 ? inp.shake : 0,
          finger: inp.finger ? { x: inp.finger.x * W, y: inp.finger.y * Hh } : null,
          kick: i === 0 && inp.kick,
        })
        // marbles and critters displace the water (and get a little drag from it)
        for (const body of this.bodies) if (body.air <= 0) l.sim.pushOut(body)
      }
      l.sim.emit(this.sink, W, dt)
    }
  }

  private updateVoices() {
    for (const b of this.bodies) {
      if (b.cfg.kind !== 'marble') continue
      const key = `roll:${b.key}`
      const v = Math.hypot(b.vx, b.vy)
      const c = b.cfg
      if (v > 1.5 && c.rollGain > 0) {
        const amp = Math.min(1, Math.pow(v / 50, 0.9)) * c.rollGain * 0.5 * Math.min(1.5, b.m)
        const p: ContinuousParams = {
          kind: 'noise',
          freq: (50 + v * 2.2) * c.pitch,
          q: 2.2,
          amp,
          pan: this.pan(b.x),
          // surface texture: bumps per second ∝ speed / circumference
          amRate: v / (2 * Math.PI * b.r) * 2,
          amDepth: 0.45,
        }
        this.sink.voice(key, p)
        this.voicesOn.add(key)
      } else if (this.voicesOn.has(key)) {
        this.sink.voice(key, null)
        this.voicesOn.delete(key)
      }
    }
  }
}
