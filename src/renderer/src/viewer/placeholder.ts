// Procedural stand-in DualSense used until a real model is loaded.
// Frame: +x right, +y up (out of the face), +z toward the player. ~16 units wide.
// Movable parts are separate named nodes with pivots at their hinge points, which is
// exactly what a real .glb needs for the rig to animate it.

import * as THREE from 'three'

export function buildPlaceholder(): THREE.Group {
  const root = new THREE.Group()
  root.name = 'DualSensePlaceholder'

  const white = new THREE.MeshStandardMaterial({ color: 0xeeeef2, roughness: 0.55 })
  const black = new THREE.MeshStandardMaterial({ color: 0x1c1d22, roughness: 0.6 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.4 })

  // Body: rounded centre slab
  const bodyShape = new THREE.Shape()
  const w = 12
  const d = 6.4
  const r = 1.6
  bodyShape.moveTo(-w / 2 + r, -d / 2)
  bodyShape.lineTo(w / 2 - r, -d / 2)
  bodyShape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
  bodyShape.lineTo(w / 2, d / 2 - r)
  bodyShape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2)
  bodyShape.lineTo(-w / 2 + r, d / 2)
  bodyShape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r)
  bodyShape.lineTo(-w / 2, -d / 2 + r)
  bodyShape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, { depth: 2, bevelEnabled: true, bevelThickness: 0.35, bevelSize: 0.35, bevelSegments: 4 })
  bodyGeo.rotateX(Math.PI / 2)
  bodyGeo.translate(0, 1, 0)
  const body = new THREE.Mesh(bodyGeo, white)
  body.name = 'Body'
  root.add(body)

  // Grips
  for (const side of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(1.7, 4.2, 6, 16), black)
    grip.name = side < 0 ? 'GripLeft' : 'GripRight'
    grip.position.set(side * 5.6, -0.3, 3.4)
    grip.rotation.set(Math.PI / 2 - 0.35, 0, side * 0.35)
    root.add(grip)
  }

  // Touchpad (press = translate down)
  const touchpad = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.2, 3.2), new THREE.MeshStandardMaterial({ color: 0xf6f6f8, roughness: 0.3 }))
  touchpad.name = 'Touchpad'
  touchpad.position.set(0, 1.42, -1.4)
  root.add(touchpad)

  // Lightbar strips along the touchpad
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x2244ff, emissiveIntensity: 1.5 })
  const lightbar = new THREE.Group()
  lightbar.name = 'Lightbar'
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.0), lightMat)
    strip.position.set(side * 3.25, 1.42, -1.4)
    lightbar.add(strip)
  }
  root.add(lightbar)

  // Face buttons (right) — node origin at rest position, press along -y
  const faceGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 24)
  const faces: [string, number, number, number][] = [
    ['Triangle', 4.9, -1.25, 0x3ad6a8],
    ['Circle', 6.05, -0.15, 0xff5a6e],
    ['Cross', 4.9, 0.95, 0x6b8cff],
    ['Square', 3.75, -0.15, 0xff8ad8],
  ]
  for (const [name, x, z, col] of faces) {
    const b = new THREE.Mesh(faceGeo, new THREE.MeshStandardMaterial({ color: 0x24262c, emissive: col, emissiveIntensity: 0.25 }))
    b.name = name
    b.position.set(x, 1.45, z)
    root.add(b)
  }

  // D-pad (left)
  const dpadGeo = new THREE.BoxGeometry(0.62, 0.3, 0.75)
  const dpads: [string, number, number, number][] = [
    ['DpadUp', -4.9, -1.15, 0],
    ['DpadDown', -4.9, 0.85, 0],
    ['DpadLeft', -5.9, -0.15, Math.PI / 2],
    ['DpadRight', -3.9, -0.15, Math.PI / 2],
  ]
  for (const [name, x, z, rot] of dpads) {
    const b = new THREE.Mesh(dpadGeo, dark)
    b.name = name
    b.position.set(x, 1.42, z)
    b.rotation.y = rot
    root.add(b)
  }

  // Sticks: node at pivot (base), cap above
  for (const [name, capName, x] of [['LeftStick', 'L3', -2.3], ['RightStick', 'R3', 2.3]] as const) {
    const pivot = new THREE.Group()
    pivot.name = name
    pivot.position.set(x, 1.0, 1.55)
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.9, 16), dark)
    shaft.position.y = 0.45
    pivot.add(shaft)
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.75, 0.32, 32), black)
    cap.name = capName
    cap.position.y = 0.95
    pivot.add(cap)
    root.add(pivot)
  }

  // Small centre buttons
  const small = (name: string, x: number, z: number, geo: THREE.BufferGeometry, mat = dark) => {
    const b = new THREE.Mesh(geo, mat)
    b.name = name
    b.position.set(x, 1.42, z)
    root.add(b)
  }
  small('Create', -3.75, -2.65, new THREE.BoxGeometry(0.3, 0.2, 0.7))
  small('Options', 3.75, -2.65, new THREE.BoxGeometry(0.3, 0.2, 0.7))
  small('PS', 0, 1.35, new THREE.CylinderGeometry(0.4, 0.4, 0.15, 24), black)
  small('Mute', 0, 2.15, new THREE.BoxGeometry(0.9, 0.12, 0.22), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff7722, emissiveIntensity: 0 }))

  // Shoulder buttons (L1/R1): press down along -y
  for (const [name, x] of [['L1', -4.7], ['R1', 4.7]] as const) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.45, 0.7), dark)
    b.name = name
    b.position.set(x, 1.15, -3.55)
    root.add(b)
  }

  // Triggers (L2/R2): pivot group at the hinge (top-back edge), blade hangs below
  for (const [name, x] of [['L2', -4.7], ['R2', 4.7]] as const) {
    const pivot = new THREE.Group()
    pivot.name = name
    pivot.position.set(x, 0.75, -3.6)
    const blade = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 0.55), black)
    blade.position.set(0, -1.1, -0.45)
    blade.rotation.x = -0.25
    pivot.add(blade)
    root.add(pivot)
  }

  return root
}
