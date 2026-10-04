// What the car would touch in a given pose.
import { footprint } from './car';
import { circleHitsPoly, polysOverlap } from './geometry';
import type { Pt } from './math';
import type { Obstacle } from './scene';
import type { Vehicle } from './vehicle';

export type WheelPart = 'front left wheel' | 'front right wheel' | 'rear left wheel' | 'rear right wheel';
export type CarPart = '' | 'left mirror' | 'right mirror' | WheelPart;
export interface Hit { obstacle: Obstacle; part: CarPart }

/** The four tyres seen from above (straight ahead), in the car's local frame. */
const wheelCache = new WeakMap<Vehicle, { part: WheelPart; pts: Pt[] }[]>();
export function wheelsOf(v: Vehicle): { part: WheelPart; pts: Pt[] }[] {
  let w = wheelCache.get(v);
  if (!w) {
    w = [];
    for (const [ax, end] of [[v.WB, 'front'], [0, 'rear']] as const) for (const [sg, side] of [[-1, 'left'], [1, 'right']] as const) {
      const z = sg * v.TRACK / 2;
      w.push({ part: `${end} ${side} wheel`, pts: [[ax - v.WR, z - v.WW / 2], [ax + v.WR, z - v.WW / 2], [ax + v.WR, z + v.WW / 2], [ax - v.WR, z + v.WW / 2]] });
    }
    wheelCache.set(v, w);
  }
  return w;
}

/** The first obstacle the car touches at rear-axle pose (px, pz, h), or null. part says whether only a door mirror or a wheel did it. */
export function collides(v: Vehicle, obstacles: readonly Obstacle[], px: number, pz: number, h: number): Hit | null {
  let B: Pt[] | null = null, ML: Pt[] = [], MR: Pt[] = [], WH: { part: WheelPart; pts: Pt[] }[] | null = null;
  for (const o of obstacles) {
    if (o.bx1 < px - 4.5 || o.bx0 > px + 4.5 || o.bz1 < pz - 4.5 || o.bz0 > pz + 4.5) continue;   // nothing of the car reaches further than 3.7 m from the rear axle
    if (o.cls === 'kerb' && o.kind === 'poly') {   // only the tyres meet a kerb
      if (!WH) WH = wheelsOf(v).map(w => ({ part: w.part, pts: footprint(px, pz, h, w.pts) }));
      for (const w of WH) if (polysOverlap(w.pts, o.pts)) return { obstacle: o, part: w.part };
      continue;
    }
    if (!B) { B = footprint(px, pz, h, v.body); if (v.mirrors.length) { ML = footprint(px, pz, h, v.mirrors[0]); MR = footprint(px, pz, h, v.mirrors[1]); } }
    const tall = o.h > v.mirrorY && v.mirrors.length > 0, hit = o.kind === 'poly' ? (P: Pt[]) => polysOverlap(P, o.pts) : (P: Pt[]) => circleHitsPoly(o.x, o.z, o.r, P);
    if (hit(B)) return { obstacle: o, part: '' };
    if (tall && hit(ML)) return { obstacle: o, part: 'left mirror' };
    if (tall && hit(MR)) return { obstacle: o, part: 'right mirror' };
  }
  return null;
}
