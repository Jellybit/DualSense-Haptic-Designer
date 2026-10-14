// Live 3D view of the controller: mirrors IMU orientation, buttons, sticks, triggers,
// touch points and lightbar colour.
//
// All rig motions are computed in the *controller frame* (+x right, +y up out of the face,
// +z toward the player), not in each node's local frame. That makes arbitrary exported
// models work even when their parts have meaningless local axes and pivots at the model
// origin (typical for Sketchfab exports): pivots are derived from each part's bounding box.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { dualSense } from '../device/hid'
import { lightbar, tracker } from '../store'
import { buildPlaceholder } from './placeholder'
import { splitDisconnectedParts } from './splitParts'
import { pickState, RIG_CONTROLS, type PivotMode, type RigControl, type RigEntry, type RigMap } from './rig'

export interface LoadedModel {
  root: THREE.Object3D
  nodeNames: string[]
  isPlaceholder: boolean
}

/** Load a model file (glb / gltf / dae) from bytes. */
export async function loadModelFromBytes(name: string, bytes: ArrayBuffer): Promise<LoadedModel> {
  const lower = name.toLowerCase()
  let root: THREE.Object3D
  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
    const loader = new GLTFLoader()
    // Embedded GLB images become blob: URLs. GLTFLoader's default ImageBitmapLoader fetch()es
    // them, which a file:// page (the packaged app) isn't allowed to do; <img> loading works.
    loader.register((parser) => {
      parser.textureLoader = new THREE.TextureLoader(parser.options.manager)
      return { name: 'dshd_img_texture_loader' }
    })
    const gltf = await loader.parseAsync(bytes, '')
    root = gltf.scene
  } else if (lower.endsWith('.dae')) {
    const text = new TextDecoder().decode(bytes)
    const dae = new ColladaLoader().parse(text, '')
    root = dae.scene
  } else {
    throw new Error('Unsupported model format — use .glb (recommended), .gltf or .dae')
  }
  fixFalseTransparency(root)
  splitDisconnectedParts(root)
  normalizeModel(root)
  return { root, nodeNames: collectNames(root), isPlaceholder: false }
}

export function placeholderModel(): LoadedModel {
  const root = buildPlaceholder()
  return { root, nodeNames: collectNames(root), isPlaceholder: true }
}

function collectNames(root: THREE.Object3D): string[] {
  const names: string[] = []
  root.traverse((o) => {
    if (o.name && o !== root) names.push(o.name)
  })
  return [...new Set(names)]
}

/**
 * Exporters often tag solid materials as alpha-blended (glTF alphaMode BLEND). Blended
 * surfaces don't write depth, so inner/back faces draw over the front and the model looks
 * inside-out or ghostly. Treat any blended material that is actually opaque as opaque.
 */
function fixFalseTransparency(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      if (!m.transparent || m.opacity < 0.99) continue
      m.transparent = false
      m.depthWrite = true
      // keep genuine cut-outs (alpha in the texture) crisp instead of blended
      if ((m as THREE.MeshStandardMaterial).map) m.alphaTest = 0.5
      m.needsUpdate = true
    }
  })
}

/** Center and scale so the model is ~16 units across (same as the placeholder). */
function normalizeModel(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  const s = 16 / maxDim
  // loader roots come with an identity transform, so this maps the bounds to ±8 around 0
  root.scale.setScalar(s)
  root.position.copy(center).multiplyScalar(-s)
}

interface Props {
  model: LoadedModel
  rig: RigMap
  /** draw touch points on the touchpad */
  showTouch?: boolean
}

interface NodeRig {
  node: THREE.Object3D
  restLocal: THREE.Matrix4
  /** controller-frame bounding box at rest (for pivots) */
  box: THREE.Box3
}

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
const DEG = Math.PI / 180

function resolvePivot(mode: PivotMode | undefined, motion: RigEntry['motion'], box: THREE.Box3, restLocal: THREE.Matrix4, toCtrl: THREE.Matrix4): THREE.Vector3 {
  const c = box.getCenter(new THREE.Vector3())
  const m = mode && mode !== 'auto' ? mode : motion === 'hinge' ? 'top-near' : motion === 'tilt' ? 'bottom' : 'center'
  switch (m) {
    case 'origin':
      return new THREE.Vector3().setFromMatrixPosition(toCtrl.clone().multiply(restLocal))
    case 'center':
      return c
    case 'bottom':
      return new THREE.Vector3(c.x, box.min.y, c.z)
    case 'top-near':
      return new THREE.Vector3(c.x, box.max.y, box.max.z)
    case 'top-far':
      return new THREE.Vector3(c.x, box.max.y, box.min.z)
    default:
      return c
  }
}

export function ControllerView({ model, rig, showTouch = true }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rigRef = useRef(rig)
  rigRef.current = rig

  useEffect(() => {
    const mount = mountRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // Neutral keeps a white controller white instead of clipping it like ACES does
    renderer.toneMapping = THREE.NeutralToneMapping
    renderer.toneMappingExposure = 0.75
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    // keep the reflections subtle; most of the shaping comes from the key light below
    scene.environmentIntensity = 0.35
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500)
    // player's-eye view: behind and above the controller, looking at the face
    camera.position.set(0, 21, 18)
    camera.lookAt(0, 0, 0)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.minDistance = 8
    controls.maxDistance = 140

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a30, 0.3))
    // low, raking key light: embossed button symbols on a white shell only read when light
    // grazes them; a soft fill from the other side keeps the shadows from going black
    const key = new THREE.DirectionalLight(0xffffff, 1.3)
    key.position.set(-14, 9, 5)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.4)
    fill.position.set(10, 6, 12)
    scene.add(fill)

    const holder = new THREE.Group() // controller frame; receives IMU orientation
    const offset = new THREE.Group() // user model-rotation fix-up
    holder.add(offset)
    offset.add(model.root)
    scene.add(holder)

    // Finger positions on the touchpad (up to two touches). Depth-tested like any other
    // object, so they're hidden when the touchpad faces away from the camera.
    const touchMarkers = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshBasicMaterial({ color: 0x66ccff }))
      m.visible = false
      holder.add(m)
      return m
    })
    const highlight = new THREE.Box3Helper(new THREE.Box3(), 0x3ad6a8)
    highlight.visible = false
    holder.add(highlight)

    // Node lookup
    const nodeCache = new Map<string, THREE.Object3D>()
    model.root.traverse((o) => {
      if (o.name && !nodeCache.has(o.name)) nodeCache.set(o.name, o)
    })

    // Rest poses, captured lazily in the controller frame
    const rigs = new Map<THREE.Object3D, NodeRig>()
    let rigsRotKey = ''
    const holderInv = new THREE.Matrix4()
    const parentToCtrl = (node: THREE.Object3D, out: THREE.Matrix4) => {
      node.parent!.updateWorldMatrix(true, false)
      return out.copy(holderInv).multiply(node.parent!.matrixWorld)
    }
    const ctrlBox = (node: THREE.Object3D) => {
      // controller-frame AABB from the mesh geometry under `node`
      const box = new THREE.Box3()
      const m = new THREE.Matrix4()
      node.updateWorldMatrix(true, true)
      node.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh || !mesh.geometry) return
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        const b = mesh.geometry.boundingBox!.clone().applyMatrix4(m.copy(holderInv).multiply(mesh.matrixWorld))
        box.union(b)
      })
      return box
    }
    const rigOf = (node: THREE.Object3D): NodeRig => {
      let r = rigs.get(node)
      if (!r) {
        node.updateMatrix()
        r = { node, restLocal: node.matrix.clone(), box: new THREE.Box3() }
        rigs.set(node, r)
        r.box = ctrlBox(node)
      }
      return r
    }
    const restore = (r: NodeRig) => {
      r.restLocal.decompose(r.node.position, r.node.quaternion, r.node.scale)
    }

    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(1, h)
      // fit the ~18-unit-wide controller horizontally regardless of panel shape
      const vfov = (camera.fov * Math.PI) / 180
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
      const dist = Math.max(9 / Math.tan(hfov / 2), 6 / Math.tan(vfov / 2)) * 1.15
      camera.position.setLength(dist)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    // --- picking: click a part to assign it to the control being mapped -----------
    const raycaster = new THREE.Raycaster()
    let downAt: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY })
    const onUp = (e: PointerEvent) => {
      if (!pickState.control || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return
      const r = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const hit = raycaster.intersectObject(model.root, true).find((h) => (h.object as THREE.Mesh).isMesh)
      if (!hit) return
      let o: THREE.Object3D = hit.object
      // prefer a named object; skip unnamed intermediate nodes
      while (!o.name && o.parent && o.parent !== model.root) o = o.parent
      pickState.finish(o.name, e.shiftKey)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    // Lightbar materials are cloned once so recolouring doesn't tint other parts sharing them
    const clonedMats = new WeakSet<THREE.Object3D>()

    const tmpParent = new THREE.Matrix4()
    const tmpW = new THREE.Matrix4()
    const tmpD = new THREE.Matrix4()
    const tmpT = new THREE.Matrix4()
    const tmpQ = new THREE.Quaternion()
    let raf = 0
    let lastActive = new Set<NodeRig>()

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const r = rigRef.current
      const s = dualSense.state
      const connected = dualSense.connected

      offset.rotation.set(r.modelRotation[0] * DEG, r.modelRotation[1] * DEG, r.modelRotation[2] * DEG)
      // model-rotation changes invalidate cached controller-frame boxes
      const rotKey = r.modelRotation.join(',')
      if (rotKey !== rigsRotKey) {
        rigs.forEach(restore)
        rigs.clear()
        rigsRotKey = rotKey
      }

      // Orientation
      if (connected && s.full) {
        const [w, x, y, z] = tracker.quaternion
        holder.quaternion.set(x, y, z, w)
      } else {
        holder.quaternion.slerp(new THREE.Quaternion(), 0.1)
      }
      holder.updateMatrixWorld(true)
      holderInv.copy(holder.matrixWorld).invert()

      const active = new Set<NodeRig>()
      for (const control of RIG_CONTROLS) {
        const e = r.entries[control]
        if (!e?.node) continue
        const node = nodeCache.get(e.node)
        if (!node || !node.parent) continue
        const nr = rigOf(node)
        // the main part plus any extra parts that move with it
        const parts = [nr]
        for (const name of e.extra ?? []) {
          const x = nodeCache.get(name)
          if (x?.parent && x !== node) parts.push(rigOf(x))
        }
        parts.forEach((p) => active.add(p))

        if (e.motion === 'color') {
          const [cr, cg, cb] = lightbar.rgb
          for (const p of parts) {
            p.node.traverse((o) => {
              const mesh = o as THREE.Mesh
              if (!mesh.isMesh) return
              if (!clonedMats.has(mesh)) {
                mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone()
                clonedMats.add(mesh)
              }
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
              for (const mat of mats as THREE.MeshStandardMaterial[]) {
                if (!('emissive' in mat)) continue
                mat.emissive.setRGB(cr / 255, cg / 255, cb / 255)
                mat.emissiveIntensity = 1.5
              }
            })
          }
          continue
        }

        // Delta transform D in the controller frame; null = at rest
        const sign = e.invert ? -1 : 1
        let moving = true
        if (e.motion === 'press') {
          const v = controlValue(control, s)
          moving = v !== 0
          const dir = AXES[e.axis].clone().multiplyScalar(-v * e.amount * sign)
          tmpD.makeTranslation(dir.x, dir.y, dir.z)
        } else {
          const pivot = resolvePivot(e.pivot, e.motion, nr.box, nr.restLocal, parentToCtrl(node, tmpParent))
          // if L3/R3 isn't mapped to its own part, push the whole stick in
          const stickPress =
            e.motion === 'tilt' && (control === 'leftStick' ? s.buttons.l3 : s.buttons.r3) && !r.entries[control === 'leftStick' ? 'l3' : 'r3'].node
          if (e.motion === 'hinge') {
            const v = controlValue(control, s)
            moving = v !== 0
            tmpQ.setFromAxisAngle(AXES[e.axis], v * e.amount * DEG * sign)
          } else {
            // tilt: stick x → roll about z (cap moves right), stick y (+down) → pitch about x toward the player
            const st = control === 'leftStick' ? s.leftStick : s.rightStick
            moving = Math.abs(st.x) >= 0.02 || Math.abs(st.y) >= 0.02 || stickPress
            const qx = new THREE.Quaternion().setFromAxisAngle(AXES.x, st.y * e.amount * DEG * sign)
            const qz = new THREE.Quaternion().setFromAxisAngle(AXES.z, -st.x * e.amount * DEG * sign)
            tmpQ.copy(qz).multiply(qx)
          }
          tmpD.makeTranslation(pivot.x, pivot.y, pivot.z)
            .multiply(new THREE.Matrix4().makeRotationFromQuaternion(tmpQ))
            .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
          if (stickPress) tmpD.premultiply(tmpT.makeTranslation(0, -0.12, 0))
        }
        for (const p of parts) {
          if (!moving) {
            restore(p)
            continue
          }
          // L' = P⁻¹ · D · P · L_rest   (P = parent→controller frame)
          const P = parentToCtrl(p.node, tmpParent)
          tmpW.copy(P).multiply(p.restLocal)
          tmpW.premultiply(tmpD)
          tmpW.premultiply(P.invert())
          tmpW.decompose(p.node.position, p.node.quaternion, p.node.scale)
        }
      }
      for (const nr of lastActive) if (!active.has(nr)) restore(nr)
      lastActive = active

      // Highlight the part being hovered in the mapping table (or picked)
      const hlName = pickState.highlight
      const hlNode = hlName ? nodeCache.get(hlName) : undefined
      if (hlNode) {
        highlight.box.copy(ctrlBox(hlNode)).expandByScalar(0.05)
        highlight.visible = true
      } else highlight.visible = false

      // Touch points on top of the touchpad part
      const tpName = r.entries.touchpad.node
      const tn = tpName ? nodeCache.get(tpName) : undefined
      if (showTouch && tn && connected) {
        const box = ctrlBox(tn)
        for (let i = 0; i < 2; i++) {
          const tp = s.touch[i]
          const m = touchMarkers[i]
          m.visible = tp.active
          if (tp.active) {
            m.position.set(
              THREE.MathUtils.lerp(box.min.x, box.max.x, tp.x / 1919),
              box.max.y + 0.05,
              THREE.MathUtils.lerp(box.min.z, box.max.z, tp.y / 1079),
            )
          }
        }
      } else touchMarkers.forEach((m) => (m.visible = false))

      renderer.domElement.style.cursor = pickState.control ? 'crosshair' : ''
      controls.update()
      renderer.render(scene, camera)
    }
    frame()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      // restore rest poses so the shared model can be re-mounted
      rigs.forEach(restore)
      offset.remove(model.root)
      renderer.dispose()
      pmrem.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [model, showTouch])

  return <div ref={mountRef} className="viewer" />
}

function controlValue(c: RigControl, s: typeof dualSense.state): number {
  if (c === 'l2') return s.l2
  if (c === 'r2') return s.r2
  if (c === 'leftStick' || c === 'rightStick' || c === 'lightbar') return 0
  return s.buttons[c] ? 1 : 0
}
