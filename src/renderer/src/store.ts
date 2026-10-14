// Global live state shared between panels (outside React for 250 Hz input).

import { dualSense } from './device/hid'
import type { InputState } from './device/inputReport'
import { DEFAULT_AXIS_MAP, OrientationTracker } from './orientation/tracker'
import { useEffect, useReducer, useSyncExternalStore } from 'react'

export const tracker = new OrientationTracker()
tracker.axisMap = loadLocal('dshd.axisMap', structuredClone(DEFAULT_AXIS_MAP))

/** Virtual tilt used when no controller is connected (gravity in box plane, g units). */
export const virtualTilt = { x: 0, y: 0 }

/** Lightbar colour currently shown (mirrors what we sent to the controller). */
export const lightbar = { rgb: [32, 64, 255] as [number, number, number] }

dualSense.onInput((s) => tracker.update(s))

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
}
