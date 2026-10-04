// What the car would touch in a given pose.
import { footprint } from './car';
import { circleHitsPoly, polysOverlap } from './geometry';
import type { Pt } from './math';
import type { Obstacle } from './scene';
import type { Vehicle } from './vehicle';

export type CarPart = '' | 'left mirror' | 'right mirror';
export interface Hit { obstacle: Obstacle; part: CarPart }

/** The first obstacle the car touches at rear-axle pose (px, pz, h), or null. part says whether only a door mirror did it. */
export function collides(v: Vehicle, obstacles: readonly Obstacle[], px: number, pz: number, h: number): Hit | null {
  let B: Pt[] | null = null, ML: Pt[] = [], MR: Pt[] = [];
  for (const o of obstacles) {
    if (o.bx1 < px - 4.5 || o.bx0 > px + 4.5 || o.bz1 < pz - 4.5 || o.bz0 > pz + 4.5) continue;   // nothing of the car reaches further than 3.7 m from the rear axle
    if (!B) { B = footprint(px, pz, h, v.body); if (v.mirrors.length) { ML = footprint(px, pz, h, v.mirrors[0]); MR = footprint(px, pz, h, v.mirrors[1]); } }
    const tall = o.h > v.mirrorY && v.mirrors.length > 0, hit = o.kind === 'poly' ? (P: Pt[]) => polysOverlap(P, o.pts) : (P: Pt[]) => circleHitsPoly(o.x, o.z, o.r, P);
    if (hit(B)) return { obstacle: o, part: '' };
    if (tall && hit(ML)) return { obstacle: o, part: 'left mirror' };
    if (tall && hit(MR)) return { obstacle: o, part: 'right mirror' };
  }
  return null;
}
