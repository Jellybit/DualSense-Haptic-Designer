// Turn one audio file into DualSense haptics with one EQ per motor.
// The controller's USB audio device has 4 channels: ch 1/2 are the headset jack / speaker
// (heard, not felt) and ch 3/4 drive the left/right grip voice-coil motors. Only the two
// motors are exposed here; ch 1/2 are written silent.
// Each motor picks a source (left, right, L+R mix, or a channel of a 4-ch file) and shapes
// it with high/low-cut filters and a 10-band graphic EQ — e.g. the left motor gets an
// explosion's low boom and the right motor its high crackle.
// The same filter graph runs live (preview) and offline (export), so what you feel is
// exactly what gets written.

export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export type EqSource = 'L' | 'R' | 'mix' | 'ch1' | 'ch2' | 'ch3' | 'ch4'

export interface EqSettings {
  source: EqSource
  /** silence this channel */
  mute: boolean
  /** output gain, dB */
  gainDb: number
  /** high-pass (low-cut) frequency, Hz; 0 = off */
  hpf: number
  /** low-pass (high-cut) frequency, Hz; 0 = off */
  lpf: number
  /** graphic EQ gains, dB, one per EQ_BANDS entry */
  bands: number[]
}

export const MOTOR_NAMES = ['Left motor (ch 3)', 'Right motor (ch 4)'] as const
/** output channel (0-based) of the controller's 4-ch device for each motor */
export const MOTOR_CHANNELS = [2, 3] as const

const flatBands = () => EQ_BANDS.map(() => 0)

export const flatEq = (source: EqSource): EqSettings => ({ source, mute: false, gainDb: 0, hpf: 0, lpf: 0, bands: flatBands() })

/** Shapes only — applying a preset keeps the channel's source. */
export const EQ_PRESETS: { name: string; shape: Omit<EqSettings, 'source'> }[] = [
  { name: 'Flat', shape: { mute: false, gainDb: 0, hpf: 0, lpf: 0, bands: flatBands() } },
  { name: 'Low boom (< 150 Hz)', shape: { mute: false, gainDb: 3, hpf: 20, lpf: 150, bands: [6, 6, 0, -12, -24, -24, -24, -24, -24, -24] } },
  { name: 'Bass (< 250 Hz)', shape: { mute: false, gainDb: 0, hpf: 25, lpf: 250, bands: [6, 6, 3, 0, -6, -12, -24, -24, -24, -24] } },
  { name: 'Punchy impacts', shape: { mute: false, gainDb: 3, hpf: 40, lpf: 500, bands: [0, 6, 6, 3, 0, -6, -18, -24, -24, -24] } },
  { name: 'Mid crackle (300 Hz – 1 kHz)', shape: { mute: false, gainDb: 3, hpf: 300, lpf: 1000, bands: [-24, -24, -12, 0, 6, 6, -6, -18, -24, -24] } },
  { name: 'Texture / rumble', shape: { mute: false, gainDb: 0, hpf: 50, lpf: 1000, bands: [-6, 0, 3, 6, 6, 3, -6, -18, -24, -24] } },
  { name: 'High buzz / ticks (> 150 Hz)', shape: { mute: false, gainDb: 3, hpf: 150, lpf: 1000, bands: [-24, -24, -6, 3, 6, 3, -6, -18, -24, -24] } },
]

/** Starting point: left file channel → left motor, right → right (a 4-ch file keeps ch 3/4). */
export function defaultEqs(channels: number): EqSettings[] {
  return channels >= 4 ? [flatEq('ch3'), flatEq('ch4')] : [flatEq('L'), flatEq('R')]
}

/** Mono EQ chain: input → HPF → 10 peaking → LPF → gain → output. */
export class EqChain {
  readonly input: GainNode
  readonly output: GainNode
  private hp: BiquadFilterNode
  private lp: BiquadFilterNode
  private peaks: BiquadFilterNode[]
  private settings: EqSettings

  constructor(
    private ctx: BaseAudioContext,
    settings: EqSettings,
  ) {
    this.settings = settings
    this.input = ctx.createGain()
    this.input.channelCount = 1
    this.input.channelCountMode = 'explicit'
    this.input.channelInterpretation = 'speakers' // a stereo feed is downmixed to (L+R)/2
    this.hp = ctx.createBiquadFilter()
    this.hp.type = 'highpass'
    this.hp.Q.value = 0.707
    this.lp = ctx.createBiquadFilter()
    this.lp.type = 'lowpass'
    this.lp.Q.value = 0.707
    this.peaks = EQ_BANDS.map((f) => {
      const b = ctx.createBiquadFilter()
      b.type = 'peaking'
      b.frequency.value = f
      b.Q.value = 1.41
      return b
    })
    this.output = ctx.createGain()
    let node: AudioNode = this.input
    for (const n of [this.hp, ...this.peaks, this.lp, this.output]) {
      node.connect(n)
      node = n
    }
    this.update(settings)
  }

  update(s: EqSettings) {
    this.settings = s
    const nyq = this.ctx.sampleRate / 2
    // "off" filters sit at the edges of the band, where they're transparent
    this.hp.frequency.value = s.hpf > 0 ? s.hpf : 5
    this.lp.frequency.value = s.lpf > 0 ? Math.min(s.lpf, nyq * 0.95) : nyq * 0.95
    this.peaks.forEach((p, i) => (p.gain.value = s.bands[i] ?? 0))
    this.output.gain.value = s.mute ? 0 : Math.pow(10, s.gainDb / 20)
  }

  /** Magnitude response in dB at the given frequencies (for drawing the EQ curve). */
  response(freqs: Float32Array<ArrayBuffer>): Float32Array {
    const total = new Float32Array(freqs.length)
    const mag = new Float32Array(freqs.length)
    const phase = new Float32Array(freqs.length)
    for (const f of [this.hp, ...this.peaks, this.lp]) {
      f.getFrequencyResponse(freqs, mag, phase)
      for (let i = 0; i < freqs.length; i++) total[i] += 20 * Math.log10(Math.max(1e-6, mag[i]))
    }
    const g = this.settings.mute ? -120 : this.settings.gainDb
    for (let i = 0; i < freqs.length; i++) total[i] += g
    return total
  }

  disconnect() {
    this.input.disconnect()
    this.output.disconnect()
  }
}

/**
 * Connect the right part of a multichannel source to an EQ chain input.
 * `split` is a ChannelSplitter over the source (one output per source channel).
 */
export function feedSource(split: ChannelSplitterNode, sourceChannels: number, src: EqSource, input: AudioNode) {
  const n = sourceChannels
  const ch = (i: number) => Math.min(i, n - 1)
  switch (src) {
    case 'L':
      split.connect(input, ch(0))
      break
    case 'R':
      split.connect(input, ch(1))
      break
    case 'mix':
      // both channels into the mono input; halve to keep the level of a centred sound
      split.connect(input, ch(0))
      if (n > 1) split.connect(input, ch(1))
      break
    default:
      split.connect(input, ch(Number(src.slice(2)) - 1))
  }
}

/** Gain to apply after feedSource so 'mix' averages instead of sums. */
export const sourceTrim = (src: EqSource, sourceChannels: number) => (src === 'mix' && sourceChannels > 1 ? 0.5 : 1)

export function audioBufferFrom(ctx: BaseAudioContext, channels: Float32Array[], sampleRate: number): AudioBuffer {
  const b = ctx.createBuffer(channels.length, channels[0].length, sampleRate)
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  return b
}

/**
 * Build source → one EQ chain per entry on any context. `connectOut(node, i)` routes
 * chain i's mono output wherever it belongs.
 */
export function buildGraph(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  eqs: EqSettings[],
  connectOut: (node: AudioNode, ch: number) => void,
): { source: AudioBufferSourceNode; chains: EqChain[]; trims: GainNode[]; split: ChannelSplitterNode } {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const n = buffer.numberOfChannels
  const split = ctx.createChannelSplitter(n)
  source.connect(split)
  const chains: EqChain[] = []
  const trims: GainNode[] = []
  eqs.forEach((eq, ch) => {
    const chain = new EqChain(ctx, eq)
    const trim = ctx.createGain()
    trim.channelCount = 1
    trim.channelCountMode = 'explicit'
    trim.gain.value = sourceTrim(eq.source, n)
    feedSource(split, n, eq.source, trim)
    trim.connect(chain.input)
    connectOut(chain.output, ch)
    chains.push(chain)
    trims.push(trim)
  })
  return { source, chains, trims, split }
}

/** Render the two motor signals exactly as previewed: [left motor, right motor]. */
export async function renderMotors(channels: Float32Array[], sampleRate: number, eqs: EqSettings[]): Promise<Float32Array[]> {
  const length = channels[0].length
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate })
  ctx.destination.channelCount = 2
  ctx.destination.channelInterpretation = 'discrete'
  const merger = ctx.createChannelMerger(2)
  merger.connect(ctx.destination)
  const { source } = buildGraph(ctx, audioBufferFrom(ctx, channels, sampleRate), eqs, (node, i) => node.connect(merger, 0, i))
  source.start()
  const out = await ctx.startRendering()
  return [0, 1].map((i) => out.getChannelData(i).slice())
}

/** The controller's native 4-ch layout: silent headset/speaker ch 1/2, motors on ch 3/4. */
export function toQuad(motors: Float32Array[]): Float32Array[] {
  const silent = new Float32Array(motors[0].length)
  return [silent, silent, motors[0], motors[1]]
}
