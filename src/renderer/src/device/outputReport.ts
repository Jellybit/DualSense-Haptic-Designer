// Building DualSense output reports.
// Common block layout follows hid-playstation.c `struct dualsense_output_report_common`
// (47 bytes). Offsets below are within that block.
//
//   USB: report 0x02, data = common(47) [+ padding to the descriptor size]
//   BT:  report 0x31, data = [seq<<4, 0x10, common(47), ..., crc32 (last 4 bytes)]
//        total 78 bytes incl. report ID, CRC over [0xA2, 0x31, data[0..72]]

import { crc32Seeded } from './crc32'

export const COMMON_SIZE = 47
export const BT_OUTPUT_SIZE = 78 // incl. report ID

// valid_flag0
export const VF0_COMPATIBLE_VIBRATION = 0x01
export const VF0_HAPTICS_SELECT = 0x02
export const VF0_RIGHT_TRIGGER = 0x04
export const VF0_LEFT_TRIGGER = 0x08
export const VF0_SPEAKER_VOLUME = 0x20
export const VF0_AUDIO_CONTROL = 0x80
// valid_flag1
export const VF1_MIC_MUTE_LED = 0x01
export const VF1_POWER_SAVE = 0x02
export const VF1_LIGHTBAR = 0x04
export const VF1_RELEASE_LEDS = 0x08
export const VF1_PLAYER_LEDS = 0x10
export const VF1_MOTOR_POWER = 0x40
export const VF1_AUDIO_CONTROL2 = 0x80
// valid_flag2
export const VF2_LED_BRIGHTNESS = 0x01
export const VF2_LIGHTBAR_SETUP = 0x02

export interface OutputState {
  rightTrigger?: number[] // 11 bytes
  leftTrigger?: number[] // 11 bytes
  /** classic rumble emulation, 0-255 (drives the voice coils as rumble) */
  rumbleLeft?: number
  rumbleRight?: number
  lightbar?: [number, number, number]
  /** 5-bit mask of the white player LEDs under the touchpad */
  playerLeds?: number
  micLed?: 0 | 1 | 2
  /** 0-7 reduction of trigger force (0 = full strength) */
  triggerPowerReduction?: number
  /**
   * Where the controller plays audio channels 1/2 (USB): its headphone jack (the default) or
   * its built-in mono speaker, which plays the right channel only. Values follow the Linux
   * hid-playstation audio patch (2025).
   */
  audioOutput?: 'headphones' | 'speaker'
}

/** Fill the 47-byte common block. */
export function buildCommon(state: OutputState): Uint8Array<ArrayBuffer> {
  const c = new Uint8Array(COMMON_SIZE)
  let vf0 = 0
  let vf1 = 0
  let vf2 = 0

  if (state.rumbleLeft !== undefined || state.rumbleRight !== undefined) {
    vf0 |= VF0_COMPATIBLE_VIBRATION | VF0_HAPTICS_SELECT
    c[2] = state.rumbleRight ?? 0
    c[3] = state.rumbleLeft ?? 0
  }
  if (state.rightTrigger) {
    vf0 |= VF0_RIGHT_TRIGGER
    c.set(state.rightTrigger.slice(0, 11), 10)
  }
  if (state.leftTrigger) {
    vf0 |= VF0_LEFT_TRIGGER
    c.set(state.leftTrigger.slice(0, 11), 21)
  }
  if (state.micLed !== undefined) {
    vf1 |= VF1_MIC_MUTE_LED
    c[8] = state.micLed
  }
  if (state.triggerPowerReduction !== undefined) {
    vf1 |= VF1_MOTOR_POWER
    c[36] = state.triggerPowerReduction & 0x07
  }
  if (state.audioOutput) {
    vf0 |= VF0_AUDIO_CONTROL
    if (state.audioOutput === 'speaker') {
      c[7] = 3 << 4 // output path: speaker only (right channel)
      vf0 |= VF0_SPEAKER_VOLUME
      c[5] = 0x64 // speaker volume 100% (accepted range ~0x3d-0x64)
      vf1 |= VF1_AUDIO_CONTROL2
      c[37] = 0x02 // speaker preamp gain ~30%
    } else {
      c[7] = 0 // output path: headphones, left + right
    }
  }
  if (state.lightbar) {
    vf1 |= VF1_LIGHTBAR
    c[44] = state.lightbar[0]
    c[45] = state.lightbar[1]
    c[46] = state.lightbar[2]
  }
  if (state.playerLeds !== undefined) {
    vf1 |= VF1_PLAYER_LEDS
    c[43] = state.playerLeds & 0x1f
    vf2 |= VF2_LED_BRIGHTNESS
    c[42] = 0x00 // full brightness
  }
  c[0] = vf0
  c[1] = vf1
  c[38] = vf2
  return c
}

/** USB report 0x02 payload (without report ID). `size` = descriptor data length (>= 47). */
export function buildUsbOutput(state: OutputState, size = COMMON_SIZE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.max(size, COMMON_SIZE))
  out.set(buildCommon(state), 0)
  return out
}

/** BT report 0x31 payload (without report ID, 77 bytes) including CRC. */
export function buildBtOutput(state: OutputState, seq: number): Uint8Array<ArrayBuffer> {
  const full = new Uint8Array(BT_OUTPUT_SIZE)
  full[0] = 0x31
  full[1] = (seq & 0x0f) << 4
  full[2] = 0x10 // tag: "has HID data"
  full.set(buildCommon(state), 3)
  const crc = crc32Seeded(0xa2, full, 0, BT_OUTPUT_SIZE - 4)
  full[74] = crc & 0xff
  full[75] = (crc >>> 8) & 0xff
  full[76] = (crc >>> 16) & 0xff
  full[77] = (crc >>> 24) & 0xff
  return full.subarray(1)
}

// ---------------------------------------------------------------------------
// Bluetooth haptics (experimental). Layout from SAxense (github.com/egormanga/SAxense),
// sample format and sequence counter as in DS5Dongle (github.com/awalol/DS5Dongle):
//   report 0x32, 142 bytes incl. ID (141 after it):
//   [0]   0x32
//   [1]   sequence counter (0-15) in the high nibble
//   [2]   packet 0x11 header: pid 0x11 | sized(0x80) = 0x91, [3] length 7
//   [4..10]  0xFE,0,0,0,0,0xFF,counter
//   [11]  packet 0x12 header: 0x92, [12] length 64
//   [13..76] 64 bytes of interleaved signed 8-bit stereo PCM @ 3000 Hz (32 frames)
//   [77..137] zero
//   [138..141] CRC-32 (seed 0xA2) over bytes [0..137], little-endian
// ---------------------------------------------------------------------------
export const BT_HAPTICS_REPORT_ID = 0x32
export const BT_HAPTICS_SIZE = 142
export const BT_HAPTICS_RATE = 3000
export const BT_HAPTICS_FRAMES = 32

/** Build a report 0x32 payload (without report ID, 141 bytes). `samples` = 64 interleaved signed 8-bit (two's complement bytes). */
export function buildBtHaptics(samples: Uint8Array, counter: number): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(BT_HAPTICS_SIZE)
  r[0] = BT_HAPTICS_REPORT_ID
  r[1] = (counter & 0x0f) << 4
  r[2] = 0x91
  r[3] = 7
  r.set([0xfe, 0, 0, 0, 0, 0xff, counter & 0xff], 4)
  r[11] = 0x92
  r[12] = 64
  r.set(samples.subarray(0, 64), 13)
  const crc = crc32Seeded(0xa2, r, 0, BT_HAPTICS_SIZE - 4)
  r[138] = crc & 0xff
  r[139] = (crc >>> 8) & 0xff
  r[140] = (crc >>> 16) & 0xff
  r[141] = (crc >>> 24) & 0xff
  return r.subarray(1)
}
