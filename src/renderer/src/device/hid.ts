// WebHID connection to a DualSense / DualSense Edge.

import {
  emptyInputState,
  parseCalibration,
  parseInputReport,
  type ImuCalibration,
  type InputState,
} from './inputReport'
import {
  BT_HAPTICS_AUDIO_REPORT_ID,
  BT_HAPTICS_REPORT_ID,
  buildBtHaptics,
  buildBtHapticsAudio,
  buildBtMicOff,
  buildBtOutput,
  buildUsbOutput,
  COMMON_SIZE,
  type OutputState,
} from './outputReport'

export const SONY_VID = 0x054c
export const DUALSENSE_PID = 0x0ce6
export const DUALSENSE_EDGE_PID = 0x0df2

export type Transport = 'usb' | 'bt'

export interface DeviceInfo {
  name: string
  transport: Transport
  edge: boolean
}

type Listener<T> = (v: T) => void

/** Byte length of an output report as declared in the HID descriptor. */
function outputReportSize(device: HIDDevice, reportId: number): number | null {
  for (const c of device.collections ?? []) {
    for (const r of c.outputReports ?? []) {
      if (r.reportId !== reportId) continue
      let bits = 0
      for (const item of r.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0)
      return Math.ceil(bits / 8)
    }
  }
  return null
}

function hasInputReport(device: HIDDevice, reportId: number): boolean {
  return (device.collections ?? []).some((c) => (c.inputReports ?? []).some((r) => r.reportId === reportId))
}

export class DualSense {
  device: HIDDevice | null = null
  info: DeviceInfo | null = null
  state: InputState = emptyInputState()
  calibration: ImuCalibration | undefined
  /** last output state sent; triggers etc. are re-sent from here */
  private out: OutputState = {}
  private btSeq = 0
  private usbOutSize = COMMON_SIZE
  private inputListeners = new Set<Listener<InputState>>()
  private connListeners = new Set<Listener<DeviceInfo | null>>()
  private sendChain: Promise<void> = Promise.resolve()
  reportRate = 0
  private reportCount = 0
  private rateTimer: number | undefined

  constructor() {
    if (typeof navigator !== 'undefined' && 'hid' in navigator) {
      navigator.hid.addEventListener('disconnect', (e) => {
        if (e.device === this.device) this.handleDisconnect()
      })
      navigator.hid.addEventListener('connect', (e) => {
        if (!this.device && e.device.vendorId === SONY_VID) void this.open(e.device)
      })
    }
  }

  get connected() {
    return !!this.device
  }

  onInput(fn: Listener<InputState>) {
    this.inputListeners.add(fn)
    return () => this.inputListeners.delete(fn)
  }

  onConnection(fn: Listener<DeviceInfo | null>) {
    this.connListeners.add(fn)
    return () => this.connListeners.delete(fn)
  }

  /** Reconnect to an already-permitted device without a user gesture. */
  async autoConnect(): Promise<boolean> {
    if (!('hid' in navigator)) return false
    const devices = await navigator.hid.getDevices()
    const ds = devices.find((d) => d.vendorId === SONY_VID && (d.productId === DUALSENSE_PID || d.productId === DUALSENSE_EDGE_PID))
    if (ds) {
      await this.open(ds)
      return true
    }
    return false
  }

  /** Must be called from a user gesture. */
  async requestAndConnect(): Promise<void> {
    if (!('hid' in navigator)) throw new Error('WebHID is not available in this environment')
    const devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: SONY_VID, productId: DUALSENSE_PID },
        { vendorId: SONY_VID, productId: DUALSENSE_EDGE_PID },
      ],
    })
    if (devices.length === 0) throw new Error('No DualSense selected')
    await this.open(devices[0])
  }

  async disconnect() {
    if (this.device) {
      try {
        await this.device.close()
      } catch {
        /* ignore */
      }
    }
    this.handleDisconnect()
  }

  private handleDisconnect() {
    if (this.device) this.device.removeEventListener('inputreport', this.onReport)
    this.device = null
    this.info = null
    this.state = emptyInputState()
    window.clearInterval(this.rateTimer)
    this.connListeners.forEach((l) => l(null))
  }

  private async open(device: HIDDevice) {
    if (!device.opened) await device.open()
    this.device = device
    // Over USB the descriptor declares input report 0x01 with 63 data bytes and no 0x31.
    const transport: Transport = hasInputReport(device, 0x31) ? 'bt' : 'usb'
    this.info = {
      name: device.productName || 'DualSense',
      transport,
      edge: device.productId === DUALSENSE_EDGE_PID,
    }
    this.usbOutSize = outputReportSize(device, 0x02) ?? COMMON_SIZE
    device.addEventListener('inputreport', this.onReport)

    // Reading calibration also switches a BT controller into full (0x31) report mode.
    try {
      const dv = await device.receiveFeatureReport(0x05)
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
      this.calibration = parseCalibration(bytes, bytes[0] === 0x05 && bytes.length >= 41)
    } catch (err) {
      console.warn('Could not read IMU calibration; using defaults', err)
      this.calibration = undefined
    }

    this.reportCount = 0
    window.clearInterval(this.rateTimer)
    this.rateTimer = window.setInterval(() => {
      this.reportRate = this.reportCount
      this.reportCount = 0
    }, 1000)

    this.connListeners.forEach((l) => l(this.info))
    // Re-apply the last known output state (triggers, lightbar)
    await this.send(this.out)
  }

  private onReport = (e: HIDInputReportEvent) => {
    const parsed = parseInputReport(e.reportId, e.data, this.state, this.calibration)
    if (!parsed) return
    this.reportCount++
    this.inputListeners.forEach((l) => l(parsed))
  }

  /** Merge into the persistent output state and send. */
  async update(partial: OutputState): Promise<void> {
    this.out = { ...this.out, ...partial }
    await this.send(partial)
  }

  setTriggers(left?: number[], right?: number[]) {
    const p: OutputState = {}
    if (left) p.leftTrigger = left
    if (right) p.rightTrigger = right
    return this.update(p)
  }

  /** Send a one-off output report with exactly these fields valid. */
  send(state: OutputState): Promise<void> {
    const dev = this.device
    const info = this.info
    if (!dev || !info) return Promise.resolve()
    this.sendChain = this.sendChain
      .then(async () => {
        if (info.transport === 'usb') {
          await dev.sendReport(0x02, buildUsbOutput(state, this.usbOutSize))
        } else {
          this.btSeq = (this.btSeq + 1) & 0x0f
          await dev.sendReport(0x31, buildBtOutput(state, this.btSeq))
        }
      })
      .catch((err) => console.error('sendReport failed', err))
    return this.sendChain
  }

  /** Experimental: stream one Bluetooth haptics packet (64 interleaved u8 samples). */
  async sendBtHaptics(samples: Uint8Array, counter: number): Promise<void> {
    if (!this.device || this.info?.transport !== 'bt') return
    await this.device.sendReport(BT_HAPTICS_REPORT_ID, buildBtHaptics(samples, counter))
  }

  /** Report 0x39: two haptic blocks (128 bytes) plus silent speaker audio. */
  async sendBtHapticsAudio(samples: Uint8Array, seq: number, counter: number): Promise<void> {
    if (!this.device || this.info?.transport !== 'bt') return
    await this.device.sendReport(BT_HAPTICS_AUDIO_REPORT_ID, buildBtHapticsAudio(samples, seq, counter))
  }

  /** Stop the microphone stream that 0x39 reports start. */
  async sendBtMicOff(seq: number): Promise<void> {
    if (!this.device || this.info?.transport !== 'bt') return
    await this.device.sendReport(BT_HAPTICS_REPORT_ID, buildBtMicOff(seq))
  }
}

export const dualSense = new DualSense()
