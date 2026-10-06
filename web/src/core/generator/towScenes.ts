// Yards for the towing lessons: a cone-lined lane to reverse a trailer straight down, a corner to reverse it round into
// a side lane, and a row of spaces between parked cars. Each gives the scene file, the space the trailer goes into
// (a towed bay: the trailer is judged, not the car), where the rig starts, and the path the trailer's axle follows
// (see towing.ts). The trailer always finishes reversed into a space that opens towards +z, like every other bay.
// Deterministic, like the templates; the paths are worked out for the trailer and the car that tows it.
import type { SceneObstacleSpec, SceneSpec } from '../scene';
import { TowPath, type PathSeg } from '../towing';
import type { Trailer } from '../trailer';
import type { Vehicle } from '../vehicle';

export type TowSceneId = 'tow-straight' | 'tow-corner' | 'tow-bay';
/** The rig's start: the car's pose and the trailer's heading. */
export interface RigPose { x: number; z: number; th: number; tth: number }
export interface TowScene { spec: SceneSpec; bay: string; start: RigPose; path: TowPath }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const rect = (x0: number, x1: number, z0: number, z1: number): number[][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(p => p.map(r3));
const cone = (x: number, z: number, name = 'cone'): SceneObstacleSpec => ({ kind: 'circle', x: r3(x), z: r3(z), r: 0.15, name, h: 0.6, cls: 'low', label: '' });
function shell(id: string, name: string, lot: number[]): SceneSpec {
  return { format: 1, id, name, layoutVersion: 1, lot: lot.map(r3), areaView: lot.map(r3), defaultBay: 'target', bays: {}, defaultStart: 'start', starts: {}, lines: [], dashes: [], kerbs: [], landmarks: [], floors: [lot.map(r3)], obstacles: [] };
}

/** The space for the trailer, opening towards +z with its back line at z0: 2.8 m wide and 4 m deep, judged on the
 *  trailer's box (reversed in, so it points out of the space), with a wall behind it. The trailer's axle finishes
 *  where its box's back is 45 cm from the back line. */
function trailerBay(spec: SceneSpec, t: Trailer, cx: number, z0: number, wall = true): { x: number; z: number } {
  const W = 2.8, D = 4.0, x0 = cx - W / 2, x1 = cx + W / 2, z1 = z0 + D;
  spec.lines.push([x0, z1, x0, z0].map(r3), [x0, z0, x1, z0].map(r3), [x1, z0, x1, z1].map(r3));
  spec.bays.target = { x0: r3(x0), x1: r3(x1), z0: r3(z0), z1: r3(z1), headZ: r3(z0 - 0.25), sideTol: 0.05, mouthTol: 0.1, inHeading: Math.PI / 2, face: 'out', towed: true };
  if (wall) spec.obstacles.push({ kind: 'poly', pts: rect(cx - 3.2, cx + 3.2, z0 - 0.9, z0 - 0.5), name: 'wall', h: 2.0, cls: 'wall' });
  return { x: cx, z: z0 + 0.45 + (t.length - t.L1) };
}

/** Where the car starts for the trailer's axle at (ax, az) with the trailer at heading tth and the car at th. */
export function rigAt(v: Vehicle, t: Trailer, ax: number, az: number, th: number, tth: number): RigPose {
  const bx = ax + t.L1 * Math.cos(tth), bz = az - t.L1 * Math.sin(tth), d = v.tow!.x;   // the ball, then the car's origin ahead of it
  return { x: bx - d * Math.cos(th), z: bz + d * Math.sin(th), th, tth };
}

/** The axle's start for a path of pieces that ends at `goal` heading `th` (the trailer's heading there), worked back. */
export function startFor(goal: { x: number; z: number }, th: number, segs: readonly PathSeg[]): { x: number; z: number; th: number } {
  let x = goal.x, z = goal.z, h = th;
  for (let i = segs.length - 1; i >= 0; i--) {
    const sg = segs[i], g = h + Math.PI;   // the way the axle was travelling at the end of this piece
    if ('line' in sg) { x -= sg.line * Math.cos(g); z += sg.line * Math.sin(g); continue; }
    const k = Math.sign(sg.turn) / sg.r, g0 = g - k * sg.r * Math.abs(sg.turn);
    x -= (Math.sin(g) - Math.sin(g0)) / k; z -= (Math.cos(g) - Math.cos(g0)) / k; h = g0 - Math.PI;
  }
  return { x, z, th: h };
}

/**
 * Reversing straight: a lane of cones 3.2 m wide and 13 m long down to the space. The rig starts pointing away from it
 * with the trailer 3° off to the car's left, so the trailer has to be kept straight from the first metre.
 */
export function towStraight(v: Vehicle, t: Trailer): TowScene {
  const spec = shell('tow-straight', 'Trailer yard', [-9, 9, -2.2, 26]), goal = trailerBay(spec, t, 0, 0), segs: PathSeg[] = [{ line: 13 }];
  const s = startFor(goal, -Math.PI / 2, segs), off = 3 * Math.PI / 180;
  for (let z = 4.6; z <= 15.9; z += 2.25) spec.obstacles.push(cone(-1.6, z), cone(1.6, z));
  spec.obstacles.push({ kind: 'poly', pts: rect(-9, 9, -2.2, -1.6), name: 'fence', h: 2.0, cls: 'wall' });
  return { spec, bay: 'target', start: rigAt(v, t, s.x, s.z, -Math.PI / 2, -Math.PI / 2 - off), path: TowPath.build(s, segs) };
}

/**
 * Round a corner: the rig starts on a yard road heading east; the trailer goes back along the road, round a corner to
 * the driver's side (the left) on an 8 m arc, and up a side lane into the space at its end. Cones mark the lane and
 * the corner's inside.
 */
export function towCorner(v: Vehicle, t: Trailer): TowScene {
  const spec = shell('tow-corner', 'Trailer yard', [-10, 26, -2.2, 26]), goal = trailerBay(spec, t, 0, 0);
  const segs: PathSeg[] = [{ line: 4 }, { r: 8, turn: -Math.PI / 2 }, { line: 8.5 }], s = startFor(goal, -Math.PI / 2, segs);
  // the side lane up to the space, and the corner's inside where the trailer cuts in
  for (let z = 4.6; z <= 12.0; z += 2.0) spec.obstacles.push(cone(-1.7, z), cone(1.7, z));
  const cx = 8, cz = goal.z + 8.5;   // the arc's centre: the corner's inside
  for (const a of [0.15, 0.5, 0.85]) spec.obstacles.push(cone(cx - 4.9 * Math.cos(a * Math.PI / 2), cz + 4.9 * Math.sin(a * Math.PI / 2), 'corner cone'));
  spec.obstacles.push({ kind: 'poly', pts: rect(-10, 26, -2.2, -1.6), name: 'fence', h: 2.0, cls: 'wall' });
  return { spec, bay: 'target', start: rigAt(v, t, s.x, s.z, 0, 0), path: TowPath.build({ x: s.x, z: s.z, th: 0 }, segs) };
}

/**
 * Into a space: a row of spaces on the driver's side of an aisle, with cars parked either side of the free one. The rig
 * starts past the space, and the trailer goes back on a 7 m turn and straight in.
 */
export function towBay(v: Vehicle, t: Trailer): TowScene {
  const spec = shell('tow-bay', 'Trailer yard', [-12, 24, -2.2, 19]), goal = trailerBay(spec, t, 0, 0, false);
  const segs: PathSeg[] = [{ line: 2 }, { r: 7, turn: -Math.PI / 2 }, { line: 5 }], s = startFor(goal, -Math.PI / 2, segs);
  // the spaces either side, 2.8 m wide, with a car in each of the next two, and a wall along the back of the row
  for (const cx of [-5.6, -2.8, 2.8, 5.6]) spec.lines.push([cx - 1.4, 4.0, cx - 1.4, 0].map(r3), [cx + 1.4, 4.0, cx + 1.4, 0].map(r3), [cx - 1.4, 0, cx + 1.4, 0].map(r3));
  for (const [cx, name] of [[-2.8, 'car in the next space'], [2.8, 'car in the next space'], [-5.6, 'parked car']] as const)
    spec.obstacles.push({ kind: 'poly', pts: rect(cx - 0.9, cx + 0.9, 0.4, 4.85), name, h: 1.5, cls: 'car', label: 'estate' });
  spec.obstacles.push({ kind: 'poly', pts: rect(-12, 24, -0.9, -0.5), name: 'wall', h: 2.0, cls: 'wall' });
  // the far side of the aisle: a fence 13 m across from the spaces
  spec.obstacles.push({ kind: 'poly', pts: rect(-12, 24, 17.0, 17.4), name: 'fence', h: 2.0, cls: 'wall' });
  return { spec, bay: 'target', start: rigAt(v, t, s.x, s.z, 0, 0), path: TowPath.build({ x: s.x, z: s.z, th: 0 }, segs) };
}

export function towScene(v: Vehicle, t: Trailer, id: TowSceneId): TowScene {
  return id === 'tow-straight' ? towStraight(v, t) : id === 'tow-corner' ? towCorner(v, t) : towBay(v, t);
}
