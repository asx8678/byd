// BYD Atto 2 (2024-): dimensions, the shape seen from above, steering geometry.
// Rear-axle bicycle model. Local frame: rear axle at the origin, x forward, z to the right.
import { DEG, type Pt } from './math';

const L = 4.33, W = 1.83, WB = 2.62, TRACK = 1.57, R_CC = 5.3;   // overhangs from BYD's spec sheet
// Full-lock geometry derived from the published 5.3 m kerb-to-kerb turning radius (outer front wheel):
const R_REAR = Math.sqrt(R_CC * R_CC - WB * WB) - TRACK / 2;   // 3.82 m circle of the rear-axle centre
export const CAR = {
  L, W, H: 1.675, WB, TRACK, OVF: 0.883, OVR: 0.827, WR: 0.334, WW: 0.215, R_CC, MASS: 1580,
  R_REAR,
  MAXSTEER: Math.atan(WB / R_REAR) / DEG,                        // 34.4° single-track angle (inner 40.8°, outer 29.6°)
  R_WALL: Math.hypot(R_REAR + W / 2, WB + 0.883),                // 5.9 m swept by the outer front corner
} as const;

// Driveline: hold to move, release to brake. A short press creeps; keep holding and the target speed ramps up.
export const DRIVE = { V_CREEP_F: 1.2, VMAX_F: 5.5, RAMP_F: 1.1, V_CREEP_R: 0.9, VMAX_R: 2.8, RAMP_R: 0.6, HOLD_T: 1.0, ACC: 2.0, BRAKE: 3.5 } as const;

// The car from above, traced from the body's widest sections so the corners are rounded like the bumpers.
export const BODY_FP: Pt[] = (() => {
  const R: Pt[] = [[3.503, 0.52], [3.40, 0.76], [3.123, 0.878], [2.80, 0.912], [0, 0.915], [-0.58, 0.858], [-0.76, 0.76], [-0.827, 0.62]];
  return [...R, ...R.slice().reverse().map(([a, b]): Pt => [a, -b])];
})();
// Door mirrors, 1.12–1.25 m up: they meet walls, pillars, the low wall and other cars, but pass over the bench and the bins.
export const MIRROR_FP: Pt[][] = [-1, 1].map(sg => [[1.77, sg * 0.90], [1.98, sg * 0.90], [1.98, sg * 1.04], [1.77, sg * 1.04]] as Pt[]);
export const MIRROR_Y = 1.12;
export const PLAN_CORNERS: Pt[] = [[3.40, -0.76], [3.40, 0.76], [-0.76, -0.76], [-0.76, 0.76]];   // FL, FR, RL, RR, on the rounded corners of the footprint

/** Local points of a car at rear-axle pose (px, pz, heading h) in world coordinates. */
export function footprint(px: number, pz: number, h: number, pts: Pt[]): Pt[] {
  const cs = Math.cos(h), sn = Math.sin(h);
  return pts.map(([lx, lz]): Pt => [px + lx * cs + lz * sn, pz - lx * sn + lz * cs]);
}

/** The four corners of a plain rectangle car: rear-left, front-left, front-right, rear-right. */
export function carCorners(ax: number, az: number, h: number, L: number, W: number, _WB: number, OVR: number): Pt[] {
  const cs = Math.cos(h), sn = Math.sin(h), x0 = -OVR, x1 = L - OVR, hw = W / 2;
  const P = (lx: number, lz: number): Pt => [ax + lx * cs + lz * sn, az - lx * sn + lz * cs];
  return [P(x0, -hw), P(x1, -hw), P(x1, hw), P(x0, hw)];
}
export const heroCorners = (px: number, pz: number, h: number): Pt[] => carCorners(px, pz, h, CAR.L, CAR.W, CAR.WB, CAR.OVR);

/** Front wheel angles (left-positive), [fl, fr], for a single-track angle deltaLeft (radians). */
export function ackermann(deltaLeft: number): [number, number] {
  if (Math.abs(deltaLeft) < 1e-4) return [0, 0];
  const Rc = CAR.WB / Math.tan(Math.abs(deltaLeft)), T = CAR.TRACK;
  const inner = Math.atan(CAR.WB / (Rc - T / 2)), outer = Math.atan(CAR.WB / (Rc + T / 2));
  return deltaLeft > 0 ? [inner, outer] : [-outer, -inner];
}
