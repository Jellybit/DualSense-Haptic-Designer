// A second audio output for hearing the original sound on the PC (speakers/headset) while
// the haptics play on the controller. Separate from the haptic engine's AudioContext, which
// is opened on the controller's audio device.

import { SAMPLE_RATE } from './dsp'

let ctx: AudioContext | null = null
let ctxSink = ''
let opening: Promise<AudioContext> | null = null

/** The PC-sound AudioContext on `sinkId` ('' = system default), reopened when the sink changes. */
export function pcContext(sinkId: string): Promise<AudioContext> {
  if (ctx && ctxSink === sinkId && ctx.state !== 'closed') return Promise.resolve(ctx)
  if (opening) return opening.then(() => pcContext(sinkId))
  opening = (async () => {
    const old = ctx
    ctx = null
    if (old) void old.close().catch(() => {})
    const c = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    if (sinkId && 'setSinkId' in c) {
      try {
        await (c as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId)
      } catch {
        // the device went away; stay on the system default
      }
    }
    ctx = c
    ctxSink = sinkId
    return c
  })().finally(() => (opening = null))
  return opening
}

/** The open PC-sound context, if any (for resuming it on a user gesture). */
export function currentPcContext(): AudioContext | null {
  return ctx
}
