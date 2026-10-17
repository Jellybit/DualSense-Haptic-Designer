# DualSense Haptic Designer

A workbench for designing PlayStation 5 DualSense feedback, and for learning how the
controller actually works.

It's made for **game developers** and for anyone **adding DualSense support to another
project** (an engine, an emulator, a mod, a library). You can:

- turn any sound into grip-motor vibration and feel it immediately,
- design adaptive-trigger resistance and vibration on a graph and feel it live,
- see the real controller mirrored on a 3D model (buttons, sticks, triggers, motion),
- export WAV files and trigger bytes ready to drop into your own code.

Along the way it shows the raw bytes and channel layouts involved, so it doubles as a
hands-on reference for the DualSense's haptics, triggers and inputs.

It runs **as a desktop app** (Windows, including a standalone `.exe`) **or in a browser**
(Chrome or Edge).

---

## Contents

- [Quick start](#quick-start)
- [Running it](#running-it): standalone exe, desktop app from source, web server
- [Building the standalone exe](#building-the-standalone-exe)
- [Connecting the controller](#connecting-the-controller)
- [Tour of the app](#tour-of-the-app)
- [What you'll learn about the DualSense](#what-youll-learn-about-the-dualsense)
- [Export formats and using them in a game](#export-formats-and-using-them-in-a-game)
- [Running in a browser: limits](#running-in-a-browser-limits)
- [3D model and credits](#3d-model-and-credits)
- [Development](#development)
- [References](#references)

---

## Quick start

1. Plug the DualSense into the PC **with a USB cable** (full haptics need USB).
2. Start the app (the standalone exe, or one of the batch files below).
3. Click **Connect DualSense** (top right).
4. On **Haptics & Triggers**, drop a sound file (WAV, MP3, OGG, FLAC) onto the page.
5. Press **✕** on the controller to feel it in the grips.

---

## Running it

### Standalone exe (no install, no Node.js)

Double-click **`DualSense Haptic Designer 0.1.0.exe`**. That's the whole app in one file;
nothing else is needed on the PC. See [Building the standalone exe](#building-the-standalone-exe)
to make one.

- The exe isn't code-signed, so the first time Windows SmartScreen may say *"Windows
  protected your PC"*. Click **More info → Run anyway**.
- The single-file exe unpacks itself to a temporary folder on each launch, so it takes a few
  seconds to start. The folder build (below) starts instantly.

### Desktop app from source

Needs [Node.js](https://nodejs.org) (LTS).

**Easiest:** double-click **`Run DualSense Haptic Designer.bat`**. It installs dependencies
the first time, builds, and starts the app. Closing its window closes the app.

Or from a terminal:

```
npm install      # once
npm start        # build and run the desktop app
npm run dev      # development mode with hot reload
```

**`Run Trigger Calibration.bat`** opens the app straight into the trigger calibration wizard
(see [Trigger calibration](#trigger-calibration)).

### Web server (run it in a browser)

Needs Node.js, plus **Chrome or Edge** to use it.

**Easiest:** double-click **`Run DualSense Haptic Designer (browser).bat`**. It builds the
web version, starts a local server at **http://localhost:5174** and opens it in Chrome (or
Edge). If the server is already running, it just opens another tab. Closing its window stops
the server.

Or from a terminal:

```
npm install          # once
npm run web:build    # build the web version into out/web/
npm run web:preview  # serve out/web/ at http://localhost:5174
npm run web          # or: development server with hot reload, same address
```

`out/web/` is a plain static site, so you can also host it yourself. It must be served from
`localhost` or over **https**, because browsers only allow controller (WebHID) and
audio-output access on secure pages. See [the browser's limits](#running-in-a-browser-limits).

---

## Building the standalone exe

The packaged app **doesn't need `node_modules`**. The interface (React, three.js and the
app code) is compiled into a few bundled files, and the desktop shell only uses Electron and
Node's built-ins. The exe contains just the Electron runtime, about 1.7 MB of app code and the
3D model.

You need Node.js and the project's dependencies **on the build machine only**:

```
npm install         # once
npm run dist        # → dist/DualSense Haptic Designer 0.1.0.exe   (single portable file, ~78 MB)
npm run dist:dir    # → dist/win-unpacked/DualSense Haptic Designer.exe   (folder, ~275 MB, starts instantly)
```

- Copy the single exe (or the whole `win-unpacked` folder) to any Windows PC and run it.
- The first build downloads electron-builder's packaging tools; later builds reuse them.
- Packaging settings live in the `build` section of `package.json`. Code signing and editing
  the exe's resources are turned off (`signAndEditExecutable: false`). That avoids needing a
  certificate, and avoids a Windows permissions error while unpacking the signing tools. As a
  result the exe uses Electron's default icon.

---

## Connecting the controller

| Connection | What works |
|---|---|
| **USB** (recommended) | Everything: buttons, sticks, motion, touchpad, lightbar, **adaptive triggers**, and **audio haptics** through the controller's 4-channel USB audio device. |
| **Bluetooth** | Input, motion, triggers and lightbar. There's no audio device over Bluetooth; an **experimental** BT haptics stream (HID report `0x32`) can be switched on with **BT haptics** in the top bar. |

On the desktop app the controller's audio device is selected automatically. In a browser,
click **Connect to Controller Vibration** (in Sound → Grip motors) once and allow the prompt.

The coloured dot next to the audio menu is **green** when vibration goes to the grip motors,
**orange** when it's playing on ordinary speakers instead.

---

## Tour of the app

### Haptics & Triggers (the main workflow)

**Sound → Grip motors**

1. **Load or drop a sound** (WAV, MP3, OGG, FLAC, M4A). The last sound you loaded comes back
   next time.
2. **Shape each grip motor** with its own EQ: a 10-band graphic EQ, low/high cut and gain, with
   a live spectrum. By default the left motor takes the file's left channel and the right motor
   its right channel. A mono file feeds both, and the two EQs can split it (the low boom on one
   motor, the crackle on the other). A 4-channel file starts from its own channels 3/4.
   **Audio Play** on a motor card plays just that motor's signal (its channel and EQ) on the PC
   output, so you can hear what it gets. If a motor's signal goes past the top of the range, a red
   **Clips** warning appears next to its Gain, and its graph marks the frequencies doing it in red
   while it plays. Clipping is safe for the controller, but it flattens the strongest moments.
3. **Play it.** The **▶ Play** button plays whatever the menu next to it says: *PC Audio Only*,
   *Vibration Only*, *Vibration + PC Audio*, *Vibration + Controller Audio* or *Controller Audio
   Only*. Or use the controller's face buttons:

   | Button | Plays |
   |---|---|
   | ✕ | vibration only |
   | ○ | controller speaker + vibration |
   | △ | PC audio only |
   | □ | PC audio + vibration |

   The speaker and PC always play the **original, unedited** sound; only the motors get the EQs.
   *Play From Start / Play When Held* applies to the buttons and face buttons. **PC sound**
   picks the output for "PC audio".
4. **Vibration Power** scales the motors (and the exports). **Normalize Vibration** instead
   raises the vibration so its loudest point is full power. It uses one shared gain for both
   motors, so their balance is kept, and each motor's EQ gain applies after it. The waveform
   and spectra show what the motors really get, with clipping in red.
5. **Export** a 4-channel WAV or a haptics-only (stereo) WAV (see [Export formats](#export-formats-and-using-them-in-a-game)).
   Both hold vibration signals for the motors, not sound to listen to.

**Trigger force feedback**

Each trigger has two dropdowns:

- **Off**
- **Force:** **Custom** (draw the resistance yourself), **Weapon**, **Bow**
- **Vibration:** **Custom** (draw the vibration strength; frequency is set per point),
  **Galloping**, **Machine**
- **Raw bytes:** type the 11 bytes directly, for experiments.

In **Custom**, click the graph to add a point, drag to move it (points can't pass their
neighbours), and select a point then press **Delete** to remove it. The blue blocks (force) or
the jagged yellow line (vibration) show exactly what each of the 10 zones receives. The green
line is your trigger's live position. **Export trigger JSON** saves both triggers for your
game.

Effects only apply while this tab is open; switching tabs releases the triggers.

#### Trigger calibration

The trigger's effect zones are positions of the trigger **motor**, not percentages of the
trigger **reading**, so a graph that assumes "zone 3 = 30%" is wrong. **Calibrate travel…**
runs a *wall test*. The app places a solid wall at a hidden zone; you ease a trigger in until
you feel it and hold still; repeat for a while. A straight line fitted through your holds maps
zones to real travel, separately for L2 and R2. After that, every graph and label shows where
effects are actually felt.

### Experiments

Toys that aren't part of the export workflow but show what the haptics can do:

- **Interactive scenes:** marbles, critters and a particle liquid "inside" the controller.
  Tilt moves them; collisions, rolling and footsteps become vibration, panned left/right by
  position and louder toward the bottom wall (softer toward the top), so you can feel where
  things are. Critters wander, stop, investigate, greet each other and dodge marbles. A quick
  lift of the controller tosses everything into the air.
- **Haptic clip composer:** a multi-track timeline of synthesized haptic clips (heartbeat,
  footsteps, explosion…) and imported sounds (drop a file onto a track), with trigger
  keyframes. The length follows the clips, **Normalize** brings the mix's loudest point to full
  strength, and any face button plays it.

### Controller & Model

Live readout of every input, IMU axis setup, lightbar and player LEDs, haptics tests (with a
**Delay Vibration** countdown so you have time to pick the controller up), and loading and
mapping a 3D model.

**Recenter** the 3D view with the on-screen button or **Options, Create, L3 or R3** on the
controller. The model then faces the camera squarely and follows your movements from there.
(The PS button is left alone because Steam often uses it.)

**Reset All** (top bar) and the **Reset … Settings** buttons in each section put settings back
to defaults. They never touch your trigger calibration, the 3D model setup or your audio
devices.

---

## What you'll learn about the DualSense

These are the details the app is built on. Several were measured on real hardware while
building it.

**Audio and haptics (USB)**

- Over USB the DualSense is a **4-channel, 48 kHz audio device**.
  **Channels 3 and 4 drive the left and right grip motors** (voice-coil actuators): haptics are
  just audio. **Channels 1 and 2** are the headphone jack / built-in speaker.
- Channels 1/2 go to the **headphone jack by default**. To hear the **built-in speaker**, the
  host switches the audio path with an output report (audio flags byte = output path 3, speaker
  volume 0x64, preamp gain 2). The speaker is **mono and plays only channel 2**, so send a mix
  of both channels there.
- A plain stereo file sent to the controller plays on the headphone/speaker channels, **not**
  the motors. That's why the 4-channel export exists.

**Adaptive triggers**

- Each trigger takes **11 bytes**: a mode byte plus parameters, inside output report `0x02`
  (USB) or `0x31` (Bluetooth, with CRC32).
- The zone-based modes split the travel into **10 zones**, with a **strength of 0–8 per
  zone**. Every curve ends up as those 10 steps.
- Zone **vibration** has an amplitude per zone but **one frequency for the whole effect**. The
  app follows a per-point frequency by re-sending the effect whenever the trigger enters a zone
  with a different frequency.
- **Weapon** and **Bow** snap at the **end** of their end zone. A Weapon's resistance starts at
  the end of its start zone, and the firmware ignores a Weapon that starts before zone 2.
- The zone positions aren't evenly spread along the trigger reading, and L2 and R2 differ near
  full pull, hence the calibration wizard.

**Input and motion**

- Buttons, sticks, triggers, touchpad and IMU come from input report `0x01` (USB) / `0x31` (BT).
- The IMU is calibrated with feature report `0x05`, and orientation is fused from gyro and
  accelerometer (Madgwick filter).

The **bytes line** under each trigger graph, the exported JSON and the **Raw bytes** mode let
you see and try all of this directly.

---

## Export formats and using them in a game

| Export | Contents | How to use it |
|---|---|---|
| **DualSense 4-ch WAV** (Haptics & Triggers) | 48 kHz 16-bit; ch 3/4 = left/right grip motors, ch 1/2 silent | Plays as-is on the controller's USB audio device. Play it on that device and it vibrates. |
| **Haptics-only WAV** (Haptics & Triggers) | 48 kHz 16-bit; ch 1 = left motor, ch 2 = right motor. A **haptic** signal, not sound: it's meant to be felt through the grip motors, not heard. | For engines/middleware that route haptics to the motors themselves (e.g. as a haptics asset). Route it to the motors, not to an audio output. |
| **Clip composer WAV** (stereo) | the timeline's left/right actuators. Also a **haptic** signal, not sound. | Same as the haptics-only WAV. |
| **Trigger JSON** (`*.triggers.json`) | `{ format: "dualsense-trigger-presets", presets: [{ name, trigger, effect, raw }] }` | `raw` is the 11 bytes to copy into the trigger block of the output report. USB report `0x02`, counting the report ID: bytes 11–21 = R2, 22–32 = L2. `effect` lets the app reopen it for editing. |
| **Trigger timeline** (next to a clip WAV) | `{ keys: [{ time, trigger, effect, raw }] }` | Send each `raw` at its `time`. |
| **Scenes / clip projects** | `*.scene.json`, `*.dshd.json` | Reopen in the app. |

**Vibration curves with per-point frequency** also carry `zoneFrequencies` (10 values, Hz).
The controller takes one frequency per effect, so to follow the curve, re-send `raw` with
**byte 9** set to the frequency of the zone the trigger is in, whenever that zone changes. The
app does exactly this live.

---

## Running in a browser: limits

- **Chrome or Edge only.** Firefox and Safari have no WebHID, so the controller can't connect.
- Serve it from `localhost` or **https**. WebHID and audio-output selection are blocked on
  plain http and `file://`.
- **Connect DualSense** opens the browser's own device chooser. Pick the controller there.
- The browser hides audio device names until you allow a permission, so click **Connect to
  Controller Vibration** once (Chrome may ask for microphone access; nothing is recorded).
- Browsers keep new audio outputs paused until you click or press a key on the page. If PC
  audio is silent at first, click anywhere once.
- Saving uses a save dialog where supported, otherwise a normal download.
- A 3D model you load yourself isn't remembered between visits (the bundled one always loads).
- Bluetooth haptics streaming is untested in the browser.

---

## 3D model and credits

The app loads `assets/models/dualsense.glb`, or your own model via **Load model…** (`.glb`
recommended; `.gltf` and `.dae` also work). Parts move in the controller frame (+x right, +y
out of the face, +z toward you). Meshes containing several separate pieces are split
automatically, and parts can be mapped by clicking them in the 3D view (**Pick**, with
<kbd>Shift</kbd>+click for extra parts that move together).

The bundled model is recognised automatically, with its parts found by position:

> **"Playstation 5 Dualsense"** by [AHarmlessPotato](https://sketchfab.com/AHarmlessPotato) on
> [Sketchfab](https://sketchfab.com/3d-models/playstation-5-dualsense-878c1f882808477ab81c2fe86d5a3936),
> licensed [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).

Keep this credit if you redistribute the model.

---

## Development

```
npm test             # unit tests (protocol, trigger curves, calibration, DSP, physics, WAV)
npm run typecheck    # TypeScript
```

Electron + TypeScript + React + three.js, built with electron-vite (desktop) and Vite (web).

| Path | What's there |
|---|---|
| `src/main/` | Electron main process: window, file dialogs, HID/audio permissions |
| `src/preload/` | the file API exposed to the page |
| `src/renderer/src/device/` | WebHID input/output reports, trigger effect encoding, calibration maths |
| `src/renderer/src/haptics/` | audio engine (controller audio device, channel routing), EQ, synth, PC audio |
| `src/renderer/src/designer/` | the tabs: workbench, triggers, scenes, clip composer, controller |
| `src/renderer/src/viewer/` | the 3D view, part splitting and rig mapping |
| `src/renderer/src/platform.ts` | desktop vs browser file access |
| `tests/` | Vitest unit tests |

> `scripts/run.mjs` clears `ELECTRON_RUN_AS_NODE` before launching. Some tools (e.g. terminals
> embedded in VS Code) set it, which would make Electron start as plain Node.

---

## References

- Linux kernel `drivers/hid/hid-playstation.c`, and its 2025 audio patch series: input/output
  report layouts, IMU calibration, speaker/headphone routing
- Nielk1's DualSense trigger effect generator: trigger mode encodings
- [SAxense](https://github.com/egormanga/SAxense): Bluetooth haptics report `0x32`
