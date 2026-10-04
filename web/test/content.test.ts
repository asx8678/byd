// The data files say what the code used to: the Atto 2's numbers, the garage, and a turning circle that matches BYD's.
import { describe, expect, it } from 'vitest';
import { ATTO2, GARAGE_561 } from '../src/core/content';
import { DEG } from '../src/core/math';
import { makeScene } from '../src/core/scene';
import { Sim } from '../src/core/sim';

describe('the Atto 2 file', () => {
  it('keeps the derived steering geometry', () => {
    expect(ATTO2.R_REAR).toBe(Math.sqrt(5.3 * 5.3 - 2.62 * 2.62) - 1.57 / 2);
    expect(ATTO2.MAXSTEER).toBeCloseTo(34.43, 2);   // single-track angle at full lock
    expect(ATTO2.R_WALL).toBeCloseTo(5.89, 2);    // circle swept by the outer front corner
  });
  it('has its outline, mirrors and twelve sensors', () => {
    expect(ATTO2.body).toHaveLength(16); expect(ATTO2.mirrors).toHaveLength(2); expect(ATTO2.sensors).toHaveLength(12);
    expect(ATTO2.pdc.half).toBe(30 * DEG);
  });
});

describe('the garage file', () => {
  it('has the surveyed garage', () => {
    expect(GARAGE_561.obstacles).toHaveLength(35);
    expect(Object.keys(GARAGE_561.bays).sort()).toEqual(['560', '561']);
    expect(GARAGE_561.starts.left).toMatchObject({ x: -8.6, z: 6.45, th: 0 });
    expect(GARAGE_561.starts.across.th).toBe(125 * DEG);
    expect(GARAGE_561.obstacles.filter(o => o.cls === 'car').map(o => o.label).filter(Boolean)).toEqual(['Peugeot 208', 'Clio']);
  });
});

describe('turning circle', () => {
  it('matches the spec sheet: 10.6 m kerb to kerb at full lock', () => {
    const empty = makeScene({ format: 1, id: 'empty', name: 'Empty', layoutVersion: 1, areaView: [-20, 20, -20, 20], defaultBay: 'x', bays: {}, defaultStart: 'o', starts: { o: { x: 0, z: 0, th: 0 } }, lines: [], obstacles: [] });
    const sim = new Sim(empty, ATTO2);
    sim.reset('o'); sim.options.selfCentre = false; sim.wheelAngle = sim.options.lockDeg;   // full lock right
    sim.input.fwd = true;
    const outer: [number, number][] = [];
    for (let i = 0; i < 60 * 30; i++) {
      sim.step(1 / 60);
      // outer front wheel when turning right: the front-left one
      const cs = Math.cos(sim.th), sn = Math.sin(sim.th), lx = ATTO2.WB, lz = -ATTO2.TRACK / 2;
      outer.push([sim.x + lx * cs + lz * sn, sim.z - lx * sn + lz * cs]);
    }
    const xs = outer.map(p => p[0]), zs = outer.map(p => p[1]);
    const diameter = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    expect(diameter).toBeCloseTo(2 * 5.3, 1);
  });
});
