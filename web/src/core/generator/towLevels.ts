// Trailer levels: reverse the box trailer behind the Octavia into a space, from level 1 (straight back into a wide space)
// to level 10 (round a tight corner into a narrow space between parked cars, on either side). A level is its number
// and a seed, like the car templates' levels, and it is solved before you see it: the coach's guided driver and a
// slower, later one both back the trailer in without touching anything or losing it, neatly enough for the accuracy
// star. When they cannot, the next layout for the seed is tried, then the level is eased a step.
import { BOX_TRAILER, TOW_CAR, vehicleFor } from '../content';
import { clamp } from '../math';
import { TOW_DRIVERS, towDrive } from '../robot';
import { makeScene, type SceneObstacleSpec, type SceneSpec } from '../scene';
import { TowPath, type PathSeg } from '../towing';
import type { Trailer } from '../trailer';
import type { Vehicle } from '../vehicle';
import { rigAt, startFor, type RigPose } from './towScenes';
import { mulberry32 } from './templates';
import type { Level } from './level';

/** What a trailer level's number turned into. side: where the space is as you drive past it (left: the driver's side). */
export interface TowKnobs { kind: 'tow'; space: number; approach: 'straight' | 'corner'; radius: number; side: 'left' | 'right'; neighbours: number | null; cones: boolean; offset: number }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rect = (x0: number, x1: number, z0: number, z1: number): number[][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(p => p.map(r3));
const cone = (x: number, z: number): SceneObstacleSpec => ({ kind: 'circle', x: r3(x), z: r3(z), r: 0.15, name: 'cone', h: 0.6, cls: 'low', label: '' });

/** The settings for a level and seed. */
export function towKnobs(level: number, seed: number): TowKnobs {
  const rnd = mulberry32(seed * 7841 + level * 131), t = (level - 1) / 9;
  return {
    kind: 'tow', space: r3(3.4 - 1.0 * t + (rnd() - 0.5) * 0.1),
    approach: level <= 2 ? 'straight' : 'corner', radius: r3(9.5 - 2.5 * t + (rnd() - 0.5) * 0.4),
    side: level >= 6 && rnd() < 0.5 ? 'right' : 'left',
    neighbours: level >= 3 ? r3(0.7 - 0.45 * t + rnd() * 0.1) : null,   // the gap from the space's line to the car beside it
    cones: level >= 6, offset: r3((1 + 3 * t) * (rnd() < 0.5 ? -1 : 1)),
  };
}

/** The yard for a level: the space, its neighbours, the cones, the far fence, and the trailer's path to it. */
export function towYard(v: Vehicle, t: Trailer, k: TowKnobs, rnd: () => number, id: string): { spec: SceneSpec; start: RigPose; path: TowPath } {
  const W = k.space, D = 4.0, z1 = D, sg = k.side === 'left' ? 1 : -1;   // the space opens towards +z, its back line at z = 0
  const final = r3(5.5 + 1.5 * rnd()), lead = r3(2 + 3 * rnd());
  const segs: PathSeg[] = k.approach === 'straight' ? [{ line: 12 }] : [{ line: lead }, { r: k.radius, turn: -sg * Math.PI / 2 }, { line: final }];
  const goal = { x: 0, z: 0.45 + (t.length - t.L1) }, s = startFor(goal, -Math.PI / 2, segs);
  // the rig starts past the space heading away from it (along +x for the driver's side, -x for the other), the
  // trailer off by the level's few degrees
  const th = k.approach === 'straight' ? -Math.PI / 2 : sg > 0 ? 0 : Math.PI, off = k.offset * Math.PI / 180;
  const start = rigAt(v, t, s.x, s.z, th, th + off);
  const reachX = k.approach === 'straight' ? 6 : sg * (k.radius + lead + 12), farZ = k.approach === 'straight' ? 26 : r3(z1 + final + k.radius + 4.2 + 2 * rnd());
  const x0 = Math.min(-12, reachX - 4), x1 = Math.max(12, reachX + 4);
  const spec: SceneSpec = { format: 1, id, name: 'Trailer yard', layoutVersion: 1, lot: [x0, x1, -2.2, farZ + 1.5].map(r3), areaView: [x0, x1, -2.2, farZ + 1.5].map(r3), defaultBay: 'target', bays: {}, defaultStart: 'start', starts: {}, lines: [], dashes: [], kerbs: [], landmarks: [], floors: [[x0, x1, -2.2, farZ + 1.5].map(r3)], obstacles: [] };
  spec.lines.push([-W / 2, z1, -W / 2, 0].map(r3), [-W / 2, 0, W / 2, 0].map(r3), [W / 2, 0, W / 2, z1].map(r3));
  spec.bays.target = { x0: r3(-W / 2), x1: r3(W / 2), z0: 0, z1: r3(z1), headZ: -0.25, sideTol: 0.05, mouthTol: 0.1, inHeading: Math.PI / 2, face: 'out', towed: true };
  spec.obstacles.push({ kind: 'poly', pts: rect(x0, x1, -0.9, -0.5), name: 'wall', h: 2.0, cls: 'wall' });
  if (k.neighbours !== null) for (const side of [-1, 1]) {   // a car in the space either side, the gap each side of it
    const cx = side * (W / 2 + k.neighbours + 0.9), outer = side * (W / 2 + 2 * k.neighbours + 1.8);
    spec.lines.push([outer, z1, outer, 0].map(r3));
    spec.obstacles.push({ kind: 'poly', pts: rect(cx - 0.9, cx + 0.9, 0.4, 0.4 + 4.45), name: 'car in the next space', h: 1.5, cls: 'car', label: 'estate' });
  }
  if (k.cones && k.approach === 'corner') {   // the corner's inside, where the trailer cuts in
    const cx = sg * k.radius, cz = goal.z + final;
    for (const a of [0.2, 0.5, 0.8]) spec.obstacles.push(cone(cx - sg * (k.radius - 2.1) * Math.cos(a * Math.PI / 2), cz + (k.radius - 2.1) * Math.sin(a * Math.PI / 2)));
  }
  spec.obstacles.push({ kind: 'poly', pts: rect(x0, x1, farZ, farZ + 0.4), name: 'fence', h: 2.0, cls: 'wall' });
  return { spec, start, path: TowPath.build({ x: s.x, z: s.z, th: s.th }, segs) };
}

/** How hard a level measured, 1–10: the space against the trailer, the corner, the neighbours and the cones. */
const scoreOf = (k: TowKnobs): number => clamp(1 + 4 * clamp((3.4 - k.space) / 1.0, 0, 1) + (k.approach === 'corner' ? 1.5 + 1.5 * clamp((9.5 - k.radius) / 2.5, 0, 1) : 0) + (k.neighbours !== null ? 1 : 0) + (k.cones ? 0.5 : 0) + (k.side === 'right' ? 0.5 : 0), 1, 10);

/**
 * A trailer level, solved: the guided driver and the slow, late one both back the trailer in cleanly and neatly. The
 * same level and seed always give the same level. null only if even level 1 has no clean way in (it always has).
 */
export function generateTow(level: number, seed: number, tries = 4): Level | null {
  const v = vehicleFor(TOW_CAR), t = BOX_TRAILER;
  for (let knob = level; knob >= 1; knob--) for (let k = 0; k < tries; k++) {
    const s2 = seed + k * 100003, rnd = mulberry32(s2 * 613 + knob), knobs = towKnobs(knob, s2), Y = towYard(v, t, knobs, rnd, `tow-${level}-${seed}`);
    Y.spec.starts = { start: { x: Y.start.x, z: Y.start.z, th: Y.start.th, label: knobs.side === 'left' ? 'Reverse the trailer into the green space on the driver’s side.' : 'Reverse the trailer into the green space: on the passenger side this time, where you see less.' } };
    const scene = makeScene(Y.spec);
    let ok = true;
    for (const [, o] of TOW_DRIVERS.slice(0, 2)) {
      const res = towDrive(v, t, scene, 'target', Y.start, Y.path, o);
      if (!res.r || res.touches || res.lost || Math.abs(res.r.angle) > 3 || Math.abs(res.r.offCentre) > 0.15) { ok = false; break; }
    }
    if (!ok) continue;
    const limit = Math.ceil((20 + 2.5 * Y.path.len + 12) / 5) * 5;
    return {
      key: `tow:${level}:${seed}`, template: 'tow', level, seed, scene, route: [], par: 1, timeLimit: limit,
      measure: { moves: 1, length: Y.path.len, minClear: 0, score: scoreOf(knobs) }, knobs, knobLevel: knob, nodes: 0,
      tow: { car: v, trailer: t, start: Y.start, path: Y.path },
    };
  }
  return null;
}
