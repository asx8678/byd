# Content

Everything here is data the game loads: plain JSON, so a later Swift version can read the same files. Coordinates are in metres. Headings are in radians (`th`), or in degrees where the field is called `thDeg`.

## vehicles/*.json

One car per file. The local frame has the rear axle at the origin, x forward and z to the right.

- `dims`: length, width, height, wheelbase, track, front and rear overhangs, wheel radius and width, mass.
- `turning.kerbRadius`: the published kerb-to-kerb turning radius. The steering lock is derived from it: the rear-axle radius at full lock is `sqrt(R² − wheelbase²) − track / 2`.
- `outline.half`: one side of the body seen from above, front to back. The other side is mirrored.
- `mirrors`: the right mirror's box `[x0, z0, x1, z1]` and its height. The left mirror is mirrored. Mirrors only meet obstacles taller than that height. Use `null` for none.
- `planCorners`: the four corners on the rounded outline (FL, FR, RL, RR), used for the drawn tracks.
- `drive`: the hold-to-move driveline (creep and top speeds, ramp, hold time, acceleration, braking).
- `parkingSensors`: ranges, cone angle and zone edges. Use `null` for a car without sensors.

Keep `name` (what players see) and `basedOn` (the real model the numbers come from) separate, and list your `sources`. Figures nobody published must be measured before a car ships.

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
- `starts`: rear-axle poses with a label. `defaultStart` and `defaultBay` pick the defaults.
- `landmarks` (optional): named points a coach can line the car up with (a stop line, a cone), besides the bay lines and parked cars it finds itself.
- Obstacles may carry a `fill` colour; the plan draws them in it (the blue tanks, the blue cone).
- `lines`, `dashes`, `marks`, `floors`, `pit`, `door`: what is drawn (`dashes` are white lane markings).
- `areaView`: the bounds of the "Whole area" view.
- `layoutVersion`: bump it when the layout changes. Saved settings and positions from an older layout are then reset.

## lessons/course.json

The course: ten lessons in order, with the sources they quote. A lesson marked `soon` is listed but not playable yet. A playable one has:

- `scene`: a generated level (`template`, `level`, `seed`, and for a kerb space `kerbGap`, the body's gap to the kerb the route was planned to), your garage (`garage`: the bay, `start`), or a scene built for the lesson (`build`: `first-metres`, `turning`, `leaving` with `level` and `seed`, or `angled` with `seed`; see `src/core/generator/lessonScenes.ts`).
- `route`: the route the coach teaches, stored so that every device coaches the same one. `start` is the rear-axle pose `[x, z, heading]`; `pieces` are `[direction, steering, metres]`, with direction 1 forward or -1 reverse and steering -1 (full lock left), 0 (straight) or 1 (full lock right). The routes come from the planner with the steering kept to full lock or straight, which is how driving schools teach these manoeuvres and what a coach can name exactly; `test/lessons.test.ts` checks that the planner still finds exactly these routes. A route marked `authored` was written for the lesson instead (the cone course, the U-turn, the one-turn angled entry); the test checks that it clears everything and passes.
- `explain`: paragraphs for the lesson card, each with the `sources` it quotes. Every claim comes from `docs/research/parking-tips.md`; where sources disagree, the text says so.
- `tips`: keyed by step number, shown on the coach card at that step. `cue` (optional) picks the part of the car and the landmark the step's mark is said with, so it matches the handbook's own rule ("your mirror" and "the near line of the green bay").
- `pass`: what passing takes besides touching nothing: `angle` (degrees off straight), `centre` (metres off centre), `kerb` (tyres to the kerb, metres), `moves` (`"par+1"`), `face` (`in` or `out`).

`sources` maps each id to a name and a link.

`garage-561.json` is the photo-surveyed garage around bay 561. Its `notes` give the survey frame used to check the numbers. Generated levels (`src/core/generator`) are built in this same format, so a level can be saved as a file.
