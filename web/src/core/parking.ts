// When is a car parked in a bay: all four corners of its rectangle inside the painted lines (with the
// bay's tolerances), and within 6° of straight, nose in or reversed in. Bays open towards +z for now.
import { heroCorners } from './car';
import { DEG, wrapPi } from './math';
import type { Bay } from './scene';
import type { Vehicle } from './vehicle';

export interface InBay { noseIn: boolean; noseOut: boolean; errIn: number; errOut: number }

/** null when any corner is outside the bay; otherwise how straight the car is, either way round. */
export function parkedIn(v: Vehicle, b: Bay, x: number, z: number, th: number): InBay | null {
  const C = heroCorners(v, x, z, th);
  const inside = C.every(p => p[0] >= b.x0 - b.sideTol && p[0] <= b.x1 + b.sideTol && p[1] >= b.headZ && p[1] <= b.z1 + b.mouthTol);
  if (!inside) return null;
  const errIn = wrapPi(th - b.inHeading), errOut = wrapPi(th - b.inHeading - Math.PI);
  return { noseIn: Math.abs(errIn) < 6 * DEG, noseOut: Math.abs(errOut) < 6 * DEG, errIn, errOut };
}
