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
  /** 0..0.5: each marble gets a random radius within ±this fraction, so rows of identical
   *  marbles can't lock up (missing in older scene files = 0) */
  sizeVariation?: number
  /** grams-ish; relative */
  mass: number
  /** 0..1 */
  restitution: number
  /** rolling resistance, 1/s velocity damping */
  rollingFriction: number
  /** no longer shown in the UI: marble clicks use the wall material */
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
  /** 0..1 chance of a little hop on reaching the spot it went to investigate */
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
  /** 0..1: things near the bottom wall (by the grips) feel louder, near the top wall softer, so you can
   *  tell up from down. 1 = ±10 dB at the walls (missing in older scene files = default) */
  depthFade?: number
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
    hopChance: 0.3, stepGain: 0.55, landGain: 0.8, pitch: 1, slip: 0.35, shy: true, color: '#ffb347',
  }
}

export function defaultLiquid(): LiquidConfig {
  return { id: nid('l'), kind: 'liquid', name: 'Water', amount: 0.5, viscosity: 0, gain: 0.7, color: '#3f8cff' }
}

export const SCENE_PRESETS: { name: string; make: () => SceneConfig }[] = [
  {
    name: 'Marble box (Ball Count)',
    make: () => ({
      version: 1, name: 'Marble box', width: 16, height: 7, gravity: 1, wallMaterial: 'wood', wallGain: 1,
      entities: [{ ...defaultMarbles(), count: 4, sizeVariation: 0.25 }],
    }),
  },
  {
    name: 'Critters inside',
    make: () => ({
      version: 1, name: 'Critters', width: 16, height: 7, gravity: 1, wallMaterial: 'wood', wallGain: 0.6,
      entities: [{ ...defaultCritters(), count: 1, radius: 0.35, speed: 3.5, stepRate: 7.5, hopChance: 0.3, stepGain: 2, landGain: 2, pitch: 1.5, slip: 0.35, shy: true }],
    }),
  },
  {
    name: 'Steel ball bearing',
    make: () => ({
      version: 1, name: 'Ball bearing', width: 16, height: 7, gravity: 1, wallMaterial: 'wood', wallGain: 2,
      entities: [{ ...defaultMarbles(), name: 'Bearing', count: 1, radius: 0.6, mass: 2.7, restitution: 0.3, rollingFriction: 2.1, impactGain: 2, rollGain: 1.4, pitch: 1, color: '#c0c6d0' }],
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
  /** -1..1, fixed per body: where its radius sits in the size-variation range */
  sizeRand: number
  m: number
  /** seconds left in the air (hop or toss), and the whole flight's length */
  air: number
  airTotal: number
  /** in the air because the box was tossed (not a hop of its own) */
  tossed: boolean
  lastImpact: number
  /** recent impact flash for drawing */
  flash: number
  // critter state
  heading: number
  /** where the critter wants to face; heading turns toward it at a mood-dependent rate */
  headingTarget: number
  stepPhase: number
  foot: number
  mood: Mood
  /** seconds left in the current mood */
  moodT: number
  /** timer for small changes within a mood (look around, wander drift) */
  turnT: number
  /** wander pace, fraction of walk speed */
  wanderSf: number
  /** investigate: target point, or a body to walk up to / follow */
  tx: number
  ty: number
  tBody: Body | null
  /** investigate: top speed, fraction of walk speed */
  peakSf: number
  /** partner of a greeting sniff, decides who wanders off and who follows */
  greetWith: Body | null
  /** seconds of being on edge after a scare: dodges marbles more readily */
  jumpy: number
  /** the marble it already decided whether to dodge (one roll per approach) */
  threatKey: string | null
  /** nose near a wall while wandering (one decision per approach) */
  wallSeen: boolean
}

/**
 * What a critter is up to. pause: stands, looks around · wander: ambles along a curving
 * path · investigate: hurries to a spot (or another critter), slows and stops there ·
 * sniff: stands at the spot · follow: tags along behind another critter · flee: runs
 * from the finger · dodge: scurries off a marble's path · knocked: sliding after a hit,
 * no footing.
 */
type Mood = 'pause' | 'wander' | 'investigate' | 'sniff' | 'follow' | 'flee' | 'dodge' | 'knocked'

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

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
  /** peak upward acceleration since the last frame, in g beyond gravity: a quick lift tosses everything */
  lift: number
}

const G_CM = 981
export const DEFAULT_DEPTH_FADE = 0.6
/** upward g that counts as a toss */
const LIFT_MIN = 0.45
/** slowest a critter walks (fraction of walk speed); anything slower is standing still */
const MIN_PACE = 0.45

export class SceneSim {
  bodies: Body[] = []
  liquids: LiquidState[] = []
  time = 0
  private rand = rng(42)
  private voicesOn = new Set<string>()
  private lastToss = -1

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
        const sizeRand = prev?.sizeRand ?? this.rand() * 2 - 1
        const r = e.kind === 'marble' ? e.radius * (1 + (e.sizeVariation ?? 0) * sizeRand) : e.radius
        const b: Body = prev ?? {
          key,
          cfg: e,
          x: r + this.rand() * (this.cfg.width - 2 * r),
          y: r + this.rand() * (this.cfg.height - 2 * r),
          vx: 0,
          vy: 0,
          r,
          sizeRand,
          m: 1,
          air: 0,
          airTotal: 0,
          tossed: false,
          lastImpact: 0,
          flash: 0,
          heading: 0,
          headingTarget: 0,
          stepPhase: this.rand(),
          foot: 0,
          mood: 'pause',
          moodT: 0.3 + this.rand() * 1.5,
          turnT: this.rand(),
          wanderSf: 0.7,
          tx: 0,
          ty: 0,
          tBody: null,
          peakSf: 1,
          greetWith: null,
          jumpy: 0,
          threatKey: null,
          wallSeen: false,
        }
        if (!prev) b.heading = b.headingTarget = this.rand() * Math.PI * 2
        b.cfg = e
        b.r = r
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

  /** y (cm) → loudness: louder toward the bottom wall (the grips), softer toward the top, 1 in the middle */
  depth(y: number) {
    const f = Math.max(0, Math.min(1, y / this.cfg.height))
    return Math.pow(10, ((f - 0.5) * 20 * (this.cfg.depthFade ?? DEFAULT_DEPTH_FADE)) / 20)
  }

  /** x (cm) → pan -1..1 */
  private pan(x: number) {
    return Math.max(-1, Math.min(1, (x / this.cfg.width) * 2 - 1))
  }

  private impact(b: Body, speed: number, material: Material, gain: number, delay = 0) {
    // Ignore resting micro-contacts
    if (speed < 2.5 || this.time - b.lastImpact < 0.015) return
    b.lastImpact = this.time
    const amp = Math.min(1, Math.pow(speed / 60, 0.8)) * gain * Math.min(1.5, 0.6 + b.m * 0.4) * this.depth(b.y)
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

    if (first && inp.lift > LIFT_MIN && this.time - this.lastToss > 0.4) this.toss(inp.lift)

    for (const b of this.bodies) {
      b.flash = Math.max(0, b.flash - dt * 6)
      if (b.cfg.kind === 'marble') {
        const c = b.cfg
        if (b.air > 0) {
          // In flight: keeps its sideways speed, no rolling
          b.air -= dt
          if (b.air <= 0) this.marbleLand(b, c)
        } else {
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
      // A critter that walks into a wall turns away from it (a knocked one just slides)
      const turnAway = b.cfg.kind === 'critter' && b.mood !== 'knocked'
      if (b.x < b.r) {
        this.impact(b, -b.vx, wallMat, hitGain)
        b.x = b.r
        b.vx = -b.vx * e
        if (turnAway) b.headingTarget = Math.PI - b.heading
      } else if (b.x > W - b.r) {
        this.impact(b, b.vx, wallMat, hitGain)
        b.x = W - b.r
        b.vx = -b.vx * e
        if (turnAway) b.headingTarget = Math.PI - b.heading
      }
      if (b.y < b.r) {
        this.impact(b, -b.vy, wallMat, hitGain)
        b.y = b.r
        b.vy = -b.vy * e
        if (turnAway) b.headingTarget = -b.heading
      } else if (b.y > H - b.r) {
        this.impact(b, b.vy, wallMat, hitGain)
        b.y = H - b.r
        b.vy = -b.vy * e
        if (turnAway) b.headingTarget = -b.heading
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
        // Click between the two: marbles click in the wall material, pan at contact point
        const mat = a.cfg.kind === 'marble' || b.cfg.kind === 'marble' ? this.cfg.wallMaterial : 'soft'
        const gain = ((a.cfg.kind === 'marble' ? a.cfg.impactGain : 0.3) + (b.cfg.kind === 'marble' ? b.cfg.impactGain : 0.3)) / 2
        const mid: Body = { ...a, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        this.impact(mid, -vn, mat, gain * 0.9)
        a.lastImpact = b.lastImpact = this.time
        a.flash = b.flash = 1
        if (a.cfg.kind === 'critter') this.critterBumped(a, b)
        if (b.cfg.kind === 'critter') this.critterBumped(b, a)
      }
    }

  }

  private critterStep(b: Body, c: CritterConfig, dt: number, inp: SimInputs, ax: number, ay: number, tiltMag: number, first: boolean) {
    // Airborne (hopping or tossed)
    if (b.air > 0) {
      b.air -= dt
      if (b.air <= 0) {
        b.air = 0
        const g = thumpGrain(c.landGain * Math.min(1, 0.5 + b.airTotal) * this.depth(b.y), this.pan(b.x), 120 * c.pitch)
        this.sink.grain(g)
        b.flash = 1
        if (b.tossed) {
          // dazed for a moment after being thrown about
          b.tossed = false
          this.setMood(b, 'pause', 0.6 + this.rand() * 0.8)
          b.jumpy = 3
        }
      }
      return
    }

    if (first && (inp.jump || inp.kick)) {
      this.hop(b, c, inp.kick ? 0.5 : 0.35, 1.5)
      return
    }
    // A hard rattle (not a lift, which tosses them) knocks them off their feet
    if (first && inp.shake > 0.35 && b.mood !== 'knocked' && this.time - this.lastToss > 0.6 && this.rand() < 0.15) {
      b.vx += (this.rand() - 0.5) * c.speed * 6
      b.vy += (this.rand() - 0.5) * c.speed * 6
      this.setMood(b, 'knocked', 0.25)
      b.jumpy = 3
    }

    b.jumpy = Math.max(0, b.jumpy - dt)
    b.moodT -= dt
    const W = this.cfg.width
    const H = this.cfg.height

    // Flee the finger: interrupts whatever it was doing, then it stops to catch its breath
    if (inp.finger && c.shy && b.mood !== 'knocked') {
      const dx = b.x - inp.finger.x * W
      const dy = b.y - inp.finger.y * H
      if (Math.hypot(dx, dy) < 5) {
        if (b.mood !== 'flee') this.setMood(b, 'flee', 0.4)
        b.moodT = 0.4
        b.headingTarget = Math.atan2(dy, dx)
      }
    }

    if (first && b.mood !== 'knocked') this.watchMarbles(b)

    // Sliding after a hit: no footing, no steps, until it skids to a stop
    if (b.mood === 'knocked') {
      const damp = Math.exp(-5 * dt)
      b.vx = b.vx * damp + ax * c.slip * dt
      b.vy = b.vy * damp + ay * c.slip * dt
      // (on a slope it may never come to rest: it finds its feet after a second regardless)
      if ((b.moodT <= 0 && Math.hypot(b.vx, b.vy) < 1.5) || b.moodT < -1) {
        this.setMood(b, 'pause', 0.5 + this.rand() * 0.7)
        b.jumpy = 4
      }
      return
    }

    // Each mood sets a pace (fraction of walk speed) and how fast it turns
    let sf = 0
    let turn = 5
    let faceFirst = true
    switch (b.mood) {
      case 'pause':
      case 'sniff': {
        b.turnT -= dt
        if (b.turnT <= 0) {
          // look around: a turn in place (sniffing: just small head turns)
          const sniff = b.mood === 'sniff'
          b.turnT = sniff ? 0.25 + this.rand() * 0.4 : 0.6 + this.rand() * 1.4
          const look = sniff ? 0.3 : 0.5 + this.rand() * 1.2
          b.headingTarget = b.heading + (this.rand() < 0.5 ? -look : look)
          if (!sniff && this.facingWall(b, 1.5)) b.headingTarget = this.angleToCenter(b) + (this.rand() - 0.5) * 1.5
        }
        if (b.moodT <= 0) this.nextMood(b)
        break
      }
      case 'wander': {
        b.turnT -= dt
        if (b.turnT <= 0) {
          b.turnT = 0.3 + this.rand() * 0.8
          b.headingTarget += (this.rand() - 0.5) * 1.2
          b.wanderSf = 0.45 + this.rand() * 0.45
        }
        sf = b.wanderSf
        turn = 2.5
        // Nose near a wall: sometimes walk up to it and stop, otherwise curve away
        if (this.facingWall(b, 1 + sf * c.speed * 0.25)) {
          if (!b.wallSeen) {
            b.wallSeen = true
            if (this.rand() < 0.35) {
              this.setMood(b, 'pause', 0.5 + this.rand() * 1.2)
              sf = 0
              break
            }
            b.headingTarget = this.angleToCenter(b) + (this.rand() - 0.5) * 1.6
          }
          sf *= 0.5
        } else b.wallSeen = false
        if (b.moodT <= 0) this.nextMood(b)
        break
      }
      case 'investigate':
      case 'follow': {
        let tx = b.tx
        let ty = b.ty
        let reach = b.r * 0.6
        if (b.tBody) {
          tx = b.tBody.x
          ty = b.tBody.y
          reach = b.r + b.tBody.r + (b.mood === 'follow' ? 1.2 : 0.25)
        }
        const left = Math.hypot(tx - b.x, ty - b.y) - reach
        b.headingTarget = Math.atan2(ty - b.y, tx - b.x)
        turn = 7
        if (b.mood === 'investigate') {
          if (left <= 0 || b.moodT <= 0) {
            this.arrive(b, c, left <= 0)
            break
          }
          // hurry over, slowing to a stop on the spot
          sf = b.peakSf * Math.min(1, Math.max(0.2, left / 2.5))
        } else {
          sf = Math.min(1.6, Math.max(0, left / 1.5))
          if (b.moodT <= 0) this.nextMood(b)
        }
        break
      }
      case 'flee':
        sf = 2.2
        turn = 10
        faceFirst = false
        if (b.moodT <= 0) {
          this.setMood(b, 'pause', 0.6 + this.rand() * 0.9)
          b.jumpy = 3
        }
        break
      case 'dodge':
        sf = 2.5
        turn = 20
        faceFirst = false
        if (b.moodT <= 0) this.setMood(b, 'pause', 0.3 + this.rand() * 0.6)
        break
    }

    // Turn toward where it wants to face
    const diff = wrapAngle(b.headingTarget - b.heading)
    const dh = Math.sign(diff) * Math.min(Math.abs(diff), turn * dt)
    b.heading = wrapAngle(b.heading + dh)
    b.headingTarget = b.heading + diff - dh
    // it turns to face something before setting off toward it
    if (faceFirst) sf *= Math.max(0.15, Math.cos(Math.min(Math.PI / 2, Math.abs(diff))))
    // Nobody creeps along: below a modest pace it either walks at that pace or stops.
    // (a bit of hysteresis, so it doesn't stutter between the two)
    const moving = Math.hypot(b.vx, b.vy) > c.speed * MIN_PACE * 0.5
    sf = sf < MIN_PACE * (moving ? 0.4 : 0.75) ? 0 : Math.max(sf, MIN_PACE)

    // Tilt: critters lean into the slope; steep tilt makes them slip and scramble
    const slipping = tiltMag > 0.35
    const target = c.speed * sf * (slipping ? 1.6 : 1)
    const wantVx = Math.cos(b.heading) * target
    const wantVy = Math.sin(b.heading) * target
    const grip = slipping ? 3 : 12
    b.vx += (wantVx - b.vx) * Math.min(1, grip * dt) + ax * c.slip * dt * (slipping ? 1 : 0.15)
    b.vy += (wantVy - b.vy) * Math.min(1, grip * dt) + ay * c.slip * dt * (slipping ? 1 : 0.15)

    // Footsteps. Step rate is the base pace at walk speed (short legs step faster); going faster
    // lengthens the stride as well as quickening it, so tempo rises slower than speed.
    // Turning on the spot shuffles the feet too.
    const v = Math.hypot(b.vx, b.vy) + (Math.abs(dh) / dt) * b.r * 1.5
    const rel = v / Math.max(0.1, c.speed)
    if (rel < 0.1) {
      // standing still: no steps; the first step comes soon after it sets off
      b.stepPhase = Math.min(b.stepPhase, 0.6)
      return
    }
    b.stepPhase += c.stepRate * Math.min(2.2, Math.pow(rel, 0.6)) * dt
    if (b.stepPhase >= 1) {
      b.stepPhase -= 1
      b.foot ^= 1
      // left/right feet sit slightly apart, gives a subtle stereo patter
      const footOffset = (b.foot ? 1 : -1) * 0.12
      // feet land harder the faster it goes: soft when ambling, heavy when running
      const force = Math.min(1.6, 0.3 + 0.7 * Math.pow(rel, 0.8))
      const amp = c.stepGain * (0.75 + this.rand() * 0.25) * (slipping ? 1.2 : 1) * force
      this.sink.grain(tapGrain(amp * this.depth(b.y), Math.max(-1, Math.min(1, this.pan(b.x) + footOffset)), (210 + this.rand() * 40) * c.pitch))
    }
  }

  private setMood(b: Body, mood: Mood, t: number) {
    b.mood = mood
    b.moodT = t
    b.turnT = mood === 'wander' ? 0 : 0.4 + this.rand() * 0.6
    if (mood !== 'investigate' && mood !== 'follow') b.tBody = null
  }

  /** Pick what to do next once a mood runs out. */
  private nextMood(b: Body) {
    const prev = b.mood
    // end of a greeting: this one wanders off, the other may tag along
    if (prev === 'sniff' && b.greetWith) {
      const o = b.greetWith
      b.greetWith = o.greetWith = null
      this.setMood(b, 'wander', 2 + this.rand() * 4)
      if (o.air <= 0 && (o.mood === 'sniff' || o.mood === 'pause')) {
        if (this.rand() < 0.5) {
          this.setMood(o, 'follow', 2 + this.rand() * 3)
          o.tBody = b
        } else this.setMood(o, 'pause', 0.5 + this.rand() * 1.5)
      }
      return
    }
    const r = this.rand()
    if (prev === 'pause' || prev === 'sniff') {
      if (r < 0.45) this.setMood(b, 'wander', 2 + this.rand() * 4)
      else if (r < 0.85) this.startInvestigate(b)
      else this.setMood(b, 'pause', 0.8 + this.rand() * 1.5)
    } else {
      if (r < 0.5) this.setMood(b, 'pause', 0.6 + this.rand() * 2.2)
      else if (r < 0.8) this.startInvestigate(b)
      else this.setMood(b, 'wander', 2 + this.rand() * 4)
    }
  }

  /** Something caught its eye: a spot in the box, or now and then another critter. */
  private startInvestigate(b: Body) {
    const others = this.bodies.filter((o) => o !== b && o.cfg.kind === 'critter' && o.air <= 0)
    this.setMood(b, 'investigate', 8)
    b.peakSf = 1.1 + this.rand() * 0.6
    if (others.length && this.rand() < 0.35) {
      b.tBody = others[Math.floor(this.rand() * others.length)]
      return
    }
    const m = b.r + 0.6
    const W = this.cfg.width
    const H = this.cfg.height
    for (let i = 0; i < 6; i++) {
      b.tx = m + this.rand() * Math.max(0, W - 2 * m)
      b.ty = m + this.rand() * Math.max(0, H - 2 * m)
      if (Math.hypot(b.tx - b.x, b.ty - b.y) > 2.5) break
    }
  }

  private arrive(b: Body, c: CritterConfig, reached: boolean) {
    const other = b.tBody
    b.tBody = null
    if (other && reached) {
      // a greeting: both stop and sniff at each other
      this.setMood(b, 'sniff', 0.8 + this.rand() * 1.2)
      if (other.air <= 0 && (other.mood === 'pause' || other.mood === 'wander' || other.mood === 'sniff')) {
        this.setMood(other, 'sniff', b.moodT + 0.3)
        other.headingTarget = Math.atan2(b.y - other.y, b.x - other.x)
        other.greetWith = b
        b.greetWith = other
      }
      return
    }
    this.setMood(b, 'sniff', 0.6 + this.rand() * 1.0)
    // sometimes a little hop of excitement on getting there
    if (reached && this.rand() < c.hopChance) this.hop(b, c, 0.22, 0.3)
  }

  /** Watch for marbles on a collision course: if it notices in time, it scurries out of the way. */
  private watchMarbles(b: Body) {
    let threat: Body | null = null
    let side = 0
    for (const m of this.bodies) {
      if (m.cfg.kind !== 'marble' || m.air > 0) continue
      const dx = m.x - b.x
      const dy = m.y - b.y
      const wx = m.vx - b.vx
      const wy = m.vy - b.vy
      const w2 = wx * wx + wy * wy
      const closing = -(dx * wx + dy * wy)
      if (w2 < 64 || closing <= 0) continue
      const t = closing / w2
      if (t > 0.7) continue
      if (Math.hypot(dx + wx * t, dy + wy * t) > b.r + m.r + 0.4) continue
      threat = m
      // which side of the marble's path the critter is on
      side = dx * wy - dy * wx
      break
    }
    if (!threat) {
      b.threatKey = null
      return
    }
    if (b.threatKey === threat.key) return
    b.threatKey = threat.key
    // fast marbles are easy to miss; a scared critter is watchful
    const speed = Math.hypot(threat.vx, threat.vy)
    const notice = Math.min(0.95, Math.max(0.1, 0.95 - speed / 120 + (b.jumpy > 0 ? 0.3 : 0)))
    if (this.rand() > notice) return
    const away = Math.atan2(threat.vy - b.vy, threat.vx - b.vx) + (side >= 0 ? Math.PI / 2 : -Math.PI / 2)
    this.setMood(b, 'dodge', 0.35 + this.rand() * 0.2)
    b.heading = b.headingTarget = wrapAngle(away)
    b.jumpy = Math.max(b.jumpy, 2)
  }

  private critterBumped(b: Body, other: Body) {
    if (b.air > 0) return
    if (other.cfg.kind === 'marble') {
      // hit: the collision already sent it off in the marble's direction; it just loses its footing
      this.setMood(b, 'knocked', 0.2)
      b.jumpy = 4
      return
    }
    if (b.tBody === other || b.greetWith === other) return
    b.headingTarget = Math.atan2(b.y - other.y, b.x - other.x) + (this.rand() - 0.5)
    if ((b.mood === 'wander' || b.mood === 'investigate') && this.rand() < 0.3) this.setMood(b, 'pause', 0.3 + this.rand() * 0.5)
  }

  private facingWall(b: Body, dist: number) {
    const px = b.x + Math.cos(b.heading) * (b.r + dist)
    const py = b.y + Math.sin(b.heading) * (b.r + dist)
    return px < b.r || px > this.cfg.width - b.r || py < b.r || py > this.cfg.height - b.r
  }

  private angleToCenter(b: Body) {
    return Math.atan2(this.cfg.height / 2 - b.y, this.cfg.width / 2 - b.x)
  }

  private hop(b: Body, c: CritterConfig, height: number, forward: number) {
    b.air = height
    b.airTotal = height
    // push-off tap
    this.sink.grain(tapGrain(c.stepGain * 0.9 * this.depth(b.y), this.pan(b.x), 170 * c.pitch))
    const dir = b.heading + (this.rand() - 0.5)
    b.vx = Math.cos(dir) * c.speed * forward
    b.vy = Math.sin(dir) * c.speed * forward
  }

  /** A quick lift of the controller throws everything off the floor; harder lifts, longer flights. */
  private toss(lift: number) {
    this.lastToss = this.time
    const strength = Math.min(1, (lift - LIFT_MIN) / 1.2)
    for (const b of this.bodies) {
      if (b.air > 0) continue
      // each flies a little differently, so they come down in a scattered patter
      const t = (0.12 + 0.35 * strength) * (0.8 + this.rand() * 0.4)
      b.air = b.airTotal = t
      b.tossed = true
      b.vx += (this.rand() - 0.5) * 10 * strength
      b.vy += (this.rand() - 0.5) * 10 * strength
    }
  }

  private marbleLand(b: Body, c: MarbleConfig) {
    b.air = 0
    // falling speed from the flight time, hits the box floor
    const vz = (G_CM * this.cfg.gravity * b.airTotal) / 2
    b.lastImpact = -1
    this.impact(b, vz * 0.35, this.cfg.wallMaterial, c.impactGain * this.cfg.wallGain)
    // bounces a couple of times, each smaller
    const next = b.airTotal * c.restitution * 0.8
    if (next > 0.04) b.air = b.airTotal = next
    else b.tossed = false
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
      l.sim.emit(this.sink, W, dt, (y) => this.depth(y))
    }
  }

  private updateVoices() {
    for (const b of this.bodies) {
      if (b.cfg.kind !== 'marble') continue
      const key = `roll:${b.key}`
      const v = b.air > 0 ? 0 : Math.hypot(b.vx, b.vy)
      const c = b.cfg
      if (v > 1.5 && c.rollGain > 0) {
        const amp = Math.min(1, Math.pow(v / 50, 0.9)) * c.rollGain * 0.5 * Math.min(1.5, b.m) * this.depth(b.y)
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
