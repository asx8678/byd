# Scenario generator prototype

This is the working prototype from the build plan (`docs/build-plan.html`, "Try the generator"). It was the starting point for M2 (route planner), M3 (scenario generator) and M4 (the coach); all three now live in `src/core` (`planner.ts`, `generator/`, `coach.ts`), and this copy stays for the build plan page. It plans for the Atto 2 only, and is not part of the app build.

- `field.ts`: a fast stand-in for the game's collision check, used inside the search.
  - Obstacles are rasterised at 5 cm with a distance field.
  - The car's outline and mirrors are tested against the raster.
  - Kerbs are half-planes the wheels may not cross; the bumpers may overhang them.
- `planner.ts`: hybrid A* over position and heading, in the core's conventions.
  - Moves are short near obstacles and long in open space.
  - Costs: reversing, changing direction, changing the steering, and driving close to things.
  - A full-lock arc then a straight line finishes the search when it can.
  - `outward: true` searches from the parked pose to the entrance and returns the route reversed.
- `templates.ts`: the bays (forward or reverse) and kerb (parallel) templates.
  - `level` 1–10 sets the knobs.
  - The same template, level and seed always give the same scene.
- `route.ts`: what a route means:
  - the exact re-check with the core's `collides`
  - moves, approach clearance and measured difficulty
  - the coach's steps, worded towards or away from the kerb or bay
- `generate.ts`: build, solve, check, measure. It eases or tightens the settings until the measured difficulty is within 2.5 of the level asked.
- `demo.ts`: the in-page demo.
- `headless.ts`: bay 561 from the left, then a seed matrix (3 templates × 4 levels × 8 seeds).

```sh
npx vite build --config prototype/generator/vite.config.mjs --mode node && node prototype/generator/dist/headless.mjs
npx vite build --config prototype/generator/vite.config.mjs   # dist/demo.js for the page
```

Known limits, to fix when it moves into `src/core` in M2:
- The garage search from a fixed start takes a few seconds. It needs finishing shots into a bay.
- Searches stop after a number of steps. Shipped levels should carry their solved route.
- The kerb rule (wheels may not cross, bumpers may overhang) lives here, not yet in the core.
