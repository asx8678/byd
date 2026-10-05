# Atto 2 Garage Trainer

Practise parking a BYD Atto 2 nose-first into bay 561, then in generated levels, in the Atto 2 or in a Smart fortwo, a Ram 1500 or a Mercedes S-Class with rear-axle steering (10°, 4.5° or off), each turning the circle its maker publishes: a row of bays entered nose first, the same reversing in, and parallel parking at a kerb, each from level 1 (roomy) to level 10 (tight). A course of ten lessons teaches each manoeuvre with a coach: watch the route, drive it guided step by step, then with less and less help, then a test. Learning layers (the path, the turning circles, the swept path of all four corners, the ideal path, a kerb close-up and the numbers) switch on in Setup, and ⟲ 5 s rewinds to try a step again. The screen is a plan: it draws the path the car takes at the current steering, an outline of the car every 0.8 m along it and, in red, where it would touch something first. It also has parking sensors with beeps, touch detection, a move counter against par, and a result card with three stars when you're parked.

It runs in any modern browser on iPhone, Android and PC, and installs to the home screen as an app that works offline.

## Commands

```sh
npm install
npm run dev              # local server with hot reload: http://localhost:5173
npm test                 # the core replayed against recorded drives, plus replay and content checks (see below)
npm run typecheck
npm run build            # installable web app in dist/ (manifest, icons, service worker)
npm run build:artifact   # one self-contained page for the claude.ai artifact: dist-artifact/atto2-garage-trainer.html
npx vite build --mode harness --outDir dist-harness   # like build, plus window.__game (the Sim, the level, par's route) for browser checks
```

To install it on a phone, serve `dist/` over HTTPS (for example GitHub Pages), open it, then:
- **iOS:** Share → Add to Home Screen.
- **Android or desktop Chrome/Edge:** Install app.

## Layout

```
content/       data the game loads; JSON, so a Swift port reads the same files (see content/README.md)
  vehicles/      one file per car: dimensions, outline, mirrors, turning circle, rear-axle steering, driveline, sensors
  scenes/        one file per place: obstacles, painted lines, bays, starts (garage-561.json is your garage)
  lessons/       course.json: the lessons, their stored routes, the handbooks' words with sources, pass rules
src/core/      the game itself, no browser code: easy to test, and the part to port to Swift
  math.ts        DEG, clamp, wrapPi, the Pt type
  vehicle.ts     a car from its file; the steering lock is worked out from the published turning circles, and with
                 rear-axle steering the car's origin moves to the point it turns about
  scene.ts       a scene from its file: obstacles, kerbs, lines, bays, starts
  content.ts     the cars and scenes that ship (ATTO2, VEHICLES, vehicleFor, GARAGE_561)
  car.ts         geometry for any car: placing outlines, rectangles, Ackermann angles
  garage.ts      old names kept for code that used them
  geometry.ts    polygon overlap (separating axes), circle vs polygon, segment distances
  collision.ts   what the car touches in a pose (body, a door mirror, or a tyre on a kerb)
  sensors.ts     gaps around the body, and the ultrasonic parking sensors (5 rays per cone)
  predict.ts     the path at the current steering, rolled forward in 6 cm steps until it would touch
  sim.ts         Sim(scene, car): state, input, step(dt) → events (touch, parked)
  parking.ts     when a car counts as parked in a bay, and how neatly (shared by Sim, the planner and the stars)
  score.ts       three stars: nothing touched, neat, efficient (par + 1 moves, inside the time)
  replay.ts      fixed 60 Hz steps; recording an attempt and playing it back; replaying to a step (rewind)
  field.ts       a 5 cm raster and distance field of the scene, for fast collision checks while planning
  planner.ts     route search (hybrid A*): into a bay from the car (planToBay), or outward from the
                 space back to the car (planBack, quicker for parallel parking); Show me, par, levels
  generator/     levels from (template, level, seed): templates.ts builds the scene, level.ts solves it
                 outward from the parked poses, checks it with the exact collision test and measures it;
                 lessonScenes.ts builds the lessons' own scenes (cone course, swept-path U-turn, leaving a
                 tight space with an exit lane, 60° angled bays)
  coach.ts       a route as steps said with what you see ("until your mirror is 55 cm short of the near
                 line"); CoachRun, which follows a try (guided: the wheel first, walking pace, brakes on the
                 mark; marks that follow the car so earlier errors are taken out); and the feedback after a
                 try (the first 30 cm drift and why, or the switch whose timing moved the finish most)
  lesson.ts      the course from content/lessons: loading a lesson, pass rules, help that steps back
src/ui/        the browser side: drawing, controls, sound, settings
  plan.ts        the map (canvas 2D)
  pdcDisplay.ts  sensor graphic, STOP card, red screen-edge glow
  hud.ts         readouts and the banner
  controls.ts    steering wheel, hold-to-move pedals, keyboard, Setup, Levels and Info
  levels.ts      the Levels tab of the Play sheet and the result card with its stars
  course.ts      the Course tab, the lesson card and a lesson's result card (localStorage key `atto2-course`)
  cars.ts        the car picker in Setup and the chosen car's facts, estimates and sources in Info
  coachCard.ts   the coach card at the top of the screen in a lesson
  progress.ts    best stars per car, last layouts and what you were playing (localStorage key `atto2-levels`)
  audio.ts       the beeper
  settings.ts    saved choices (localStorage key `atto2-garage`)
src/main.ts    wiring and the frame loop: the simulation steps at a fixed 60 Hz, drawing is capped at
               30 fps and skipped while nothing changes; Replay plays the current attempt from its start;
               Show me lets a ghost drive the route that set par, or plans one from where the car is;
               a try's result is read once the car has sat parked for a second; lessons: Watch, tries,
               the coach between the pedals and the car (applied before each step, so replays stay exact)
public/        manifest, icons, service worker
test/          golden test and its recorded fixtures, replay, content, planner and generator tests
prototype/     the scenario generator prototype (now in src/core: generator/, planner.ts, coach.ts)
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
- each car turns its published circle in the simulation: the Atto 2 10.6 m (BYD), the Smart 6.95 m (Daimler) and the Ram 14.08 m (FCA) kerb to kerb. Their steering locks are worked out from these figures, so this checks the simulation against that working-out, and the Smart's 7.30 m wall to wall matches because its front corners were placed to match it. The one independent check is the S-Class: a single front lock lands within 10 cm of both of Mercedes' wall-to-wall circles (11.89 m with 4.5° rear steering, 10.79 m with 10°)
- with rear-axle steering the rear wheels turn against the front ones and the rear axle runs the way they point, with no scrub
- every car builds levels 1, 5 and 10 of every template (`GEN_CAR_LEVELS=all` for 1–10) whose routes clear everything and end parked with three stars; the Smart parks in 561 from every start, the Ram and the S-Class are reported as not fitting it, and a start a long car would touch something at moves back until it is clear
- the planner finds 561 from all three starts and 560 from the left. Each route is clear under the exact collision check and ends parked nose in, neatly; from the left it takes three moves. It also parks in an open bay in one move, reports a blocked bay at once, and finds the same route every time
- every level the generator makes (3 templates × levels 1–10 × 3 seeds; `GEN_SEEDS=10 npm test` for 300) starts clear, its route passes the exact collision check, and the route's end counts as parked, the right way round, with three stars
- a nose-first bay does not accept a reversed-in car, and the other way round
- kerbs stop the tyres but not the bumpers, and a drive in a level replays exactly, touches and moves included
- planBack finds a way in from part way along a level's route
- every lesson's stored route is still what the planner finds (full lock or straight only), clears everything and passes
- a driver who does only what the coach shows passes every lesson: guided (also with the wheel 4° off, letting go early or turning the wheel slowly) and with cue marks only (also reacting late)
- the feedback names an early or late turn, a stop too soon or too far before reversing, a wheel short of full lock or coming off it, an extra move, and (for a parallel park that misses by a little) the switch that caused it, in degrees
- two passes lower the help, two fails raise it with slow motion, and a pass in the test finishes the lesson
- a U-turn is measured the long way round, and leaving a space only counts once the car is out in the lane, straight
- going back 5 s and driving on again ends exactly where never going back does, coach and path included

## Porting to Swift later

`src/core` maps one to one onto a Swift package:
- plain structs and functions
- one `Sim` class
- no globals: each `Sim` owns its scene, its car and its readings
- the cars and scenes are JSON in `content/`, read by both versions

Port it, then port the golden test with the same JSON fixtures. When the Swift core passes, it behaves exactly like this one. Only `src/ui` needs a new front end, such as SpriteKit or SwiftUI.
