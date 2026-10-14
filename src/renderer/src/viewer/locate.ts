// Find controller parts by *where they are* rather than by name.
//
// Model exporters rename and merge things freely (every mesh called "defaultMaterial",
// all buttons in one mesh…), but a cross button is always at the same spot on the
// controller. After a model is split into pieces (splitParts.ts), normalized and given
// its rotation fix, each locator below picks the pieces whose centre lies near a known
// position in the controller frame (+x right, +y out of the face, +z toward the player).

import * as THREE from 'three'
import type { RigControl } from './rig'

export interface Locator {
  /** expected centre, controller frame (model normalized to 16 units wide) */
  at: [number, number, number]
  /** search radius */
  r: number
  /** ignore pieces bigger than this (e.g. the shell, whose centre may happen to be close) */
  maxSize?: number
}

/**
 * Convert coordinates of the Sketchfab DualSense mesh (x ±1 across, y toward the triggers,
 * z out of the face) to the controller frame.
 */
// The full model spans x ±1, y ±0.65, z ±0.41 (stick tops included), so it's centred at the
// origin and normalization scales it by 8.
const g = (x: number, y: number, z: number): [number, number, number] => [8 * x, 8 * z, -8 * y]

/** Positions of the movable parts of the Sketchfab DualSense geometry. */
export const DUALSENSE_LOCATORS: Partial<Record<RigControl, Locator>> = {
  triangle: { at: g(0.623, 0.423, 0.31), r: 0.6 },
  square: { at: g(0.476, 0.276, 0.31), r: 0.6 },
  cross: { at: g(0.623, 0.129, 0.3), r: 0.6 },
  circle: { at: g(0.77, 0.276, 0.3), r: 0.6 },
  dpadUp: { at: g(-0.62, 0.376, 0.285), r: 0.4 },
  dpadRight: { at: g(-0.524, 0.274, 0.285), r: 0.4 },
  dpadDown: { at: g(-0.627, 0.177, 0.285), r: 0.4 },
  dpadLeft: { at: g(-0.723, 0.281, 0.285), r: 0.4 },
  leftStick: { at: g(-0.318, -0.001, 0.345), r: 0.2 },
  rightStick: { at: g(0.318, -0.001, 0.345), r: 0.2 },
  l2: { at: g(-0.614, 0.528, -0.118), r: 0.5 },
  r2: { at: g(0.614, 0.528, -0.118), r: 0.5 },
  l1: { at: g(-0.619, 0.577, 0.122), r: 0.5 },
  r1: { at: g(0.619, 0.577, 0.122), r: 0.5 },
  create: { at: g(-0.467, 0.494, 0.294), r: 0.3 },
  options: { at: g(0.467, 0.494, 0.294), r: 0.3 },
  ps: { at: g(0, 0.01, 0.255), r: 0.5 },
  mute: { at: g(0, -0.1025, 0.2155), r: 0.25 },
  touchpad: { at: g(0, 0.41, 0.24), r: 1.0, maxSize: 8 },
}

interface Piece {
  name: string
  center: THREE.Vector3
  size: number
}

/** Leaf meshes with their controller-frame centre and size, for a given rotation fix. */
function pieces(root: THREE.Object3D, rotationDeg: [number, number, number]): Piece[] {
  const D = Math.PI / 180
  const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotationDeg[0] * D, rotationDeg[1] * D, rotationDeg[2] * D))
  // Work in the root's own frame: when the model is mounted in the viewer its parents carry
  // the live IMU tilt and the current rotation fix, which must not leak in here.
  root.updateMatrixWorld(true)
  const parentInv = root.parent ? root.parent.matrixWorld.clone().invert() : new THREE.Matrix4()
  const out: Piece[] = []
  const m = new THREE.Matrix4()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.name || !mesh.geometry) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(m.copy(rot).multiply(parentInv).multiply(mesh.matrixWorld))
    const s = box.getSize(new THREE.Vector3())
    out.push({ name: mesh.name, center: box.getCenter(new THREE.Vector3()), size: Math.max(s.x, s.y, s.z) })
  })
  return out
}

/** Resolve locators to node names: the closest piece is the main node, the rest are extras. */
export function locateParts(
  root: THREE.Object3D,
  rotationDeg: [number, number, number],
  locators: Partial<Record<RigControl, Locator>>,
): Partial<Record<RigControl, { node: string; extra: string[] }>> {
  const all = pieces(root, rotationDeg)
  const used = new Set<string>()
  const result: Partial<Record<RigControl, { node: string; extra: string[] }>> = {}
  for (const [control, loc] of Object.entries(locators) as [RigControl, Locator][]) {
    const at = new THREE.Vector3(...loc.at)
    const hits = all
      .filter((p) => !used.has(p.name) && p.size <= (loc.maxSize ?? 4) && p.center.distanceTo(at) <= loc.r)
      .sort((a, b) => a.center.distanceTo(at) - b.center.distanceTo(at))
    if (!hits.length) continue
    hits.forEach((h) => used.add(h.name))
    result[control] = { node: hits[0].name, extra: hits.slice(1).map((h) => h.name) }
  }
  return result
}
