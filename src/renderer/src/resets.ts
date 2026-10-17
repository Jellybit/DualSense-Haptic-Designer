// "Reset" buttons: each section clears its saved settings and tells its panel (if it's on
// screen) to go back to defaults. Panels that aren't mounted pick the defaults up when they
// next load. Calibration, the 3D model/rig and audio device choices are never reset here.

import { clearLastSound } from './lastSound'

export type ResetSection = 'motor' | 'trigger' | 'scene'

export const RESET_LABELS: Record<ResetSection, string> = {
  motor: 'Reset Motor Settings',
  trigger: 'Reset Trigger Settings',
  scene: 'Reset Scene Settings',
}

const KEYS: Record<ResetSection, string[]> = {
  // both motor EQs, Vibration Power, Normalize, Play choice and mode, and the loaded sound
  motor: [
    'dshd.workbench.motorEqs',
    'dshd.workbench.boost',
    'dshd.workbench.normalize',
    'dshd.workbench.mode',
    'dshd.workbench.playChoice',
    'dshd.workbench.file',
  ],
  trigger: ['dshd.trig.L2', 'dshd.trig.R2'],
  scene: ['dshd.scene', 'dshd.scene.master'],
}

const listeners = new Set<(s: ResetSection) => void>()

/** Listen for resets; returns an unsubscribe function. */
export function onReset(fn: (s: ResetSection) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function resetSection(s: ResetSection): Promise<void> {
  for (const k of KEYS[s]) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* storage unavailable */
    }
  }
  if (s === 'motor') await clearLastSound()
  listeners.forEach((fn) => fn(s))
}

export async function resetAll(): Promise<void> {
  for (const s of Object.keys(KEYS) as ResetSection[]) await resetSection(s)
}

/** Ask first: these can't be undone. */
export function confirmReset(what: string): boolean {
  return window.confirm(`${what}?\n\nThis can't be undone.`)
}
