// Scenes made for lessons rather than levels: an empty car park with cones for the first metres, the same with the
// car's swept path painted on the floor, a tight space to leave, and a row of angled bays. Each gives the scene file,
// the bay a try ends in and where the car starts. Deterministic, like the templates; none of them is a Levels template.
import type { Pose } from '../planner';
import type { SceneObstacleSpec, SceneSpec } from '../scene';
import type { Vehicle } from '../vehicle';
import { draft, growWidth, mulberry32 } from './templates';

export type LessonSceneId = 'first-metres' | 'turning' | 'leaving' | 'angled';
/** route: for a lesson written for the scene (not planned), its pieces [dir, lvl, length] from the start, for this car. */
export interface LessonScene { spec: SceneSpec; bay: string; start: Pose; route?: number[][] }

const r2 = (n: number) => Math.round(n * 100) / 100, r6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** How much longer than the Atto 2 a car is: the lesson bays are that much deeper for it (like the levels' bays). */
const deeper = (v: Vehicle): number => Math.max(0, v.L - 4.33);

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rect = (x0: number, x1: number, z0: number, z1: number): number[][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(p => p.map(r3));
const cone = (x: number, z: number, name = 'cone', fill?: string): SceneObstacleSpec => ({ kind: 'circle', x: r3(x), z: r3(z), r: 0.15, name, h: 0.6, cls: 'low', label: '', ...(fill ? { fill } : {}) });
function shell(id: string, name: string, lot: number[]): SceneSpec {
  return { format: 1, id, name, layoutVersion: 1, lot: lot.map(r3), areaView: lot.map(r3), defaultBay: 'target', bays: {}, defaultStart: 'start', starts: {}, lines: [], dashes: [], kerbs: [], landmarks: [], floors: [lot.map(r3)], obstacles: [] };
}
/** A row of painted bays opening towards +z, side lines every w from x0 for n bays, z from back to mouth. */
function bayRow(spec: SceneSpec, x0: number, w: number, n: number, back: number, mouth: number): void {
  for (let i = 0; i <= n; i++) spec.lines.push([x0 + i * w, back, x0 + i * w, mouth].map(r3));
  spec.lines.push([x0, back, x0 + n * w, back].map(r3));
}

/**
 * First metres: drive forward to a stop line, back to a blue cone, then on full lock left into a wide bay. The route
 * is F straight 5 m, R straight 3 m, F full lock left 90°, F straight into the bay until the rear bumper is 17.5 cm in.
 */
export function firstMetres(v: Vehicle): LessonScene {
  const deep = deeper(v), spec = shell('lesson-first-metres', 'Empty car park', [-4, 15, -12.8 - deep, 4.2]);
  const R = v.R_REAR, front = v.WB + v.OVF, m = v.mirrors[1], mirrorX = m ? (m[0][0] + m[1][0]) / 2 : 0.7 * v.WB;
  const stopX = 5 + front, cx = 2 + R, W = 2.8 + growWidth(v), back = -11.5 - deep, mouth = -6.5;
  // the stop line, with a cone at each end; the blue cone where the mirror is when the car has backed up 3 m, on the
  // left inside the circle the car turns on next, or on the right when that circle is too tight to hold it (the Smart's)
  const coneZ = Math.hypot(mirrorX, R - 2.4) + 0.15 + 0.3 <= R - v.W / 2 ? -2.4 : 2.4;
  spec.lines.push([stopX, -1.4, stopX, 1.4].map(r3));
  spec.obstacles.push(cone(stopX, -1.8), cone(stopX, 1.8), cone(2 + mirrorX, coneZ, 'blue cone', '#3b7ddd'), cone(-1.5, -1.6), cone(-1.5, 1.6));
  spec.landmarks = [{ name: 'the stop line', x: r3(stopX), z: 1.2 }, { name: 'the blue cone', x: r3(2 + mirrorX), z: coneZ }];
  // a row of wide bays at the top, the target in line with where the turn ends, and a wall behind them
  bayRow(spec, cx - W / 2 - 2 * W, W, 5, back, mouth);
  spec.obstacles.push({ kind: 'poly', pts: rect(-4, 15, -12.8 - deep, -12.2 - deep), name: 'wall', h: 2.5, cls: 'wall' });
  spec.bays.target = { x0: r3(cx - W / 2), x1: r3(cx + W / 2), z0: back, z1: mouth, headZ: back - 0.25, sideTol: 0.05, mouthTol: 0.1, inHeading: Math.PI / 2, face: 'in' };
  // the quarter turn ends at z = -R; on until the rear bumper is 17.5 cm past the bay's mouth
  const route = [[1, 0, 5], [-1, 0, 3], [1, -1, r6(Math.PI / 2 * R)], [1, 0, r2(v.OVR - R - mouth + 0.175)]];
  return { spec, bay: 'target', start: { x: 0, z: 0, th: 0 }, route };
}

/**
 * How a car turns: a U-turn on full lock left between painted lines that show the car's swept path (the inner rear
 * wheel's circle and the outer front corner's), with cones just outside them, ending straight into a bay.
 * The route is F straight 2 m, F full lock left 180°, F straight into the bay.
 */
export function turning(v: Vehicle): LessonScene {
  const R = v.R_REAR, deep = deeper(v);
  // the inner rear wheel's circle (it sits RA behind the point the car turns about when the rear wheels steer)
  const rIn = Math.hypot(R - v.TRACK / 2, v.RA), rOut = v.R_WALL, cx = R, cz = 2, ex = 2 * R, W = 2.8 + growWidth(v), back = -4 - deep, mouth = 1;
  const spec = shell('lesson-turning', 'Empty car park', [-4, r3(ex + 7), -5.2 - deep, r3(cz + rOut + 2.4)]);
  // the swept path, painted as dashed arcs: where the inner rear wheel runs and where the outer front corner swings
  for (const r of [rIn, rOut]) for (let k = 0; k < 24; k++) {
    const a0 = Math.PI * k / 24, a1 = Math.PI * (k + 1) / 24;
    spec.dashes!.push([cx + r * Math.cos(a0), cz + r * Math.sin(a0), cx + r * Math.cos(a1), cz + r * Math.sin(a1)].map(r3));
  }
  // the turn line under the rear wheels where the turn starts; cones just inside and just outside the swept path
  spec.lines.push([-1.6, cz, 1.6, cz].map(r3));
  spec.landmarks = [{ name: 'the turn line', x: -1.3, z: cz }];
  spec.obstacles.push(cone(cx, cz + rIn - 0.62, 'inner cone'));
  for (const a of [Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4]) spec.obstacles.push(cone(cx + (rOut + 0.55) * Math.cos(a), cz + (rOut + 0.55) * Math.sin(a), 'outer cone'));
  spec.obstacles.push(cone(-1.6, -1.6), cone(1.6, -1.6));
  // the bay the U-turn comes up into, with its neighbours painted, and a wall behind
  bayRow(spec, ex - W / 2 - W, W, 3, back, mouth);
  spec.obstacles.push({ kind: 'poly', pts: rect(-4, ex + 7, -5.2 - deep, -4.6 - deep), name: 'wall', h: 2.5, cls: 'wall' });
  spec.bays.target = { x0: r3(ex - W / 2), x1: r3(ex + W / 2), z0: back, z1: mouth, headZ: back - 0.25, sideTol: 0.05, mouthTol: 0.1, inHeading: Math.PI / 2, face: 'in' };
  // the U-turn ends level with the turn line; on until the rear bumper is 17.3 cm past the bay's mouth
  const route = [[1, 0, 2], [1, -1, r6(Math.PI * R)], [1, 0, r2(cz - mouth + 0.173 + v.OVR)]];
  return { spec, bay: 'target', start: { x: 0, z: 0, th: -Math.PI / 2 }, route };
}

/**
 * Leaving a tight space: a parallel-parking level with the car already parked, nose 35 cm from the car in front, and
 * a stretch of the lane beyond that car to drive out into (a bay of kind 'exit'). The kerb space stays as 'space'.
 */
export function leaving(v: Vehicle, level: number, seed: number): LessonScene {
  const d = draft(v, 'kerb', level, seed), spec = d.spec, space = spec.bays.target;
  if (d.knobs.kind !== 'kerb') throw new Error('leaving needs a kerb level');
  const G = space.x1, laneTop = space.z0, laneW = d.knobs.lane, laneC = laneTop - laneW / 2;
  const ahead = spec.obstacles.find(o => o.name === 'car in front of the space');
  const aheadEnd = ahead && ahead.kind === 'poly' ? Math.max(...ahead.pts.map(p => p[0])) : G + 4.5;
  const ex0 = r3(aheadEnd + 0.5), ex1 = r3(aheadEnd + 9), goals: Pose[] = [];
  for (let x = ex0 + v.OVR + 0.2; x <= ex1 - (v.L - v.OVR) - 0.2 + 1e-9; x += 0.5) for (const dz of [-0.3, 0, 0.3]) goals.push({ x: r3(x), z: r3(laneC + dz), th: 0 });
  spec.bays = {
    space,
    exit: { x0: ex0, x1: ex1, z0: r3(laneTop - laneW), z1: r3(laneTop), headZ: r3(laneTop - laneW), sideTol: 0, mouthTol: 0, inHeading: 0, face: 'in', kind: 'exit', box: [ex0, ex1, r3(laneTop - laneW + 0.05), r3(laneTop + 0.1)], goals },
  };
  spec.defaultBay = 'exit'; spec.name = 'Leaving a tight space'; spec.id = `lesson-leaving-${level}-${seed}`;
  const start: Pose = { x: r3(G - 0.35 - (v.L - v.OVR)), z: r3(-0.15 - v.W / 2), th: 0 };
  return { spec, bay: 'exit', start };
}

/**
 * Angled bays at 60° to the aisle. Built with the bays upright (so every bay is an ordinary box) and the aisle
 * running at 30° across the plan: the car comes up the aisle at heading 30° and turns 60° into the bay. The mouths
 * and back lines slant with the aisle; neighbours are parked in the bays either side, some further along.
 */
export function angled(v: Vehicle, seed: number, out = 1.2, Wb0 = 2.6): LessonScene {
  const Wb = Wb0 + growWidth(v), rnd = mulberry32(seed * 7907 + 60), D = 6.0 + deeper(v), A = 5.2, t30 = Math.tan(Math.PI / 6);
  const mz = (x: number) => -t30 * x;                                         // the line of the mouths
  const ux = Math.cos(Math.PI / 6), uz = -Math.sin(Math.PI / 6), nx = -uz, nz = ux;   // along the aisle, and across it (away from the bays)
  const spec = shell(`lesson-angled-${seed}`, 'Angled bays', [-16, 16, -16, 16]);
  const n = 5, obs: SceneObstacleSpec[] = spec.obstacles;
  for (let i = -n; i <= n + 1; i++) { const x = (i - 0.5) * Wb; spec.lines.push([x, mz(x), x, mz(x) - D].map(r3)); }
  spec.lines.push([-(n + 0.5) * Wb, mz(-(n + 0.5) * Wb) - D, (n + 0.5) * Wb, mz((n + 0.5) * Wb) - D].map(r3));
  // parked cars: both neighbours, and most of the others, nose in or reversed in, a little off centre
  const sizes: [number, number, string][] = [[4.06, 1.75, 'hatchback'], [4.35, 1.83, 'crossover'], [4.7, 1.83, 'estate'], [5.0, 1.9, 'saloon']];
  for (let i = -n; i <= n; i++) {
    if (i === 0 || (Math.abs(i) > 1 && rnd() < 0.3)) continue;
    const [L, W, label] = sizes[Math.floor(rnd() * sizes.length)], x = i * Wb + (rnd() - 0.5) * 0.2, z = mz(x) - D / 2 - 0.2 + (rnd() - 0.5) * 0.3;
    obs.push({ kind: 'poly', pts: rect(x - W / 2, x + W / 2, z - L / 2, z + L / 2), name: i === -1 ? 'car in the near bay' : i === 1 ? 'car in the far bay' : 'parked car', h: 1.5, cls: 'car', label });
  }
  // the wall across the aisle, and the end of the car park behind the bays
  const along = (t: number, off: number): number[] => [t * ux + off * nx, t * uz + off * nz];
  obs.push({ kind: 'poly', pts: [along(-24, A), along(24, A), along(24, A + 0.5), along(-24, A + 0.5)].map(p => p.map(r3)), name: 'wall', h: 2.5, cls: 'wall' });
  obs.push({ kind: 'poly', pts: [along(-24, -D - 0.6), along(24, -D - 0.6), along(24, -D - 1.1), along(-24, -D - 1.1)].map(p => p.map(r3)), name: 'back wall', h: 2.5, cls: 'wall' });
  // the target bay as an upright box: corners in front of the slanting mouth at the car's right side, short of the back line at its left
  const x0 = -Wb / 2, x1 = Wb / 2, mouth = r3(mz(v.W / 2 + 0.05)), head = r3(mz(-(v.W / 2 + 0.05)) - D);
  spec.bays.target = { x0: r3(x0), x1: r3(x1), z0: head, z1: mouth, headZ: head, sideTol: 0.05, mouthTol: 0.1, inHeading: Math.PI / 2, face: 'in' };
  // come up the aisle `out` m (1.2: Georgia's 3–4 ft) out from the parked cars' ends, a few bays before the target
  const start: Pose = { x: r3(-9 * ux + (out + v.W / 2) * nx), z: r3(-9 * uz + (out + v.W / 2) * nz), th: Math.PI / 6 };
  // one turn: along the aisle until full lock left 60° ends on the bay's centre line, then straight in to the middle of its depth
  const R = v.R_REAR, box = spec.bays.target, xTurn = -(1 - Math.sin(start.th)) * R, t = (xTurn - start.x) / Math.cos(start.th);
  const zArc = start.z - t * Math.sin(start.th) - Math.cos(start.th) * R, zEnd = box.headZ + ((box.z1 + 0.1 - box.headZ) - v.L) / 2 + (v.WB + v.OVF);
  const route = [[1, 0, r6(t)], [1, -1, r6((Math.PI / 2 - start.th) * R)], [1, 0, r6(zArc - zEnd)]];
  return { spec, bay: 'target', start, route };
}

export function lessonScene(v: Vehicle, id: LessonSceneId, level = 1, seed = 1): LessonScene {
  return id === 'first-metres' ? firstMetres(v) : id === 'turning' ? turning(v) : id === 'leaving' ? leaving(v, level, seed) : angled(v, seed);
}
