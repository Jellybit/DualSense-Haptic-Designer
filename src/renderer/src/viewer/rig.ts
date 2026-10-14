// Mapping from logical controller inputs to nodes in the 3D model.

import type { Object3D } from 'three'
import { DUALSENSE_LOCATORS, locateParts } from './locate'

import type { ButtonName } from '../device/inputReport'

export type RigControl = ButtonName | 'leftStick' | 'rightStick' | 'lightbar'

/**
 * Where hinge/tilt rotations pivot, in the controller frame. 'auto' = top-near edge for
 * hinges (triggers), bottom-centre for tilts (sticks). 'origin' = the node's own origin,
 * for properly rigged models.
 */
export type PivotMode = 'auto' | 'origin' | 'center' | 'bottom' | 'top-near' | 'top-far'
export const PIVOT_MODES: PivotMode[] = ['auto', 'origin', 'center', 'bottom', 'top-near', 'top-far']

export interface RigEntry {
  /** node name in the model, null = unmapped */
  node: string | null
  /** All motions are in the controller frame (+x right, +y up out of the face, +z toward the player).
   *  press: translate along -axis; hinge: rotate about axis; tilt: stick 2-axis rotation */
  motion: 'press' | 'hinge' | 'tilt' | 'color'
  axis: 'x' | 'y' | 'z'
  /** press depth in model units (after auto-scale, model is ~16 units wide) or max degrees */
  amount: number
  invert?: boolean
  pivot?: PivotMode
  /** additional parts that move together with `node` (e.g. a button cap and its glyph) */
  extra?: string[]
}

export interface RigMap {
  /** extra rotation applied to the loaded model, degrees XYZ */
  modelRotation: [number, number, number]
  entries: Record<RigControl, RigEntry>
}

const press = (amount = 0.12): RigEntry => ({ node: null, motion: 'press', axis: 'y', amount })

export const RIG_CONTROLS: RigControl[] = [
  'cross', 'circle', 'square', 'triangle',
  'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight',
  'l1', 'r1', 'l2', 'r2', 'l3', 'r3', 'leftStick', 'rightStick',
  'create', 'options', 'ps', 'touchpad', 'mute',
  'fnLeft', 'fnRight', 'paddleLeft', 'paddleRight', 'lightbar',
]

export function defaultRig(): RigMap {
  const entries = {} as Record<RigControl, RigEntry>
  for (const c of RIG_CONTROLS) entries[c] = press()
  entries.l2 = { node: null, motion: 'hinge', axis: 'x', amount: -25 }
  entries.r2 = { node: null, motion: 'hinge', axis: 'x', amount: -25 }
  entries.l1 = { node: null, motion: 'press', axis: 'y', amount: 0.08 }
  entries.r1 = { node: null, motion: 'press', axis: 'y', amount: 0.08 }
  entries.leftStick = { node: null, motion: 'tilt', axis: 'y', amount: 22 }
  entries.rightStick = { node: null, motion: 'tilt', axis: 'y', amount: 22 }
  entries.l3 = press(0.15)
  entries.r3 = press(0.15)
  entries.touchpad = press(0.06)
  entries.lightbar = { node: null, motion: 'color', axis: 'y', amount: 0 }
  return { modelRotation: [0, 0, 0], entries }
}

/** Name patterns for auto-mapping arbitrary models. First match wins. */
const PATTERNS: Record<RigControl, RegExp[]> = {
  cross: [/^cross$/i, /cross|btn_?x\b|button_?x\b|\bx_?(btn|button)/i],
  circle: [/^circle$/i, /circle/i],
  square: [/^square$/i, /square/i],
  triangle: [/^triangle$/i, /triangle/i],
  dpadUp: [/dpad.*up|d_?pad.*up|up.*arrow|arrow.*up|\bup\b/i],
  dpadDown: [/dpad.*down|d_?pad.*down|down.*arrow|arrow.*down|\bdown\b/i],
  dpadLeft: [/dpad.*left|d_?pad.*left|left.*arrow|arrow.*left/i],
  dpadRight: [/dpad.*right|d_?pad.*right|right.*arrow|arrow.*right/i],
  l1: [/^l1$/i, /\bl1\b|l_?bumper|left_?bumper|lb\b/i],
  r1: [/^r1$/i, /\br1\b|r_?bumper|right_?bumper|rb\b/i],
  l2: [/^l2$/i, /\bl2\b|l_?trigger|left_?trigger|\blt\b/i],
  r2: [/^r2$/i, /\br2\b|r_?trigger|right_?trigger|\brt\b/i],
  l3: [/^l3$/i, /\bl3\b|left_?stick_?cap|left_?thumb_?cap/i],
  r3: [/^r3$/i, /\br3\b|right_?stick_?cap|right_?thumb_?cap/i],
  leftStick: [/^leftstick$/i, /left_?(analog|stick|thumb|joystick)/i, /stick_?l\b|l_?stick/i],
  rightStick: [/^rightstick$/i, /right_?(analog|stick|thumb|joystick)/i, /stick_?r\b|r_?stick/i],
  create: [/^create$/i, /create|share/i],
  options: [/^options$/i, /options|menu|start/i],
  ps: [/^ps$/i, /\bps_?(btn|button)?\b|home|playstation/i],
  touchpad: [/^touchpad$/i, /touch_?pad|track_?pad/i],
  mute: [/^mute$/i, /mute|mic/i],
  fnLeft: [/fn_?l|left_?fn/i],
  fnRight: [/fn_?r|right_?fn/i],
  paddleLeft: [/paddle_?l|left_?paddle|back_?l/i],
  paddleRight: [/paddle_?r|right_?paddle|back_?r/i],
  lightbar: [/light_?bar|led_?bar|light_?strip/i],
}

/** Fill unmapped entries by matching node names. */
export function autoMap(rig: RigMap, nodeNames: string[]): RigMap {
  const next: RigMap = { ...rig, entries: { ...rig.entries } }
  const used = new Set(Object.values(rig.entries).map((e) => e.node).filter(Boolean))
  for (const control of RIG_CONTROLS) {
    const e = next.entries[control]
    if (e.node && nodeNames.includes(e.node)) continue
    let found: string | null = null
    for (const re of PATTERNS[control]) {
      found = nodeNames.find((n) => re.test(n) && !used.has(n)) ?? null
      if (found) break
    }
    next.entries[control] = { ...e, node: found }
    if (found) used.add(found)
  }
  return next
}

/** Shared state for click-to-pick mapping between the rig table and the 3D view. */
export const pickState = {
  /** control currently waiting for a click on the model */
  control: null as RigControl | null,
  /** node name to outline in the viewer */
  highlight: null as string | null,
  onPick: null as ((control: RigControl, node: string, add: boolean) => void) | null,
  start(control: RigControl, onPick: (control: RigControl, node: string, add: boolean) => void) {
    this.control = control
    this.onPick = onPick
  },
  cancel() {
    this.control = null
    this.onPick = null
  },
  /** `add` = Shift held: toggle as an extra part and keep picking */
  finish(node: string, add = false) {
    const c = this.control
    const cb = this.onPick
    if (!add) this.cancel()
    this.highlight = node
    if (c && cb) cb(c, node, add)
  },
}

// ---------------------------------------------------------------------------
// Ready-made rigs for known models (matched by characteristic node names).

interface KnownRig {
  name: string
  match: string[]
  /** `root`: the loaded (split + normalized) model, for rigs that locate parts by position */
  rig: (root: Object3D) => RigMap
}

/** Smaller press depths for the small centre buttons. */
const SMALL_PRESS: Partial<Record<RigControl, number>> = { create: 0.08, options: 0.08, ps: 0.08, mute: 0.06, touchpad: 0.06 }

export const KNOWN_RIGS: KnownRig[] = [
  {
    // "Playstation 5 Dualsense" by AHarmlessPotato, Sketchfab (CC-BY-4.0). Merged into 3
    // meshes all named "defaultMaterial", so parts are found by position after splitting.
    name: 'Sketchfab Playstation 5 Dualsense (AHarmlessPotato)',
    match: ['DualSense', 'defaultMaterial'],
    rig: (root) => {
      const r = defaultRig()
      r.modelRotation = [90, 0, -180]
      const found = locateParts(root, r.modelRotation, DUALSENSE_LOCATORS)
      for (const [k, v] of Object.entries(found)) {
        const c = k as RigControl
        r.entries[c] = { ...r.entries[c], node: v.node, extra: v.extra, ...(SMALL_PRESS[c] ? { amount: SMALL_PRESS[c] } : {}) }
      }
      return r
    },
  },
]

export function knownRigFor(nodeNames: string[]): KnownRig | null {
  return KNOWN_RIGS.find((k) => k.match.every((n) => nodeNames.includes(n))) ?? null
}

/** Does this rig reference at least one node that exists in the model? */
export function rigFitsModel(rig: RigMap, nodeNames: string[]) {
  const names = new Set(nodeNames)
  return Object.values(rig.entries).some((e) => e.node && names.has(e.node))
}
