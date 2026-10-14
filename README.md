# DualSense Haptic Designer

A desktop tool for designing DualSense feedback: "things moving inside the controller" scenes
(à la Astro's Playroom / 1-2-Switch Ball Count), haptic clips, and adaptive-trigger effects.
It mirrors the physical controller on a live 3D model and exports WAV and JSON for use in your
own games.

## Run

```
npm install
npm run dev      # development with hot reload
npm run build    # production build into out/
npm start        # run the production build
npm test         # unit tests (protocol, DSP, physics, WAV)
```

Connect the controller over **USB** for full haptics. Click **Connect DualSense**. The haptic
audio output switches to the controller's audio device ("DualSense Wireless Controller", 4
channels) automatically.

> `scripts/run.mjs` strips `ELECTRON_RUN_AS_NODE` before launching. Some host processes (e.g.
> tools embedded in VS Code) set it, which would make Electron start as plain Node.

## Run in a browser

The same app also runs in a Chrome or Edge tab:

```
npm run web          # dev server at http://localhost:5174
npm run web:build    # static build into out/web/
npm run web:preview  # serve out/web/ at http://localhost:5174
```

Or double-click `Run DualSense Haptic Designer (browser).bat`: it builds, serves and opens the
page in Chrome (or Edge). Closing its window stops the server.

Limits compared with the desktop app:

- **Chrome or Edge only.** Firefox and Safari have no WebHID, so the controller can't connect.
- It must be served from `localhost` or over https. WebHID and audio output selection are
  blocked on plain http and `file://`.
- **Connect DualSense** opens the browser's own device chooser. Pick the controller there.
- The browser hides audio device names until you grant a permission, so the controller's
  audio output can't be found automatically. Click **Connect to Controller Vibration** in the
  Sound → Grip motors section and allow it (Chrome may ask for microphone access; nothing is recorded).
- Saving uses a save dialog where the browser supports one, or else a normal download. The last
  sound is kept by the app and comes back on the next visit; a model you load does not.
- Bluetooth haptics streaming (report `0x32`) is untested in the browser.

## How it works

| Feature | Mechanism |
|---|---|
| Haptics (USB) | The DualSense is a 4-ch 48 kHz USB audio device. **Channels 3/4 drive the left/right voice-coil actuators.** The app opens the device with `AudioContext.setSinkId` and routes its synth there. |
| Haptics (Bluetooth, experimental) | Synth output is decimated to 3 kHz u8 stereo and streamed in HID report `0x32` (layout from [SAxense](https://github.com/egormanga/SAxense)). Toggle with **BT haptics** in the top bar. |
| Adaptive triggers | 11 bytes per trigger in output report `0x02` (USB) / `0x31` (BT, CRC32). Encodings follow the community reference (Nielk1 / hid-playstation). |
| Input & motion | WebHID input report parsing, IMU calibration (feature report `0x05`), Madgwick gyro+accel fusion. |
| "Things inside" scenes | A 2D top-down box physics sim. Gravity comes from the real controller tilt. Collisions become impact grains (amplitude ∝ impulse, pitch by material), rolling becomes speed-modulated band-passed noise, and footsteps become tiny taps. Each event is panned L↔R by its x position across the two actuators. |

## Tabs

- **Haptics & Triggers** (main workflow):
  1. Load (or drop) a sound: WAV, MP3, OGG or FLAC.
  2. Shape what each **grip motor** gets with its own EQ: a 10-band graphic EQ, low/high
     cut and gain, with a live spectrum. By default the left motor takes the file's left
     channel and the right motor its right channel. A mono file feeds both, and the two EQs
     then split it (e.g. the low boom on one motor, the crackle on the other). A 4-channel
     file starts from its own ch 3/4.
  3. Press any face button on the controller (✕ ○ □ △) to feel it. Choose *play from start*
     or *play while held*. EQ edits apply live.
  4. Design L2/R2 trigger feedback below.
     **Calibrate travel…** (or `Run Trigger Calibration.bat`) runs a wall test: ease a trigger
     into a hidden wall and hold, many times. A line fitted through the holds maps effect zones
     to real trigger travel, so the graphs and zone labels show where effects are actually felt.
  5. **Export 4-ch WAV** or **Export stereo WAV** (both rendered through the exact same EQs),
     and **Export trigger JSON**.
- **Controller & Model**: live input readout, IMU axis setup, lightbar, test signals, model
  loading and rig mapping.
- **Experiments**: interactive toys that aren't part of the export workflow:
  - *Interactive scenes*: marbles, critters and a particle liquid that react to tilt,
    touchpad and buttons.
  - *Haptic clip composer*: a synth timeline.

## Export formats

- **DualSense 4-ch WAV** (main tab): 48 kHz 16-bit, ch 3/4 = left/right grip motors, ch 1/2
  silent. On the controller's USB audio device, ch 1/2 are the headset jack / speaker (heard,
  not felt) and ch 3/4 are the two voice-coil motors, one per grip. So this file plays on PC
  as-is.
- **Haptics stereo WAV** (main tab): 48 kHz 16-bit, ch 1 = left motor, ch 2 = right motor.
  For engines/middleware that route haptics to the motors themselves. Played as plain audio
  to the controller, a stereo file would go to the headset/speaker instead.
- **Clip composer WAV, stereo** (Experiments): ch1 = left actuator, ch2 = right actuator, 48 kHz 16-bit.
- **Clip composer WAV, 4-ch** (Experiments): ch1/2 silent (speaker/headset), ch3/4 = actuators. Play it straight to
  the controller's audio endpoint on PC.
- **Trigger JSON** (`*.triggers.json`, the L2/R2 effects): `{ format: "dualsense-trigger-presets", presets: [{ name,
  trigger, effect, raw }] }`. `raw` is the 11 bytes to copy into the trigger block of the
  output report (USB report 0x02: bytes 11–21 = R2, 22–32 = L2, counting the report ID).
  Vibration curves also carry `zoneFrequencies` (10 values, Hz): the controller takes one
  frequency per effect, so to follow the curve, re-send `raw` with byte 9 set to the frequency of
  the zone the trigger is in whenever that zone changes (the app does this live).
- **Trigger timeline** (`*.triggers.json`, written next to a clip WAV when it has trigger
  keys): `{ keys: [{ time, trigger, effect, raw }] }`.
- **Scenes** (`*.scene.json`) and **clip projects** (`*.dshd.json`) can be re-opened in the
  tool.

## 3D model

Use **.glb** (binary glTF): one file, native in three.js, and it keeps the part hierarchy.
`.gltf` and `.dae` also load. The app auto-loads `assets/models/dualsense.glb`, or use
**Load model…**.

Parts move in the controller frame (+x right, +y up out of the face, +z toward you). Pivots
for triggers and sticks are derived from each part's bounding box, so models whose parts are
all pivoted at the origin still animate correctly. Meshes that contain several disconnected
pieces (e.g. both sticks in one mesh) are split automatically into `mesh#0`, `mesh#1`, …
To map a control, click **Pick** in the rig table, then click the part in the 3D view.
<kbd>Shift</kbd>+click adds extra parts that move together (button glyphs, etc.).

The built-in rig preset recognises the bundled model automatically. Parts are found by their
position on the controller, so renamed or merged re-exports of it still work:

> **"Playstation 5 Dualsense"** by [AHarmlessPotato](https://sketchfab.com/AHarmlessPotato) on
> [Sketchfab](https://sketchfab.com/3d-models/playstation-5-dualsense-878c1f882808477ab81c2fe86d5a3936),
> licensed [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). This is the bundled
> `assets/models/dualsense.glb`.

Keep this credit if you redistribute the model.

## References

- Linux `drivers/hid/hid-playstation.c`: input/output report layouts, calibration
- [SAxense](https://github.com/egormanga/SAxense): Bluetooth haptics report `0x32`
- Nielk1's DualSense trigger effect generator: trigger effect encodings
