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
- `bays`: the painted rectangle, plus how "parked" is judged:
  - `headZ`: how far in the car may reach.
  - `sideTol` and `mouthTol`: tolerances over the side lines and out of the mouth.
  - `inHeading`: the nose-in heading. Reversed-in parking is the opposite heading.
- `starts`: rear-axle poses with a label. `defaultStart` and `defaultBay` pick the defaults.
- `lines`, `marks`, `floors`, `pit`, `door`: what is drawn.
- `areaView`: the bounds of the "Whole area" view.
- `layoutVersion`: bump it when the layout changes. Saved settings and positions from an older layout are then reset.

`garage-561.json` is the photo-surveyed garage around bay 561. Its `notes` give the survey frame used to check the numbers.
