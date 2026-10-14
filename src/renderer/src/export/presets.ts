// Trigger preset (de)serialization.
//
// File format (JSON):
// {
//   "format": "dualsense-trigger-presets",
//   "version": 1,
//   "presets": [
//     { "name": "Pistol", "trigger": "R2", "effect": { "type": "weapon", ... },
//       "raw": [37, 64, 1, 7, 0, 0, 0, 0, 0, 0, 0] }
//   ]
// }
// `raw` is the 11 bytes to copy into the output report's trigger block
// (USB report 0x02 offsets 11..21 for R2 / 22..32 for L2 counting the report ID).
// Games only need `raw`; `effect` lets the designer re-open the preset for editing.

import { decodeTrigger, encodeTrigger, toCurveEffect, zoneFrequencies, type TriggerEffect } from '../device/triggerEffects'

export interface TriggerPreset {
  name: string
  trigger: 'L2' | 'R2' | 'both'
  effect: TriggerEffect
  raw: number[]
  /**
   * Vibration curves only: the frequency (Hz) for each of the 10 zones. The controller takes one
   * frequency per effect, so to follow the curve a game re-sends `raw` with byte 9 set to the
   * frequency of the zone the trigger is in, whenever that changes.
   */
  zoneFrequencies?: number[]
}

export interface PresetFile {
  format: 'dualsense-trigger-presets'
  version: 1
  presets: TriggerPreset[]
}

/** Older slider-style effects are stored as curves. */
export function makePreset(name: string, trigger: TriggerPreset['trigger'], effect: TriggerEffect): TriggerPreset {
  const e = toCurveEffect(effect)
  return { name, trigger, effect: e, raw: encodeTrigger(e), ...(e.type === 'vibrationCurve' ? { zoneFrequencies: zoneFrequencies(e) } : {}) }
}

export function serializePresets(presets: TriggerPreset[]): string {
  const file: PresetFile = {
    format: 'dualsense-trigger-presets',
    version: 1,
    presets: presets.map((p) => makePreset(p.name, p.trigger, p.effect)),
  }
  return JSON.stringify(file, null, 2)
}

export function parsePresets(text: string): TriggerPreset[] {
  const data = JSON.parse(text)
  // Accept a bare array of presets, or a bare array of 11-byte arrays, too.
  const list: unknown[] = Array.isArray(data) ? data : data?.presets
  if (!Array.isArray(list)) throw new Error('Not a trigger preset file')
  return list.map((item, i) => {
    if (Array.isArray(item)) {
      const effect = decodeTrigger(item as number[])
      return makePreset(`Preset ${i + 1}`, 'both', effect)
    }
    const p = item as Partial<TriggerPreset>
    const effect = p.effect ?? (p.raw ? decodeTrigger(p.raw) : { type: 'off' as const })
    return makePreset(p.name ?? `Preset ${i + 1}`, p.trigger ?? 'both', effect)
  })
}
