// When is a car parked: all four corners of its rectangle inside the bay's box (by default the painted lines with
// the bay's tolerances), stopped and within 6° of straight, the way round the bay asks for. Bays open towards +z.
// Also how well: off centre, the angle, and in a space along a kerb, the tyres' gap to the kerb.
import { footprint, heroCorners } from './car';
import { wheelsOf } from './collision';
import { DEG, wrapPi } from './math';
import { besideKerb, toBay, type Bay, type Kerb, type Rect } from './scene';
import type { Vehicle } from './vehicle';

export interface InBay { noseIn: boolean; noseOut: boolean; errIn: number; errOut: number }

/** Where all four corners must be: [x0, x1, z0, z1]. */
export const bayBox = (b: Bay): Rect => b.box ?? [b.x0 - b.sideTol, b.x1 + b.sideTol, b.headZ, b.z1 + b.mouthTol];

/** null when any corner is outside the bay; otherwise how straight the car is, either way round. A turned bay is
 *  judged in its own frame. */
export function parkedIn(v: Vehicle, b: Bay, wx: number, wz: number, wth: number): InBay | null {
  const [x, z, th] = toBay(b, wx, wz, wth), C = heroCorners(v, x, z, th), [x0, x1, z0, z1] = bayBox(b);
  const inside = C.every(p => p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1);
  if (!inside) return null;
  const errIn = wrapPi(th - b.inHeading), errOut = wrapPi(th - b.inHeading - Math.PI);
  return { noseIn: Math.abs(errIn) < 6 * DEG, noseOut: Math.abs(errOut) < 6 * DEG, errIn, errOut };
}

/** Straight, and the way round the bay asks for: nose in, reversed in, or either. */
export function facesRight(b: Bay, at: InBay): boolean {
  const f = b.face ?? 'either';
  return f === 'in' ? at.noseIn : f === 'out' ? at.noseOut : at.noseIn || at.noseOut;
}

/** The kerb-side tyres' gap to the nearest kerb beside them, the larger of the two (m); Infinity with no kerbs. */
export function tyreGap(v: Vehicle, kerbs: readonly Kerb[], x: number, z: number, th: number): number {
  let near = Infinity, gap = Infinity;
  for (const k of kerbs) {
    const g = wheelsOf(v).map(w => Math.min(...footprint(x, z, th, w.pts).map(p => (besideKerb(k, p[0], p[1]) ? k.c - (k.nx * p[0] + k.nz * p[1]) : Infinity)))).sort((a, b) => a - b);
    if (g[0] < near) { near = g[0]; gap = g[1]; }
  }
  return gap;
}

/** How a parked car sits: off centre across the bay (m, + to the right as you sit in the car), degrees off straight, tyres to the kerb (m). */
export interface Placement { offCentre: number; angle: number; kerbGap: number }
export function placement(v: Vehicle, b: Bay, kerbs: readonly Kerb[], x: number, z: number, th: number, at: InBay): Placement {
  const [bx, , bth] = toBay(b, x, z, th), cx = bx + (v.WB / 2) * Math.cos(bth);
  return {
    offCentre: b.kind === 'exit' ? 0 : (at.noseIn ? 1 : -1) * (cx - (b.x0 + b.x1) / 2), angle: (at.noseIn ? at.errIn : at.errOut) / DEG,
    kerbGap: b.kind === 'kerb' ? tyreGap(v, kerbs, x, z, th) : Infinity,
  };
}

/** Neatly parked: within 3° of straight, and centred within 15 cm in a bay or the tyres within 30 cm of the kerb
 *  (out in the lane after leaving a space, straight is enough). */
export const NEAT = { angle: 3, centre: 0.15, kerb: 0.30 };
export const isNeat = (b: Bay, p: Placement): boolean => Math.abs(p.angle) <= NEAT.angle && (b.kind === 'kerb' ? p.kerbGap <= NEAT.kerb : b.kind === 'exit' || Math.abs(p.offCentre) <= NEAT.centre);
