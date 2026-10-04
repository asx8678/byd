# Atto 2 Garage Trainer

Practise parking a BYD Atto 2 nose-first into bay 561. The screen is a plan of the garage: it draws the path the car takes at the current steering, an outline of the car every 0.8 m along it and, in red, where it would touch something first. It also has parking sensors with beeps, touch detection and a result card when you're parked.

It runs in any modern browser on iPhone, Android and PC, and installs to the home screen as an app that works offline.

## Commands

```sh
npm install
npm run dev              # local server with hot reload: http://localhost:5173
npm test                 # the core replayed against recorded drives (see below)
npm run typecheck
npm run build            # installable web app in dist/ (manifest, icons, service worker)
npm run build:artifact   # one self-contained page for the claude.ai artifact: dist-artifact/atto2-garage-trainer.html
```

To install it on a phone, serve `dist/` over HTTPS (for example GitHub Pages), open it, then:
- **iOS:** Share → Add to Home Screen.
- **Android or desktop Chrome/Edge:** Install app.

## Layout

```
src/core/      the game itself, no browser code: easy to test, and the part to port to Swift
  math.ts        DEG, clamp, wrapPi, the Pt type
  car.ts         Atto 2 dimensions, outline from above, door mirrors, Ackermann steering
  garage.ts      the surveyed garage: bays, painted lines, walls, pillars, parked cars (buildObstacles)
  geometry.ts    polygon overlap (separating axes), circle vs polygon, segment distances
  collision.ts   what the car touches in a pose (body, or only a door mirror)
  sensors.ts     gaps around the body, and the 12 ultrasonic parking sensors (5 rays per 60° cone)
  predict.ts     the path at the current steering, rolled forward in 6 cm steps until it would touch
  sim.ts         Sim: state, input, step(dt) → events (touch, parked)
src/ui/        the browser side: drawing, controls, sound, settings
  plan.ts        the map (canvas 2D)
  pdcDisplay.ts  sensor graphic, STOP card, red screen-edge glow
  hud.ts         readouts and the banner
  controls.ts    steering wheel, hold-to-move pedals, keyboard, Setup and Info
  audio.ts       the beeper
  settings.ts    saved choices (localStorage key `atto2-garage`)
src/main.ts    wiring and the frame loop (30 fps cap, no redraw while nothing changes)
public/        manifest, icons, service worker
test/          golden test and its recorded fixtures
```

## The golden test

`test/fixtures/golden.json` was recorded from the original single-file version of the game. It replays scripted drives, frame by frame at 33.4 ms, with the key presses in `ops.json`:
- the three start positions
- touches, including a mirror-only touch
- the speed ramp and reversing
- parking nose-in, reversed in, and in bay 560

At each of the 127 checkpoints the test compares pose, speed, steering, all 12 sensor readings, the body gaps, the predicted paths and the banner text, to within 1e-9.

Physics changes will legitimately change these numbers. When you make one on purpose, record new fixtures rather than loosening the tolerance.

## Porting to Swift later

`src/core` maps one to one onto a Swift package:
- plain structs and functions
- one `Sim` class
- no globals: each `Sim` owns its obstacles and readings

Port it, then port the golden test with the same JSON fixtures. When the Swift core passes, it behaves exactly like this one. Only `src/ui` needs a new front end, such as SpriteKit or SwiftUI.
