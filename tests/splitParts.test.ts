import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { splitDisconnectedParts } from '../src/renderer/src/viewer/splitParts'

const quad = (x: number) => [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 0, 0, x + 1, 1, 0, x, 1, 0]

describe('splitDisconnectedParts', () => {
  it('splits a mesh with separate pieces into a named group', () => {
    const g = new THREE.BufferGeometry()
    // 5 quads per piece so each passes the minimum-size filter; pieces at x=5.. and x=-10..
    const pos = [...[5, 6, 7, 8, 9].flatMap(quad), ...[-10, -9, -8, -7, -6].flatMap(quad)]
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const mesh = new THREE.Mesh(g)
    mesh.name = 'Sticks'
    const root = new THREE.Group()
    root.add(mesh)
    splitDisconnectedParts(root)
    const group = root.getObjectByName('Sticks')!
    expect((group as THREE.Mesh).isMesh).toBeFalsy()
    const a = group.getObjectByName('Sticks#0') as THREE.Mesh
    const b = group.getObjectByName('Sticks#1') as THREE.Mesh
    // sorted by x: the piece at negative x comes first
    expect(a.geometry.boundingBox!.max.x).toBeLessThan(0)
    expect(b.geometry.boundingBox!.min.x).toBeGreaterThan(0)
    expect(a.geometry.getIndex()!.count).toBe(30)
  })

  it('leaves single-piece meshes alone', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 2, 3, 4].flatMap(quad), 3))
    const mesh = new THREE.Mesh(g)
    mesh.name = 'Body'
    const root = new THREE.Group()
    root.add(mesh)
    splitDisconnectedParts(root)
    expect(root.getObjectByName('Body')).toBe(mesh)
  })
})
