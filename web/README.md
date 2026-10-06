# Atto 2 Garage Trainer

Practise parking a BYD Atto 2 nose-first into bay 561, then in generated levels and a course of lessons, in the Atto 2 or in a Smart fortwo, a Peugeot 208, a Škoda Octavia estate, a Ram 1500 or a Mercedes S-Class with rear-axle steering (10°, 4.5° or off), each turning the circle its maker publishes: a row of bays entered nose first, the same reversing in, and parallel parking at a kerb, each from level 1 (roomy) to level 10 (tight). A course of ten lessons teaches each manoeuvre with a coach: watch the route, drive it guided step by step, then with less and less help, then a test. Three more teach reversing a box trailer behind the Octavia (straight, round a corner, into a space), with a coach that shows where to hold the wheel, and ten trailer levels follow. Learning layers (the path, the turning circles, the swept path of all four corners, the ideal path, a kerb close-up and the numbers) switch on in Setup, and ⟲ 5 s rewinds to try a step again. The screen is a plan: it draws the path the car takes at the current steering, an outline of the car every 0.8 m along it and, in red, where it would touch something first. It also has parking sensors with beeps, touch detection, a move counter against par, and a result card with three stars when you're parked.

On the street (Play → On the street) you drive a district in Drive mode: an accelerator and a brake you press harder higher up the button, physics with tyres that slip and grip that runs out (blended into the parking model below 18 km/h), and a map that turns so you drive up and zooms out with speed (pinch it to zoom yourself, double-tap to give the zoom back). Stop beside a free space on your kerb side, or beside a free bay in a car park (rows of bays at 90°, 60° or 45°), and Park mode takes over for the parking itself. Play the hand-made Harbour district or a district made up for you (roomy, average or tight), under Morocco's, Germany's or the UK's rules of the road (Setup; the UK keeps left). Other cars drive the streets (none, light or busy), traffic lights and give-way lines run the junctions, and you have indicators, hazard lights and a horn. Parked cars pull out and leave their space to whoever waits for it, couriers stop in the lane with their hazards on, cars pass you (or honk) while you hold them up, and spot thieves dive into a space you hesitate over. Going through a red light, not giving way, speeding, hitting a car, not signalling a turn or as you pull in or out, blocking a junction, parking where it is not allowed and hazard lights the country does not allow count as faults on the way to your space, and the card says how long you held up traffic.

It runs in any modern browser on iPhone, Android and PC, and installs to the home screen as an app that works offline.

## Commands

```sh
npm install
npm run dev              # local server with hot reload: http://localhost:5173
npm test                 # the core replayed against recorded drives, plus replay and content checks (see below)
npm run typecheck
npm run build            # installable web app in dist/ (manifest, icons, service worker)
npm run build:artifact   # one self-contained page for the claude.ai artifact: dist-artifact/atto2-garage-trainer.html
npm run build:store      # the store edition of the web app in dist-store/: generic car names, and Pro (below) kept for a licence key
npm run licence -- keygen <folder outside the repo>      # the seller's licence keypair (prints the public key for src/storeConfig.ts)
npm run licence -- issue <private.pem> <order>           # a licence key for a buyer
npx vite build --mode harness --outDir dist-harness   # like build, plus window.__game (the Sim, the level, par's route) for browser checks
```

To install it on a phone, serve `dist/` over HTTPS (for example GitHub Pages), open it, then:
- **iOS:** Share → Add to Home Screen.
- **Android or desktop Chrome/Edge:** Install app.

## Editions and Pro

Your own page, development and the tests are the personal edition: everything open, the makers' names. `npm run build:store` makes the store edition, which keeps Pro for a licence key (`src/core/tiers.ts`): free are the Atto 2, the Smart, the 208 and the Octavia, all the lessons, the garage, Harbour, the roomy and average districts, today's level, and levels 1–6 of each car template in their first five layouts (about a hundred maps); Pro adds the Ram and the S-Class, levels 7–10, the trailer levels, more layouts, busy traffic, spot thieves and the tight districts. Pro choices show a Pro tag and open the Pro sheet; nothing Pro comes back from an earlier visit without the key. The store edition calls the cars by generic names (each car file's `store`) and leaves out the models they are based on, the sources and the estimates' wording, which lowers the risk of using makers' names in something sold (it is not legal advice).

A licence key is an order's details signed with the seller's private key (ECDSA P-256), checked on the phone against the public key in `src/storeConfig.ts` (`src/core/licence.ts`), so no server is needed; a key can be shared. Until `LICENCE_PUBLIC_KEY` and `BUY_URL` are set, the store edition says Pro is not on sale and nothing unlocks it. Keep the private key outside the repository: `keygen` refuses a folder inside one.

## Layout

```
content/       data the game loads; JSON, so a Swift port reads the same files (see content/README.md)
  vehicles/      one file per car: dimensions, outline, mirrors, turning circle, rear-axle steering, driveline, sensors,
                 a tow bar
  trailers/      one file per trailer: its size, the drawbar, where the axle is, its weight
  scenes/        one file per place: obstacles, painted lines, bays, starts (garage-561.json is your garage)
  lessons/       course.json: the lessons, their stored routes, the handbooks' words with sources, pass rules
  maps/          street districts for the map kit: roads, sides, zones, car parks, who is parked (harbour.json)
src/core/      the game itself, no browser code: easy to test, and the part to port to Swift
  math.ts        DEG, clamp, wrapPi, the Pt type
  vehicle.ts     a car from its file; the steering lock is worked out from the published turning circles, and with
                 rear-axle steering the car's origin moves to the point it turns about
  scene.ts       a scene from its file: obstacles, kerbs, lines, bays, starts
  content.ts     the cars, trailers and scenes that ship (ATTO2, VEHICLES, vehicleFor, TRAILERS, GARAGE_561)
  trailer.ts     a trailer on a car's tow ball: it follows the ball as a tractrix (its axle only moves along it),
                 the angle it settles at on a steady turn, what it touches (its tyres meet kerbs), and the jackknife
                 where it folds into the car
  car.ts         geometry for any car: placing outlines, rectangles, Ackermann angles
  garage.ts      old names kept for code that used them
  geometry.ts    polygon overlap (separating axes), circle vs polygon, segment distances
  collision.ts   what the car touches in a pose (body, a door mirror, or a tyre on a kerb)
  sensors.ts     gaps around the body, and the ultrasonic parking sensors (5 rays per cone)
  predict.ts     the path at the current steering, rolled forward in 6 cm steps until it would touch
  sim.ts         Sim(scene, car): state, input, step(dt) → events (touch, parked, fault); Park mode (hold to move,
                 the exact low-speed model) or Drive mode (accelerator and brake through dynamics.ts); your
                 indicators and hazards; on the street the traffic and the rules step with it; a trailer on the
                 tow ball (the rear sensors switch off, and a towed space is judged on the trailer)
  traffic.ts     the road network from a district (lanes, paths through the junctions, lights, give-way lines, the
                 zones paths share and who goes first) and the other cars: six sizes and a van, calm, cautious,
                 fast, impatient drivers, couriers and spot thieves, the Intelligent Driver Model, giving way by
                 the time needed to get across, only where their size fits; parked cars that pull out (an S-curve
                 out of a free space), couriers that stop in the lane, thieves that dive into the space you are
                 after (an S-curve in, nose first), cars that pass you or a stopped courier, horns; seeded (the
                 cars after the traffic itself with numbers of their own) and snapshot-able
  rules.ts       the faults of a drive: a red light, not giving way, more than 3 km/h over the limit for over a
                 second, hitting a car in traffic, touching anything in Drive mode, a turn or pulling in or out without signalling,
                 blocking a junction, parking where it is not allowed, hazard lights the country does not allow;
                 how long you held up traffic
  country.ts     the rules of the road by country (Morocco, Germany, the UK): the side traffic keeps to, when
                 hazard lights are allowed, whose a space is, with their sources
  dynamics.ts    Drive mode's street physics: a single-track model with tyres that slip, weight transfer, ABS,
                 power, drag; blended into the low-speed model between 7 and 18 km/h; the zoom rule's look-ahead
  city.ts        the map kit: a district spec compiled into a scene, the free spaces a car fits along the kerbs
                 and in the car parks (and whether the planner can park it there), the street or car park you are
                 on, the space you stopped beside; traffic keeping right or left
  lot.ts         car parks for the map kit: rows of bays at 90°, 60° or 45° either side of their aisles (one way
                 when angled), cross aisles, a low wall and a driveway; who is parked in them
  district.ts    districts made up from a seed and a level: the grid, the streets' widths and speeds, parking,
                 zones, car parks, how full and how tight
  world.ts       a spatial grid over a big scene's obstacles, so collisions and sensors only look nearby
  parking.ts     when a car counts as parked in a bay, and how neatly (shared by Sim, the planner and the stars);
                 a bay turned on the map (a car park's) is judged in its own frame
  score.ts       three stars: nothing touched, neat, efficient (par + 1 moves, inside the time)
  replay.ts      fixed 60 Hz steps; recording an attempt (with the traffic as it was, and a checkpoint every 10 s)
                 and playing it back; replaying to a step (rewind, from the last checkpoint)
  field.ts       a 5 cm raster and distance field of the scene, for fast collision checks while planning (kerbs
                 as half-planes for the wheels, and a raster of their own for any off those lines)
  planner.ts     route search (hybrid A*): into a bay from the car (planToBay), or outward from the
                 space back to the car (planBack, quicker for parallel parking); Show me, par, levels
  generator/     levels from (template, level, seed): templates.ts builds the scene, level.ts solves it
                 outward from the parked poses, checks it with the exact collision test and measures it;
                 lessonScenes.ts builds the lessons' own scenes (cone course, swept-path U-turn, leaving a
                 tight space with an exit lane, 60° angled bays); towScenes.ts the trailer yards (a straight lane,
                 a corner, a space between cars), each with the path the trailer's axle follows; towLevels.ts the
                 trailer levels (a narrower space, a tighter corner, cars and cones closing in, the passenger side),
                 each solved by the towing coach's drivers before you see it
  coach.ts       a route as steps said with what you see ("until your mirror is 55 cm short of the near
                 line"); CoachRun, which follows a try (guided: the wheel first, walking pace, brakes on the
                 mark; marks that follow the car so earlier errors are taken out); and the feedback after a
                 try (the first 30 cm drift and why, or the switch whose timing moved the finish most)
  towing.ts      reversing a trailer: a path for its axle, a pilot that steers the car to keep the trailer on it
                 (pure pursuit on the trailer, the hitch angle that holds that curve, the car's curvature that
                 brings the hitch angle there; its hand no faster than a person's), and TowCoach, which shows its
                 wheel as a target, keeps the rig to a crawl and has you pull forward when the trailer gets away
  lesson.ts      the course from content/lessons: loading a lesson (a towing lesson in its own car and trailer),
                 pass rules, help that steps back
  lessonRoutes.ts each lesson in each car: the route worked out for the car (keeping the Atto 2's moves where
                 coached drivers can follow them), and the lesson's tips matched to its steps
  robot.ts       drivers who do only what the coach shows, guided or on cue marks, a little early, late or off;
                 for the towing lessons, drivers who follow the target on the wheel or steer by eye
src/ui/        the browser side: drawing, controls, sound, settings
  plan.ts        the map (canvas 2D): north up, or in Drive mode turned so you drive up and zoomed by speed;
                 pinch, the mouse wheel or + and - to zoom yourself, a double tap (or 0) to give it back; on the
                 street the pavements, blocks and their hatched buildings, car parks, kerbs, zones and names, with
                 detail that fades in as you zoom in (lane lines, bays and parked cars from 2.6 px/m, labels from 7.8);
                 a trailer, where it goes at the current wheel, and in a towing lesson its line and the space (the
                 view frames the whole rig, or the ghost while it shows the way)
  pdcDisplay.ts  sensor graphic, STOP card, red screen-edge glow (the rear group off with a trailer on)
  hud.ts         speed and moves (between the wheel and pedals), with a trailer on its angle to the car, the
                 wheel's turns, a towing coach's target on the wheel's rim, the banner
  controls.ts    steering wheel, pedals (hold to move; in Drive mode an accelerator and a brake pressed harder
                 higher up), keyboard, the Park/Drive button, Setup, Levels and Info
  levels.ts      the Levels tab of the Play sheet and the result card with its stars
  course.ts      the Course tab, the lesson card and a lesson's result card (localStorage key `atto2-course`)
  cars.ts        the car picker in Setup and the chosen car's facts, estimates and sources in Info (and the
                 trailer's, with where it folds into the car, when one is on)
  coachCard.ts   the coach card at the top of the screen in a lesson (a towing lesson's from its own coach: where
                 your hand at the bottom of the wheel should go)
  progress.ts    best stars per car, last layouts and what you were playing (localStorage key `atto2-levels`)
  audio.ts       the beeper
  settings.ts    saved choices (localStorage key `atto2-garage`)
src/cityCheck.worker.ts  the street's free spaces checked with the planner in a worker, so driving never stutters
src/main.ts    wiring and the frame loop: the simulation steps at a fixed 60 Hz, drawing is capped at
               30 fps and skipped while nothing changes; Replay plays the current attempt from its start;
               Show me lets a ghost drive the route that set par, or plans one from where the car is;
               a try's result is read once the car has sat parked for a second; lessons: Watch, tries,
               the coach between the pedals and the car (applied before each step, so replays stay exact)
public/        manifest, icons, service worker
test/          golden test and its recorded fixtures, replay, content, planner, generator, car, lesson,
               Drive-mode physics (dynamics.test.ts), street district (city.test.ts), car park, made-up
               district, traffic (traffic.test.ts), your drive (drive.test.ts) and rules of the road
               (rules.test.ts) tests
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
- a driver who does only what the coach shows passes every lesson: guided (also with the wheel 4° off, letting go early or turning the wheel slowly) and with cue marks only (also reacting late). In every other car the guided driver and the late one pass every lesson the car can do (`LESSON_DRIVERS=all` runs all six), each car's stored routes are still what `planLesson` gives, the Ram and the S-Class are the only ones that cannot do your garage and the Ram the tight parallel space, a tip stays where the same two moves meet, a Smart's coach never names a back seat, and the lesson words fill in each car's numbers while the Atto 2's read exactly as before
- the feedback names an early or late turn, a stop too soon or too far before reversing, a wheel short of full lock or coming off it, an extra move, and (for a parallel park that misses by a little) the switch that caused it, in degrees
- two passes lower the help, two fails raise it with slow motion, and a pass in the test finishes the lesson
- a U-turn is measured the long way round, and leaving a space only counts once the car is out in the lane, straight
- going back 5 s and driving on again ends exactly where never going back does, coach and path included
- Drive mode against what the makers publish: 0–100 km/h (the Atto 2 DM-i Boost 7.5 s, the Smart 14.4 s) and the S-Class's 0–60 mph (3.9 s) within 3%, every car's top speed, and stopping from 100 km/h in a normal 33–46 m (50 km/h: 8–12.5 m)
- below 7 km/h a Drive-mode step moves the car along exactly the arc a Park-mode step would, and its turning circle at walking pace is the spec sheet's; speeding up through the 7–18 km/h blend and slowing down again the turn rate never jolts
- steady cornering: at a fixed steering wheel the circle widens with speed (understeer), and turned too hard at 50 km/h the car runs wide at its tyres' limit without spinning
- a drive with pedals, the wheel and a switch into Park mode and back replays exactly; the zoom rule shows the blueprint's look-ahead at each speed
- the Harbour district: the same seed gives the same district, parked cars keep to their lanes, every car gets the spaces the fill promised and the planner parks it in each of them (and in nine in ten of all the free gaps) from where Park mode starts; stopping beside a space is recognised only on your side of the road; kerbs on other streets do not count; the zones keep their kerb clear; every car drives Harbour Street at 50 km/h and turns left and right at the Market Street crossing without touching anything
- car parks: a bay turned to any angle is judged pose by pose exactly as the same bay unturned, and the planner parks in it; the Harbour district's three car parks (90°, 60° and 45°) sit in their blocks with their driveways open and their bays inside the walls; the planner parks the Atto 2, the Smart and the S-Class (10° and off) in every bay kept free from where Park mode starts, and stopping there is recognised; the Ram is told it is too long for 5 m bays; every car drives in from the street through each driveway without touching anything
- driving on the left: the same district with the traffic turned round (the same kerbs, parked cars and spaces), you start in the other lane and park on your left, the planner parks the Atto 2 and the S-Class in every promised space there, and every car drives Harbour Street in the left lane
- made-up districts: the same seed and level give the same district; at roomy, average and tight, every car is promised five spaces and the planner parks it in each, the start and the driveways are clear and nearly every bay a car park keeps free is in reach; and the levels get narrower, fuller, sloppier and tighter
- traffic: Harbour's junctions get lights at the crossroads and on the 50 km/h roads, give way on the other side roads and nothing at the ring's corners; every path through a junction starts where its lane ends, ends where the next begins and is no tighter than 6 m; the lights never show green both ways; the same seed gives the same traffic and a snapshot carries on exactly; four minutes of Harbour and of a roomy, an average and a tight made-up district, light and busy, keeping right and left (`TRAFFIC_SEEDS=n` for more layouts), with no car touching another, a kerb or anything parked, none through a red light, none stuck and the last-resort check never needed; a car stops a couple of metres behind your car (further when you signal to park), waits at its line while you are in its way and goes when you have gone, and is what your car touches when you drive into it
- your drive: an indicator cancels itself after the wheel has been turned its way and back, but not for a lane change; crossing the stop line on red is a fault, on green or amber it is not; speeding is one fault a spell, with its top speed; hitting a car in traffic is a touch and a fault; how long you held up traffic is counted, and not while you wait yourself; a car parked at the kerb that will pull out takes its space until it goes, your sensors hear it, your path stops at it and backing into it is a touch, not a crash; a try beside a space with a thief replays exactly, and so does pulling out after Drive on (a recording of its own), signalled or not; a drive in busy traffic with parked cars pulling out, couriers and a thief replays exactly (car, traffic and rules), through JSON too, and rewinds to exactly where everything was, from its checkpoints as from the start
- parked cars, couriers, thieves and passing: the traffic itself moves exactly as M7 part 1 left it when there are none (a fingerprint); parked cars sit only in free spaces not promised to your car, wake as you come up behind them, signal for three seconds, wait for you or a car coming along the lane, pull out and leave the space free; a courier stops 30 to 60 s with its hazards on, and the car behind waits, honks after its patience and goes on; a driver honks at you when you hold it up, not while you wait at a red light; a thief comes for the space you stop beside and waits with its nose at the back of it, gives up when you signal and start reversing in time or are reversing already, dives in when you never signal or reverse too late, waits again when you begin to reverse just as it begins to dive, and carries on exactly from a snapshot taken mid-dive (a passing car too, mid-pass); you beside spaces in three districts for a minute, claiming them or not, with nothing touching; a car goes round a stopped courier, waits for one coming the other way, goes round you when you stop to park, and a car the other way stops for one out in its lane
- rules of the road (rules.test.ts): pulling out over a give-way line in front of a car on the main road less than 3 s away is a fault, 5 s away or with none it is not; a turn without the indicator on as you came into the junction is a fault (the right way, from 10 m before, is not; switched on in the junction is); pulling in without signalling towards the kerb and pulling out without signalling away from it; stopping in a junction for 3 s, but not waiting to turn across, signalling, nor while the lights are with you; parking 10 s in a bus stop or by a junction, but not in a space; hazard lights in the UK only while stopped (not even reversing slowly), in Germany not even then, in Morocco not scored; the countries' sides of the road, settings saved before them, and what a thief means in each

## Porting to Swift later

`src/core` maps one to one onto a Swift package:
- plain structs and functions
- one `Sim` class
- no globals: each `Sim` owns its scene, its car and its readings
- the cars and scenes are JSON in `content/`, read by both versions

Port it, then port the golden test with the same JSON fixtures. When the Swift core passes, it behaves exactly like this one. Only `src/ui` needs a new front end, such as SpriteKit or SwiftUI.
