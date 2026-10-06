# Content

Everything here is data the game loads: plain JSON, so a later Swift version can read the same files. Coordinates are in metres. Headings are in radians (`th`), or in degrees where the field is called `thDeg`.

## vehicles/*.json

One car per file; `src/core/content.ts` lists them. The file's frame has the rear axle at the origin, x forward and z to the right.

- `name`, `short` (the picker's label) and `basedOn` (the real model the numbers come from): keep what players see separate from the model. `store`: `{ name, short }`, the generic names the store edition uses instead (it also leaves out `basedOn`, the sources and the estimates' wording).
- `sources`: where each figure comes from, a link at the end of each. `estimates`: every figure no source gave, in words; the app lists them under the car's facts.
- `dims`: length, width, `widthMirrors` (optional), height, wheelbase, track (the front one: it sets the kerb circle), front and rear overhangs, wheel radius and width, mass.
- `turning`: `by` says who published it; the steering lock is worked out from the published turning circle, either `kerbRadius` (the Atto 2's file) or `circles`, a list of `{ kerbDiameter, wallDiameter, rearSteer }`. A kerb-to-kerb figure without rear steering sets the lock exactly: the rear-axle radius at full lock is `sqrt(R² − wheelbase²) − track / 2`. Otherwise the lock is the angle that best fits every figure given; wall to wall is measured round the outline. `turnsLockToLock` when published.
- `rearSteer`: `{ options, default }`, the rear wheels' angle at full lock for each setting in degrees, `0` for off. At parking speed they turn against the front wheels with `tan(rear) = k · tan(front)`, so the car turns about a fixed point ahead of the rear axle. The game puts the car's origin there, so the planner, the coach and the simulation treat it like any other car; each setting is its own car, id `<file id>@<degrees>`.
- `outline.half`: one side of the body seen from above, front to back. The other side is mirrored.
- `mirrors`: the right mirror's box `[x0, z0, x1, z1]` and its height. The left mirror is mirrored. Mirrors only meet obstacles taller than that height. Use `null` for none.
- `planCorners`: the four corners on the rounded outline (FL, FR, RL, RR), used for the drawn tracks. `glass`: where the windows run on the plan, `[front, back]` (x). `seats`: 2 for a two-seater, which has no back seat for the coach to name.
- `drive`: the hold-to-move driveline (creep and top speeds, ramp, hold time, acceleration, braking).
- `dynamics`: Drive mode on the street (`src/core/dynamics.ts`). `power` (kW), `driven` (`front`, `rear` or `all`), `frontShare` (the weight on the front axle), `cgHeight` (m), `cdA` (drag coefficient times frontal area, m²), `grip` (the front tyres' friction coefficient on dry asphalt; the rears get 5% more), `launch` (the most the drive train pulls from rest, m/s²), `coast` (slowing with no pedal pressed, m/s²), `topSpeed` (km/h), and the published `zeroTo100` or `zeroTo60mph` (s). `powerShare` is the share of the peak power the model applies on average through a run: it is tuned so the car takes the published 0–100 time (`test/dynamics.test.ts` checks it). Most cars publish power, mass, top speed and 0–100; the rest are estimates, and `estimates` says which.
- `parkingSensors`: `layout` (`4-front-4-rear-2-each-side`, `4-front-4-rear` or `4-rear`), ranges, cone angle, zone edges, and where the corner and side sensors sit across the car (`cornerZ`, `sideZ`). Use `null` for a car without sensors.
- `towing` (optional): a tow bar. `ball` is the tow ball's centre, x in the same frame (negative: behind the rear axle); `unbraked`, `braked` and `noseWeight` are the maker's limits in kg. Only a car with one can pull a trailer, and while it does its rear parking sensors are off, as a real car's are.

A car goes in when its turning circle in the simulation matches the sheet (`test/cars.test.ts`). Figures nobody published are estimates until measured, and the file says which. The W124 waits for its steering lock.

## trailers/*.json

One trailer per file; `src/core/content.ts` lists them. The frame has the coupling (the tow ball's centre) at the origin, x forward towards the car and z to the right; the trailer turns about its axle, `dims.axle` behind the coupling, and its tyres roll without slipping, so it follows the ball as a tractrix.

- `name`, `short`, `basedOn`, `sources` and `estimates` as for a car.
- `dims`: overall `length` (coupling to the back) and `width`, `height`, `drawbar` (coupling to the box), `axle` (coupling to the axle), `track`, `wheelRadius`, `wheelWidth`, `mass` (gross, kg), `payload`, and the box's `inside` size.
- `frame`: the A-frame's `width` where it meets the box and `head`, where it starts behind the ball (the end of the coupling head). The A-frame and the box, which is as wide as the trailer's overall width so nothing that sticks out is missed, are what touch things and what folds into the car in a jackknife; the tyres meet kerbs.

A bay with `towed: true` (see scenes) is judged on the trailer's box, not on the car pulling it.

## scenes/*.json

One place per file. The world frame has x to the right and z down the plan. A heading of 0 drives to the right; +90° drives up the plan.

- `obstacles`: polygons (`pts`) or circles (`x`, `z`, `r`), each with:
  - `name`: used in messages ("Touched the low wall").
  - `h`: height in metres.
  - `cls`: `wall`, `low`, `lowwall` or `car`.
  - `label` (optional): drawn on parked cars.
- `kerbs` (optional): `a` to `b` with the pavement on the right of that line, `depth` metres deep. Only the tyres meet a kerb; the bumpers hang over it. The route planner sees each kerb as a half-plane.
- `bays`: the painted rectangle, plus how "parked" is judged:
  - `headZ`: how far in the car may reach.
  - `sideTol` and `mouthTol`: tolerances over the side lines and out of the mouth.
  - `inHeading`: the nose-in heading. Reversed-in parking is the opposite heading.
  - `face` (optional): `in`, `out` (reversed in) or `either`, the default.
  - `kind` (optional): `kerb` for a space along a kerb; the result then gives the tyres' gap to the kerb. `exit` for a stretch of lane to drive out into after leaving a space: parked there means inside it and straight.
  - `box` (optional): `[x0, x1, z0, z1]`, where all four corners must be. By default the lines widened by the tolerances, back to `headZ`.
  - `goals` (optional): rear-axle poses that count as well parked, for the route planner.
  - `towed` (optional): a space for a trailer. The trailer's box must be inside it and straight; the car pulling it may stay outside.
- `starts`: rear-axle poses with a label. `defaultStart` and `defaultBay` pick the defaults.
- `landmarks` (optional): named points a coach can line the car up with (a stop line, a cone), besides the bay lines and parked cars it finds itself.
- Obstacles may carry a `fill` colour; the plan draws them in it (the blue tanks, the blue cone).
- `lines`, `dashes`, `marks`, `floors`, `pit`, `door`: what is drawn (`dashes` are white lane markings).
- `areaView`: the bounds of the "Whole area" view.
- `layoutVersion`: bump it when the layout changes. Saved settings and positions from an older layout are then reset.

## maps/*.json

A street district for the map kit (`src/core/city.ts`), which compiles it into a scene (kerbs, buildings, parked cars, lamp posts), the free spaces along the kerbs and the layers the plan draws; the game never sees the spec itself. The map's frame has x east and y north (the game's z is -y).

- `bounds`: `[x0, y0, x1, y1]`. `corner`: the kerb's radius at a junction's corners. `drive`: `right` or `left`, the side traffic keeps to (Setup can switch it: the kerbs, parked cars and spaces stay where they are, and everything that faces the traffic turns round).
- `roads`: each with `id`, `name`, `axis` (`x` or `y`: which way it runs), `at` (where its centre line is across that), `lane` (one lane each way, metres), `limit` (km/h), and its `right` and `left` sides as you drive towards +x or +y, each `{ park, walk }`: the parking lane's width (left out: no parking on that side) and the pavement's. Every road runs the whole grid, from the outermost road across it to the one on the far side, so the streets make blocks inside a ring.
- `zones`: `{ road, side, from, to, kind }`, a stretch of kerb measured along the road where you may not park: `bus` (a bus stop), `loading`, `none` (no parking at any time: a double red line), `disabled` (a blue badge bay: now and then a car in it) or `driveway`.
- `lots`: car parks inside the blocks, each `{ id, name, rect, aisles, angle, bay, aisle, entry, at }`: `rect` is the room it may take (`[x0, y0, x1, y1]`, behind the pavements); `aisles` which way they run (`x` or `y`); `angle` the bays' angle to the aisle (90, 60 or 45: two-way aisles at 90°, one way at the others, taking turns so the cross aisles join them into a loop, the one you come to first running away from the driveway); `bay` a bay's width and length (`[2.5, 5.0]`); `aisle` its width (6.0 two-way, about 4.6 at 60° and 4.0 at 45°); `entry` the road the driveway comes from, lined up with the aisle nearest `at` along it. It takes as much of `rect` as its aisles and rows need, against that road; a 7 m cross aisle at each end; a low wall round it with the driveway's opening; the kerb dropped across the pavement and no parking 3.5 m either side. Optional: `cross` (the cross aisles' width), `limit` (km/h, 10), `occupancy` (the map's by default), `free` (bays kept free, 3). A bay counts with the nose up to 30 cm over its back line and the tail up to 40 cm out of its mouth, so a car up to its length plus 0.33 m fits: the Ram (5.92 m) is too long for 5 m bays.
- `harbourSide`: `south` puts water beyond the outermost road on that side, behind a quay wall.
- `fill`: who is parked, from the layout number: `occupancy` (how full the parking lanes are), `sloppiness` (how far parked cars sit from the kerb and how crooked), `guarantee` (how many spaces the chosen car fits, each with a car in front of it to line up with) and optionally `spare` (how much longer than the car they are, `[min, max]` metres, 1.4 to 2.6 by default). Nobody parks within 7 m of a junction.
- `start`: where you start, `{ road, at, dir }`: in your lane, driving towards +x or +y (`dir` 1) or the other way.

## lessons/course.json

The course: lessons in order, with the sources they quote: ten parking lessons, then three towing lessons. A lesson marked `soon` is listed but not playable yet. `chapter` (optional) puts a heading in the course list before a lesson. A playable parking lesson has:

- `scene`: a generated level (`template`, `level`, `seed`, and for a kerb space `kerbGap`, the body's gap to the kerb the route was planned to), your garage (`garage`: the bay, `start`), or a scene built for the lesson (`build`: `first-metres`, `turning`, `leaving` with `level` and `seed`, or `angled` with `seed`; see `src/core/generator/lessonScenes.ts`).
- `route`: the Atto 2's route, the one the coach teaches in it, stored so that every device coaches the same one. `start` is the rear-axle pose `[x, z, heading]`; `pieces` are `[direction, steering, metres]`, with direction 1 forward or -1 reverse and steering -1 (full lock left), 0 (straight) or 1 (full lock right). The routes come from the planner with the steering kept to full lock or straight, which is how driving schools teach these manoeuvres and what a coach can name exactly; `test/lessons.test.ts` checks that the planner still finds exactly these routes. A route marked `authored` was written for the lesson instead (the cone course, the U-turn, the one-turn angled entry); the test checks that it clears everything and passes.
- `routes`: the same lesson in every other car, by vehicle id (the S-Class once per rear-steering setting), in the same form, or `null` where the car cannot do the lesson (the Ram and the S-Class do not fit bay 561; the Ram has no route in the tight parallel space that a coach can mark reliably). They come from `planLesson` in `src/core/lessonRoutes.ts`: the lesson's scene built for the car (its bays grow for a bigger car), then a route that keeps the Atto 2's moves where the car can drive them, kept only if every coached driver in `src/core/robot.ts` passes it. Run `UPDATE_ROUTES=1 npx vitest run test/lessons.test.ts` to write them again after changing a car or the planner; the test checks they are still what `planLesson` gives.
- `explain`: paragraphs for the lesson card, each with the `sources` it quotes. Every claim comes from `docs/research/parking-tips.md`; where sources disagree, the text says so. `{car}` is filled in with the car's name, `{circle}` with its turning circle and whose figure that is, `{bay}` with the width of the lesson's bay.
- `tips`: keyed by the Atto 2's step numbers, shown on the coach card at that step. `cue` (optional) picks the part of the car and the landmark the step's mark is said with, so it matches the handbook's own rule ("your mirror" and "the near line of the green bay"). In another car a tip goes to the step where the same two moves meet, and is left out where that car does that part differently.
- `pass`: what passing takes besides touching nothing: `angle` (degrees off straight), `centre` (metres off centre), `kerb` (tyres to the kerb, metres), `moves` (`"par+1"`), `face` (`in` or `out`).

A towing lesson has `tow` (`{ trailer }`: always in the car with a tow bar, the Octavia, pulling that trailer, whatever car is chosen) and `scene.tow`, one of the trailer yards in `src/core/generator/towScenes.ts` (`tow-straight`, `tow-corner`, `tow-bay`), each with the path the trailer's axle follows. It has no `route`, `routes` or `tips`: its coach steers by that path (`src/core/towing.ts`), showing where to hold the wheel, and par is one move. `explain` and `pass` work as for a parking lesson; `pass` is judged on the trailer, which finishes reversed in (`face: "out"`).

`sources` maps each id to a name and a link.

`garage-561.json` is the photo-surveyed garage around bay 561. Its `notes` give the survey frame used to check the numbers. Generated levels (`src/core/generator`) are built in this same format, so a level can be saved as a file.
