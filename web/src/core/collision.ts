// What the car would touch in a given pose.
import { BODY_FP, MIRROR_FP, MIRROR_Y, footprint } from './car';
import { circleHitsPoly, polysOverlap } from './geometry';
import type { Obstacle } from './garage';
import type { Pt } from './math';

export type CarPart = '' | 'left mirror' | 'right mirror';
export interface Hit { obstacle: Obstacle; part: CarPart }

/** The first obstacle the car touches at rear-axle pose (px, pz, h), or null. part says whether only a door mirror did it. */
export function collides(obstacles: readonly Obstacle[], px: number, pz: number, h: number): Hit | null {
  let B: Pt[] | null = null, ML: Pt[] = [], MR: Pt[] = [];
  for (const o of obstacles) {
    if (o.bx1 < px - 4.5 || o.bx0 > px + 4.5 || o.bz1 < pz - 4.5 || o.bz0 > pz + 4.5) continue;   // nothing of the car reaches further than 3.7 m from the rear axle
    if (!B) { B = footprint(px, pz, h, BODY_FP); ML = footprint(px, pz, h, MIRROR_FP[0]); MR = footprint(px, pz, h, MIRROR_FP[1]); }
    const tall = o.h > MIRROR_Y, hit = o.kind === 'poly' ? (P: Pt[]) => polysOverlap(P, o.pts) : (P: Pt[]) => circleHitsPoly(o.x, o.z, o.r, P);
    if (hit(B)) return { obstacle: o, part: '' };
    if (tall && hit(ML)) return { obstacle: o, part: 'left mirror' };
    if (tall && hit(MR)) return { obstacle: o, part: 'right mirror' };
  }
  return null;
}
