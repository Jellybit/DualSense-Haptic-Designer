// Main workflow:
//  1. load a sound (WAV / MP3 / OGG / FLAC …)
//  2. shape what each grip motor gets with one EQ per motor
//     (e.g. low boom → left motor, crackle → right motor)
//  3. feel it on the controller by pressing any face button
//  4. design the L2/R2 trigger feedback
//  5. export a 4-channel WAV (motors on ch 3/4, ch 1/2 silent) + the trigger JSON

import { platform } from '../../platform'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import { hapticEngine, HapticEngine, type OutputDevice } from '../../haptics/engine'
import { currentPcContext, pcContext } from '../../haptics/pcAudio'
import { loadLastSound, saveLastSound } from '../../lastSound'
import { confirmReset, onReset, RESET_LABELS, resetSection } from '../../resets'
import { SAMPLE_RATE } from '../../haptics/dsp'
import {
  audioBufferFrom,
  buildGraph,
  defaultEqs,
  EQ_BANDS,
  EQ_PRESETS,
  EqChain,
  feedSource,
  MOTOR_CHANNELS,
  MOTOR_NAMES,
  renderMotors,
  sourceTrim,
  toQuad,
  type EqSettings,
  type EqSource,
} from '../../haptics/eq'
import { decodeWav, encodeWavChannels, resample } from '../../export/wav'
import { loadLocal, PressTracker, saveLocal, useConnection } from '../../store'
import { Card, downloadName, Param } from '../../ui/controls'
import { exportTriggerJson, TriggerPanel } from '../triggers/TriggerPanel'
import { F_MAX, F_MIN, MotorGraphPainter, workbenchLive, type MotorAnalyser } from './motorGraph'

const FACE_BUTTONS = ['cross', 'circle', 'square', 'triangle'] as const

/** What a playback sends where: grip motors, the controller's speaker (ch 1/2), the PC output. */
interface PlayTarget {
  vibration: boolean
  speaker: boolean
  pc: boolean
}
const VIBRATION_ONLY: PlayTarget = { vibration: true, speaker: false, pc: false }
const PC_ONLY: PlayTarget = { vibration: false, speaker: false, pc: true }
const VIBRATION_PC: PlayTarget = { vibration: true, speaker: false, pc: true }
const VIBRATION_SPEAKER: PlayTarget = { vibration: true, speaker: true, pc: false }
const SPEAKER_ONLY: PlayTarget = { vibration: false, speaker: true, pc: false }
/** ✕ vibration · ○ controller speaker + vibration · △ PC sound · □ PC sound + vibration */
const BUTTON_TARGET: Record<(typeof FACE_BUTTONS)[number], PlayTarget> = {
  cross: VIBRATION_ONLY,
  circle: VIBRATION_SPEAKER,
  triangle: PC_ONLY,
  square: VIBRATION_PC,
}
/** What the on-screen Play button plays */
const PLAY_CHOICES: { label: string; target: PlayTarget }[] = [
  { label: 'PC Audio Only', target: PC_ONLY },
  { label: 'Vibration Only', target: VIBRATION_ONLY },
  { label: 'Vibration + PC Audio', target: VIBRATION_PC },
  { label: 'Vibration + Controller Audio', target: VIBRATION_SPEAKER },
  { label: 'Controller Audio Only', target: SPEAKER_ONLY },
]
const PLAY_CHOICE_KEY = 'dshd.workbench.playChoice'
const NORMALIZE_KEY = 'dshd.workbench.normalize'

/**
 * Normalize Vibration: one gain for both motors (keeping their balance), measured before each
 * motor's EQ Gain (dB), which then applies on top. The gain is the last stage of each motor's
 * chain, so a motor's pre-gain peak is its output peak divided by that gain. 1 when silent.
 */
function normalizeGain(motors: Float32Array[], eqs: EqSettings[]): number {
  let peak = 0
  motors.forEach((c, k) => {
    let p = 0
    for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]))
    peak = Math.max(peak, p / Math.pow(10, (eqs[k]?.gainDb ?? 0) / 20))
  })
  return peak > 1e-6 ? 1 / peak : 1
}
const PC_SINK_KEY = 'dshd.workbench.pcSink'
const AUDIO_FILTER = [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a'] }]
const LAST_FILE_KEY = 'dshd.workbench.file'
const EQ_KEY = 'dshd.workbench.motorEqs'
const LANE_COLORS = ['#5aa9ff', '#8fd14f']

interface LoadedAudio {
  name: string
  path?: string
  /** source channels, resampled to 48 kHz */
  channels: Float32Array[]
  info: string
}

type PlayMode = 'restart' | 'hold'

interface PreviewGraph {
  ctx: AudioContext
  source: AudioBufferSourceNode
  chains: EqChain[]
  trims: GainNode[]
  split: ChannelSplitterNode
  analysers: AnalyserNode[]
  srcAnalyser: AnalyserNode
  sources: EqSource[]
  startTime: number
  /** per-motor gain: Vibration Power, or 0 when this playback has no vibration */
  motorGains: GainNode[]
  target: PlayTarget
  /** extra nodes to disconnect: the controller-speaker path */
  speakerNodes: AudioNode[]
  /** the original sound on the PC output, once its context is ready */
  pcSource: AudioBufferSourceNode | null
}

/** Audio Play: one motor's EQ'd signal on the PC output, to hear what that motor gets. */
interface AuditionGraph {
  ch: number
  source: AudioBufferSourceNode
  split: ChannelSplitterNode
  trim: GainNode
  chain: EqChain
  eqSource: EqSource
  analyser: AnalyserNode
  srcAnalyser: AnalyserNode
}

async function decodeAudioFile(name: string, bytes: Uint8Array, path?: string): Promise<LoadedAudio> {
  const isWav = /\.wav$/i.test(name)
  let channels: Float32Array[]
  let srcRate: number
  try {
    // Chromium decodes WAV/MP3/OGG/FLAC/AAC and resamples to the context rate
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE)
    const buf = await ctx.decodeAudioData(bytes.slice().buffer)
    channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
    srcRate = isWav ? decodeWav(bytes).sampleRate : buf.sampleRate
  } catch (err) {
    // some WAV variants (e.g. 4-channel WAVE_FORMAT_EXTENSIBLE) aren't accepted by the browser decoder
    if (!isWav) throw err
    const w = decodeWav(bytes)
    srcRate = w.sampleRate
    channels = w.channels.map((c) => resample(c, w.sampleRate, SAMPLE_RATE))
  }
  return { name, path, channels, info: `${channels.length} ch · ${srcRate} Hz · ${(channels[0].length / SAMPLE_RATE).toFixed(2)} s` }
}

/** Do these EQ settings make sense for a file with `n` channels? */
function eqsFit(eqs: EqSettings[], n: number) {
  return eqs.length === 2 && eqs.every((e) => (e.source.startsWith('ch') ? Number(e.source.slice(2)) <= n : true))
}

export function WorkbenchPanel() {
  const info = useConnection()
  const [audio, setAudio] = useState<LoadedAudio | null>(null)
  const [eqs, setEqsState] = useState<EqSettings[]>(() => loadLocal(EQ_KEY, defaultEqs(2)))
  const [rendered, setRendered] = useState<Float32Array[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  /** what's playing now, or null */
  const [playing, setPlaying] = useState<PlayTarget | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [mode, setMode] = useState<PlayMode>(() => loadLocal('dshd.workbench.mode', 'restart'))
  const [loop, setLoop] = useState(false)
  // Vibration Power: gain on the motors, applied live and to exported WAVs
  const [volume, setVolume] = useState(() => loadLocal('dshd.workbench.boost', 1))
  const [dragOver, setDragOver] = useState(false)
  const graph = useRef<PreviewGraph | null>(null)
  const [pcSink, setPcSink] = useState<string>(() => loadLocal(PC_SINK_KEY, ''))
  const [playChoice, setPlayChoice] = useState<string>(() => {
    const saved = loadLocal(PLAY_CHOICE_KEY, 'Vibration Only')
    return PLAY_CHOICES.some((c) => c.label === saved) ? saved : 'Vibration Only'
  })
  const playTarget = PLAY_CHOICES.find((c) => c.label === playChoice)!.target
  const [pcOutputs, setPcOutputs] = useState<OutputDevice[]>([])
  // Normalize Vibration: the motors get the gain that brings their loudest point to full
  // power (instead of Vibration Power)
  const [normalize, setNormalize] = useState(() => loadLocal(NORMALIZE_KEY, false))
  // rendered matches the latest EQs once its debounced render lands
  const normGain = useMemo(() => (rendered ? normalizeGain(rendered, eqs) : 1), [rendered]) // eslint-disable-line react-hooks/exhaustive-deps
  const motorGain = normalize ? normGain : volume
  // each motor's loudest point as the motor gets it (1 = full power; above that it clips)
  const motorPeaks = useMemo(
    () =>
      rendered?.map((c) => {
        let p = 0
        for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]))
        return p
      }) ?? null,
    [rendered],
  )
  // Reset Motor Settings: EQs, power, normalize, play options back to defaults; unload the sound
  useEffect(
    () =>
      onReset((s) => {
        if (s !== 'motor') return
        stopPreview()
        stopAudition()
        setAudio(null)
        setRendered(null)
        setPlayhead(0)
        setEqsState(defaultEqs(2))
        setVolume(1)
        setNormalize(false)
        setLoop(false)
        setMode('restart')
        setPlayChoice('Vibration Only')
        setError(null)
        setMsg(null)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const latest = useRef({ audio, eqs, mode, loop, motorGain, pcSink })
  latest.current = { audio, eqs, mode, loop, motorGain, pcSink }

  const setEqs = (next: EqSettings[]) => {
    setEqsState(next)
    saveLocal(EQ_KEY, next)
  }

  /** Each motor's EQ is independent. */
  const changeEq = (i: number, patch: Partial<EqSettings>) => setEqs(eqs.map((e, j) => (j === i ? { ...e, ...patch } : e)))

  // --- loading ------------------------------------------------------------------
  const load = async (name: string, bytes: Uint8Array, path?: string, remember = true) => {
    setError(null)
    setMsg(null)
    try {
      stopPreview()
      stopAudition()
      const a = await decodeAudioFile(name, bytes, path)
      setAudio(a)
      setPlayhead(0)
      if (!eqsFit(latest.current.eqs, a.channels.length) || (a.channels.length >= 4) !== latest.current.eqs.some((e) => e.source.startsWith('ch'))) {
        setEqs(defaultEqs(a.channels.length))
      }
      // the newest sound wins on reload: a path to reopen, or (dropped / browser) the stored copy
      if (path) saveLocal(LAST_FILE_KEY, path)
      else if (remember) saveLocal(LAST_FILE_KEY, null)
      // keep a copy so it comes back after a reload (dropped files and the browser have no path)
      if (remember) void saveLastSound(name, bytes)
    } catch (e) {
      setError(`Couldn't decode ${name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  useEffect(() => {
    // the desktop app reopens the last file from disk; otherwise use the stored copy
    const last = loadLocal<string | null>(LAST_FILE_KEY, null)
    void (async () => {
      const f = last ? await platform.readFile(last) : null
      if (f) return load(f.name, f.data, f.path)
      const saved = await loadLastSound()
      if (saved) await load(saved.name, saved.data, undefined, false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFile = async () => {
    const f = await platform.openFile(AUDIO_FILTER)
    if (f) await load(f.name, f.data, f.path)
  }
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) await load(file.name, new Uint8Array(await file.arrayBuffer()))
  }

  // --- live preview through the 4 EQs -----------------------------------------------
  const bufferCache = useRef<{ audio: LoadedAudio; ctx: AudioContext; buffer: AudioBuffer } | null>(null)
  const pcBufferCache = useRef<{ audio: LoadedAudio; ctx: AudioContext; buffer: AudioBuffer } | null>(null)

  function stopPreview() {
    const g = graph.current
    graph.current = null
    if (g) {
      g.source.onended = null
      try {
        g.source.stop()
      } catch {
        /* not started */
      }
      g.chains.forEach((c) => c.disconnect())
      g.trims.forEach((t) => t.disconnect())
      g.split.disconnect()
      g.motorGains.forEach((m) => m.disconnect())
      g.speakerNodes.forEach((n) => n.disconnect())
      if (g.target.speaker) void dualSense.update({ audioOutput: 'headphones' })
      if (g.pcSource) {
        try {
          g.pcSource.stop()
        } catch {
          /* not started */
        }
        g.pcSource.disconnect()
      }
    }
    setPlaying(null)
  }

  function startPreview(target: PlayTarget = VIBRATION_ONLY) {
    const { audio: a, eqs: e, loop: lp, motorGain: vol, pcSink: sink } = latest.current
    const ctx = hapticEngine.ctx
    if (!a || !ctx) return
    stopPreview()
    let cache = bufferCache.current
    if (!cache || cache.audio !== a || cache.ctx !== ctx) {
      cache = { audio: a, ctx, buffer: audioBufferFrom(ctx, a.channels, SAMPLE_RATE) }
      bufferCache.current = cache
    }
    // The haptic graph always runs (it drives the playhead and the EQ spectra); without
    // vibration its motor gains are 0
    const analysers: AnalyserNode[] = []
    const motorGains: GainNode[] = []
    const g = buildGraph(ctx, cache.buffer, e, (node, ch) => {
      const mg = ctx.createGain()
      mg.gain.value = target.vibration ? vol : 0
      node.connect(mg)
      hapticEngine.connectToChannel(mg, MOTOR_CHANNELS[ch])
      motorGains[ch] = mg
      const an = ctx.createAnalyser()
      an.fftSize = 4096
      an.smoothingTimeConstant = 0.75
      // the spectrum shows what the motor gets: after Vibration Power / Normalize
      mg.connect(an)
      analysers[ch] = an
    })
    const srcAnalyser = ctx.createAnalyser()
    srcAnalyser.fftSize = 4096
    srcAnalyser.smoothingTimeConstant = 0.75
    g.source.connect(srcAnalyser)
    g.source.loop = lp
    // ○: the original sound on the controller's built-in speaker. It's mono and plays only
    // channel 2, so send a mono mix to channels 1 and 2, and switch the controller's audio
    // from its headphone jack to the speaker while this plays
    const speakerNodes: AudioNode[] = []
    if (target.speaker) {
      const mono = ctx.createGain()
      mono.channelCount = 1
      mono.channelCountMode = 'explicit'
      mono.channelInterpretation = 'speakers'
      g.source.connect(mono)
      hapticEngine.connectToChannel(mono, 0)
      hapticEngine.connectToChannel(mono, 1)
      speakerNodes.push(mono)
      void dualSense.update({ audioOutput: 'speaker' })
    }
    const pg: PreviewGraph = {
      ctx,
      ...g,
      analysers,
      srcAnalyser,
      sources: e.map((x) => x.source),
      startTime: ctx.currentTime,
      motorGains,
      target,
      speakerNodes,
      pcSource: null,
    }
    g.source.onended = () => {
      if (graph.current === pg) stopPreview()
    }
    g.source.start()
    graph.current = pg
    setPlaying(target)
    // △/□: the original sound on the PC output, started at the same point in the sound
    if (target.pc) {
      void pcContext(sink).then((pc) => {
        if (graph.current !== pg) return
        void pc.resume()
        let pcb = pcBufferCache.current
        if (!pcb || pcb.audio !== a || pcb.ctx !== pc) {
          pcb = { audio: a, ctx: pc, buffer: audioBufferFrom(pc, a.channels, SAMPLE_RATE) }
          pcBufferCache.current = pcb
        }
        const src = pc.createBufferSource()
        src.buffer = pcb.buffer
        src.loop = pg.source.loop
        src.connect(pc.destination)
        const elapsed = ctx.currentTime - pg.startTime
        src.start(0, pg.source.loop ? elapsed % pcb.buffer.duration : elapsed)
        pg.pcSource = src
      })
    }
  }

  // --- Audio Play ---------------------------------------------------------------------
  const [audition, setAudition] = useState<number | null>(null)
  const auditionGraph = useRef<AuditionGraph | null>(null)
  /** bumped on every start/stop, so a start still waiting for the PC output can tell it was superseded */
  const auditionToken = useRef(0)
  /** A motor's settings for listening: its Mute is for the vibration, so it doesn't silence this */
  const audible = (e: EqSettings): EqSettings => ({ ...e, mute: false })

  function stopAudition() {
    auditionToken.current++
    const a = auditionGraph.current
    auditionGraph.current = null
    if (a) {
      a.source.onended = null
      try {
        a.source.stop()
      } catch {
        /* not started */
      }
      a.source.disconnect()
      a.split.disconnect()
      a.trim.disconnect()
      a.chain.disconnect()
      a.analyser.disconnect()
    }
    setAudition(null)
  }

  async function startAudition(ch: number) {
    const { audio: a, eqs: e, loop: lp, pcSink: sink } = latest.current
    if (!a) return
    stopAudition()
    const token = auditionToken.current
    const pc = await pcContext(sink)
    if (token !== auditionToken.current) return
    void pc.resume()
    let pcb = pcBufferCache.current
    if (!pcb || pcb.audio !== a || pcb.ctx !== pc) {
      pcb = { audio: a, ctx: pc, buffer: audioBufferFrom(pc, a.channels, SAMPLE_RATE) }
      pcBufferCache.current = pcb
    }
    const analyser = pc.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0.75
    // the motor signal is mono: it plays centred on the PC speakers
    const g = buildGraph(pc, pcb.buffer, [audible(e[ch])], (node) => {
      node.connect(analyser)
      node.connect(pc.destination)
    })
    const srcAnalyser = pc.createAnalyser()
    srcAnalyser.fftSize = 4096
    srcAnalyser.smoothingTimeConstant = 0.75
    g.source.connect(srcAnalyser)
    g.source.loop = lp
    const ag: AuditionGraph = { ch, source: g.source, split: g.split, trim: g.trims[0], chain: g.chains[0], eqSource: e[ch].source, analyser, srcAnalyser }
    g.source.onended = () => {
      if (auditionGraph.current === ag) stopAudition()
    }
    g.source.start()
    auditionGraph.current = ag
    setAudition(ch)
  }

  // The spectra follow the vibration preview, or this motor's Audio Play. Audio Play's analyser
  // sits before Vibration Power / Normalize: scale it to what the motor gets
  const motorAnalyser = (ch: number): MotorAnalyser => {
    const node = graph.current?.analysers[ch]
    if (node) return { node, gain: 1 }
    return auditionGraph.current?.ch === ch ? { node: auditionGraph.current.analyser, gain: motorGain } : null
  }
  const srcAnalyser = (ch: number) => graph.current?.srcAnalyser ?? (auditionGraph.current?.ch === ch ? auditionGraph.current.srcAnalyser : null)
  // ...and the minis above the 3D view show the same
  workbenchLive.eqs = eqs
  workbenchLive.analyser = motorAnalyser
  workbenchLive.srcAnalyser = srcAnalyser
  useEffect(
    () => () => {
      workbenchLive.eqs = null
      workbenchLive.analyser = () => null
      workbenchLive.srcAnalyser = () => null
    },
    [],
  )

  // EQ edits apply live to the running preview
  useEffect(() => {
    const g = graph.current
    if (!g) return
    const n = g.source.buffer!.numberOfChannels
    eqs.forEach((e, i) => {
      g.chains[i].update(e)
      if (g.sources[i] !== e.source) {
        g.split.disconnect(g.trims[i])
        feedSource(g.split, n, e.source, g.trims[i])
        g.trims[i].gain.value = sourceTrim(e.source, n)
        g.sources[i] = e.source
      }
    })
  }, [eqs])

  // ... and to Audio Play
  useEffect(() => {
    const a = auditionGraph.current
    if (!a) return
    const e = eqs[a.ch]
    a.chain.update(audible(e))
    if (a.eqSource !== e.source) {
      const n = a.source.buffer!.numberOfChannels
      a.split.disconnect(a.trim)
      feedSource(a.split, n, e.source, a.trim)
      a.trim.gain.value = sourceTrim(e.source, n)
      a.eqSource = e.source
    }
  }, [eqs]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const g = graph.current
    if (!g) return
    g.source.loop = loop
    if (g.pcSource) g.pcSource.loop = loop
  }, [loop])
  useEffect(() => {
    if (auditionGraph.current) auditionGraph.current.source.loop = loop
  }, [loop])
  const [vibrationMsg, setVibrationMsg] = useState<string | null>(null)
  const connectVibration = async () => {
    try {
      const ok = await hapticEngine.connectController()
      setVibrationMsg(ok ? null : 'No DualSense audio device found. Connect the controller by USB (Bluetooth has no audio device).')
    } catch {
      setVibrationMsg('Permission was not granted, so the controller audio device could not be found.')
    }
  }

  useEffect(() => {
    const g = graph.current
    if (g && g.target.vibration) g.motorGains.forEach((m) => (m.gain.value = motorGain))
  }, [motorGain])
  useEffect(() => saveLocal('dshd.workbench.boost', volume), [volume])
  useEffect(() => saveLocal(NORMALIZE_KEY, normalize), [normalize])

  // PC sound output: open it ahead of time, and list the outputs other than the controller
  useEffect(() => {
    saveLocal(PC_SINK_KEY, pcSink)
    stopAudition()
    void pcContext(pcSink)
  }, [pcSink])
  useEffect(() => {
    const refresh = () => void HapticEngine.listOutputs().then((l) => setPcOutputs(l.filter((d) => !d.isDualSense))).catch(() => {})
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    const unsub = hapticEngine.onStatus(refresh) as unknown as () => void
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refresh)
      unsub()
    }
  }, [])
  // Browsers keep a new AudioContext paused until a click or key press, and controller
  // buttons don't count, so resume the PC context on the next real gesture
  useEffect(() => {
    const resume = () => void currentPcContext()?.resume()
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)
    return () => {
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
    }
  }, [])
  // engine restarts (output device change) invalidate the preview graph
  // Redraw when the audio output changes (the speakers/controller notice depends on it);
  // a preview playing on the old output's AudioContext has to stop
  const [, redraw] = useReducer((x: number) => x + 1, 0)
  useEffect(
    () =>
      hapticEngine.onStatus(() => {
        redraw()
        if (graph.current && graph.current.ctx !== hapticEngine.ctx) stopPreview()
      }) as unknown as () => void,
    [],
  )
  useEffect(
    () => () => {
      stopPreview()
      stopAudition()
      hapticEngine.setMasterGain(1)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Face buttons trigger playback; playhead follows the audio clock
  useEffect(() => {
    const presses = new PressTracker()
    let held = false
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const b = dualSense.state.buttons
      let pressed: PlayTarget | null = null
      for (const name of FACE_BUTTONS) if (presses.pressed(name, b[name])) pressed = BUTTON_TARGET[name]
      const anyHeld = FACE_BUTTONS.some((n) => b[n])
      if (pressed) startPreview(pressed)
      if (latest.current.mode === 'hold' && held && !anyHeld) stopPreview()
      held = anyHeld
      const g = graph.current
      if (g) {
        const dur = g.source.buffer!.duration
        let t = g.ctx.currentTime - g.startTime
        if (g.source.loop) t %= dur
        setPlayhead(Math.min(t, dur))
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Space plays/stops too
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.code !== 'Space') return
      e.preventDefault()
      if (graph.current) stopPreview()
      else startPreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Offline render of the two motor signals (debounced) — drives the waveform
  useEffect(() => {
    if (!audio) return
    let cancelled = false
    const t = window.setTimeout(async () => {
      const out = await renderMotors(audio.channels, SAMPLE_RATE, eqs)
      if (!cancelled) setRendered(out)
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [audio, eqs])

  // --- export ---------------------------------------------------------------------
  const baseName = audio ? audio.name.replace(/\.[^.]+$/, '') : 'haptics'

  /**
   * 'quad':   the controller's native USB-audio layout (ch 1/2 silent, motors on ch 3/4) —
   *           plays as-is on the controller's sound device.
   * 'stereo': motors only (ch 1 = left motor, ch 2 = right motor), for engines/middleware
   *           that route haptics to the motors themselves.
   */
  const exportWav = async (layout: 'quad' | 'stereo') => {
    if (!audio) return
    const motors = await renderMotors(audio.channels, SAMPLE_RATE, eqs)
    const gain = normalize ? normalizeGain(motors, eqs) : volume
    for (const c of motors) for (let i = 0; i < c.length; i++) c[i] *= gain
    let peak = 0
    for (const c of motors) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]))
    const quad = layout === 'quad'
    const data = encodeWavChannels(quad ? toQuad(motors) : motors, SAMPLE_RATE)
    const name = downloadName(`${baseName}-${quad ? 'dualsense-4ch' : 'haptics-stereo'}`, 'wav')
    const path = await platform.saveFile(name, [{ name: 'WAV', extensions: ['wav'] }], data)
    if (!path) return
    const layoutText = quad ? '4-ch, 48 kHz, 16-bit: motors on ch 3/4, ch 1/2 silent' : '2-ch, 48 kHz, 16-bit: left motor, right motor'
    setMsg(`Saved ${path} (${layoutText})${peak > 1 ? ` — note: peaks at ${Math.round(peak * 100)}%, lower Vibration Power or some EQ gain to avoid clipping` : ''}`)
  }

  const exportJson = async () => {
    const path = await exportTriggerJson(baseName)
    if (path) setMsg(`Saved ${path}`)
  }

  const nCh = audio?.channels.length ?? 2
  // A mono file feeds both motors (L and R read the same channel); the EQs then split it.
  const sourceOptions: { value: EqSource; label: string }[] =
    nCh === 1
      ? [
          { value: 'L', label: 'Mono' },
          { value: 'R', label: 'Mono' },
        ]
      : [
          { value: 'L', label: 'Left' },
          { value: 'R', label: 'Right' },
          { value: 'mix', label: 'L+R mix' },
          ...(nCh > 2 ? [1, 2, 3, 4].filter((i) => i <= nCh).map((i) => ({ value: `ch${i}` as EqSource, label: `Channel ${i}` })) : []),
        ]

  return (
    <>
      <Card
        title="Sound → grip motors"
        right={
          <>
            <button onClick={() => confirmReset(RESET_LABELS.motor) && void resetSection('motor')} title="Both motor EQs, Vibration Power, Normalize and play options back to defaults, and unload the sound">
              {RESET_LABELS.motor}
            </button>
            <button className="primary" onClick={() => void exportWav('quad')} disabled={!audio} title="Controller's native layout: ch 1/2 silent, motors on ch 3/4. Plays as-is on the controller's sound device.">
              Export 4-ch WAV…
            </button>
            <button className="primary" onClick={() => void exportWav('stereo')} disabled={!audio} title="Motors only: left motor, right motor. A haptic signal for the grip motors, meant to be felt, not heard. For engines/middleware that route haptics themselves.">
              Export Haptics-only WAV…
            </button>
            <button className="primary" onClick={() => void exportJson()}>
              Export trigger JSON…
            </button>
          </>
        }
      >
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => void onDrop(e)}
          style={{ outline: dragOver ? '2px dashed var(--accent)' : 'none', borderRadius: 8 }}
        >
          <div className="row" style={{ marginBottom: 8 }}>
            <button onClick={() => void openFile()}>Load sound…</button>
            {audio ? (
              <span>
                <b>{audio.name}</b> <span className="muted small">· {audio.info}</span>
              </span>
            ) : (
              <span className="muted">Load or drop a WAV / MP3 here.</span>
            )}
          </div>
          {error && <div className="errbox">{error}</div>}
          {audio ? (
            <MotorWaveform channels={rendered} gain={motorGain} playhead={playhead} duration={audio.channels[0].length / SAMPLE_RATE} />
          ) : (
            <div className="muted" style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: 30, textAlign: 'center' }}>
              Drop a sound file here
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className={playing ? 'active' : ''}
              disabled={!audio}
              // from start: click plays (and stops while playing); when held: plays while the button is held down
              onClick={mode === 'restart' ? () => (playing ? stopPreview() : startPreview(playTarget)) : undefined}
              onPointerDown={
                mode === 'hold'
                  ? (e) => {
                      e.currentTarget.setPointerCapture(e.pointerId)
                      startPreview(playTarget)
                    }
                  : undefined
              }
              onPointerUp={mode === 'hold' ? () => stopPreview() : undefined}
              onPointerCancel={mode === 'hold' ? () => stopPreview() : undefined}
            >
              {playing && mode === 'restart' ? '■ Stop' : '▶ Play'}
            </button>
            <select
              value={playChoice}
              title="What the Play button plays"
              onChange={(e) => {
                setPlayChoice(e.target.value)
                saveLocal(PLAY_CHOICE_KEY, e.target.value)
              }}
            >
              {PLAY_CHOICES.map((c) => (
                <option key={c.label} value={c.label}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={mode}
              title="Applies to the controller's face buttons and the Play button"
              onChange={(e) => {
                setMode(e.target.value as PlayMode)
                saveLocal('dshd.workbench.mode', e.target.value)
              }}
            >
              <option value="restart">Play From Start</option>
              <option value="hold">Play When Held</option>
            </select>
            <span className="muted">PC sound:</span>
            <select value={pcSink} onChange={(e) => setPcSink(e.target.value)} title="Where PC audio plays the original sound">
              <option value="">System default output</option>
              {pcOutputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="row">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
            </label>
            <label className="row" title="Raise the vibration so the loudest point of the sound becomes full vibration power">
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> Normalize Vibration
            </label>
            <div style={{ minWidth: 260, flex: 1 }}>
              <Param
                label="Vibration Power"
                value={normalize ? Math.min(2, normGain) : volume}
                min={0}
                max={2}
                step={0.05}
                onChange={setVolume}
                format={(v) => `${Math.round((normalize ? normGain : v) * 100)}%`}
                disabled={normalize}
              />
            </div>
          </div>
          {hapticEngine.channelCount < 4 && (
            <div className="warnbox small row" style={{ marginTop: 8 }}>
              <span style={{ flex: 1 }}>
                Sound is playing on {hapticEngine.channelCount}-channel speakers, not the controller's grip motors.
                {vibrationMsg && <> {vibrationMsg}</>}
              </span>
              <button className="primary" onClick={() => void connectVibration()}>
                Connect to Controller Vibration
              </button>
            </div>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            {info ? (
              <>
                <b>✕</b> vibration · <b>○</b> controller speaker + vibration · <b>△</b> PC sound · <b>□</b> PC sound + vibration. The speaker and PC
                play the original, unedited sound.
              </>
            ) : (
              'Connect the controller to play from its face buttons (or press Space for vibration).'
            )}{' '}
            Each grip motor has its own EQ below; edits apply live while playing. Vibration Power applies to the motors and to exported WAVs.
          </p>
          {msg && <div className="muted small" style={{ marginTop: 6 }}>{msg}</div>}
        </div>
      </Card>

      <div>
        <div>
          <h3 className="muted" style={{ margin: '4px 0 8px', fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' }}>
            Grip motors
          </h3>
          <div className="grid2">
            {[0, 1].map((ch) => (
              <EqCard
                key={ch}
                ch={ch}
                eq={eqs[ch]}
                sourceOptions={sourceOptions}
                onChange={(p) => changeEq(ch, p)}
                peak={motorPeaks ? motorPeaks[ch] * motorGain : null}
                auditioning={audition === ch}
                canAudition={!!audio}
                onAudition={() => (audition === ch ? stopAudition() : void startAudition(ch))}
                // the spectra follow the vibration preview, or this motor's Audio Play
                analyser={() => motorAnalyser(ch)}
                srcAnalyser={() => srcAnalyser(ch)}
              />
            ))}
          </div>
        </div>
      </div>

      <h3 className="muted" style={{ margin: '16px 0 8px', fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' }}>
        Trigger force feedback
      </h3>
      <TriggerPanel embedded />
    </>
  )
}

// --- one EQ ------------------------------------------------------------------------

function EqCard(props: {
  ch: number
  eq: EqSettings
  sourceOptions: { value: EqSource; label: string }[]
  onChange: (p: Partial<EqSettings>) => void
  /** loudest point this motor gets (1 = full power), null while rendering or with no sound */
  peak: number | null
  /** Audio Play: this motor's EQ'd signal on the PC output */
  auditioning: boolean
  canAudition: boolean
  onAudition: () => void
  /** this motor's live signal */
  analyser: () => MotorAnalyser
  srcAnalyser: () => AnalyserNode | null
}) {
  const { ch, eq, onChange } = props
  const painter = useMemo(() => new MotorGraphPainter(ch), [ch])
  const canvas = useRef<HTMLCanvasElement>(null)
  const getters = useRef(props)
  getters.current = props

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const p = getters.current
      if (c) painter.draw(c, 130, p.eq, p.analyser(), p.srcAnalyser())
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [painter])

  const hz = (v: number) => (v === 0 ? 'off' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`)
  // log-scale slider helpers for the cut filters (0 = off at the slider's end)
  const toSlider = (f: number, offAt: 'min' | 'max') => (f === 0 ? (offAt === 'min' ? 0 : 1000) : Math.round((Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * 1000))
  const fromSlider = (v: number, offAt: 'min' | 'max') => ((offAt === 'min' && v <= 0) || (offAt === 'max' && v >= 1000) ? 0 : Math.round(F_MIN * Math.pow(F_MAX / F_MIN, v / 1000)))

  return (
    <Card
      title={MOTOR_NAMES[ch]}
      right={
        <>
          <select value={eq.source} onChange={(e) => onChange({ source: e.target.value as EqSource })} title="What part of the file feeds this channel">
            {props.sourceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                from {o.label}
              </option>
            ))}
          </select>
          <select
            value=""
            onChange={(e) => {
              const p = EQ_PRESETS[Number(e.target.value)]
              if (p) onChange(structuredClone(p.shape))
            }}
          >
            <option value="">Preset…</option>
            {EQ_PRESETS.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name}
              </option>
            ))}
          </select>
          <button className={eq.mute ? 'active' : ''} onClick={() => onChange({ mute: !eq.mute })}>
            {eq.mute ? 'Muted' : 'Mute'}
          </button>
          <button
            className={props.auditioning ? 'active' : ''}
            disabled={!props.canAudition}
            onClick={props.onAudition}
            title="Hear what this motor gets (its source channel and EQ) on the PC sound output"
          >
            {props.auditioning ? '■ Stop' : 'Audio Play'}
          </button>
        </>
      }
    >
      <canvas ref={canvas} className="graph" style={{ height: 130 }} />
      <div className="zones" style={{ margin: '8px 0', gridTemplateColumns: `repeat(${EQ_BANDS.length}, 1fr)` }}>
        {EQ_BANDS.map((f, i) => (
          <div className="z" key={f}>
            <input
              type="range"
              min={-24}
              max={12}
              step={1}
              value={eq.bands[i]}
              style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 80 }}
              onChange={(e) => {
                const bands = [...eq.bands]
                bands[i] = Number(e.target.value)
                onChange({ bands })
              }}
              onDoubleClick={() => {
                const bands = [...eq.bands]
                bands[i] = 0
                onChange({ bands })
              }}
              title="Double-click to reset"
            />
            <span>{eq.bands[i] > 0 ? `+${eq.bands[i]}` : eq.bands[i]}</span>
            <span>{f >= 1000 ? `${f / 1000}k` : f}</span>
          </div>
        ))}
      </div>
      <Param label="Low cut (Hz)" value={toSlider(eq.hpf, 'min')} min={0} max={1000} onChange={(v) => onChange({ hpf: fromSlider(v, 'min') })} format={() => hz(eq.hpf)} />
      <Param label="High cut (Hz)" value={toSlider(eq.lpf, 'max')} min={0} max={1000} onChange={(v) => onChange({ lpf: fromSlider(v, 'max') })} format={() => hz(eq.lpf)} />
      <Param
        label={
          <>
            Gain (dB)
            {props.peak !== null && props.peak > 1 && !eq.mute && (
              <span
                className="clip-badge"
                title={`This motor's signal goes past the top of the range (peaks at ${Math.round(props.peak * 100)}%). It's safe: the controller never gets more than its normal maximum, the extra is just cut off flat. But that loses detail in the strongest moments, which can feel harsher or buzzier than intended. To fix it, lower Gain or the boosted EQ bands, or turn down Vibration Power. Clipped moments show in red in the sound's waveform at the top of the page, and in this motor's graph while it plays.`}
              >
                <span className="clip-dot">!</span>Clips
              </span>
            )}
          </>
        }
        value={eq.gainDb} min={-24} max={12} step={0.5} onChange={(v) => onChange({ gainDb: v })} format={(v) => (v > 0 ? `+${v}` : String(v))} />
    </Card>
  )
}

// --- 4-lane waveform of the rendered output ----------------------------------------------

/** The two motor signals as the motors get them (after Vibration Power / Normalize); clipped spots in red. */
function MotorWaveform({ channels, gain, playhead, duration }: { channels: Float32Array[] | null; gain: number; playhead: number; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const H = 2 * 60
  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    const W = c.clientWidth
    c.width = W * dpr
    c.height = H * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const lane = H / 2
    channels?.forEach((x, k) => {
      const y0 = k * lane
      const per = Math.max(1, Math.floor(x.length / W))
      for (let px = 0; px < W; px++) {
        let mn = 0
        let mx = 0
        const s = px * per
        for (let i = s; i < Math.min(x.length, s + per); i++) {
          if (x[i] < mn) mn = x[i]
          if (x[i] > mx) mx = x[i]
        }
        mn *= gain
        mx *= gain
        const h = lane / 2 - 3
        g.fillStyle = mx > 1 || mn < -1 ? '#ff3030' : LANE_COLORS[k]
        g.fillRect(px, y0 + lane / 2 - Math.min(1, mx) * h, 1, Math.max(1, (Math.min(1, mx) - Math.max(-1, mn)) * h))
      }
      g.fillStyle = '#8b91a1'
      g.font = '10px Segoe UI'
      g.fillText(MOTOR_NAMES[k], 4, y0 + 12)
      g.strokeStyle = '#262a35'
      g.beginPath()
      g.moveTo(0, y0 + lane)
      g.lineTo(W, y0 + lane)
      g.stroke()
    })
    if (!channels) {
      g.fillStyle = '#8b91a1'
      g.fillText('rendering…', 8, 16)
    }
    g.fillStyle = '#3ad6a8'
    g.fillRect((playhead / Math.max(1e-6, duration)) * W, 0, 2, H)
  }, [channels, gain, playhead, duration, H])
  return <canvas ref={ref} className="wave" style={{ height: H }} />
}
