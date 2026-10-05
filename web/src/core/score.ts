// Stars for a parked result, one per skill: no touching, neat (straight and centred, or close to the kerb),
// and efficient (no more than one move over par, inside the time). Par is the planner's best route, which
// is not a proven minimum, so beating it is possible.
import { NEAT } from './parking';
import type { ParkedResult } from './sim';

export interface Stars { clean: boolean; neat: boolean; efficient: boolean; count: number }

export function starsFor(r: ParkedResult, par: number, timeLimit: number): Stars {
  const clean = r.hits === 0;
  const neat = Math.abs(r.angle) <= NEAT.angle && (r.kind === 'kerb' ? r.kerbGap <= NEAT.kerb : r.kind === 'exit' || Math.abs(r.offCentre) <= NEAT.centre);
  const efficient = r.moves <= par + 1 && r.elapsed <= timeLimit;
  return { clean, neat, efficient, count: +clean + +neat + +efficient };
}
