// A trailer from its data file (content/trailers/*.json) on a car's tow ball: where it goes, what it touches, and when
// the rig folds up (a jackknife). The trailer's wheels roll without slipping, so its axle only ever moves along the
// trailer; the ball goes wherever the car takes it. Local frame: the coupling (the tow ball's centre) at the origin, x
// forward towards the car, z to the right; the trailer points along its heading tth, from its axle to the ball.
// Pure logic with no screen code, like the rest of core/.
import { footprint } from './car';
import type { CarPart } from './collision';
import { circleHitsPoly, polysOverlap } from './geometry';
import { DEG, wrapPi, type Pt } from './math';
import type { InBay } from './parking';
import { bayBox } from './parking';
import { toBay, type Bay, type Obstacle } from './scene';
import type { Vehicle } from './vehicle';
import { nearby } from './world';

/** The file format. Lengths in metres in the trailer's frame: x forward from the coupling, z to the right. */
export interface TrailerSpec {
  format: 1; id: string; name: string; short?: string; basedOn?: string; sources?: string[]; notes?: string;
  estimates?: string[];                                            // figures no source gave: the app says they are estimates
  /** Overall length (coupling to the back) and width; the drawbar from the coupling to the box; the axle behind the
   *  coupling; gross weight (kg). */
  dims: { length: number; width: number; height: number; drawbar: number; axle: number; track: number; wheelRadius: number; wheelWidth: number; mass: number; payload?: number; inside?: number[] };
  /** The A-frame: its width where it meets the box, and where it starts behind the ball (the end of the coupling head). */
  frame: { width: number; head: number };
}

export interface Trailer {
  readonly id: string; readonly name: string; readonly short: string;
  /** From the ball to the axle: how far behind the ball the trailer turns about. */
  readonly L1: number;
  readonly length: number; readonly width: number; readonly drawbar: number; readonly track: number; readonly WR: number; readonly WW: number;
  /** The box, mudguards included; the A-frame from the coupling head to the box; the two tyres. */
  readonly box: Pt[]; readonly frame: Pt[]; readonly wheels: Pt[][];
  /** The furthest any part of the trailer is from the ball. */
  readonly reach: number;
  readonly spec: TrailerSpec;
}

export function makeTrailer(s: TrailerSpec): Trailer {
  const d = s.dims, hw = d.width / 2, fw = s.frame.width / 2, ww = d.wheelWidth / 2;
  const box: Pt[] = [[-d.drawbar, -hw], [-d.drawbar, hw], [-d.length, hw], [-d.length, -hw]];
  const frame: Pt[] = [[-s.frame.head, -0.06], [-s.frame.head, 0.06], [-d.drawbar, fw], [-d.drawbar, -fw]];
  const wheels = [-1, 1].map(sg => [[-d.axle + d.wheelRadius, sg * d.track / 2 - ww], [-d.axle + d.wheelRadius, sg * d.track / 2 + ww], [-d.axle - d.wheelRadius, sg * d.track / 2 + ww], [-d.axle - d.wheelRadius, sg * d.track / 2 - ww]] as Pt[]);
  const reach = Math.max(...[...box, ...frame].map(([a, b]) => Math.hypot(a, b)));
  return { id: s.id, name: s.name, short: s.short ?? s.name, L1: d.axle, length: d.length, width: d.width, drawbar: d.drawbar, track: d.track, WR: d.wheelRadius, WW: d.wheelWidth, box, frame, wheels, reach, spec: s };
}

/** Where the tow ball is with the car at pose (x, z, th). */
export function ballAt(v: Vehicle, x: number, z: number, th: number): Pt {
  const bx = v.tow!.x;
  return [x + bx * Math.cos(th), z - bx * Math.sin(th)];
}

/**
 * The trailer's heading after the ball moves in a straight line from a to b: the tractrix. The axle only moves along
 * the trailer, so the angle φ between the trailer and the ball's way of travel goes as tan(φ/2) · e^(−d/L1): it shrinks
 * as the car pulls the trailer and grows as the car pushes it back. Exact for a straight move, and exactly undone by
 * the move back. The heading stays continuous with the one before (no jump at ±180°).
 */
export function towStep(L1: number, a: Pt, b: Pt, tth: number): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz);
  if (d < 1e-12) return tth;
  const g = Math.atan2(-dz, dx), phi = wrapPi(tth - g), k = Math.exp(-d / (2 * L1));
  return tth + wrapPi(g + 2 * Math.atan2(Math.sin(phi / 2) * k, Math.cos(phi / 2) / k) - tth);
}

/** The angle between the car and its trailer (rad): + when the car points to the left of the trailer, so the trailer
 *  trails off to the car's left behind it. */
export const hitchAngle = (th: number, tth: number): number => wrapPi(th - tth);

/** The ball's distance behind the car's origin (m). */
export const ballBehind = (v: Vehicle): number => -v.tow!.x;

/**
 * Where the rig settles when driven at the car's curvature k, forward (rad): the hitch angle at which it stops
 * changing, sin φ = k (L1 + M cos φ), with M the ball's distance behind the car's origin. null when the car turns
 * too tightly for the trailer to settle (it folds even going forward).
 */
export function settledAngle(v: Vehicle, t: Trailer, k: number): number | null {
  // sin φ − k M cos φ = k L1  →  √(1 + k²M²) · sin(φ − atan(kM)) = k L1
  const M = ballBehind(v), r = Math.hypot(1, k * M), s = k * t.L1 / r;
  return Math.abs(s) > 1 ? null : Math.atan(k * M) + Math.asin(s);
}

/** The hitch angle that keeps the trailer on a circle of curvature kt (its axle's; + turning left as it is pulled):
 *  sin φ − L1 kt cos φ = M kt. */
export function angleForTrailerCurve(v: Vehicle, t: Trailer, kt: number): number {
  const c = t.L1 * kt, d = ballBehind(v) * kt;
  return Math.atan(c) + Math.asin(Math.max(-1, Math.min(1, d / Math.hypot(1, c))));
}

/** How fast the hitch angle changes per metre the car's origin moves (+ forward), at car curvature k. */
export function hitchRate(v: Vehicle, t: Trailer, phi: number, k: number): number {
  const M = ballBehind(v);
  return k * (1 + (M / t.L1) * Math.cos(phi)) - Math.sin(phi) / t.L1;
}

export type TrailerPart = Extract<CarPart, 'trailer' | 'drawbar' | 'trailer wheel'>;
const NONE: readonly Obstacle[] = [];

/** The first obstacle the trailer touches with the ball at (bx, bz) and the trailer pointing along tth: its tyres meet
 *  kerbs, its box and A-frame everything else; the scene's first, then `extra`. */
export function trailerHits(t: Trailer, obstacles: readonly Obstacle[], bx: number, bz: number, tth: number, extra: readonly Obstacle[] = NONE): { obstacle: Obstacle; part: TrailerPart } | null {
  const r = t.reach + 0.8, near = nearby(obstacles, bx, bz, r);
  let B: Pt[] | null = null, F: Pt[] = [], W: Pt[][] | null = null;
  for (let i = 0, n = near.length + extra.length; i < n; i++) {
    const o = i < near.length ? near[i] : extra[i - near.length];
    if (o.bx1 < bx - r || o.bx0 > bx + r || o.bz1 < bz - r || o.bz0 > bz + r) continue;
    if (o.cls === 'kerb' && o.kind === 'poly') {
      W ??= t.wheels.map(w => footprint(bx, bz, tth, w));
      for (const w of W) if (polysOverlap(w, o.pts)) return { obstacle: o, part: 'trailer wheel' };
      continue;
    }
    if (!B) { B = footprint(bx, bz, tth, t.box); F = footprint(bx, bz, tth, t.frame); }
    const hit = o.kind === 'poly' ? (P: Pt[]) => polysOverlap(P, o.pts) : (P: Pt[]) => circleHitsPoly(o.x, o.z, o.r, P);
    if (hit(B)) return { obstacle: o, part: 'trailer' };
    if (hit(F)) return { obstacle: o, part: 'drawbar' };
  }
  return null;
}

/** Whether the trailer touches the car towing it: the rig has folded up (a jackknife). */
export function folded(v: Vehicle, t: Trailer, x: number, z: number, th: number, tth: number): boolean {
  const [bx, bz] = ballAt(v, x, z, th), C = footprint(x, z, th, v.body);
  return polysOverlap(C, footprint(bx, bz, tth, t.frame)) || polysOverlap(C, footprint(bx, bz, tth, t.box));
}

/** The hitch angle at which the trailer first touches the car (rad, the smaller of the two sides), found in steps of
 *  a tenth of a degree. */
const jackCache = new WeakMap<Vehicle, WeakMap<Trailer, number>>();
export function jackknifeAngle(v: Vehicle, t: Trailer): number {
  let m = jackCache.get(v); if (!m) jackCache.set(v, m = new WeakMap());
  let a = m.get(t);
  if (a === undefined) {
    a = Math.PI;
    for (const sg of [-1, 1]) for (let d = 0; d <= 1800; d++) if (folded(v, t, 0, 0, 0, -sg * d * DEG / 10)) { a = Math.min(a, d * DEG / 10); break; }
    m.set(t, a);
  }
  return a;
}

/** The trailer's box as a rectangle in its frame: rear-left, front-left, front-right, rear-right (as carCorners). */
export const boxCorners = (t: Trailer): Pt[] => [[-t.length, -t.width / 2], [-t.drawbar, -t.width / 2], [-t.drawbar, t.width / 2], [-t.length, t.width / 2]];

/** null when any corner of the trailer's box is outside the bay; otherwise how straight it is, either way round
 *  (nose in: its drawbar end first; nose out: reversed in, its back first). A turned bay is judged in its own frame. */
export function trailerIn(t: Trailer, b: Bay, bx: number, bz: number, tth: number): InBay | null {
  const [x, z, th] = toBay(b, bx, bz, tth), C = footprint(x, z, th, boxCorners(t)), [x0, x1, z0, z1] = bayBox(b);
  if (!C.every(p => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1)) return null;
  const errIn = wrapPi(th - b.inHeading), errOut = wrapPi(th - b.inHeading - Math.PI);
  return { noseIn: Math.abs(errIn) < 6 * DEG, noseOut: Math.abs(errOut) < 6 * DEG, errIn, errOut };
}
