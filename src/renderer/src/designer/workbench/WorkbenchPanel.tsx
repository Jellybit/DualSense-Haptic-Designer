// Main workflow:
//  1. load a sound (WAV / MP3 / OGG / FLAC …)
//  2. shape what each grip motor gets with one EQ per motor
//     (e.g. low boom → left motor, crackle → right motor)
//  3. feel it on the controller by pressing any face button
//  4. design the L2/R2 trigger feedback
//  5. export a 4-channel WAV (motors on ch 3/4, ch 1/2 silent) + the trigger JSON

import { useEffect, useMemo, useRef, useState } from 'react'
import { dualSense } from '../../device/hid'
import { hapticEngine } from '../../haptics/engine'
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

const FACE_BUTTONS = ['cross', 'circle', 'square', 'triangle'] as const
const AUDIO_FILTER = [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a'] }]
const LAST_FILE_KEY = 'dshd.workbench.file'
const EQ_KEY = 'dshd.workbench.motorEqs'
const LANE_COLORS = ['#5aa9ff', '#ff7a9c']

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
  const [playing, setPlaying] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [mode, setMode] = useState<PlayMode>(() => loadLocal('dshd.workbench.mode', 'restart'))
  const [loop, setLoop] = useState(false)
  const [volume, setVolume] = useState(1)
  const [dragOver, setDragOver] = useState(false)
  const graph = useRef<PreviewGraph | null>(null)
  const latest = useRef({ audio, eqs, mode, loop })
  latest.current = { audio, eqs, mode, loop }

  const setEqs = (next: EqSettings[]) => {
    setEqsState(next)
    saveLocal(EQ_KEY, next)
  }

  /** Each motor's EQ is independent. */
  const changeEq = (i: number, patch: Partial<EqSettings>) => setEqs(eqs.map((e, j) => (j === i ? { ...e, ...patch } : e)))

  // --- loading ------------------------------------------------------------------
  const load = async (name: string, bytes: Uint8Array, path?: string) => {
    setError(null)
    setMsg(null)
    try {
      stopPreview()
      const a = await decodeAudioFile(name, bytes, path)
      setAudio(a)
      setPlayhead(0)
      if (!eqsFit(latest.current.eqs, a.channels.length) || (a.channels.length >= 4) !== latest.current.eqs.some((e) => e.source.startsWith('ch'))) {
        setEqs(defaultEqs(a.channels.length))
      }
      if (path) saveLocal(LAST_FILE_KEY, path)
    } catch (e) {
      setError(`Couldn't decode ${name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  useEffect(() => {
    const last = loadLocal<string | null>(LAST_FILE_KEY, null)
    if (last) void window.api.readFile(last).then((f) => f && load(f.name, f.data, f.path))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openFile = async () => {
    const f = await window.api.openFile(AUDIO_FILTER)
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
    }
    setPlaying(false)
  }

  function startPreview() {
    const { audio: a, eqs: e, loop: lp } = latest.current
    const ctx = hapticEngine.ctx
    if (!a || !ctx) return
    stopPreview()
    let cache = bufferCache.current
    if (!cache || cache.audio !== a || cache.ctx !== ctx) {
      cache = { audio: a, ctx, buffer: audioBufferFrom(ctx, a.channels, SAMPLE_RATE) }
      bufferCache.current = cache
    }
    const analysers: AnalyserNode[] = []
    const g = buildGraph(ctx, cache.buffer, e, (node, ch) => {
      hapticEngine.connectToChannel(node, MOTOR_CHANNELS[ch])
      const an = ctx.createAnalyser()
      an.fftSize = 4096
      an.smoothingTimeConstant = 0.75
      node.connect(an)
      analysers[ch] = an
    })
    const srcAnalyser = ctx.createAnalyser()
    srcAnalyser.fftSize = 4096
    srcAnalyser.smoothingTimeConstant = 0.75
    g.source.connect(srcAnalyser)
    g.source.loop = lp
    const pg: PreviewGraph = { ctx, ...g, analysers, srcAnalyser, sources: e.map((x) => x.source), startTime: ctx.currentTime }
    g.source.onended = () => {
      if (graph.current === pg) stopPreview()
    }
    g.source.start()
    graph.current = pg
    setPlaying(true)
  }

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

  useEffect(() => {
    if (graph.current) graph.current.source.loop = loop
  }, [loop])
  useEffect(() => hapticEngine.setMasterGain(volume), [volume])
  // engine restarts (output device change) invalidate the preview graph
  useEffect(() => hapticEngine.onStatus(() => graph.current && graph.current.ctx !== hapticEngine.ctx && stopPreview()) as unknown as () => void, [])
  useEffect(
    () => () => {
      stopPreview()
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
      let pressed = false
      for (const name of FACE_BUTTONS) if (presses.pressed(name, b[name])) pressed = true
      const anyHeld = FACE_BUTTONS.some((n) => b[n])
      if (pressed) startPreview()
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

  const exportWav = async () => {
    if (!audio) return
    const motors = await renderMotors(audio.channels, SAMPLE_RATE, eqs)
    let peak = 0
    for (const c of motors) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]))
    const path = await window.api.saveFile(downloadName(`${baseName}-dualsense`, 'wav'), [{ name: 'WAV', extensions: ['wav'] }], encodeWavChannels(toQuad(motors), SAMPLE_RATE))
    if (path)
      setMsg(
        `Saved ${path} (4-ch, 48 kHz, 16-bit: motors on ch 3/4, ch 1/2 silent)${peak > 1 ? ` — note: peaks at ${Math.round(peak * 100)}%, lower some EQ gain to avoid clipping` : ''}`,
      )
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
            <button className="primary" onClick={() => void exportWav()} disabled={!audio}>
              Export 4-ch WAV…
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
            <MotorWaveform channels={rendered} playhead={playhead} duration={audio.channels[0].length / SAMPLE_RATE} />
          ) : (
            <div className="muted" style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: 30, textAlign: 'center' }}>
              Drop a sound file here
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className={playing ? 'active' : ''} disabled={!audio} onClick={() => (playing ? stopPreview() : startPreview())}>
              {playing ? '■ Stop' : '▶ Play'}
            </button>
            <span className="muted">Controller:</span>
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as PlayMode)
                saveLocal('dshd.workbench.mode', e.target.value)
              }}
            >
              <option value="restart">press ✕ ○ □ △ → play from start</option>
              <option value="hold">hold ✕ ○ □ △ → play while held</option>
            </select>
            <label className="row">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
            </label>
            <div style={{ minWidth: 260, flex: 1 }}>
              <Param label="Preview volume" value={volume} min={0} max={2} step={0.05} onChange={setVolume} format={(v) => `${Math.round(v * 100)}%`} />
            </div>
          </div>
          {hapticEngine.channelCount < 4 && (
            <div className="warnbox small" style={{ marginTop: 8 }}>
              The selected audio output has only {hapticEngine.channelCount} channels, so both motors are played on it for listening. Pick the 🎮 DualSense output at the top to
              feel the motors.
            </div>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            {info ? 'Press any face button on the controller to play.' : 'Connect the controller to play from its face buttons (or press Space).'} Each grip motor has its
            own EQ below; edits apply live while playing. Preview volume only affects testing.
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
                analyser={() => graph.current?.analysers[ch] ?? null}
                srcAnalyser={() => graph.current?.srcAnalyser ?? null}
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

const curveCtx = new OfflineAudioContext(1, 128, SAMPLE_RATE)
const F_MIN = 20
const F_MAX = 20000

function EqCard(props: {
  ch: number
  eq: EqSettings
  sourceOptions: { value: EqSource; label: string }[]
  onChange: (p: Partial<EqSettings>) => void
  analyser: () => AnalyserNode | null
  srcAnalyser: () => AnalyserNode | null
}) {
  const { ch, eq, onChange } = props
  const chain = useMemo(() => new EqChain(curveCtx, eq), [])
  chain.update(eq)
  const canvas = useRef<HTMLCanvasElement>(null)
  const eqRef = useRef(eq)
  eqRef.current = eq
  const getters = useRef(props)
  getters.current = props

  useEffect(() => {
    let raf = 0
    const W0 = 600
    const freqs = new Float32Array(W0)
    for (let i = 0; i < W0; i++) freqs[i] = F_MIN * Math.pow(F_MAX / F_MIN, i / (W0 - 1))
    let spec: Float32Array<ArrayBuffer> | null = null
    let srcSpec: Float32Array<ArrayBuffer> | null = null
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      const W = c.clientWidth
      const H = 130
      if (c.width !== Math.round(W * dpr)) {
        c.width = Math.round(W * dpr)
        c.height = H * dpr
      }
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      const xOf = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W
      // grid
      g.strokeStyle = '#262a35'
      g.fillStyle = '#5d6475'
      g.font = '9px Segoe UI'
      for (const f of EQ_BANDS) {
        const x = xOf(f)
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, H)
        g.stroke()
        g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 3)
      }
      const yDb = (db: number) => H / 2 - (db / 30) * (H / 2)
      g.beginPath()
      g.moveTo(0, yDb(0))
      g.lineTo(W, yDb(0))
      g.stroke()

      // live spectra: the file (faint) and this channel's output
      const drawSpec = (an: AnalyserNode | null, buf: Float32Array<ArrayBuffer> | null, fill: string) => {
        if (!an) return buf
        if (!buf || buf.length !== an.frequencyBinCount) buf = new Float32Array(an.frequencyBinCount)
        an.getFloatFrequencyData(buf)
        const binHz = an.context.sampleRate / an.fftSize
        g.beginPath()
        g.moveTo(0, H)
        for (let x = 0; x < W; x += 2) {
          const f = F_MIN * Math.pow(F_MAX / F_MIN, x / W)
          const db = buf[Math.min(buf.length - 1, Math.round(f / binHz))]
          g.lineTo(x, H - Math.max(0, Math.min(1, (db + 100) / 80)) * H)
        }
        g.lineTo(W, H)
        g.closePath()
        g.fillStyle = fill
        g.fill()
        return buf
      }
      srcSpec = drawSpec(getters.current.srcAnalyser(), srcSpec, 'rgba(140,150,170,0.18)')
      spec = drawSpec(getters.current.analyser(), spec, ch === 0 ? 'rgba(90,169,255,0.45)' : 'rgba(255,122,156,0.45)')

      // EQ curve
      const resp = chain.response(freqs)
      g.strokeStyle = eqRef.current.mute ? '#555' : '#ffb347'
      g.lineWidth = 2
      g.beginPath()
      for (let i = 0; i < W0; i++) {
        const x = (i / (W0 - 1)) * W
        const y = Math.max(0, Math.min(H, yDb(resp[i])))
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
      g.lineWidth = 1
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [chain, ch])

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
      <Param label="Gain (dB)" value={eq.gainDb} min={-24} max={12} step={0.5} onChange={(v) => onChange({ gainDb: v })} format={(v) => (v > 0 ? `+${v}` : String(v))} />
    </Card>
  )
}

// --- 4-lane waveform of the rendered output ----------------------------------------------

function MotorWaveform({ channels, playhead, duration }: { channels: Float32Array[] | null; playhead: number; duration: number }) {
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
      g.fillStyle = LANE_COLORS[k]
      const per = Math.max(1, Math.floor(x.length / W))
      for (let px = 0; px < W; px++) {
        let mn = 0
        let mx = 0
        const s = px * per
        for (let i = s; i < Math.min(x.length, s + per); i++) {
          if (x[i] < mn) mn = x[i]
          if (x[i] > mx) mx = x[i]
        }
        const h = lane / 2 - 3
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
  }, [channels, playhead, duration, H])
  return <canvas ref={ref} className="wave" style={{ height: H }} />
}
