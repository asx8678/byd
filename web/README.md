# Atto 2 Garage Trainer

Practise parking a BYD Atto 2 nose-first into bay 561. The screen is a plan of the garage: it draws the path the car takes at the current steering, an outline of the car every 0.8 m along it and, in red, where it would touch something first. It also has parking sensors with beeps, touch detection and a result card when you're parked.

It runs in any modern browser on iPhone, Android and PC, and installs to the home screen as an app that works offline.

## Commands

```sh
npm install
npm run dev              # local server with hot reload: http://localhost:5173
npm test                 # the core replayed against recorded drives, plus replay and content checks (see below)
npm run typecheck
npm run build            # installable web app in dist/ (manifest, icons, service worker)
npm run build:artifact   # one self-contained page for the claude.ai artifact: dist-artifact/atto2-garage-trainer.html
```

To install it on a phone, serve `dist/` over HTTPS (for example GitHub Pages), open it, then:
- **iOS:** Share → Add to Home Screen.
- **Android or desktop Chrome/Edge:** Install app.

## Layout

```
content/       data the game loads; JSON, so a Swift port reads the same files (see content/README.md)
  vehicles/      one file per car: dimensions, outline, mirrors, turning circle, driveline, sensors
  scenes/        one file per place: obstacles, painted lines, bays, starts (garage-561.json is your garage)
src/core/      the game itself, no browser code: easy to test, and the part to port to Swift
  math.ts        DEG, clamp, wrapPi, the Pt type
  vehicle.ts     a car from its file; the steering lock is derived from the turning circle
  scene.ts       a scene from its file: obstacles, lines, bays, starts
  content.ts     the cars and scenes that ship (ATTO2, GARAGE_561)
  car.ts         geometry for any car: placing outlines, rectangles, Ackermann angles
  garage.ts      old names kept for code that used them
  geometry.ts    polygon overlap (separating axes), circle vs polygon, segment distances
  collision.ts   what the car touches in a pose (body, or only a door mirror)
  sensors.ts     gaps around the body, and the ultrasonic parking sensors (5 rays per cone)
  predict.ts     the path at the current steering, rolled forward in 6 cm steps until it would touch
  sim.ts         Sim(scene, car): state, input, step(dt) → events (touch, parked)
  replay.ts      fixed 60 Hz steps; recording an attempt and playing it back
src/ui/        the browser side: drawing, controls, sound, settings
  plan.ts        the map (canvas 2D)
  pdcDisplay.ts  sensor graphic, STOP card, red screen-edge glow
  hud.ts         readouts and the banner
  controls.ts    steering wheel, hold-to-move pedals, keyboard, Setup and Info
  audio.ts       the beeper
  settings.ts    saved choices (localStorage key `atto2-garage`)
src/main.ts    wiring and the frame loop: the simulation steps at a fixed 60 Hz, drawing is capped at
               30 fps and skipped while nothing changes; Replay plays the current attempt from its start
public/        manifest, icons, service worker
test/          golden test and its recorded fixtures, replay and content tests
prototype/     the scenario generator prototype (route planner, templates, coach); the start of M2 and M3
```

## The golden test

`test/fixtures/golden.json` was recorded from the original single-file version of the game. It replays scripted drives, frame by frame at 33.4 ms, with the key presses in `ops.json`:
- the three start positions
- touches, including a mirror-only touch
- the speed ramp and reversing
- parking nose-in, reversed in, and in bay 560

At each of the 127 checkpoints the test compares pose, speed, steering, all 12 sensor readings, the body gaps, the predicted paths and the banner text, to within 1e-9.

Physics changes will legitimately change these numbers. When you make one on purpose, record new fixtures rather than loosening the tolerance.

The other tests check that:
- a recorded attempt replays exactly: same pose, touches and parking result, also after a round trip through JSON
- the data files reproduce the old numbers (steering geometry, the garage's 35 obstacles and its starts)
- the Atto 2 turns a 10.6 m kerb-to-kerb circle in the simulation, as on BYD's spec sheet

## Porting to Swift later

`src/core` maps one to one onto a Swift package:
- plain structs and functions
- one `Sim` class
- no globals: each `Sim` owns its scene, its car and its readings
- the cars and scenes are JSON in `content/`, read by both versions

Port it, then port the golden test with the same JSON fixtures. When the Swift core passes, it behaves exactly like this one. Only `src/ui` needs a new front end, such as SpriteKit or SwiftUI.
