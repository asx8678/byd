// Car parks in the map kit: a bay turned to any angle is judged and planned like one that is not; the Harbour district's
// lots sit in their blocks with their driveways open; every car that fits their bays is parked in each free one from
// where Park mode starts, and one that does not is told why; and every car drives in from the street without touching
// anything.
import { describe, expect, it } from 'vitest';
import { checkSlot, localScene, lotStop, parkStart, slotNear } from '../src/core/city';
import { VEHICLES } from '../src/core/content';
import { generate } from '../src/core/generator/level';
import { polysOverlap } from '../src/core/geometry';
import { lotFit } from '../src/core/lot';
import { DEG, type Pt } from '../src/core/math';
import { facesRight, parkedIn } from '../src/core/parking';
import { exactCheck, moves, planBack, planToBay } from '../src/core/planner';
import { bayRect, makeScene, type Bay, type Scene } from '../src/core/scene';
import { Sim } from '../src/core/sim';
import { CARS, boxesMeet, city, drivePath, lotSlots } from './helpers/city';

/** A scene turned by phi about the origin, its bay given the turn as its frame: what the bay judges should not change. */
function turned(sc: Scene, bayId: string, phi: number): { scene: Scene; at: (x: number, z: number, th: number) => [number, number, number] } {
  const c = Math.cos(phi), s = Math.sin(phi), T = (x: number, z: number): [number, number] => [x * c + z * s, -x * s + z * c];
  const lot = sc.lot!, corners = [T(lot[0], lot[2]), T(lot[1], lot[2]), T(lot[0], lot[3]), T(lot[1], lot[3])];
  const box = [Math.min(...corners.map(p => p[0])), Math.max(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[1]))];
  const bay: Bay = { ...sc.bays[bayId], frame: { x: 0, z: 0, rot: phi } };
  const scene = makeScene({
    format: 1, id: `${sc.id}-turned`, name: sc.name, layoutVersion: 1, lot: box, areaView: box, defaultBay: bayId, bays: { [bayId]: bay }, defaultStart: 'start',
    starts: {}, lines: [], kerbs: [],
    obstacles: sc.obstacles.map(o => ({ ...(o.kind === 'poly' ? { kind: 'poly' as const, pts: o.pts.map(p => T(p[0], p[1])) } : { kind: 'circle' as const, ...(([x, z]) => ({ x, z }))(T(o.x, o.z)), r: o.r }), name: o.name, h: o.h, cls: o.cls, label: o.label })),
  });
  return { scene, at: (x, z, th) => [...T(x, z), th + phi] };
}

describe('car parks', () => {
  it('judges and plans a bay turned to any angle as it does the same bay unturned', () => {
    const v = VEHICLES['byd-atto2'], L = generate(v, 'bays-in', 3, 1)!, b = L.scene.bays[L.scene.defaultBay], start = L.scene.starts.start;
    const plain = planToBay(v, L.scene, start, L.scene.defaultBay);
    expect(plain.status).toBe('found');
    for (const phi of [30 * DEG, 135 * DEG, -60 * DEG]) {
      const t = turned(L.scene, L.scene.defaultBay, phi), tb = t.scene.bays[L.scene.defaultBay];
      // the same answer, pose by pose, along the planned route and around the bay
      for (const p of plain.pieces.flatMap(q => [q.from, q.to])) for (const [dx, dth] of [[0, 0], [0.4, 0], [0, 4 * DEG], [-0.3, -7 * DEG]]) {
        const q = { x: p.x + dx, z: p.z, th: p.th + dth }, a = parkedIn(v, b, q.x, q.z, q.th), r = parkedIn(v, tb, ...t.at(q.x, q.z, q.th));
        expect(!!r).toBe(!!a);
        if (a && r) { expect(r.noseIn).toBe(a.noseIn); expect(r.errIn).toBeCloseTo(a.errIn, 9); }
      }
      const [sx, sz, sth] = t.at(start.x, start.z, start.th), plan = planToBay(v, t.scene, { x: sx, z: sz, th: sth }, L.scene.defaultBay);
      expect(plan.status).toBe('found');
      const end = plan.pieces[plan.pieces.length - 1].to, at = parkedIn(v, tb, end.x, end.z, end.th);
      expect(at && facesRight(tb, at)).toBe(true);
      expect(moves(plan.pieces)).toBeLessThanOrEqual(4);   // the obstacles rasterise a little differently turned, so not always the same route
    }
  });

  it('sit in their blocks, behind the pavements, with the driveway open and the bays inside the walls', () => {
    for (const seed of [1, 2]) {
      const m = city('byd-atto2', seed), obs = m.scene.obstacles;
      expect(m.lots.map(l => l.angle).sort()).toEqual([45, 60, 90]);
      for (const lot of m.lots) {
        const [x0, x1, z0, z1] = lot.rect, g = lot.gate, inLot = { bx0: x0 + 0.3, bx1: x1 - 0.3, bz0: z0 + 0.3, bz1: z1 - 0.3 }, gate = { bx0: g[0] + 0.05, bx1: g[1] - 0.05, bz0: g[2] + 0.05, bz1: g[3] - 0.05 };
        const lotPoly: Pt[] = [[inLot.bx0, inLot.bz0], [inLot.bx1, inLot.bz0], [inLot.bx1, inLot.bz1], [inLot.bx0, inLot.bz1]];
        for (const o of obs) {
          if ((o.name === 'building' || o.cls === 'kerb') && o.kind === 'poly' && boxesMeet(o, inLot)) expect(polysOverlap(o.pts, lotPoly), `${lot.id}: ${o.name}`).toBe(false);
          // nothing on the driveway: no kerb for the wheels, no building, lamp post or parked car
          if (o.cls === 'kerb' || o.name === 'building' || o.name === 'lamp post' || o.name === 'car park wall') expect(boxesMeet(o, gate), `${lot.id} driveway: ${o.name}`).toBe(false);
        }
        // the street's parking is kept clear either side of the driveway: no parked car within a metre of it
        const mouth = { bx0: g[0] - 1, bx1: g[1] + 1, bz0: g[2] - 1, bz1: g[3] + 1 };
        expect(obs.filter(o => o.cls === 'car' && o.name === 'parked car' && boxesMeet(o, mouth) && (o.cx < x0 || o.cx > x1 || o.cz < z0 || o.cz > z1)).length, lot.id).toBe(0);
        const rects = lot.bays.map(b => bayRect(b.bay, [b.bay.x0, b.bay.x1, b.bay.z0, b.bay.z1]));
        for (const r of rects) for (const p of r) { expect(p[0]).toBeGreaterThan(x0); expect(p[0]).toBeLessThan(x1); expect(p[1]).toBeGreaterThan(z0); expect(p[1]).toBeLessThan(z1); }
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const shrink = (r: Pt[]): Pt[] => { const cx = r.reduce((a, p) => a + p[0], 0) / 4, cz = r.reduce((a, p) => a + p[1], 0) / 4; return r.map(p => [cx + (p[0] - cx) * 0.98, cz + (p[1] - cz) * 0.98]); };
          expect(polysOverlap(shrink(rects[i]), shrink(rects[j])), `${lot.id}: bays ${i + 1} and ${j + 1}`).toBe(false);
        }
        // the cars parked in it keep off its wall
        for (const o of obs) if (o.cls === 'car' && o.cx > x0 && o.cx < x1 && o.cz > z0 && o.cz < z1 && o.kind === 'poly')
          for (const w of obs) if (w.name === 'car park wall' && w.kind === 'poly' && boxesMeet(o, w)) expect(polysOverlap(o.pts, w.pts)).toBe(false);
      }
    }
  });

  it.each(['byd-atto2', 'smart-fortwo-c453', 'mercedes-s-class-w223@10', 'mercedes-s-class-w223@0'])('%s: the planner parks the car in every free bay kept for it (and nearly every other), from where Park mode starts', id => {
    const v = VEHICLES[id];
    let all = 0, ok = 0;
    for (const seed of [1, 2]) {
      const m = city(id, seed);
      expect(lotSlots(m).filter(s => s.guaranteed).length).toBe(3 * m.lots.length);
      for (const s of lotSlots(m)) {
        const from = parkStart(v, s), local = localScene(m, s), plan = planBack(v, local, from, s.id, { maxNodes: 6000 });
        const clear = plan.status === 'found' && !exactCheck(v, local, plan.field, plan.pieces);
        all++; s.parkable = clear;
        if (s.guaranteed) { expect(clear, `${s.id}: ${plan.status}`).toBe(true); s.parkable = undefined; expect(checkSlot(m, v, s)).toBe(true); }
        if (!clear) continue;
        // stopped there, Park mode knows the bay (or the one level with it across the aisle: the same place to stop)
        const near = slotNear(m, v, from.x, from.z, from.th);
        expect(near?.kind).toBe('lot');
        if (near && near.id !== s.id && near.kind === 'lot') { expect(near.lot).toBe(s.lot); expect(Math.abs(near.at.s - s.at.s)).toBeLessThan(1e-6); }
        // facing against a one-way aisle it does not
        if (s.lot.aisles[s.at.aisle].dir) expect(slotNear(m, v, from.x, from.z, from.th + Math.PI)).toBeNull();
        ok++;
        expect(local.kerbs.length).toBe(0);
        expect(moves(plan.pieces)).toBeLessThanOrEqual(5);
        const end = plan.pieces[plan.pieces.length - 1].to, at = parkedIn(v, s.bay, end.x, end.z, end.th);
        expect(at && facesRight(s.bay, at)).toBe(true);
        expect(lotStop(v, s.lot, s.at, 1).th).not.toBe(lotStop(v, s.lot, s.at, -1).th);
      }
    }
    expect(ok / all).toBeGreaterThan(0.9);
  }, 60000);

  it('tells the Ram why it has no bays: too long for them', () => {
    const v = VEHICLES['ram-1500-dt'], m = city('ram-1500-dt', 1);
    expect(lotSlots(m).length).toBe(0);
    for (const lot of m.lots) expect(lotFit(lot, v)).toMatch(/5\.92 m long: too long for these 5\.0 m bays/);
    for (const id of ['byd-atto2', 'smart-fortwo-c453', 'mercedes-s-class-w223@10']) for (const lot of m.lots) expect(lotFit(lot, VEHICLES[id])).toBe('');
  });

  it.each(CARS)('%s: in from the street, through each car park\'s driveway, without touching anything', id => {
    const v = VEHICLES[id], m = city(id, 1);
    for (const lot of m.lots) {
      const st = m.streets.find(s => s.id === lot.road)!, g = lot.gate, alongX = st.along === 'x';
      const gc = alongX ? (g[0] + g[1]) / 2 : (g[2] + g[3]) / 2, face = alongX ? (lot.rect[2] > st.c ? lot.rect[2] : lot.rect[3]) : (lot.rect[0] > st.c ? lot.rect[0] : lot.rect[1]);
      const side = face > st.c ? 1 : -1, dd = st.along === 'x' ? side : -side, tl = st.c + side * st.lane / 2, R = 7;
      const P = (s: number, t: number): Pt => (alongX ? [s, t] : [t, s]), path: Pt[] = [];
      for (let s = gc - dd * 40; (gc - dd * R - s) * dd > 0.01; s += dd) path.push(P(s, tl));
      for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI / 2; path.push(P(gc - dd * R + dd * R * Math.sin(a), tl + side * R * (1 - Math.cos(a)))); }
      for (let t = tl + side * (R + 1); (face + side * 9 - t) * side > 0; t += side) path.push(P(gc, t));
      const sim = new Sim(m.scene, v); sim.reset('start'); sim.setMode('drive');
      const [px, pz] = path[0]; sim.place(px, pz, alongX ? (dd > 0 ? 0 : Math.PI) : (dd > 0 ? -Math.PI / 2 : Math.PI / 2)); sim.v = 12 / 3.6;
      const r = drivePath(sim, path, 12);
      expect(r.hits, `${lot.id}`).toBe(0);
      expect(r.x > lot.rect[0] && r.x < lot.rect[1] && r.z > lot.rect[2] && r.z < lot.rect[3], `${lot.id} ends in the car park`).toBe(true);
    }
  });
});
