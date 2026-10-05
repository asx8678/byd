// The map kit and the Harbour district: the same seed gives the same district; parked cars keep to their parking lanes;
// every car finds the free spaces it was promised, and the route planner parks it in every space of the first layouts
// from where Park mode would start; stopping beside a space is recognised (and only on your side of the road); kerbs
// on other streets do not count as the kerb beside you; zones keep their kerb clear; and the lanes are clear to drive.
// The car parks are in lots.test.ts, driving on the left and the made-up districts in districts.test.ts.
import { describe, expect, it } from 'vitest';
import { checkSlot, localScene, parkStart, slotNear, streetAt, streetPt, type CityMap } from '../src/core/city';
import { collides } from '../src/core/collision';
import { MAPS, VEHICLES } from '../src/core/content';
import { polysOverlap } from '../src/core/geometry';
import { parkedIn, tyreGap } from '../src/core/parking';
import { exactCheck, moves, planBack } from '../src/core/planner';
import { DEG, wrapPi, type Pt } from '../src/core/math';
import { STEP } from '../src/core/replay';
import { Sim } from '../src/core/sim';
import { CARS, arc, boxesMeet, city, drivePath, kerbSlots } from './helpers/city';

describe('the Harbour district', () => {
  it('is the same district from the same seed, and another from another', () => {
    const a = JSON.stringify(city('byd-atto2', 7).scene), b = JSON.stringify(city('byd-atto2', 7).scene), c = JSON.stringify(city('byd-atto2', 8).scene);
    expect(a).toBe(b); expect(a).not.toBe(c);
  });
  it.each(CARS)('%s: parked cars keep to their lanes, and the free spaces fit the car', id => {
    const v = VEHICLES[id];
    for (const seed of [1, 2, 3]) {
      const m = city(id, seed), obs = m.scene.obstacles, cars = obs.filter(o => o.cls === 'car'), kerbs = obs.filter(o => o.cls === 'kerb');
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (a.kind === 'poly' && b.kind === 'poly' && !(a.bx1 < b.bx0 || b.bx1 < a.bx0 || a.bz1 < b.bz0 || b.bz1 < a.bz0)) expect(polysOverlap(a.pts, b.pts)).toBe(false);
      }
      for (const a of cars) for (const k of kerbs) if (a.kind === 'poly' && k.kind === 'poly' && !(a.bx1 < k.bx0 || k.bx1 < a.bx0 || a.bz1 < k.bz0 || k.bz1 < a.bz0)) expect(polysOverlap(a.pts, k.pts)).toBe(false);
      expect(kerbSlots(m).every(s => s.length >= v.L + 0.8)).toBe(true);
      expect(kerbSlots(m).filter(s => s.guaranteed && s.length >= v.L + 1.4).length).toBeGreaterThanOrEqual(MAPS.harbour.fill.guarantee);
      expect(collides(v, obs, m.start.x, m.start.z, m.start.th)).toBeNull();
      expect(streetAt(m, m.start.x, m.start.z, m.start.th)?.id).toBe('harbour');
    }
  });
});

describe('zones along the kerb', () => {
  it('keep their kerb clear: no free space in one, and no one parked in one but a blue badge holder in a disabled bay', () => {
    for (const seed of [1, 2, 3]) {
      const m = city('byd-atto2', seed), L = m.scene.city!;
      expect(new Set(L.zones.map(z => z.kind))).toEqual(new Set(['bus', 'loading', 'disabled', 'none', 'driveway']));
      for (const z of L.zones) {
        const zx = z.pts.map(p => p[0]), zz = z.pts.map(p => p[1]), box = { bx0: Math.min(...zx) + 0.15, bx1: Math.max(...zx) - 0.15, bz0: Math.min(...zz) + 0.15, bz1: Math.max(...zz) - 0.15 };   // a space's box runs 5 cm past its ends
        for (const s of kerbSlots(m)) { const b = s.bay.box!; expect(b[1] < box.bx0 || b[0] > box.bx1 || b[3] < box.bz0 || b[2] > box.bz1, `${s.id} in a ${z.kind} zone`).toBe(true); }
        if (z.kind !== 'disabled') expect(m.scene.obstacles.filter(o => o.cls === 'car' && boxesMeet(o, box)).length, `a car in a ${z.kind} zone`).toBe(0);
        expect(z.lines.length).toBe(z.kind === 'none' ? 2 : 0);   // no parking at any time: a double line along the kerb
      }
    }
  });
});

describe('parking on the street', () => {
  it.each([...CARS, 'mercedes-s-class-w223@4.5', 'mercedes-s-class-w223@0'])('%s: the planner parks the car in every promised space (and nearly every other), from where Park mode starts', id => {
    const v = VEHICLES[id];
    let all = 0, ok = 0;
    for (const seed of [1, 2]) {
      const m: CityMap = city(id, seed);
      for (const s of kerbSlots(m)) {
        const from = parkStart(v, s), local = localScene(m, s), plan = planBack(v, local, from, s.id, { maxNodes: 6000 });
        const clear = plan.status === 'found' && !exactCheck(v, local, plan.field, plan.pieces);
        all++;
        if (s.guaranteed) {
          expect(clear, `${s.id}, ${s.length.toFixed(2)} m: ${plan.status}${plan.status === 'found' ? ', touches ' + exactCheck(v, local, plan.field, plan.pieces) : ''}`).toBe(true);
          expect(checkSlot(m, v, s)).toBe(true);   // the game's own check says the same
        }
        if (!clear) continue;
        ok++;
        // the planner sees both kerbs of the street, even on the ring where the outer kerb runs on past the junctions
        expect(local.kerbs.length).toBe(2);
        expect(moves(plan.pieces)).toBeLessThanOrEqual(s.length - v.L < 1 ? 5 : 4);   // less than a metre to spare may take a fifth
        // where it ends counts as parked in the space, with the tyres close to the kerb
        const end = plan.pieces[plan.pieces.length - 1].to, at = parkedIn(v, s.bay, end.x, end.z, end.th);
        expect(at?.noseIn).toBe(true);
        expect(tyreGap(v, m.scene.kerbs, end.x, end.z, end.th)).toBeLessThan(0.3);
      }
    }
    expect(ok / all).toBeGreaterThan(0.9);
  }, 60000);
  it('knows the space you stopped beside, and only on your side of the road, facing the way the lane runs', () => {
    const v = VEHICLES['byd-atto2'], m = city('byd-atto2', 1);
    for (const s of kerbSlots(m)) {
      const p = parkStart(v, s);
      expect(slotNear(m, v, p.x, p.z, p.th)?.id).toBe(s.id);
      expect(slotNear(m, v, p.x, p.z, p.th + Math.PI)?.id).not.toBe(s.id);   // facing against the lane
      const st = s.street, far = streetPt(st, st.along === 'x' ? p.x : p.z, -s.side * 1.6);   // in the other lane
      expect(slotNear(m, v, far[0], far[1], p.th)?.id).not.toBe(s.id);
    }
  });
  it('counts only the kerb beside the car, not one on another street or across a block', () => {
    const v = VEHICLES['byd-atto2'], m = city('byd-atto2', 1), s = m.start;
    expect(tyreGap(v, m.scene.kerbs, s.x, s.z, s.th)).toBeGreaterThan(2.5);   // in the lane: the nearest kerb is the parking lane's
  });
});

describe('driving through the district', () => {
  it.each(CARS)('%s: left and right at the Market Street crossing, in lane, without touching anything', id => {
    const v = VEHICLES[id], m = city(id, 1), harbour = m.streets.find(s => s.id === 'harbour')!, market = m.streets.find(s => s.id === 'market')!;
    const z0 = harbour.c + harbour.lane / 2, keep = v.W > 2 ? 0.3 : 0;   // a wide pickup keeps to the left of its lane
    for (const [turn, R, kmh] of [['left', 9, 15], ['left', 8, 20], ['right', 5.5, 15], ['right', 6, 20]] as const) {
      const sim = new Sim(m.scene, v); sim.reset('start'); sim.setMode('drive'); sim.place(-40, z0, 0); sim.v = kmh / 3.6;
      const xl = turn === 'left' ? market.c + market.lane / 2 - keep : market.c - market.lane / 2 + keep, path: Pt[] = [];
      for (let x = -40; x < xl - R - 0.01; x += 1) path.push([x, z0]);
      if (turn === 'left') { path.push(...arc(xl - R, z0 - R, R, Math.PI / 2, 0)); for (let z = z0 - R - 1; z > -45; z -= 1) path.push([xl, z]); }
      else { path.push(...arc(xl - R, z0 + R, R, -Math.PI / 2, 0)); for (let z = z0 + R + 1; z < 45; z += 1) path.push([xl, z]); }
      const r = drivePath(sim, path, kmh);
      expect(r.hits, `${turn} at ${kmh} km/h`).toBe(0);
      expect(Math.abs(r.x - xl)).toBeLessThan(0.2);
      expect(Math.abs(wrapPi(r.th - (turn === 'left' ? Math.PI / 2 : -Math.PI / 2)))).toBeLessThan(3 * DEG);
    }
  });
  it.each(CARS)('%s: down Harbour Street at 50 km/h in its lane without touching anything', id => {
    const v = VEHICLES[id], m = city(id, 1), sim = new Sim(m.scene, v);
    sim.reset('start'); sim.setMode('drive');
    let hits = 0;
    for (let n = 0; n < 60 * 14 && sim.x < 95; n++) {
      const e = 50 / 3.6 - sim.v; sim.input.acc = Math.max(0, Math.min(1, e)); sim.input.brk = Math.max(0, Math.min(1, -e));
      hits += sim.step(STEP).filter(ev => ev.type === 'touch').length;
    }
    expect(hits).toBe(0);
    expect(sim.x).toBeGreaterThan(60);
  });
});
