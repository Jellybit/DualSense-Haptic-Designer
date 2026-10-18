// Haptic audio engine: routes the synth's L/R actuator signal to the DualSense.
//
// USB: the DualSense is a 4-channel 48 kHz audio device. Channels 3 & 4 (index 2, 3)
//      drive the left/right voice coils. We select it with AudioContext.setSinkId and
//      open a 4-channel discrete destination.
// Monitor: if a 2-channel device is selected (speakers/headphones) the haptic signal is
//      sent to channels 1-2 so you can *hear* the design.
// BT:  (experimental) the synth output is tapped, decimated to 3 kHz and streamed in
//      HID report 0x39 or 0x32 — see btHaptics.ts.

import workletUrl from './synth.worklet.ts?worker&url'
import type { MixerMessage } from './mixer'
import { saveLocal } from '../store'
import { SAMPLE_RATE, type ContinuousParams, type Grain } from './dsp'

export interface OutputDevice {
  deviceId: string
  label: string
  isDualSense: boolean
}

export type RoutingMode = 'dualsense' | 'monitor'

type BlockListener = (L: Float32Array, R: Float32Array) => void

export class HapticEngine {
  ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private merger: ChannelMergerNode | null = null
  master: GainNode | null = null
  private analysers: AnalyserNode[] = []
  sinkId = ''
  routing: RoutingMode = 'monitor'
  channelCount = 2
  meter = { l: 0, r: 0 }
  positions: Record<string, number> = {}
  private tapListeners = new Set<BlockListener>()
  private endedListeners = new Set<(id: string) => void>()
  private statusListeners = new Set<() => void>()
  private pending: MixerMessage[] = []
  private flushScheduled = false
  error: string | null = null

  get running() {
    return this.ctx?.state === 'running'
  }

  onStatus(fn: () => void) {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }
  private emitStatus() {
    this.statusListeners.forEach((f) => f())
  }

  static async listOutputs(): Promise<OutputDevice[]> {
    const devs = await navigator.mediaDevices.enumerateDevices()
    return devs
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Output ${d.deviceId.slice(0, 6)}`,
        isDualSense: /dualsense|wireless controller/i.test(d.label),
      }))
  }

  /**
   * Browsers hide output device labels until the page has a media permission, so the
   * DualSense can't be recognised by name. Ask for one (needs a user gesture). Returns the
   * device id picked by selectAudioOutput, when that API is used.
   */
  static async unlockOutputLabels(): Promise<string | null> {
    const md = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> }
    if (md.selectAudioOutput) {
      try {
        return (await md.selectAudioOutput()).deviceId
      } catch {
        // dismissed, or not allowed here; fall through to the mic prompt
      }
    }
    const stream = await md.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    return null
  }

  /**
   * Find the controller's audio device and switch haptics to it. In a browser, device
   * names stay hidden until a media permission is granted, so this asks for one (needs a
   * user gesture). Returns false when no DualSense audio device is found.
   */
  async connectController(): Promise<boolean> {
    let list = await HapticEngine.listOutputs()
    let id = list.find((d) => d.isDualSense)?.deviceId
    if (!id) {
      const picked = await HapticEngine.unlockOutputLabels()
      list = await HapticEngine.listOutputs()
      id = picked ?? list.find((d) => d.isDualSense)?.deviceId
    }
    if (!id) return false
    saveLocal('dshd.sink', id)
    await this.start(id)
    return true
  }

  /** Start (or restart) on a given output device. '' = system default. */
  async start(sinkId: string): Promise<void> {
    this.error = null
    await this.stop()
    try {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
      if (sinkId && 'setSinkId' in ctx) {
        await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId)
      }
      await ctx.audioWorklet.addModule(workletUrl)
      const node = new AudioWorkletNode(ctx, 'haptic-synth', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      const maxCh = ctx.destination.maxChannelCount
      const channels = maxCh >= 4 ? 4 : Math.max(2, maxCh)
      ctx.destination.channelCount = channels
      ctx.destination.channelCountMode = 'explicit'
      ctx.destination.channelInterpretation = 'discrete'

      const splitter = ctx.createChannelSplitter(2)
      const merger = ctx.createChannelMerger(channels)
      merger.channelInterpretation = 'discrete'
      const master = ctx.createGain()
      node.connect(splitter)
      merger.connect(master).connect(ctx.destination)
      // taps on the two motor signals, for the live graphs (their own splitter: applyRouting
      // disconnects everything on the routing one)
      const tap = ctx.createChannelSplitter(2)
      node.connect(tap)
      const analysers = [0, 1].map((ch) => {
        const an = ctx.createAnalyser()
        an.fftSize = 4096
        an.smoothingTimeConstant = 0.75
        tap.connect(an, ch)
        return an
      })

      this.ctx = ctx
      this.node = node
      this.splitter = splitter
      this.merger = merger
      this.master = master
      this.analysers = analysers
      this.sinkId = sinkId
      this.channelCount = channels
      this.applyRouting(channels >= 4 ? 'dualsense' : 'monitor')

      node.port.onmessage = (e) => {
        const m = e.data
        if (m.t === 'meter') {
          this.meter = { l: m.l, r: m.r }
          this.positions = m.pos
        } else if (m.t === 'block') {
          this.tapListeners.forEach((f) => f(m.L, m.R))
        } else if (m.t === 'ended') {
          this.endedListeners.forEach((f) => f(m.id))
        }
      }
      if (this.tapListeners.size) this.post({ t: 'tap', on: true })
      await ctx.resume()
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      console.error('Haptic engine failed to start', err)
    }
    this.emitStatus()
  }

  async stop() {
    if (this.ctx) {
      try {
        await this.ctx.close()
      } catch {
        /* ignore */
      }
    }
    this.ctx = null
    this.node = null
    this.emitStatus()
  }

  /** Route the haptic pair to channels 3/4 (DualSense) or 1/2 (monitor on speakers). */
  applyRouting(mode: RoutingMode) {
    if (!this.splitter || !this.merger) return
    this.splitter.disconnect()
    const base = mode === 'dualsense' && this.channelCount >= 4 ? 2 : 0
    this.splitter.connect(this.merger, 0, base)
    this.splitter.connect(this.merger, 1, base + 1)
    this.routing = base === 2 ? 'dualsense' : 'monitor'
    this.emitStatus()
  }

  /**
   * Route a mono node to output channel `ch` (0-3) of the device. On a 2-channel device
   * (speakers/headphones) channels 1/3 fold to left and 2/4 to right so everything is audible.
   */
  connectToChannel(node: AudioNode, ch: number) {
    if (!this.merger) return
    node.connect(this.merger, 0, this.channelCount >= 4 ? ch : ch % 2)
  }

  /**
   * The synth's live signal for motor `ch` (0 = left, 1 = right): scenes and clip playback.
   * `gain` is the master gain applied after it, so together they're what the motor gets.
   */
  motorAnalyser(ch: number): { node: AnalyserNode; gain: number } | null {
    const node = this.analysers[ch]
    return node && this.ctx ? { node, gain: this.master?.gain.value ?? 1 } : null
  }

  setMasterGain(v: number) {
    if (this.master) this.master.gain.value = v
  }

  /** Batched message posting (one postMessage per microtask). */
  post(m: MixerMessage) {
    this.pending.push(m)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => {
        this.flushScheduled = false
        const msgs = this.pending
        this.pending = []
        this.node?.port.postMessage(msgs)
      })
    }
  }

  grain(g: Grain) {
    this.post({ t: 'grain', g })
  }

  voice(id: string, p: ContinuousParams | null) {
    this.post({ t: 'voice', id, p })
  }

  /** Play a rendered stereo buffer. Copies so the caller can keep its arrays. */
  play(id: string, L: Float32Array, R: Float32Array, offset = 0, loop = false) {
    const l = L.slice()
    const r = R.slice()
    this.pending.push({ t: 'play', id, L: l, R: r, offset, loop })
    // flush immediately with transfer
    const msgs = this.pending
    this.pending = []
    this.node?.port.postMessage(msgs, [l.buffer, r.buffer])
  }

  stopPlayback(id?: string) {
    this.post({ t: 'stop', id })
  }

  onEnded(fn: (id: string) => void) {
    this.endedListeners.add(fn)
    return () => this.endedListeners.delete(fn)
  }

  /** Receive the synth's output in 1024-sample blocks (for BT streaming). */
  onBlock(fn: BlockListener) {
    this.tapListeners.add(fn)
    if (this.tapListeners.size === 1) this.post({ t: 'tap', on: true })
    return () => {
      this.tapListeners.delete(fn)
      if (this.tapListeners.size === 0) this.post({ t: 'tap', on: false })
    }
  }
}

export const hapticEngine = new HapticEngine()

