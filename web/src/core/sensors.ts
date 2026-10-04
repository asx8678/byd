// Distances around the car: the gap from each side of the body outline, and the 12 ultrasonic parking sensors.
import { CAR, heroCorners } from './car';
import { ptSeg, segSeg } from './geometry';
import type { Obstacle } from './garage';
import { DEG, type Pt } from './math';

export type Side = 'front' | 'rear' | 'left' | 'right';
export type SideValues = Record<Side, number>;
export const SIDES: readonly Side[] = ['front', 'rear', 'left', 'right'];

/** Gap from each side of the car's rectangle to the nearest obstacle (9 = nothing near). */
export function edgeGaps(obstacles: readonly Obstacle[], x: number, z: number, th: number, out: SideValues): void {
  const C = heroCorners(x, z, th);
  const edges: Record<Side, [Pt, Pt]> = { rear: [C[0], C[3]], front: [C[1], C[2]], left: [C[0], C[1]], right: [C[3], C[2]] };
  for (const k of SIDES) out[k] = 9;
  for (const o of obstacles) {
    if (o.kind === 'poly') {
      let near = false; for (const p of o.pts) if (Math.abs(p[0] - x) < 14 && Math.abs(p[1] - z) < 14) { near = true; break; }
      if (!near && Math.hypot(o.pts[0][0] - o.pts[2][0], o.pts[0][1] - o.pts[2][1]) < 12) continue;
      for (let i = 0; i < o.pts.length; i++) {
        const p = o.pts[i], q = o.pts[(i + 1) % o.pts.length];
        for (const k of EDGE_ORDER) { const d = segSeg(edges[k][0], edges[k][1], p, q); if (d < out[k]) out[k] = d; }
      }
    } else {
      for (const k of EDGE_ORDER) { const d = Math.max(0, ptSeg(o.x, o.z, edges[k][0][0], edges[k][0][1], edges[k][1][0], edges[k][1][1]) - o.r); if (d < out[k]) out[k] = d; }
    }
  }
}
const EDGE_ORDER: readonly Side[] = ['rear', 'front', 'left', 'right'];

// Parking sensors: four in each bumper (two centre, two corner angled 35° out) and two per side, each a 60° cone.
export const PDC = { front: 1.2, rear: 1.5, side: 0.6, half: 30 * DEG } as const;
export const PDC_BANDS: Record<Side, readonly number[]> = { front: [0.3, 0.6, 0.9, 1.2], rear: [0.3, 0.7, 1.1, 1.5], left: [0.3, 0.45, 0.6], right: [0.3, 0.45, 0.6] };   // zone edges per group, red / amber / green outwards
export const rangeOf = (g: Side): number => (g === 'left' || g === 'right' ? PDC.side : PDC[g]);
export interface SensorMount { g: Side; lx: number; lz: number; a: number }
export const SENSORS: readonly SensorMount[] = (() => {
  const fx = CAR.WB + CAR.OVF - 0.03, rx = -CAR.OVR + 0.02;
  return [
    { g: 'front', lx: fx, lz: -0.26, a: 0 }, { g: 'front', lx: fx, lz: 0.26, a: 0 },
    { g: 'front', lx: fx - 0.08, lz: -0.68, a: -35 * DEG }, { g: 'front', lx: fx - 0.08, lz: 0.68, a: 35 * DEG },
    { g: 'rear', lx: rx, lz: -0.26, a: Math.PI }, { g: 'rear', lx: rx, lz: 0.26, a: Math.PI },
    { g: 'rear', lx: rx + 0.06, lz: -0.68, a: Math.PI + 35 * DEG }, { g: 'rear', lx: rx + 0.06, lz: 0.68, a: Math.PI - 35 * DEG },
    { g: 'left', lx: CAR.WB + 0.3, lz: -0.9, a: -Math.PI / 2 }, { g: 'left', lx: -0.3, lz: -0.9, a: -Math.PI / 2 },
    { g: 'right', lx: CAR.WB + 0.3, lz: 0.9, a: Math.PI / 2 }, { g: 'right', lx: -0.3, lz: 0.9, a: Math.PI / 2 },
  ] as SensorMount[];
})();

/** Nearest obstacle along a ray, capped at maxR. */
export function rayDist(obstacles: readonly Obstacle[], ox: number, oz: number, dx: number, dz: number, maxR: number): number {
  let best = maxR;
  for (const o of obstacles) {
    if (o.kind === 'poly') {
      let near = false; for (const p of o.pts) if (Math.abs(p[0] - ox) < maxR + 8 && Math.abs(p[1] - oz) < maxR + 8) { near = true; break; }
      if (!near && Math.hypot(o.pts[0][0] - o.pts[2][0], o.pts[0][1] - o.pts[2][1]) < 12) continue;
      for (let i = 0; i < o.pts.length; i++) {
        const p = o.pts[i], q = o.pts[(i + 1) % o.pts.length], ex = q[0] - p[0], ez = q[1] - p[1];
        const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-9) continue;
        const t = ((p[0] - ox) * ez - (p[1] - oz) * ex) / den, u = ((p[0] - ox) * dz - (p[1] - oz) * dx) / den;
        if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
      }
    } else {
      const fx = ox - o.x, fz = oz - o.z, bq = fx * dx + fz * dz, cq = fx * fx + fz * fz - o.r * o.r, disc = bq * bq - cq;
      if (cq < 0) best = 0; else if (disc >= 0) { const t = -bq - Math.sqrt(disc); if (t >= 0 && t < best) best = t; }
    }
  }
  return best;
}

/** Each sensor sweeps five rays across its cone; readings[i] is sensor i's distance, out is the closest per group. */
export function scanPdc(obstacles: readonly Obstacle[], x: number, z: number, th: number, readings: number[], out: SideValues): void {
  const cs = Math.cos(th), sn = Math.sin(th);
  for (const k of SIDES) out[k] = Infinity;
  SENSORS.forEach((sd, i) => {
    const range = rangeOf(sd.g);
    const ox = x + sd.lx * cs + sd.lz * sn, oz = z - sd.lx * sn + sd.lz * cs; let best = range;
    for (let k = -2; k <= 2; k++) {
      const a = sd.a + k * PDC.half / 2, lxd = Math.cos(a), lzd = Math.sin(a);
      const d = rayDist(obstacles, ox, oz, lxd * cs + lzd * sn, -lxd * sn + lzd * cs, range); if (d < best) best = d;
    }
    readings[i] = best; if (best < out[sd.g]) out[sd.g] = best;
  });
}
