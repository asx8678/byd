// Car geometry that works for any vehicle: placing local outlines in the world, rectangles, Ackermann angles.
// Local frame: rear axle at the origin, x forward, z to the right.
import type { Pt } from './math';
import type { Vehicle } from './vehicle';

/** Local points of a car at rear-axle pose (px, pz, heading h) in world coordinates. */
export function footprint(px: number, pz: number, h: number, pts: readonly Pt[]): Pt[] {
  const cs = Math.cos(h), sn = Math.sin(h);
  return pts.map(([lx, lz]): Pt => [px + lx * cs + lz * sn, pz - lx * sn + lz * cs]);
}

/** The four corners of a plain rectangle car: rear-left, front-left, front-right, rear-right. */
export function carCorners(ax: number, az: number, h: number, L: number, W: number, _WB: number, OVR: number): Pt[] {
  const cs = Math.cos(h), sn = Math.sin(h), x0 = -OVR, x1 = L - OVR, hw = W / 2;
  const P = (lx: number, lz: number): Pt => [ax + lx * cs + lz * sn, az - lx * sn + lz * cs];
  return [P(x0, -hw), P(x1, -hw), P(x1, hw), P(x0, hw)];
}
/** The driven car's bounding rectangle at a rear-axle pose. */
export const heroCorners = (v: Vehicle, px: number, pz: number, h: number): Pt[] => carCorners(px, pz, h, v.L, v.W, v.WB, v.OVR);

/** Front wheel angles (left-positive), [fl, fr], for a single-track angle deltaLeft (radians). */
export function ackermann(v: Vehicle, deltaLeft: number): [number, number] {
  if (Math.abs(deltaLeft) < 1e-4) return [0, 0];
  const Rc = v.WB / Math.tan(Math.abs(deltaLeft)), T = v.TRACK;
  const inner = Math.atan(v.WB / (Rc - T / 2)), outer = Math.atan(v.WB / (Rc + T / 2));
  return deltaLeft > 0 ? [inner, outer] : [-outer, -inner];
}
