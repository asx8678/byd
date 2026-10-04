// The route planner: known cases in the garage, an open bay, a blocked bay, and the same answer every time.
import { describe, expect, it } from 'vitest';
import { ATTO2, GARAGE_561 } from '../src/core/content';
import { parkedIn } from '../src/core/parking';
import { exactCheck, moves, planToBay, type Plan } from '../src/core/planner';
import { makeScene, type SceneSpec } from '../src/core/scene';

const route = (p: Plan) => p.pieces.map(pc => `${pc.dir > 0 ? 'F' : 'R'}${pc.lvl}:${pc.len.toFixed(1)}`).join(' ');
const ends = (p: Plan) => p.pieces[p.pieces.length - 1].to;

describe('garage 561', () => {
  for (const [start, bay, maxMoves] of [['left', '561', 4], ['right', '561', 5], ['across', '561', 5], ['left', '560', 6]] as const) {
    it(`${bay} from the ${start}`, () => {
      const s = GARAGE_561.starts[start], plan = planToBay(ATTO2, GARAGE_561, s, bay);
      expect(plan.status, route(plan)).toBe('found');
      expect(moves(plan.pieces), route(plan)).toBeLessThanOrEqual(maxMoves);
      expect(exactCheck(ATTO2, GARAGE_561, plan.field, plan.pieces)).toBeNull();
      const e = ends(plan); expect(parkedIn(ATTO2, GARAGE_561.bays[bay], e.x, e.z, e.th)?.noseIn).toBe(true);
    });
  }
  it('finds 561 from the left in three moves, as the earlier search did', () => {
    expect(moves(planToBay(ATTO2, GARAGE_561, GARAGE_561.starts.left, '561').pieces)).toBe(3);
  });
  it('gives the same route every time', () => {
    const a = planToBay(ATTO2, GARAGE_561, GARAGE_561.starts.across, '561'), b = planToBay(ATTO2, GARAGE_561, GARAGE_561.starts.across, '561');
    expect(route(a)).toBe(route(b)); expect(a.nodes).toBe(b.nodes);
  });
});

const lot = (extra: SceneSpec['obstacles'] = []): SceneSpec => ({
  format: 1, id: 'test-lot', name: 'Test lot', layoutVersion: 1, lot: [-12, 12, -8, 16], areaView: [-12, 12, -8, 16],
  defaultBay: 'A', bays: { A: { x0: -1.25, x1: 1.25, z0: 0, z1: 5, headZ: 0, sideTol: 0.03, mouthTol: 0.15, inHeading: Math.PI / 2 } },
  defaultStart: 'front', starts: { front: { x: 0, z: 11, th: Math.PI / 2 } }, lines: [],
  obstacles: [{ kind: 'poly', pts: [[-12, -8], [12, -8], [12, -7.5], [-12, -7.5]], name: 'wall', h: 2.5, cls: 'wall' }, ...extra],
});

describe('a bay on its own', () => {
  it('straight in from in front: one move', () => {
    const sc = makeScene(lot()), plan = planToBay(ATTO2, sc, sc.starts.front, 'A');
    expect(plan.status).toBe('found'); expect(moves(plan.pieces), route(plan)).toBe(1);
  });
  it('a blocked bay has no route, and says so at once', () => {
    const sc = makeScene(lot([{ kind: 'poly', pts: [[-0.5, 1], [0.5, 1], [0.5, 4], [-0.5, 4]], name: 'a skip', h: 1.5, cls: 'wall' }]));
    const plan = planToBay(ATTO2, sc, sc.starts.front, 'A');
    expect(plan.status).toBe('none'); expect(plan.nodes).toBe(0);
  });
});
