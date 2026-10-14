// Haptic clip timeline: compose L/R actuator waveforms from primitives, imported WAVs,
// and trigger-effect keyframes. Export as WAV (+ trigger JSON timeline).

import { platform } from '../../platform'
import { useEffect, useMemo, useRef, useState } from 'react'
import { hapticEngine } from '../../haptics/engine'
import { SAMPLE_RATE, type Material } from '../../haptics/dsp'
import { decodeWav, encodeWav, hapticChannels, resample, type WavLayout } from '../../export/wav'
import { encodeTrigger, EFFECT_LABELS } from '../../device/triggerEffects'
import { loadLocal, PressTracker, saveLocal, useConnection } from '../../store'
import { dualSense } from '../../device/hid'
import { Card, downloadName, Param, Select } from '../../ui/controls'
import { applyTrigger, releaseTriggers, triggerState } from '../triggers/TriggerPanel'
import { CLIP_PRESETS, newProject, renderProject, uid, type Clip, type ClipSource, type HapticProject, type TriggerKey } from './model'

const PX_PER_SEC_DEFAULT = 160
const PLAY_ID = 'timeline'
const MATERIALS: Material[] = ['wood', 'glass', 'metal', 'rubber', 'stone', 'soft']

export function ClipsPanel() {
  const [project, setProjectState] = useState<HapticProject>(() => loadLocal('dshd.project', newProject()))
  const [sel, setSel] = useState<string | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  const [pps, setPps] = useState(PX_PER_SEC_DEFAULT)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [msg, setMsg] = useState<string | null>(null)
  const info = useConnection()
  const playStart = useRef<{ ctxTime: number; from: number } | null>(null)
  const firedKeys = useRef(new Set<string>())

  const setProject = (p: HapticProject) => {
    setProjectState(p)
    saveLocal('dshd.project', p)
  }
  const updateClip = (id: string, patch: Partial<Clip>) => setProject({ ...project, clips: project.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  const updateSource = (id: string, patch: Partial<ClipSource>) =>
    setProject({ ...project, clips: project.clips.map((c) => (c.id === id ? { ...c, source: { ...c.source, ...patch } as ClipSource } : c)) })

  const rendered = useMemo(() => renderProject(project), [project])
  const selected = project.clips.find((c) => c.id === sel) ?? null
  const selectedKey = project.triggerKeys.find((k) => k.id === selKey) ?? null

  // Playback ------------------------------------------------------------------
  const play = (from = playhead) => {
    const off = Math.round(from * SAMPLE_RATE)
    hapticEngine.play(PLAY_ID, rendered.L, rendered.R, off, loop)
    playStart.current = { ctxTime: hapticEngine.ctx?.currentTime ?? 0, from }
    firedKeys.current = new Set(project.triggerKeys.filter((k) => k.time < from).map((k) => k.id))
    // apply the trigger state in effect at `from`
    for (const side of ['L', 'R'] as const) {
      const prior = project.triggerKeys.filter((k) => k.side === side && k.time <= from).sort((a, b) => b.time - a.time)[0]
      if (prior) void applyTrigger(side === 'L' ? 'L2' : 'R2', prior.effect)
    }
    setPlaying(true)
  }
  const stop = () => {
    hapticEngine.stopPlayback(PLAY_ID)
    playStart.current = null
    setPlaying(false)
  }

  useEffect(() => hapticEngine.onEnded((id) => id === PLAY_ID && (setPlaying(false), (playStart.current = null))) as unknown as () => void, [])

  // Leaving the composer stops the clip and releases any trigger keyframe effects
  useEffect(
    () => () => {
      hapticEngine.stopPlayback(PLAY_ID)
      void releaseTriggers()
    },
    [],
  )

  // Any face button plays the clip from the start (the composer has only a vibration track)
  const playRef = useRef(play)
  playRef.current = play
  useEffect(() => {
    const presses = new PressTracker()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const b = dualSense.state.buttons
      let pressed = false
      for (const name of ['cross', 'circle', 'square', 'triangle'] as const) if (presses.pressed(name, b[name])) pressed = true
      if (pressed) playRef.current(0)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  // Re-render while playing → restart from the current position so edits are heard
  useEffect(() => {
    if (playing) play(playhead)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const pos = hapticEngine.positions[PLAY_ID]
      if (pos === undefined) return
      const t = pos / SAMPLE_RATE
      setPlayhead(t)
      // trigger keyframes
      for (const k of project.triggerKeys) {
        if (k.time <= t && !firedKeys.current.has(k.id)) {
          firedKeys.current.add(k.id)
          void applyTrigger(k.side === 'L' ? 'L2' : 'R2', k.effect)
        }
      }
      if (loop && t < 0.05) firedKeys.current.clear()
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [playing, project.triggerKeys, loop])

  // Space = play/stop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
      if (e.code === 'Space') {
        e.preventDefault()
        if (playing) stop()
        else play()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        setProject({ ...project, clips: project.clips.filter((c) => c.id !== sel) })
        setSel(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selKey) {
        setProject({ ...project, triggerKeys: project.triggerKeys.filter((k) => k.id !== selKey) })
        setSelKey(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Editing helpers ------------------------------------------------------------
  const addPreset = (i: number) => {
    const base = CLIP_PRESETS[i].make()
    const track = selected?.track ?? 0
    const clip: Clip = { ...base, id: uid(), track, start: Math.round(playhead * 100) / 100 }
    const duration = Math.max(project.duration, clip.start + clip.duration)
    setProject({ ...project, duration, clips: [...project.clips, clip] })
    setSel(clip.id)
  }

  const importWav = async () => {
    const f = await platform.openFile([{ name: 'WAV audio', extensions: ['wav'] }])
    if (!f) return
    try {
      const a = decodeWav(f.data)
      const { L, R } = hapticChannels(a)
      const l = resample(L, a.sampleRate, SAMPLE_RATE)
      const r = resample(R, a.sampleRate, SAMPLE_RATE)
      const clip: Clip = {
        id: uid(),
        name: f.name.replace(/\.wav$/i, ''),
        track: selected?.track ?? 0,
        start: Math.round(playhead * 100) / 100,
        duration: l.length / SAMPLE_RATE,
        gain: 1,
        attack: 0,
        release: 0,
        panStart: 0,
        panEnd: 0,
        source: { kind: 'sample', name: f.name, L: Array.from(l, (v) => Math.round(v * 10000) / 10000), R: Array.from(r, (v) => Math.round(v * 10000) / 10000) },
      }
      setProject({ ...project, duration: Math.max(project.duration, clip.start + clip.duration), clips: [...project.clips, clip] })
      setSel(clip.id)
      setMsg(`Imported ${f.name}: ${a.channels.length} ch @ ${a.sampleRate} Hz${a.channels.length >= 4 ? ' (used ch 3/4)' : ''}`)
    } catch (e) {
      setMsg(`WAV import failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const exportWav = async (layout: WavLayout) => {
    const bytes = encodeWav(rendered.L, rendered.R, SAMPLE_RATE, layout)
    const path = await platform.saveFile(downloadName(`${project.name}${layout === 'quad' ? '-4ch' : ''}`, 'wav'), [{ name: 'WAV', extensions: ['wav'] }], bytes)
    if (!path) return
    let extra = ''
    if (project.triggerKeys.length) {
      const timeline = {
        format: 'dualsense-trigger-timeline',
        version: 1,
        wav: path.split(/[\\/]/).pop(),
        keys: [...project.triggerKeys]
          .sort((a, b) => a.time - b.time)
          .map((k) => ({ time: Math.round(k.time * 1000) / 1000, trigger: k.side === 'L' ? 'L2' : 'R2', effect: k.effect, raw: encodeTrigger(k.effect) })),
      }
      const tpath = path.replace(/\.wav$/i, '') + '.triggers.json'
      const saved = await platform.saveFile(tpath.split(/[\\/]/).pop()!, [{ name: 'JSON', extensions: ['json'] }], JSON.stringify(timeline, null, 2))
      if (saved) extra = ` + ${saved}`
    }
    setMsg(`Exported ${path}${extra}`)
  }

  const saveProject = async () => {
    const path = await platform.saveFile(downloadName(project.name, 'dshd.json'), [{ name: 'Haptic project', extensions: ['json'] }], JSON.stringify(project))
    if (path) setMsg(`Saved ${path}`)
  }
  const openProject = async () => {
    const f = await platform.openFile([{ name: 'Haptic project', extensions: ['json'] }])
    if (!f) return
    try {
      const p = JSON.parse(new TextDecoder().decode(f.data)) as HapticProject
      if (p.version !== 1 || !Array.isArray(p.clips)) throw new Error('not a haptic project')
      stop()
      setProject(p)
      setSel(null)
    } catch (e) {
      setMsg(`Open failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const addTriggerKey = (side: 'L' | 'R') => {
    const effect = triggerState[side === 'L' ? 'L2' : 'R2']
    const k: TriggerKey = { id: uid(), time: Math.round(playhead * 100) / 100, side, effect }
    setProject({ ...project, triggerKeys: [...project.triggerKeys, k] })
    setSelKey(k.id)
    setSel(null)
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={playing ? 'active' : 'primary'} onClick={() => (playing ? stop() : play())}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
        <button onClick={() => { stop(); setPlayhead(0) }}>⏮</button>
        <label className="row">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
        </label>
        <span className="mono">{playhead.toFixed(2)}s</span>
        <input type="text" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} style={{ width: 180 }} />
        <span className="muted">Length</span>
        <input type="number" step={0.5} min={0.1} value={project.duration} onChange={(e) => setProject({ ...project, duration: Math.max(0.1, Number(e.target.value)) })} />
        <span className="muted">Zoom</span>
        <input type="range" min={40} max={600} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
        <div className="spacer" />
        <button onClick={() => void openProject()}>Open…</button>
        <button onClick={() => void saveProject()}>Save…</button>
        <button onClick={() => { if (confirm('Clear the current project?')) { stop(); setProject(newProject()); setSel(null) } }}>New</button>
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted">Add:</span>
        {CLIP_PRESETS.map((p, i) => (
          <button key={p.name} onClick={() => addPreset(i)}>
            {p.name}
          </button>
        ))}
        <button onClick={() => void importWav()}>WAV…</button>
        <span className="muted" style={{ marginLeft: 8 }}>Trigger key at playhead:</span>
        <button onClick={() => addTriggerKey('L')} title="Uses the current L2 effect from the Adaptive Triggers tab">+L2</button>
        <button onClick={() => addTriggerKey('R')} title="Uses the current R2 effect from the Adaptive Triggers tab">+R2</button>
      </div>

      <Timeline
        project={project}
        pps={pps}
        playhead={playhead}
        sel={sel}
        selKey={selKey}
        onSeek={(t) => {
          setPlayhead(t)
          if (playing) play(t)
        }}
        onSelect={(id) => { setSel(id); setSelKey(null) }}
        onSelectKey={(id) => { setSelKey(id); setSel(null) }}
        onMove={(id, start, track) => updateClip(id, { start, track })}
        onResize={(id, duration) => updateClip(id, { duration })}
        onMoveKey={(id, time) => setProject({ ...project, triggerKeys: project.triggerKeys.map((k) => (k.id === id ? { ...k, time } : k)) })}
        onTrack={(i, patch) => setProject({ ...project, tracks: project.tracks.map((t, j) => (j === i ? { ...t, ...patch } : t)) })}
        onAddTrack={() => setProject({ ...project, tracks: [...project.tracks, { name: `Track ${project.tracks.length + 1}`, mute: false, solo: false }] })}
      />

      <Waveform L={rendered.L} R={rendered.R} playhead={playhead} duration={project.duration} />

      <div className="row" style={{ margin: '10px 0' }}>
        <button className="primary" onClick={() => void exportWav('stereo')}>Export WAV (stereo L/R)</button>
        <button onClick={() => void exportWav('quad')}>Export WAV (4-ch, haptics on 3/4)</button>
        {msg && <span className="muted small">{msg}</span>}
      </div>

      {selected && <ClipInspector clip={selected} onChange={(p) => updateClip(selected.id, p)} onSource={(p) => updateSource(selected.id, p)} onDelete={() => { setProject({ ...project, clips: project.clips.filter((c) => c.id !== selected.id) }); setSel(null) }} onDuplicate={() => { const c = { ...structuredClone(selected), id: uid(), start: selected.start + selected.duration }; setProject({ ...project, duration: Math.max(project.duration, c.start + c.duration), clips: [...project.clips, c] }); setSel(c.id) }} />}
      {selectedKey && (
        <Card title={`Trigger key · ${selectedKey.side}2`} right={<button className="danger" onClick={() => { setProject({ ...project, triggerKeys: project.triggerKeys.filter((k) => k.id !== selectedKey.id) }); setSelKey(null) }}>Delete</button>}>
          <div className="row">
            <span className="muted">Time</span>
            <input type="number" step={0.01} value={selectedKey.time} onChange={(e) => setProject({ ...project, triggerKeys: project.triggerKeys.map((k) => (k.id === selectedKey.id ? { ...k, time: Math.max(0, Number(e.target.value)) } : k)) })} />
            <span>{EFFECT_LABELS[selectedKey.effect.type]}</span>
            <button onClick={() => setProject({ ...project, triggerKeys: project.triggerKeys.map((k) => (k.id === selectedKey.id ? { ...k, effect: triggerState[k.side === 'L' ? 'L2' : 'R2'] } : k)) })}>
              Replace with current {selectedKey.side}2 effect
            </button>
            {!info && <span className="muted small">(connect a controller to feel trigger keys during playback)</span>}
          </div>
        </Card>
      )}
      {!selected && !selectedKey && (
        <p className="muted small">
          Click a clip to edit it. Drag clips to move (across tracks too), drag the right edge to resize. <kbd>Space</kbd> plays/stops, any face button on the controller plays from the start, <kbd>Del</kbd> deletes. Pan −1 = left
          grip, +1 = right grip — sweeping pan across a clip makes the sensation travel through the controller.
        </p>
      )}
    </>
  )
}

function Timeline(props: {
  project: HapticProject
  pps: number
  playhead: number
  sel: string | null
  selKey: string | null
  onSeek: (t: number) => void
  onSelect: (id: string) => void
  onSelectKey: (id: string) => void
  onMove: (id: string, start: number, track: number) => void
  onResize: (id: string, duration: number) => void
  onMoveKey: (id: string, time: number) => void
  onTrack: (i: number, patch: Partial<HapticProject['tracks'][number]>) => void
  onAddTrack: () => void
}) {
  const { project, pps } = props
  const width = project.duration * pps
  const lanesRef = useRef<HTMLDivElement>(null)

  const drag = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'resize') => {
    e.stopPropagation()
    props.onSelect(clip.id)
    const x0 = e.clientX
    const y0 = e.clientY
    const s0 = clip.start
    const d0 = clip.duration
    const t0 = clip.track
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pps
      const snap = (v: number) => (ev.shiftKey ? v : Math.round(v * 20) / 20)
      if (mode === 'move') {
        const dTrack = Math.round((ev.clientY - y0) / 48)
        const track = Math.max(0, Math.min(project.tracks.length - 1, t0 + dTrack))
        props.onMove(clip.id, Math.max(0, snap(s0 + dt)), track)
      } else {
        props.onResize(clip.id, Math.max(0.02, snap(d0 + dt)))
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragKey = (e: React.PointerEvent, k: TriggerKey) => {
    e.stopPropagation()
    props.onSelectKey(k.id)
    const x0 = e.clientX
    const t0 = k.time
    const move = (ev: PointerEvent) => props.onMoveKey(k.id, Math.max(0, Math.round((t0 + (ev.clientX - x0) / pps) * 100) / 100))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const seekFrom = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    props.onSeek(Math.max(0, Math.min(project.duration, (e.clientX - r.left) / pps)))
  }

  const step = pps > 300 ? 0.1 : pps > 120 ? 0.25 : 0.5
  const ticks = []
  for (let t = 0; t <= project.duration + 1e-6; t += step) ticks.push(t)

  return (
    <div className="timeline" style={{ overflowX: 'auto' }}>
      <div style={{ width: width + 120, position: 'relative' }}>
        <div className="tl-ruler" style={{ width }} onMouseDown={seekFrom}>
          {ticks.map((t) => (
            <div key={t} className="tl-tick" style={{ left: t * pps }}>
              {Math.abs(t - Math.round(t)) < 1e-6 ? `${Math.round(t)}s` : ''}
            </div>
          ))}
        </div>
        <div ref={lanesRef}>
          {project.tracks.map((tr, i) => (
            <div className="tl-track" key={i}>
              <div className="tl-head">
                <input type="text" value={tr.name} onChange={(e) => props.onTrack(i, { name: e.target.value })} style={{ width: '100%', padding: '1px 4px' }} />
                <div className="row" style={{ gap: 4 }}>
                  <button className={tr.mute ? 'active' : ''} onClick={() => props.onTrack(i, { mute: !tr.mute })}>M</button>
                  <button className={tr.solo ? 'active' : ''} onClick={() => props.onTrack(i, { solo: !tr.solo })}>S</button>
                </div>
              </div>
              <div className="tl-lane" style={{ width }} onMouseDown={seekFrom}>
                {project.clips
                  .filter((c) => c.track === i)
                  .map((c) => (
                    <div
                      key={c.id}
                      className={`tl-clip ${props.sel === c.id ? 'sel' : ''}`}
                      style={{ left: c.start * pps, width: Math.max(6, c.duration * pps), background: panColor(c) }}
                      onPointerDown={(e) => drag(e, c, 'move')}
                      onMouseDown={(e) => e.stopPropagation()}
                      title={`${c.name} · ${c.duration.toFixed(2)}s`}
                    >
                      {c.name}
                      <div className="grip" onPointerDown={(e) => drag(e, c, 'resize')} />
                    </div>
                  ))}
              </div>
            </div>
          ))}
          <div className="tl-track" style={{ height: 26 }}>
            <div className="tl-head small muted">Triggers</div>
            <div className="tl-lane" style={{ width }} onMouseDown={seekFrom}>
              {project.triggerKeys.map((k) => (
                <div
                  key={k.id}
                  className={`tl-key ${props.selKey === k.id ? 'sel' : ''}`}
                  style={{ left: k.time * pps, background: k.side === 'L' ? 'var(--left)' : 'var(--right)' }}
                  title={`${k.side}2 → ${EFFECT_LABELS[k.effect.type]} @ ${k.time}s`}
                  onPointerDown={(e) => dragKey(e, k)}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="tl-playhead" style={{ left: 120 + props.playhead * pps }} />
      </div>
      <div style={{ padding: 6 }}>
        <button className="small" onClick={props.onAddTrack}>+ Track</button>
      </div>
    </div>
  )
}

/** Clip colour shows its pan: blue = left grip, pink = right grip. */
function panColor(c: Clip) {
  const p = (c.panStart + c.panEnd) / 2
  const l = [52, 100, 180]
  const r = [180, 70, 120]
  const t = (p + 1) / 2
  const mix = l.map((v, i) => Math.round(v + (r[i] - v) * t))
  return `linear-gradient(90deg, rgb(${l.map((v, i) => Math.round(v + (r[i] - v) * ((c.panStart + 1) / 2))).join(',')}), rgb(${l.map((v, i) => Math.round(v + (r[i] - v) * ((c.panEnd + 1) / 2))).join(',')})), rgb(${mix.join(',')})`
}

export function Waveform({ L, R, playhead, duration }: { L: Float32Array; R: Float32Array; playhead: number; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    const W = c.clientWidth
    const H = 110
    c.width = W * dpr
    c.height = H * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    const drawCh = (x: Float32Array, y0: number, h: number, color: string) => {
      g.fillStyle = color
      const per = Math.max(1, Math.floor(x.length / W))
      for (let px = 0; px < W; px++) {
        let mn = 0
        let mx = 0
        const s = px * per
        for (let i = s; i < Math.min(x.length, s + per); i++) {
          if (x[i] < mn) mn = x[i]
          if (x[i] > mx) mx = x[i]
        }
        g.fillRect(px, y0 + h / 2 - mx * (h / 2), 1, Math.max(1, (mx - mn) * (h / 2)))
      }
    }
    drawCh(L, 2, H / 2 - 4, '#5aa9ff')
    drawCh(R, H / 2 + 2, H / 2 - 4, '#ff7a9c')
    g.fillStyle = '#8b91a1'
    g.font = '10px Segoe UI'
    g.fillText('L actuator', 4, 12)
    g.fillText('R actuator', 4, H / 2 + 12)
    const x = (playhead / duration) * W
    g.fillStyle = '#3ad6a8'
    g.fillRect(x, 0, 2, H)
  }, [L, R, playhead, duration])
  return <canvas ref={ref} className="wave" style={{ height: 110, marginTop: 10 }} />
}

function ClipInspector({ clip, onChange, onSource, onDelete, onDuplicate }: { clip: Clip; onChange: (p: Partial<Clip>) => void; onSource: (p: Partial<ClipSource>) => void; onDelete: () => void; onDuplicate: () => void }) {
  const s = clip.source
  const hz = (v: number) => `${Math.round(v)} Hz`
  return (
    <Card
      title={`Clip · ${clip.name}`}
      right={
        <>
          <button onClick={onDuplicate}>Duplicate</button>
          <button className="danger" onClick={onDelete}>Delete</button>
        </>
      }
    >
      <div className="grid2">
        <div>
          <div className="param">
            <label>Name</label>
            <input type="text" value={clip.name} onChange={(e) => onChange({ name: e.target.value })} />
            <span />
          </div>
          <Param label="Start (s)" value={clip.start} min={0} max={30} step={0.01} onChange={(v) => onChange({ start: v })} format={(v) => v.toFixed(2)} />
          <Param label="Duration (s)" value={clip.duration} min={0.02} max={10} step={0.01} onChange={(v) => onChange({ duration: v })} format={(v) => v.toFixed(2)} />
          <Param label="Gain" value={clip.gain} min={0} max={1.5} step={0.01} onChange={(v) => onChange({ gain: v })} format={(v) => v.toFixed(2)} />
          <Param label="Attack (s)" value={clip.attack} min={0} max={2} step={0.01} onChange={(v) => onChange({ attack: v })} format={(v) => v.toFixed(2)} />
          <Param label="Release (s)" value={clip.release} min={0} max={2} step={0.01} onChange={(v) => onChange({ release: v })} format={(v) => v.toFixed(2)} />
          <Param label="Pan start (L↔R)" value={clip.panStart} min={-1} max={1} step={0.05} onChange={(v) => onChange({ panStart: v })} format={(v) => v.toFixed(2)} />
          <Param label="Pan end (L↔R)" value={clip.panEnd} min={-1} max={1} step={0.05} onChange={(v) => onChange({ panEnd: v })} format={(v) => v.toFixed(2)} />
        </div>
        <div>
          <div className="param">
            <label>Source</label>
            <span>{s.kind}</span>
            <span />
          </div>
          {s.kind === 'tone' && (
            <>
              <Select label="Waveform" value={s.wave} options={['sine', 'square', 'triangle', 'saw'] as const} onChange={(v) => onSource({ wave: v })} />
              <Param label="Freq start" value={s.freqStart} min={10} max={1000} onChange={(v) => onSource({ freqStart: v })} format={hz} />
              <Param label="Freq end" value={s.freqEnd} min={10} max={1000} onChange={(v) => onSource({ freqEnd: v })} format={hz} />
              <Param label="Pulse rate" value={s.amRate} min={0} max={60} step={0.5} onChange={(v) => onSource({ amRate: v })} format={hz} />
              <Param label="Pulse depth" value={s.amDepth} min={0} max={1} step={0.05} onChange={(v) => onSource({ amDepth: v })} format={(v) => v.toFixed(2)} />
            </>
          )}
          {s.kind === 'noise' && (
            <>
              <Param label="Band start" value={s.freqStart} min={20} max={1000} onChange={(v) => onSource({ freqStart: v })} format={hz} />
              <Param label="Band end" value={s.freqEnd} min={20} max={1000} onChange={(v) => onSource({ freqEnd: v })} format={hz} />
              <Param label="Band Q" value={s.q} min={0.3} max={10} step={0.1} onChange={(v) => onSource({ q: v })} format={(v) => v.toFixed(1)} />
              <Param label="Grain rate" value={s.amRate} min={0} max={60} step={0.5} onChange={(v) => onSource({ amRate: v })} format={hz} />
              <Param label="Grain depth" value={s.amDepth} min={0} max={1} step={0.05} onChange={(v) => onSource({ amDepth: v })} format={(v) => v.toFixed(2)} />
            </>
          )}
          {s.kind === 'pulses' && (
            <>
              <Select label="Pulse" value={s.grain} options={['tap', 'thump', 'impact'] as const} onChange={(v) => onSource({ grain: v })} />
              {s.grain === 'impact' && <Select label="Material" value={s.material} options={MATERIALS} onChange={(v) => onSource({ material: v })} />}
              <Param label="Rate start (/s)" value={s.rateStart} min={0.2} max={80} step={0.1} onChange={(v) => onSource({ rateStart: v })} format={(v) => v.toFixed(1)} />
              <Param label="Rate end (/s)" value={s.rateEnd} min={0.2} max={80} step={0.1} onChange={(v) => onSource({ rateEnd: v })} format={(v) => v.toFixed(1)} />
              <Param label="Timing jitter" value={s.jitter} min={0} max={1} step={0.05} onChange={(v) => onSource({ jitter: v })} format={(v) => v.toFixed(2)} />
              <Param label="Pan spread" value={s.spread} min={0} max={1} step={0.05} onChange={(v) => onSource({ spread: v })} format={(v) => v.toFixed(2)} />
              <Param label="Pitch" value={s.pitch} min={0.3} max={3} step={0.05} onChange={(v) => onSource({ pitch: v })} format={(v) => `×${v.toFixed(2)}`} />
              <label className="row small">
                <input type="checkbox" checked={s.doublet} onChange={(e) => onSource({ doublet: e.target.checked })} /> Doublet (lub-dub)
              </label>
            </>
          )}
          {s.kind === 'sample' && <p className="muted small">Imported audio: {s.name} ({(s.L.length / SAMPLE_RATE).toFixed(2)} s). Pan acts as L/R balance.</p>}
        </div>
      </div>
    </Card>
  )
}
