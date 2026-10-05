// Shared by the street map tests: the cars they drive, the Harbour district for a car and layout, its free spaces by
// kind, and a driver that follows a path.
import { buildCity, type CityMap, type KerbSlot, type LotSlot } from '../../src/core/city';
import { MAPS, VEHICLES } from '../../src/core/content';
import { DEG, clamp, wrapPi, type Pt } from '../../src/core/math';
import { STEP } from '../../src/core/replay';
import type { Obstacle } from '../../src/core/scene';
import type { Sim } from '../../src/core/sim';

export const CARS = ['byd-atto2', 'smart-fortwo-c453', 'ram-1500-dt', 'mercedes-s-class-w223@10'];
export const city = (id: string, seed: number): CityMap => buildCity(MAPS.harbour, VEHICLES[id], seed);
export const kerbSlots = (m: CityMap): KerbSlot[] => m.slots.filter((s): s is KerbSlot => s.kind === 'kerb');
export const lotSlots = (m: CityMap): LotSlot[] => m.slots.filter((s): s is LotSlot => s.kind === 'lot');
export const boxesMeet = (a: Obstacle, b: { bx0: number; bx1: number; bz0: number; bz1: number }): boolean => !(a.bx1 < b.bx0 || b.bx1 < a.bx0 || a.bz1 < b.bz0 || b.bz1 < a.bz0);

/** A driver for the tests: the wheel set so the rear axle arcs through a point a few metres along the path (pure
 *  pursuit), the pedals holding kmh. Touches on the way, and where it ended. */
export function drivePath(sim: Sim, path: Pt[], kmh: number): { hits: number; x: number; z: number; th: number } {
  const v = sim.vehicle;
  let hits = 0, k = 0;
  for (let n = 0; n < 60 * 40; n++) {
    const Ld = 2.5 + 0.25 * sim.v;
    while (k < path.length - 1 && Math.hypot(path[k][0] - sim.x, path[k][1] - sim.z) < Ld) k++;
    if (k === path.length - 1 && Math.hypot(path[k][0] - sim.x, path[k][1] - sim.z) < 2) break;
    const [tx, tz] = path[k], alpha = wrapPi(Math.atan2(-(tz - sim.z), tx - sim.x) - sim.th);
    const delta = Math.atan(2 * v.WB * Math.sin(alpha) / Math.max(1, Math.hypot(tx - sim.x, tz - sim.z)));
    sim.input.wheelHeld = true; sim.wheelAngle = clamp(-delta / DEG / v.MAXSTEER * sim.options.lockDeg, -sim.options.lockDeg, sim.options.lockDeg);
    const e = kmh / 3.6 - sim.v; sim.input.acc = clamp(e, 0, 1); sim.input.brk = clamp(-e, 0, 1);
    hits += sim.step(STEP).filter(ev => ev.type === 'touch').length;
  }
  return { hits, x: sim.x, z: sim.z, th: sim.th };
}
export const arc = (cx: number, cz: number, R: number, a0: number, a1: number): Pt[] => Array.from({ length: 25 }, (_, i) => { const a = a0 + (a1 - a0) * i / 24; return [cx + R * Math.cos(a), cz + R * Math.sin(a)] as Pt; });

