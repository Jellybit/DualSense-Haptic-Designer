// Split meshes that contain several disconnected pieces (e.g. both thumbsticks exported as
// one mesh) into separately animatable sub-parts.
//
// A qualifying mesh is replaced by a Group with the same name and transform; its children
// are one mesh per piece, named `<name>#<k>`. Pieces are ordered by bounding-box centre
// (x, then y, then z, in the mesh's own geometry space) so indices are stable for a model.

import * as THREE from 'three'

/** meshes that merge a whole controller's worth of buttons can hold dozens of pieces */
const MAX_PARTS = 256

function components(geo: THREE.BufferGeometry): { tris: number[]; box: THREE.Box3 }[] | null {
  const pos = geo.getAttribute('position')
  if (!pos) return null
  const index = geo.getIndex()
  const triCount = (index ? index.count : pos.count) / 3
  if (triCount < 8) return null
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k)

  // weld vertices by position so UV/normal seams don't split pieces
  const weld = new Map<string, number>()
  const rep = new Int32Array(pos.count)
  for (let v = 0; v < pos.count; v++) {
    const key = `${pos.getX(v).toFixed(5)},${pos.getY(v).toFixed(5)},${pos.getZ(v).toFixed(5)}`
    let r = weld.get(key)
    if (r === undefined) weld.set(key, (r = v))
    rep[v] = r
  }
  const parent = Int32Array.from({ length: pos.count }, (_, i) => i)
  const find = (x: number) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]]
    return x
  }
  for (let t = 0; t < triCount; t++) {
    const a = find(rep[vi(t, 0)])
    parent[find(rep[vi(t, 1)])] = a
    parent[find(rep[vi(t, 2)])] = a
  }
  const byRoot = new Map<number, { tris: number[]; box: THREE.Box3 }>()
  const p = new THREE.Vector3()
  for (let t = 0; t < triCount; t++) {
    const r = find(rep[vi(t, 0)])
    let c = byRoot.get(r)
    if (!c) byRoot.set(r, (c = { tris: [], box: new THREE.Box3() }))
    c.tris.push(t)
    for (let k = 0; k < 3; k++) c.box.expandByPoint(p.fromBufferAttribute(pos, vi(t, k)))
    if (byRoot.size > MAX_PARTS) return null
  }
  const list = [...byRoot.values()]
  if (list.length < 2) return null
  const ctr = (c: { box: THREE.Box3 }) => c.box.getCenter(new THREE.Vector3())
  list.sort((a, b) => {
    const ca = ctr(a)
    const cb = ctr(b)
    return ca.x - cb.x || ca.y - cb.y || ca.z - cb.z
  })
  return list
}

/**
 * Give every mesh a unique name. Exporters often name all meshes after their material
 * (e.g. three meshes all called "defaultMaterial"), which would make them unpickable.
 */
function uniquifyMeshNames(root: THREE.Object3D) {
  const seen = new Map<string, number>()
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return
    const base = o.name || 'mesh'
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    o.name = n === 0 ? base : `${base}_${n}`
  })
}

export function splitDisconnectedParts(root: THREE.Object3D) {
  uniquifyMeshNames(root)
  const meshes: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && m.geometry && m.geometry.groups.length <= 1) meshes.push(m)
  })
  for (const mesh of meshes) {
    const parts = components(mesh.geometry)
    if (!parts || !mesh.parent) continue
    const index = mesh.geometry.getIndex()
    const group = new THREE.Group()
    group.name = mesh.name
    group.position.copy(mesh.position)
    group.quaternion.copy(mesh.quaternion)
    group.scale.copy(mesh.scale)
    parts.forEach((part, k) => {
      const g = new THREE.BufferGeometry()
      for (const [name, attr] of Object.entries(mesh.geometry.attributes)) g.setAttribute(name, attr)
      const idx: number[] = []
      for (const t of part.tris) for (let q = 0; q < 3; q++) idx.push(index ? index.getX(t * 3 + q) : t * 3 + q)
      g.setIndex(idx)
      // attributes are shared, so bounds must come from this piece only
      g.boundingBox = part.box.clone()
      g.boundingSphere = part.box.getBoundingSphere(new THREE.Sphere())
      const piece = new THREE.Mesh(g, mesh.material)
      piece.name = `${mesh.name}#${k}`
      piece.castShadow = mesh.castShadow
      piece.receiveShadow = mesh.receiveShadow
      group.add(piece)
    })
    const parent = mesh.parent
    parent.add(group)
    parent.remove(mesh)
  }
}
