// Driving on the left: the same district with the traffic turned round, parked in on the left. Districts made up from a
// seed: the same seed and level give the same district; every car is promised its spaces and can be parked in each, the
// start is clear, the car parks fit; and the levels get harder.
import { describe, expect, it } from 'vitest';
import { buildCity, checkSlot, localScene, parkStart, slotNear, streetAt } from '../src/core/city';
import { collides } from '../src/core/collision';
import { MAPS, VEHICLES } from '../src/core/content';
import { generateDistrict } from '../src/core/district';
import { lotFit } from '../src/core/lot';
import { wrapPi } from '../src/core/math';
import { parkedIn, tyreGap } from '../src/core/parking';
import { exactCheck, planBack } from '../src/core/planner';
import { STEP } from '../src/core/replay';
import { Sim } from '../src/core/sim';
import { CARS, city, kerbSlots, lotSlots } from './helpers/city';

describe('driving on the left', () => {
  it('is the same district with the traffic turned round: you start in the other lane, and park on your left', () => {
    const v = VEHICLES['byd-atto2'];
    for (const seed of [1, 2]) {
      const r = city('byd-atto2', seed), m = buildCity(MAPS.harbour, v, seed, 'left'), harbour = m.streets.find(s => s.id === 'harbour')!;
      expect(m.drive).toBe('left');
      // the same kerbs, the same parked cars in the same places (each turned round in its own box), the same spaces
      expect(JSON.stringify(m.scene.kerbs)).toBe(JSON.stringify(r.scene.kerbs));
      expect(m.scene.obstacles.length).toBe(r.scene.obstacles.length);
      m.scene.obstacles.forEach((o, i) => { expect(o.cx).toBeCloseTo(r.scene.obstacles[i].cx, 6); expect(o.cz).toBeCloseTo(r.scene.obstacles[i].cz, 6); });
      expect(kerbSlots(m).map(s => [s.street.id, s.side, s.a0, s.a1])).toEqual(kerbSlots(r).map(s => [s.street.id, s.side, s.a0, s.a1]));
      // heading east on Harbour Street, in the northern lane
      expect(m.start.th).toBe(0); expect(m.start.z).toBeLessThan(harbour.c);
      expect(collides(v, m.scene.obstacles, m.start.x, m.start.z, m.start.th)).toBeNull();
      // every space faces the traffic beside it, now the other way: kerb on your left
      for (const s of kerbSlots(m)) {
        expect(Math.abs(wrapPi(s.th - (kerbSlots(r).find(q => q.id === s.id)!.th + Math.PI)))).toBeLessThan(1e-9);
        const p = parkStart(v, s);
        const toKerb = (s.street.along === 'x' ? [0, s.side] : [s.side, 0]) as [number, number];   // from the car towards the kerb
        expect(toKerb[0] * Math.sin(p.th) + toKerb[1] * Math.cos(p.th)).toBeLessThan(0);           // on the car's left
        expect(slotNear(m, v, p.x, p.z, p.th)?.id).toBe(s.id);
        expect(slotNear(m, v, p.x, p.z, p.th + Math.PI)?.id).not.toBe(s.id);
      }
    }
  });
  it.each(['byd-atto2', 'mercedes-s-class-w223@10'])('%s: the planner parks the car on the left in every promised space, from where Park mode starts', id => {
    const v = VEHICLES[id];
    for (const seed of [1, 2]) {
      const m = buildCity(MAPS.harbour, v, seed, 'left');
      for (const s of kerbSlots(m).filter(q => q.guaranteed)) {
        const from = parkStart(v, s), local = localScene(m, s), plan = planBack(v, local, from, s.id, { maxNodes: 6000 });
        expect(plan.status === 'found' && !exactCheck(v, local, plan.field, plan.pieces), s.id).toBe(true);
        const end = plan.pieces[plan.pieces.length - 1].to;
        expect(parkedIn(v, s.bay, end.x, end.z, end.th)?.noseIn).toBe(true);
        expect(tyreGap(v, m.scene.kerbs, end.x, end.z, end.th)).toBeLessThan(0.3);
      }
      // in a car park's two-way aisle the bay on your left comes first
      for (const s of lotSlots(m).filter(q => q.lot.angle === 90)) {
        const p = parkStart(v, s), [mx, mz] = s.at.mouth;
        expect((mx - p.x) * Math.sin(p.th) + (mz - p.z) * Math.cos(p.th)).toBeLessThan(0);
      }
    }
  }, 60000);
  it('down Harbour Street at 50 km/h in the left lane without touching anything', () => {
    for (const id of CARS) {
      const v = VEHICLES[id], m = buildCity(MAPS.harbour, v, 1, 'left'), sim = new Sim(m.scene, v);
      sim.reset('start'); sim.setMode('drive');
      let hits = 0;
      for (let n = 0; n < 60 * 14 && sim.x < 95; n++) {
        const e = 50 / 3.6 - sim.v; sim.input.acc = Math.max(0, Math.min(1, e)); sim.input.brk = Math.max(0, Math.min(1, -e));
        hits += sim.step(STEP).filter(ev => ev.type === 'touch').length;
      }
      expect(hits, id).toBe(0);
      expect(sim.x).toBeGreaterThan(60);
    }
  });
});

describe('districts made up from a seed', () => {
  it('are the same from the same seed and level, and another from another', () => {
    const a = JSON.stringify(generateDistrict(7, 5));
    expect(JSON.stringify(generateDistrict(7, 5))).toBe(a);
    expect(JSON.stringify(generateDistrict(8, 5))).not.toBe(a);
    expect(JSON.stringify(generateDistrict(7, 6))).not.toBe(a);
  });
  it.each([2, 5, 9])('level %i: every car is promised its spaces and can park in each; the start and the driveways are clear', level => {
    let kept = 0, parkable = 0;
    for (const seed of [1, 2, 3]) {
      const spec = generateDistrict(seed, level);
      for (const id of CARS) {
        const v = VEHICLES[id], m = buildCity(spec, v, seed), g = kerbSlots(m).filter(s => s.guaranteed);
        expect(g.length, `${spec.name}, ${id}`).toBeGreaterThanOrEqual(spec.fill.guarantee);
        for (const s of g) expect(checkSlot(m, v, s), `${spec.name} ${seed}, ${id}: ${s.id} (${s.length.toFixed(2)} m)`).toBe(true);
        expect(collides(v, m.scene.obstacles, m.start.x, m.start.z, m.start.th)).toBeNull();
        expect(streetAt(m, m.start.x, m.start.z, m.start.th)?.id).toBe(spec.start.road);
        for (const lot of m.lots) {
          const gate = { bx0: lot.gate[0] + 0.05, bx1: lot.gate[1] - 0.05, bz0: lot.gate[2] + 0.05, bz1: lot.gate[3] - 0.05 };
          expect(m.scene.obstacles.filter(o => (o.cls === 'kerb' || o.name === 'building' || o.name === 'lamp post') && !(o.bx1 < gate.bx0 || o.bx0 > gate.bx1 || o.bz1 < gate.bz0 || o.bz0 > gate.bz1)).length, `${spec.name}: ${lot.id}'s driveway`).toBe(0);
          if (lotFit(lot, v)) continue;
          for (const s of lotSlots(m).filter(q => q.lot === lot && q.guaranteed)) { kept++; if (checkSlot(m, v, s)) parkable++; }
        }
      }
    }
    // the bays a car park keeps free are free for any car, not promised to yours: nearly all of them are in reach
    if (kept) expect(parkable / kept).toBeGreaterThan(0.8);
  }, 120000);
  it('gets harder with the level: narrower lanes, a fuller and sloppier street, less room in the promised spaces', () => {
    const mean = (level: number, f: (s: ReturnType<typeof generateDistrict>) => number) => { let t = 0; for (let seed = 1; seed <= 12; seed++) t += f(generateDistrict(seed, level)); return t / 12; };
    const lane = (s: ReturnType<typeof generateDistrict>) => s.roads.reduce((a, r) => a + r.lane, 0) / s.roads.length;
    expect(mean(9, lane)).toBeLessThan(mean(2, lane) - 0.15);
    expect(mean(9, s => s.fill.occupancy)).toBeGreaterThan(mean(2, s => s.fill.occupancy));
    expect(mean(9, s => s.fill.sloppiness)).toBeGreaterThan(mean(2, s => s.fill.sloppiness));
    expect(generateDistrict(1, 9).fill.spare![1]).toBeLessThan(generateDistrict(1, 2).fill.spare![0]);
  });
});
