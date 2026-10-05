// Distances around the car: the gap from each side of the body outline, and the ultrasonic parking sensors.
import { heroCorners } from './car';
import { ptSeg, segSeg } from './geometry';
import type { Pt } from './math';
import type { Obstacle } from './scene';
import type { Side, Vehicle } from './vehicle';
import { nearby } from './world';

export type { Side, SensorMount } from './vehicle';
export type SideValues = Record<Side, number>;
export const SIDES: readonly Side[] = ['front', 'rear', 'left', 'right'];

/** Gap from each side of the car's rectangle to the nearest obstacle (9 = nothing near). */
export function edgeGaps(v: Vehicle, obstacles: readonly Obstacle[], x: number, z: number, th: number, out: SideValues): void {
  const C = heroCorners(v, x, z, th);
  const edges: Record<Side, [Pt, Pt]> = { rear: [C[0], C[3]], front: [C[1], C[2]], left: [C[0], C[1]], right: [C[3], C[2]] };
  for (const k of SIDES) out[k] = 9;
  for (const o of nearby(obstacles, x, z, v.L + 10)) {
    if (o.cls === 'kerb') continue;   // the bumpers hang over kerbs
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

// Parking sensors: the car's mounts (vehicle.sensors), each sweeping a cone; ranges and the zone edges come with the car.
/** How far a sensor group hears. */
export const rangeOf = (v: Vehicle, g: Side): number => (g === 'left' || g === 'right' ? v.pdc.side : v.pdc[g]);

/** Nearest obstacle along a ray, capped at maxR. */
export function rayDist(obstacles: readonly Obstacle[], ox: number, oz: number, dx: number, dz: number, maxR: number): number {
  let best = maxR;
  for (const o of obstacles) {
    if (o.cls === 'kerb') continue;   // too low for the sensors
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
export function scanPdc(v: Vehicle, obstacles: readonly Obstacle[], x: number, z: number, th: number, readings: number[], out: SideValues): void {
  const cs = Math.cos(th), sn = Math.sin(th), near = nearby(obstacles, x, z, v.REACH + Math.max(v.pdc.front, v.pdc.rear, v.pdc.side) + 1);
  for (const k of SIDES) out[k] = Infinity;
  v.sensors.forEach((sd, i) => {
    const range = rangeOf(v, sd.g);
    const ox = x + sd.lx * cs + sd.lz * sn, oz = z - sd.lx * sn + sd.lz * cs; let best = range;
    for (let k = -2; k <= 2; k++) {
      const a = sd.a + k * v.pdc.half / 2, lxd = Math.cos(a), lzd = Math.sin(a);
      const d = rayDist(near, ox, oz, lxd * cs + lzd * sn, -lxd * sn + lzd * cs, range); if (d < best) best = d;
    }
    readings[i] = best; if (best < out[sd.g]) out[sd.g] = best;
  });
}
