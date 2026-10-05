// Every car turns as its spec sheet says: each is driven round a full circle at full lock in the simulation and the
// circles its outer front wheel (kerb to kerb) and its body (wall to wall) sweep are measured.
import { describe, expect, it } from 'vitest';
import { footprint, rearAngles } from '../src/core/car';
import { collides } from '../src/core/collision';
import { ATTO2, CAR_SPECS, GARAGE_561, VEHICLES, vehicleFor } from '../src/core/content';
import { generate, levelKey } from '../src/core/generator/level';
import { TEMPLATES } from '../src/core/generator/templates';
import { clearStart, exactCheck, fieldFor, fitsBay, planToBay } from '../src/core/planner';
import { STEP } from '../src/core/replay';
import { starsFor } from '../src/core/score';
import { DEG } from '../src/core/math';
import { makeScene } from '../src/core/scene';
import { Sim } from '../src/core/sim';
import type { Vehicle } from '../src/core/vehicle';

const empty = makeScene({ format: 1, id: 'empty', name: 'Empty', layoutVersion: 1, areaView: [-30, 30, -30, 30], defaultBay: 'x', bays: {}, defaultStart: 'o', starts: { o: { x: 0, z: 0, th: 0 } }, lines: [], obstacles: [] });

/** Full lock right for one whole turn and a bit: the diameters of the outer front wheel's and the body's circles. */
function circles(v: Vehicle): { kerb: number; wall: number; rearSlip: number } {
  const sim = new Sim(empty, v);
  sim.reset('o'); sim.options.selfCentre = false; sim.wheelAngle = sim.options.lockDeg; sim.input.fwd = true;
  const wheel: [number, number][] = [], body: [number, number][] = [];
  let rearSlip = 0, last: [number, number] | null = null, th0 = sim.th;
  while (sim.th > -2 * Math.PI - 0.3) {
    th0 = sim.th; sim.step(1 / 60);
    wheel.push(footprint(sim.x, sim.z, sim.th, [[v.WB, -v.TRACK / 2]])[0]);   // turning right, the front-left wheel is outside
    body.push(...footprint(sim.x, sim.z, sim.th, v.body));
    // the rear axle's centre: which way it moves against the way the car points
    const ra = footprint(sim.x, sim.z, sim.th, [[v.RA, 0]])[0];
    if (last && sim.v > 0.5 && sim.v < 1.3) { const dx = ra[0] - last[0], dz = ra[1] - last[1], m = Math.atan2(-dz, dx); rearSlip = (m - (th0 + sim.th) / 2 + 3 * Math.PI) % (2 * Math.PI) - Math.PI; }   // at creeping speed, against the heading half way through the step
    last = ra;
  }
  const span = (p: [number, number][]) => Math.max(Math.max(...p.map(q => q[0])) - Math.min(...p.map(q => q[0])), Math.max(...p.map(q => q[1])) - Math.min(...p.map(q => q[1])));
  return { kerb: span(wheel), wall: span(body), rearSlip: rearSlip / DEG };
}

describe('turning circles against the spec sheets', () => {
  it('Atto 2: 10.6 m kerb to kerb (BYD)', () => {
    expect(circles(ATTO2).kerb).toBeCloseTo(10.6, 1);
  });
  it('Smart fortwo: 6.95 m kerb to kerb, 7.30 m wall to wall (Daimler)', () => {
    const c = circles(vehicleFor('smart-fortwo-c453'));
    expect(Math.abs(c.kerb - 6.95)).toBeLessThan(0.03);
    expect(Math.abs(c.wall - 7.30)).toBeLessThan(0.05);
  });
  it('Ram 1500: 14.08 m curb to curb (FCA)', () => {
    expect(Math.abs(circles(vehicleFor('ram-1500-dt')).kerb - 14.08)).toBeLessThan(0.03);
  });
  it('S-Class: one front lock fits both published wall-to-wall circles, 11.89 m (4.5°) and 10.79 m (10°)', () => {
    const c45 = circles(vehicleFor('mercedes-s-class-w223', 4.5)), c10 = circles(vehicleFor('mercedes-s-class-w223', 10));
    expect(Math.abs(c45.wall - 11.89)).toBeLessThan(0.1);
    expect(Math.abs(c10.wall - 10.79)).toBeLessThan(0.1);
    // with the rear steering off: Mercedes says the 10° system saves up to 7 ft (2.13 m), so about 12.9 m
    const off = circles(vehicleFor('mercedes-s-class-w223', 0));
    expect(off.wall).toBeGreaterThan(12.6); expect(off.wall).toBeLessThan(13.1);
    expect(off.wall - c10.wall).toBeLessThan(2.14);
  });
});

describe('rear-axle steering', () => {
  it('turns the rear wheels the other way, and the rear axle moves the way they point', () => {
    for (const deg of [4.5, 10]) {
      const v = vehicleFor('mercedes-s-class-w223', deg);
      expect(v.RA).toBeLessThan(-0.2);                                 // the car turns about a point ahead of the rear axle
      expect(v.WB - v.RA).toBeCloseTo(3.216, 9);                       // the wheelbase itself is unchanged
      const [rl, rr] = rearAngles(v, -v.MAXSTEER * DEG);                // full lock right
      expect((rl + rr) / 2 / DEG).toBeGreaterThan(0);                  // the rear wheels point left
      expect(Math.atan(v.RS * Math.tan(v.MAXSTEER * DEG)) / DEG).toBeCloseTo(deg, 6);
      expect(circles(v).rearSlip).toBeCloseTo(deg, 1);                 // its centre runs at the rear wheels' angle, no tyre scrub
    }
    expect(vehicleFor('mercedes-s-class-w223', 0).RA).toBe(0);
  });
});

describe('every car', () => {
  it('has an outline, a front-lock and a reach that covers it', () => {
    for (const v of Object.values(VEHICLES)) {
      expect(v.body.length, v.id).toBeGreaterThanOrEqual(16);
      expect(v.MAXSTEER, v.id).toBeGreaterThan(30); expect(v.MAXSTEER, v.id).toBeLessThan(45);
      expect(v.WB + v.OVF + v.OVR, v.id).toBeCloseTo(v.L, 9);
      for (const [x, z] of v.body) expect(Math.hypot(x, z), v.id).toBeLessThanOrEqual(v.REACH);
    }
    expect(Object.keys(VEHICLES).sort()).toEqual(['byd-atto2', 'mercedes-s-class-w223@0', 'mercedes-s-class-w223@10', 'mercedes-s-class-w223@4.5', 'ram-1500-dt', 'smart-fortwo-c453']);
    expect(CAR_SPECS.map(s => s.id)[0]).toBe('byd-atto2');
  });
  it('feels a wall at the tip of the Ram\'s bonnet, 4.6 m ahead of its rear axle', () => {
    const v = vehicleFor('ram-1500-dt'), nose = v.WB + v.OVF;
    const wall = makeScene({ ...{ format: 1, id: 'w', name: 'W', layoutVersion: 1, areaView: [-30, 30, -30, 30], defaultBay: 'x', bays: {}, defaultStart: 'o', starts: { o: { x: 0, z: 0, th: 0 } }, lines: [] },
      obstacles: [{ kind: 'poly', pts: [[nose - 0.02, -0.3], [nose + 0.3, -0.3], [nose + 0.3, 0.3], [nose - 0.02, 0.3]], name: 'wall', h: 2, cls: 'wall' }] });
    expect(nose).toBeGreaterThan(4.5);
    expect(collides(v, wall.obstacles, 0, 0, 0)?.obstacle.name).toBe('wall');
    expect(collides(v, wall.obstacles, -0.05, 0, 0)).toBeNull();
  });
  it('has parking sensors where its file says: none, rear only, front and rear, or all round', () => {
    expect(vehicleFor('smart-fortwo-c453').sensors.map(s => s.g)).toEqual(['rear', 'rear', 'rear', 'rear']);
    expect(new Set(vehicleFor('ram-1500-dt').sensors.map(s => s.g))).toEqual(new Set(['front', 'rear']));
    expect(vehicleFor('mercedes-s-class-w223').sensors).toHaveLength(12);
    for (const v of Object.values(VEHICLES)) for (const s of v.sensors) expect(Math.abs(s.lz), v.id).toBeLessThan(v.W / 2);
  });
});

// The same levels in every car: each builds, the route clears everything with the exact test, the car starts clear,
// and the route's end counts as parked with three stars. GEN_CAR_LEVELS=all sweeps levels 1–10 (default 1, 5, 10).
const CAR_LEVELS = process.env.GEN_CAR_LEVELS === 'all' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 5, 10];
describe.each(Object.values(VEHICLES).filter(v => v !== ATTO2).map(v => [v.id, v] as const))('levels in the %s', (_id, v) => {
  for (const tpl of TEMPLATES) it(`${tpl}, levels ${CAR_LEVELS.join(', ')}`, () => {
    for (const level of CAR_LEVELS) {
      const L = generate(v, tpl, level, 1), key = `${v.id} ${levelKey(tpl, level, 1)}`;
      expect(L, key).not.toBeNull();
      if (!L) continue;
      expect(exactCheck(v, L.scene, fieldFor(v, L.scene), L.route), key).toBeNull();
      const sim = new Sim(L.scene, v); sim.reset('start');
      expect(sim.touching(), key).toBeNull();
      const e = L.route[L.route.length - 1].to; sim.place(e.x, e.z, e.th); sim.moves = L.par;
      const parked = sim.step(STEP).find(x => x.type === 'parked');
      expect(parked, key).toBeDefined();
      if (parked?.type === 'parked') expect(starsFor(parked.result, L.par, L.timeLimit).count, key).toBe(3);
    }
  }, 120000);
});

describe('your garage in other cars', () => {
  it('the Smart parks in 561 from every start; the Ram and the S-Class do not fit it', () => {
    for (const start of Object.keys(GARAGE_561.starts)) {
      const sm = vehicleFor('smart-fortwo-c453'), s = clearStart(sm, GARAGE_561, GARAGE_561.starts[start]), p = planToBay(sm, GARAGE_561, s, '561');
      expect(p.status, start).toBe('found');
    }
    expect(fitsBay(vehicleFor('smart-fortwo-c453'), GARAGE_561, '561')).toBe(true);
    expect(fitsBay(ATTO2, GARAGE_561, '561')).toBe(true);
    expect(fitsBay(vehicleFor('ram-1500-dt'), GARAGE_561, '561')).toBe(false);
    expect(fitsBay(vehicleFor('mercedes-s-class-w223'), GARAGE_561, '561')).toBe(false);
  });
  it('a start a long car would touch something at moves back until it is clear', () => {
    for (const v of Object.values(VEHICLES)) for (const [name, s0] of Object.entries(GARAGE_561.starts)) {
      const s = clearStart(v, GARAGE_561, s0);
      expect(collides(v, GARAGE_561.obstacles, s.x, s.z, s.th), `${v.id} ${name}`).toBeNull();
      if (v === ATTO2) expect(s).toEqual({ x: s0.x, z: s0.z, th: s0.th });   // the Atto 2 stands where it always has
    }
  });
});
