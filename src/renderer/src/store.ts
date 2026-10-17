// Global live state shared between panels (outside React for 250 Hz input).

import { dualSense } from './device/hid'
import { platform } from './platform'
import type { InputState } from './device/inputReport'
import { DEFAULT_AXIS_MAP, OrientationTracker } from './orientation/tracker'
import { useEffect, useReducer, useSyncExternalStore } from 'react'

export const tracker = new OrientationTracker()
tracker.axisMap = loadLocal('dshd.axisMap', structuredClone(DEFAULT_AXIS_MAP))

/** Virtual tilt used when no controller is connected (gravity in box plane, g units). */
export const virtualTilt = { x: 0, y: 0 }

/** Lightbar colour currently shown (mirrors what we sent to the controller). */
export const lightbar = { rgb: [32, 64, 255] as [number, number, number] }


export function liveInput(): InputState {
  return dualSense.state
}

// --- tiny reactive helpers -------------------------------------------------

export function useConnection() {
  return useSyncExternalStore(
    (cb) => dualSense.onConnection(cb) as unknown as () => void,
    () => dualSense.info,
  )
}

/** Re-render at a fixed rate (for live readouts) without wiring every input event to React. */
export function useTicker(hz = 20) {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const id = window.setInterval(force, 1000 / hz)
    return () => window.clearInterval(id)
  }, [hz])
}

/** Edge detector for one-shot button presses inside rAF loops. */
export class PressTracker {
  private prev: Record<string, boolean> = {}
  pressed(name: string, now: boolean) {
    const was = this.prev[name] ?? false
    this.prev[name] = now
    return now && !was
  }
}

/** localStorage helpers that never throw. */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
export function saveLocal(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* ignore */
  }
  persistSettings()
}

// Portable exe: mirror the settings into the file next to the exe (batched, and flushed when
// the window closes). Values are stored parsed, so the file reads as plain JSON.
let persistTimer = 0
function settingsSnapshot() {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    const v = localStorage.getItem(k)!
    try {
      out[k] = JSON.parse(v)
    } catch {
      out[k] = v
    }
  }
  return out
}
/** Call after changing localStorage directly (saveLocal already does). */
export function persistSettings() {
  if (!platform.saveSettings) return
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = 0
    platform.saveSettings?.(settingsSnapshot())
  }, 500)
}
if (platform.saveSettings)
  window.addEventListener('beforeunload', () => {
    if (!persistTimer) return
    window.clearTimeout(persistTimer)
    persistTimer = 0
    platform.saveSettings?.(settingsSnapshot(), true)
  })

// Short notes over the 3D view saying what a controller button just did ("✕ - Vibration Only")
const hintListeners = new Set<(text: string) => void>()
export function showButtonHint(text: string) {
  hintListeners.forEach((fn) => fn(text))
}
export function onButtonHint(fn: (text: string) => void): () => void {
  hintListeners.add(fn)
  return () => hintListeners.delete(fn)
}

// Options, Create, L3 or R3 on the controller recenters the 3D view (not PS: it's often taken by Steam)
const RECENTER_BUTTONS = ['options', 'create', 'l3', 'r3'] as const
const RECENTER_NAMES: Record<(typeof RECENTER_BUTTONS)[number], string> = { options: 'Options', create: 'Create', l3: 'L3', r3: 'R3' }
const recenterPresses = new PressTracker()
dualSense.onInput((s) => {
  tracker.update(s)
  // check every button so each one's edge state stays current
  const pressed = RECENTER_BUTTONS.filter((b) => recenterPresses.pressed(b, s.buttons[b]))
  if (pressed.length) recenter(RECENTER_NAMES[pressed[0]])
})

/** Recenter the 3D view, saying which button did it. */
export function recenter(button: string) {
  tracker.recenter()
  showButtonHint(`${button} - Reset 3D View`)
}
