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

import { decodeTrigger, encodeTrigger, type TriggerEffect } from '../device/triggerEffects'

export interface TriggerPreset {
  name: string
  trigger: 'L2' | 'R2' | 'both'
  effect: TriggerEffect
  raw: number[]
}

export interface PresetFile {
  format: 'dualsense-trigger-presets'
  version: 1
  presets: TriggerPreset[]
}

export function makePreset(name: string, trigger: TriggerPreset['trigger'], effect: TriggerEffect): TriggerPreset {
  return { name, trigger, effect, raw: encodeTrigger(effect) }
}

export function serializePresets(presets: TriggerPreset[]): string {
  const file: PresetFile = {
    format: 'dualsense-trigger-presets',
    version: 1,
    presets: presets.map((p) => ({ ...p, raw: encodeTrigger(p.effect) })),
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

export const BUILTIN_PRESETS: TriggerPreset[] = [
  makePreset('Off', 'both', { type: 'off' }),
  makePreset('Pistol', 'R2', { type: 'weapon', start: 4, end: 7, strength: 8 }),
  makePreset('Shotgun (heavy)', 'R2', { type: 'weapon', start: 2, end: 7, strength: 8 }),
  makePreset('Brake pedal', 'L2', { type: 'slope', start: 1, end: 9, startStrength: 1, endStrength: 8 }),
  makePreset('Accelerator', 'R2', { type: 'feedback', position: 0, strength: 3 }),
  makePreset('Stiff spring', 'both', { type: 'feedback', position: 1, strength: 8 }),
  makePreset('Bow draw', 'R2', { type: 'bow', start: 1, end: 6, strength: 6, snapForce: 8 }),
  makePreset('Machine gun', 'R2', { type: 'vibration', position: 3, amplitude: 8, frequency: 18 }),
  makePreset('Engine idle', 'R2', { type: 'machine', start: 1, end: 9, amplitudeA: 3, amplitudeB: 6, frequency: 25, period: 6 }),
  makePreset('Horse gallop', 'both', { type: 'galloping', start: 0, end: 9, firstFoot: 2, secondFoot: 5, frequency: 3 }),
  makePreset('Rumble strip', 'both', { type: 'multiVibration', frequency: 35, amplitudes: [0, 0, 3, 6, 8, 8, 6, 3, 0, 0] }),
  makePreset('Detent click', 'both', { type: 'multiFeedback', strengths: [0, 0, 0, 0, 8, 0, 0, 0, 0, 0] }),
]
