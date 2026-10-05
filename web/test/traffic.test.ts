// Traffic on the street (core/traffic.ts): the road network a district makes, the lights, and the other cars: that they
// never touch each other, a kerb or anything parked, never run a red light, never stall for good, stop behind your car
// and wait for it, and come back exactly from a snapshot; the parked cars that pull out, the couriers who stop in the
// lane, and the drivers who honk. TRAFFIC_SEEDS=n runs n layouts of every district (default 2).
import { describe, expect, it } from 'vitest';
import { buildCity, parkStart, sideDir, type CityMap, type Drive, type KerbSlot, type MapSpec } from '../src/core/city';
import { ATTO2, MAPS, VEHICLES } from '../src/core/content';
import { generateDistrict } from '../src/core/district';
import { footprint } from '../src/core/car';
import { circleHitsPoly, polysOverlap } from '../src/core/geometry';
import type { Pt } from '../src/core/math';
import { STEP } from '../src/core/replay';
import { AMBER, CYCLE, DENSITY, DRIVERS, GREEN, TYPES, Traffic, diveFor, lightAt, networkOf, poseOn, type CarSnap, type El, type PlayerView, type TrafficSnap } from '../src/core/traffic';
import { nearby } from '../src/core/world';

const harbour = (seed = 1, drive: Drive = 'right'): CityMap => buildCity(MAPS.harbour, ATTO2, seed, drive);
const SEEDS = Array.from({ length: +(process.env.TRAFFIC_SEEDS ?? 2) }, (_, i) => i + 1);

/** The way on from lane el: straight on where it can. */
function routeFrom(map: CityMap, el: El): number[] {
  const net = networkOf(map), route: number[] = [];
  for (let e = el; route.length < 3;) { const n = e.kind === 'lane' ? e.next.find(id => net.els[id].turn === 'straight') ?? e.next[0] : e.next[0]; route.push(n); e = net.els[n]; }
  return route;
}
/** A car of a given size and driver on lane `el` at s, going v. */
const carOn = (map: CityMap, id: number, el: El, s: number, v: number, type = 2, drv = 0, more: Partial<CarSnap> = {}): CarSnap =>
  ({ id, type, drv, el: el.id, s, v, acc: 0, route: routeFrom(map, el), ind: 0, wait: false, commit: -1, inAt: 1e9, jams: 0, moved: 0, ...more });
/** A traffic of one car of a given size and driver, on lane `el` at s, going v, with the route the network gives it. */
function oneCar(map: CityMap, el: El, s: number, v: number, type = 2, drv = 0): Traffic {
  const T = new Traffic(networkOf(map)), snap: TrafficSnap = { t: 0, r: 1, cars: [carOn(map, 0, el, s, v, type, drv)] };
  T.restore(snap);
  return T;
}
const VAN = TYPES.findIndex(t => t.name === 'van'), COURIER = DRIVERS.findIndex(d => d.name === 'courier'), THIEF = DRIVERS.findIndex(d => d.name === 'thief');
/** The traffic's fingerprint after a minute (see below), as M7 part 1 left it (commit 4b5c050). A change that moves the
 *  traffic itself on purpose changes it: say why in the commit. */
const FINGERPRINT = 766601948;
/** The cars besides the traffic, as the game has them in light and busy traffic (two thieves: as in a tight district). */
const EXTRAS = { light: { leavers: 3, couriers: 1, thieves: 2, patience: 5 }, busy: { leavers: 5, couriers: 2, thieves: 2, patience: 5 } } as const;
/** Your car standing still on lane el, rear axle s along it. */
const standing = (el: El, s: number, more: Partial<PlayerView> = {}): PlayerView => {
  const [x, z, th] = poseOn(el, s);
  return { x, z, th, v: 0, L: ATTO2.L, W: ATTO2.W, OVR: ATTO2.OVR, ind: 0, hazard: false, park: false, ...more };
};
const playerBox = (p: PlayerView): Pt[] => footprint(p.x, p.z, p.th, [[-p.OVR, -p.W / 2], [p.L - p.OVR, -p.W / 2], [p.L - p.OVR, p.W / 2], [-p.OVR, p.W / 2]]);

describe('the road network', () => {
  const net = networkOf(harbour());
  it('has Harbour\'s nine junctions: lights at the crossroads and at the T-junctions on 50 km/h roads, give way at the others, nothing at the corners', () => {
    const by = Object.fromEntries(net.junctions.map(j => [j.name, `${j.arms}:${j.control}`]));
    expect(by).toEqual({
      'Ropewalk and Mill Lane': '2:none', 'Ropewalk and Market Street': '3:giveway', 'Ropewalk and Dock Road': '2:none',
      'Harbour Street and Mill Lane': '3:giveway', 'Harbour Street and Market Street': '4:lights', 'Harbour Street and Dock Road': '3:lights',
      'Quay Road and Mill Lane': '2:none', 'Quay Road and Market Street': '3:lights', 'Quay Road and Dock Road': '2:none',
    });
    // at a give-way junction only the side road's lane gives way
    for (const j of net.junctions) for (const a of j.approaches) expect(a.minor).toBe(j.control === 'giveway' && net.els[a.el].axis === j.minor);
  });
  it('joins every lane to every other way out of a junction but back: paths that start where their lane ends, end where the next begins and are no tighter than 6 m', () => {
    for (const j of net.junctions) {
      const paths = net.els.filter(e => e.kind === 'path' && e.j === net.junctions.indexOf(j));
      expect(paths.length).toBe({ 2: 2, 3: 6, 4: 12 }[j.arms]);
    }
    for (const e of net.els) {
      if (e.kind === 'lane') { expect(e.next.length).toBeGreaterThan(0); continue; }
      const [ax, az, ah] = poseOn(net.els[e.from], net.els[e.from].len), [bx, bz, bh] = poseOn(e, 0), [cx, cz, ch] = poseOn(e, e.len), [dx, dz, dh] = poseOn(net.els[e.next[0]], 0);
      expect(Math.hypot(ax - bx, az - bz) + Math.abs(ah - bh)).toBeLessThan(1e-9);
      expect(Math.hypot(cx - dx, cz - dz)).toBeLessThan(1e-9);
      expect(Math.cos(ch - dh)).toBeGreaterThan(1 - 1e-9);
      expect(e.kmax).toBeLessThanOrEqual(1 / 6);
    }
  });
  it('is made for every made-up district: lanes long enough, paths joined up, and every size of car with somewhere to drive', () => {
    // TRAFFIC_NETS=n for n layouts of each level, both ways round (default 20)
    for (const drive of ['right', 'left'] as Drive[]) for (const level of [2, 5, 9]) for (let seed = 1; seed <= +(process.env.TRAFFIC_NETS ?? 20); seed++) {
      const n = networkOf(buildCity(generateDistrict(seed, level), ATTO2, seed, drive)), id = `level ${level} layout ${seed} ${drive}`;
      for (const e of n.els) {
        if (e.kind === 'lane') { expect(e.len, id).toBeGreaterThan(10); continue; }
        const a = n.els[e.from], [ax, az] = poseOn(a, a.len), [bx, bz] = poseOn(e, 0), [cx, cz] = poseOn(e, e.len), [dx, dz] = poseOn(n.els[e.next[0]], 0);
        expect(Math.hypot(ax - bx, az - bz) + Math.hypot(cx - dx, cz - dz), id).toBeLessThan(1e-6);
      }
      TYPES.forEach((ty, t) => {
        const lanes = n.els.filter(e => e.kind === 'lane' && n.ok[t][e.id]).length, out = n.els.filter(e => !n.ok[t][e.id]);
        expect(lanes, `${id}: ${ty.name}`).toBeGreaterThan(0);
        if (ty.name !== 'pickup' && ty.name !== 'van') for (const e of out) expect(e.turn, `${id}: ${ty.name} kept off ${e.name}`).toBe('far');   // only a turn that swings it over a parked car (the two widest may miss more)
      });
    }
  }, 120000);
  it('lets every size of car drive all of Harbour, but keeps a pickup off a turn that would swing it over a parked car', () => {
    TYPES.forEach((ty, t) => {
      const out = net.els.filter(e => !net.ok[t][e.id]);
      if (ty.name !== 'pickup') expect(out).toEqual([]);
      else { expect(out.length).toBeLessThanOrEqual(2); for (const e of out) expect(e.turn).toBe('far'); }
    });
  });
  it('turns the lights: one street green, amber, then red both ways for a moment before the other\'s green', () => {
    const j = net.junctions.find(q => q.control === 'lights')!;
    for (let t = 0; t < CYCLE; t += 0.1) {
      const x = lightAt(j, 'x', t), z = lightAt(j, 'z', t);
      expect(x === 'red' || z === 'red').toBe(true);
    }
    const greenFor = (axis: 'x' | 'z') => { let n = 0; for (let t = 0; t < CYCLE; t += 0.01) if (lightAt(j, axis, t) === 'green') n++; return n / 100; };
    expect(greenFor('x')).toBeCloseTo(GREEN, 1); expect(greenFor('z')).toBeCloseTo(GREEN, 1);
    let amber = 0; for (let t = 0; t < CYCLE; t += 0.01) if (lightAt(j, 'x', t) === 'amber') amber++;
    expect(amber / 100).toBeCloseTo(AMBER, 1);
  });
});

describe('traffic', () => {
  it('is the same every time from the same seed, and carries on exactly from a snapshot, parked cars and couriers too', () => {
    const m = harbour(3), net = networkOf(m);
    const a = Traffic.spawn(net, 3, DENSITY.busy, m.start, EXTRAS.busy), b = Traffic.spawn(net, 3, DENSITY.busy, m.start, EXTRAS.busy);
    for (let n = 0; n < 90 * 60; n++) { a.step(STEP, null); b.step(STEP, null); }
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
    const mid = a.snapshot(), c = new Traffic(net);
    c.restore(JSON.parse(JSON.stringify(mid)));
    for (let n = 0; n < 150 * 60; n++) { a.step(STEP, null); c.step(STEP, null); }
    expect(JSON.stringify(c.snapshot())).toBe(JSON.stringify(a.snapshot()));
    expect(a.cars.length).toBeGreaterThan(20);
    expect(a.cars.filter(q => q.state === 'parked').length).toBeLessThan(a.places.length);   // some have pulled out (one wakes at 93 s)
  });
  it('moves the traffic itself exactly as before when there are no parked cars to pull out and no couriers', () => {
    // a fingerprint of where every car is after a minute of busy traffic in Harbour (layout 1), from before they came
    const m = harbour(1), T = Traffic.spawn(networkOf(m), 1, DENSITY.busy, m.start);
    for (let n = 0; n < 60 * 60; n++) T.step(STEP, null);
    const json = JSON.stringify(T.cars.map(c => [c.id, c.type, c.drv, c.el, c.s, c.v, c.route, c.ind, c.wait, c.commit, c.inAt, c.jams, c.moved]));
    let h = 2166136261;
    for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 16777619) >>> 0;
    expect(h).toBe(FINGERPRINT);
  });

  const maps: [string, (seed: number) => MapSpec][] = [['Harbour', () => MAPS.harbour], ['roomy', s => generateDistrict(s, 2)], ['average', s => generateDistrict(s, 5)], ['tight', s => generateDistrict(s, 9)]];
  for (const [name, spec] of maps) for (const seed of SEEDS) for (const drive of ['right', 'left'] as Drive[]) for (const [dname, dens] of Object.entries(DENSITY)) {
    it(`${name} layout ${seed}, keeping ${drive}, ${dname}: four minutes with no touches, no red lights run and no one stuck`, () => {
      const m = buildCity(spec(seed), ATTO2, seed, drive), net = networkOf(m), T = Traffic.spawn(net, seed, dens, m.start, EXTRAS[dname as keyof typeof EXTRAS]), E = net.els;
      const parked = new Set(T.cars.filter(c => c.state === 'parked').map(c => c.id));
      let touches = 0, kerbs = 0, reds = 0;
      for (let n = 0; n < 240 * 60; n++) {
        const before = T.cars.map(c => ({ el: c.el, toLine: E[c.el].kind === 'lane' ? E[c.el].len - (c.s + TYPES[c.type].L - TYPES[c.type].OVR) : -1 }));
        T.step(STEP, null);
        T.cars.forEach((c, i) => {   // a front crossing a stop line on red, unless it was going on through at amber
          const b = before[i], e = E[b.el];
          if (c.state === 'parked' || b.toLine < 0 || (c.el === b.el && e.len - (c.s + TYPES[c.type].L - TYPES[c.type].OVR) >= 0)) return;
          const J = net.junctions[e.j];
          if (J.control === 'lights' && lightAt(J, e.axis, T.t) === 'red' && c.commit !== e.j) reds++;
        });
        for (let i = 0; i < T.cars.length; i++) for (let k = i + 1; k < T.cars.length; k++) {
          const a = T.cars[i], b = T.cars[k];
          if (Math.abs(a.x - b.x) < 8 && Math.abs(a.z - b.z) < 8 && polysOverlap(a.box, b.box)) touches++;
        }
        if (n % 20) continue;
        for (const c of T.cars) {
          if (c.state !== 'parked' && c.state !== 'out' && !net.ok[c.type][c.el]) touches += 1000;   // only where its size fits
          const ty = TYPES[c.type], tr = ty.W - 0.26;
          const tyres = [0, ty.WB].flatMap(ax => [-1, 1].map(sg => footprint(c.x, c.z, c.h, [[ax - 0.33, sg * tr / 2 - 0.11], [ax + 0.33, sg * tr / 2 - 0.11], [ax + 0.33, sg * tr / 2 + 0.11], [ax - 0.33, sg * tr / 2 + 0.11]])));
          for (const o of nearby(m.scene.obstacles, c.x, c.z, 8)) {
            if (o.cls === 'kerb') { if (o.kind === 'poly' && tyres.some(w => polysOverlap(w, o.pts))) kerbs++; }
            else if (o.kind === 'poly' ? polysOverlap(c.box, o.pts) : circleHitsPoly(o.x, o.z, o.r, c.box)) touches++;
          }
        }
      }
      expect({ touches, kerbs, reds, lastResort: T.cars.reduce((m, c) => m + c.jams, 0) }).toEqual({ touches: 0, kerbs: 0, reds: 0, lastResort: 0 });
      expect(Math.min(...T.cars.filter(c => !parked.has(c.id)).map(c => c.moved))).toBeGreaterThan(150);   // a courier stops for up to a minute
      expect(T.cars.length).toBeGreaterThan(3);
      expect(T.cars.some(c => TYPES[c.type].name === 'van')).toBe(true);
    }, 60000);
  }
});

describe('traffic and your car', () => {
  const m = harbour(), net = networkOf(m), lane = net.els.filter(e => e.kind === 'lane' && e.street === 'harbour').sort((a, b) => b.len - a.len)[0];
  const run = (T: Traffic, p: PlayerView | null, secs: number) => { let met = 0; for (let n = 0; n < secs * 60; n++) { T.step(STEP, p); if (p && polysOverlap(T.cars[0].box, playerBox(p))) met++; } return met; };
  const gapTo = (T: Traffic, p: PlayerView, sP: number) => { const c = T.cars[0], ty = TYPES[c.type]; return (sP - p.OVR) - (c.s + ty.L - ty.OVR); };

  it('stops behind you, a couple of metres back, and goes on when you drive off', () => {
    const sP = lane.len - 15, p = standing(lane, sP), T = oneCar(m, lane, 5, 12);
    expect(run(T, p, 20)).toBe(0);
    expect(T.cars[0].v).toBeLessThan(0.01);
    expect(gapTo(T, p, sP)).toBeGreaterThan(2); expect(gapTo(T, p, sP)).toBeLessThan(3.5);   // its 2 m, and the 30 cm it keeps round your car
    const was = T.cars[0].moved;
    run(T, null, 30);
    expect(T.cars[0].moved - was).toBeGreaterThan(10);
  });
  it('leaves room to park when you signal towards the kerb, or have your hazards on', () => {
    for (const more of [{ ind: 1 as const }, { hazard: true }, { park: true }]) {
      const sP = lane.len - 15, p = standing(lane, sP, more), T = oneCar(m, lane, 5, 12);
      expect(run(T, p, 20)).toBe(0);
      expect(gapTo(T, p, sP)).toBeGreaterThan(6);
    }
  });
  it('waits at its line while you stand in its way through the junction, and goes once you have gone', () => {
    // a corner of the ring (nothing else to wait for): your car in the middle of its way round, a car coming up to it
    const corner = net.els.filter(e => e.kind === 'lane' && net.junctions[e.j].control === 'none').sort((a, b) => b.len - a.len)[0];
    const T = oneCar(m, corner, corner.len - 40, 10), path = net.els[T.cars[0].route[0]], p = standing(path, path.len / 2);
    expect(run(T, p, 15)).toBe(0);
    const c = T.cars[0];
    expect(c.el).toBe(corner.id); expect(c.v).toBeLessThan(0.01);
    expect(corner.len - (c.s + TYPES[c.type].L - TYPES[c.type].OVR)).toBeGreaterThan(-0.01);   // its nose short of the line
    run(T, null, 15);
    expect(T.cars[0].el).not.toBe(corner.id);
  });
  it('is what your car touches when you drive into it, mirrors too', () => {
    const T = oneCar(m, lane, 30, 0), c = T.cars[0], ty = TYPES[c.type];
    const [x, z, th] = poseOn(lane, 30 + ty.L - ty.OVR + ATTO2.OVR - 0.05);   // your back bumper 5 cm into its front
    expect(T.touch(ATTO2, x, z, th)).toEqual({ name: `${ty.name} in traffic`, part: '', parked: false });
    expect(T.touch(ATTO2, x, z, th + Math.PI)).not.toBeNull();
    const [x2, z2] = poseOn(lane, 30 + ty.L - ty.OVR + ATTO2.OVR + 0.3);
    expect(T.touch(ATTO2, x2, z2, th)).toBeNull();
    // alongside, a mirror's width away
    const side = ty.W / 2 + 0.97, [sx, sz] = [c.x + side * Math.sin(c.h), c.z + side * Math.cos(c.h)];
    expect(T.touch(VEHICLES['byd-atto2'], sx - (1.9 - ATTO2.WB / 2) * Math.cos(c.h), sz + (1.9 - ATTO2.WB / 2) * Math.sin(c.h), c.h)?.part).toBe('left mirror');
  });
});

describe('parked cars that pull out, couriers, and drivers who honk', () => {
  const kerb = 1 as const;   // keeping right, the kerb you park at is on your right
  /** Harbour with parked cars that will pull out and nothing else, and the first one that wakes as you come up behind it. */
  function leaver(seed = 1) {
    const m = harbour(seed), net = networkOf(m), T = Traffic.spawn(net, seed, 0, m.start, { leavers: 5 });
    const L = T.cars.find(c => c.state === 'parked' && c.wakeD > 0)!, ex = T.places[L.place], lane = net.els[ex.el];
    return { m, net, T, L, ex, lane, back: L.s - TYPES[L.type].OVR };
  }
  it('sit at the back of free spaces that were not promised to your car, which are taken while they are there', () => {
    const { m, T } = leaver();
    expect(T.places.length).toBeGreaterThan(2);
    for (const ex of T.places) {
      const sl = m.slots.find(s => s.id === ex.slot)!;
      expect(sl.kind).toBe('kerb'); expect(sl.guaranteed).toBe(false);
      expect(T.taken(sl.id)).toBe(true);
    }
    expect(m.slots.filter(s => T.taken(s.id)).length).toBe(T.places.length);
  });
  it('wake as you come up behind them, signal for three seconds, and pull out once you have stopped: then the space is free', () => {
    const { T, L, ex, lane, back } = leaver();
    let p = standing(lane, back - (L.wakeD + 6) - (ATTO2.L - ATTO2.OVR), { ind: kerb });   // further back than it looks
    for (let n = 0; n < 60; n++) T.step(STEP, p);
    expect(L.ind).toBe(0);
    p = standing(lane, back - 8 - (ATTO2.L - ATTO2.OVR), { ind: kerb });   // 8 m behind it
    T.step(STEP, p);
    expect(L.ind).toBe(ex.side); expect(ex.side).toBe(-1);   // away from the kerb
    const woke = T.t;
    let out = -1, met = 0;
    for (let n = 0; n < 40 * 60 && L.state !== 'drive'; n++) {
      T.step(STEP, p);
      if (L.state === 'out' && out < 0) out = T.t;
      if (polysOverlap(L.box, playerBox(p))) met++;
    }
    expect(out - woke).toBeGreaterThanOrEqual(3); expect(out - woke).toBeLessThan(3.2);
    expect(L.state).toBe('drive'); expect(T.taken(ex.slot)).toBe(false);
    expect({ met, jams: L.jams }).toEqual({ met: 0, jams: 0 });
    for (let n = 0; n < 10 * 60; n++) T.step(STEP, null);
    expect(L.moved).toBeGreaterThan(ex.len + 5);   // and on along its lane
  });
  it('wait while you stand beside them, and while a car comes along the lane, and go once it is clear', () => {
    const { T, L, ex, lane, m } = leaver();
    L.until = 0;   // its time has come
    const beside = standing(lane, L.s);
    for (let n = 0; n < 12 * 60; n++) T.step(STEP, beside);
    expect(L.ind).toBe(ex.side); expect(L.state).toBe('parked');
    // a car on its way along the lane at 40 km/h, 30 m back: too close to stop for it, so it waits for that car to go by
    const snap = T.snapshot();
    snap.cars.push(carOn(m, snap.cars.length, lane, L.s - 30, 11));
    T.restore(snap);
    const P = T.cars[L.id], C = T.cars[T.cars.length - 1];
    let at = -1;
    for (let n = 0; n < 30 * 60 && at < 0; n++) { T.step(STEP, null); if (P.state !== 'parked') at = C.s - TYPES[C.type].OVR; }
    expect(at).toBeGreaterThan(ex.joinS + TYPES[P.type].L);   // its back bumper past where the parked car joins the lane
    for (let n = 0; n < 15 * 60; n++) T.step(STEP, null);
    expect(P.state).toBe('drive'); expect(T.cars.reduce((s, c) => s + c.jams, 0)).toBe(0);
  });
  it('stay where they are when your car touches them, as any parked car does', () => {
    const { T, L } = leaver(), ty = TYPES[L.type];
    const [x, z, th] = [L.x + (ty.L - ty.OVR + ATTO2.OVR - 0.05) * Math.cos(L.h), L.z - (ty.L - ty.OVR + ATTO2.OVR - 0.05) * Math.sin(L.h), L.h];   // your back bumper 5 cm into its front
    expect(T.touch(ATTO2, x, z, th)).toEqual({ name: 'parked car', part: '', parked: true });
    expect(T.near(L.x, L.z, 3, true).map(o => o.name)).toEqual(['parked car']);
  });
  it('a courier stops in its lane with its hazards on for 30 to 60 s; the car behind waits, honks, and goes on after it', () => {
    const m = harbour(), lane = networkOf(m).els.filter(e => e.kind === 'lane' && e.street === 'harbour').sort((a, b) => b.len - a.len)[0];
    const T = new Traffic(networkOf(m));
    T.restore({ t: 0, r: 1, x: 7, base: 0, cars: [carOn(m, 0, lane, 12, 4, VAN, COURIER, { nextStop: 0 }), carOn(m, 1, lane, 0, 4)] });
    const [V, C] = T.cars;
    let stopped = -1, until = 0, honked = -1, gone = -1;
    for (let n = 0; n < 90 * 60 && gone < 0; n++) {
      T.step(STEP, null);
      if (V.state === 'stop' && stopped < 0) { stopped = T.t; until = V.until; expect(V.haz).toBe(true); }
      if (C.honk >= 0 && honked < 0) honked = T.t;
      if (stopped >= 0 && V.state === 'drive') gone = T.t;
    }
    expect(stopped).toBeGreaterThan(0);
    expect(until - stopped).toBeGreaterThanOrEqual(30); expect(until - stopped).toBeLessThanOrEqual(60);
    expect(gone).toBeCloseTo(until, 1); expect(V.haz).toBe(false);
    expect(honked - stopped).toBeGreaterThan(DRIVERS[C.drv].patience - 0.1); expect(honked).toBeLessThan(until);   // held from the step it stopped in
    for (let n = 0; n < 15 * 60; n++) T.step(STEP, null);
    expect(C.moved).toBeGreaterThan(60); expect(T.cars.reduce((s, c) => s + c.jams, 0)).toBe(0);
  });
  it('a driver held up by you honks once its patience runs out, but not while you wait at a red light yourself', () => {
    const m = harbour(), net = networkOf(m), lane = net.els.filter(e => e.kind === 'lane' && e.street === 'harbour').sort((a, b) => b.len - a.len)[0];
    // you, standing in the lane mid-block
    const p = standing(lane, lane.len - 30), T = oneCar(m, lane, 5, 12), C = T.cars[0];
    let first = -1, held = 0;
    for (let n = 0; n < 40 * 60; n++) { T.step(STEP, p); if (C.honk >= 0 && first < 0) first = T.t; if (T.held.includes(C.id)) held += STEP; }
    expect(C.v).toBeLessThan(0.01);
    expect(first).toBeGreaterThan(DRIVERS[C.drv].patience); expect(first).toBeLessThan(DRIVERS[C.drv].patience + 8);
    expect(held).toBeGreaterThan(30);
    // you at a red light's stop line, red for a good while: whoever waits behind you waits for the light
    const lights = net.els.filter(e => e.kind === 'lane' && net.junctions[e.j].control === 'lights').sort((a, b) => b.len - a.len)[0], J = net.junctions[lights.j];
    let t0 = 0;
    for (let t = 0; t < CYCLE; t += 0.05) if (lightAt(J, lights.axis, t) === 'red' && lightAt(J, lights.axis, t - 0.1) !== 'red') { t0 = t; break; }
    const q = standing(lights, lights.len - 0.5 - (ATTO2.L - ATTO2.OVR)), R = oneCar(m, lights, 5, 10), D = R.cars[0];
    R.t = t0;
    for (let n = 0; n < 22 * 60; n++) { R.step(STEP, q); expect(R.held).toEqual([]); }
    expect(lightAt(J, lights.axis, R.t)).toBe('red');
    expect(D.v).toBeLessThan(0.01); expect(D.honk).toBe(-1);
  });
});

describe('spot thieves', () => {
  const kerb = 1 as const;
  /** Harbour (layout 1), the first space on the street a city car can dive into with room to come up behind it, your car
   *  stopped where Park mode starts for it, and a thief in a city car coming up the lane 25 m behind where it would wait. */
  function contest(patience = 5) {
    const m = harbour(), net = networkOf(m);
    const sl = m.slots.find((s): s is KerbSlot => s.kind === 'kerb' && !!diveFor(net, s, 0) && diveFor(net, s, 0)!.s0 > 30)!, dv = diveFor(net, sl, 0)!;
    const T = new Traffic(net), lane = net.els[dv.el];
    T.restore({ t: 0, r: 1, x: 3, base: 0, patience, cars: [carOn(m, 0, lane, dv.s0 - 25, 6, 0, THIEF)] });
    const at = parkStart(ATTO2, sl), p: PlayerView = { x: at.x, z: at.z, th: at.th, v: 0, L: ATTO2.L, W: ATTO2.W, OVR: ATTO2.OVR, ind: 0, hazard: false, park: true, bay: sl.id };
    return { m, net, T, sl, dv, p, thief: T.cars[0] };
  }
  /** Step until the thief waits at the back of the space (its patience running), then `secs` more, doing `act` each step. */
  function play(T: Traffic, p: PlayerView, secs: number, act: (t: number) => void = () => {}): { waited: number; met: number } {
    const c = T.cars[0];
    let waited = -1, met = 0;
    for (let n = 0; n < 60 * 60; n++) {
      if (waited >= 0 && T.t - waited > secs) break;
      act(waited >= 0 ? T.t - waited : -1);
      T.step(STEP, p);
      if (waited < 0 && c.aimT >= 0) waited = c.aimT;
      if (polysOverlap(c.box, playerBox(p))) met++;
    }
    return { waited, met };
  }
  it('comes for the space you stop beside, and waits in the lane with its nose at the back of the space', () => {
    const { T, sl, dv, p, thief } = contest();
    T.step(STEP, p);
    expect(thief.aim).toBe(sl.id);
    const { waited } = play(T, p, 1);
    expect(waited).toBeGreaterThan(0);
    const ty = TYPES[thief.type], dir = sideDir(sl.street, sl.side), back = dir > 0 ? sl.a0 : sl.a1, along = sl.street.along === 'x' ? thief.x : thief.z;
    expect((along + dir * (ty.L - ty.OVR) * 1 - back) * dir).toBeLessThan(0.65);   // its nose at most 50 cm (and a little) past the back of the space
    expect(Math.abs(thief.s - dv.s0)).toBeLessThan(0.15);
  });
  it('gives up when you signal towards the kerb and start reversing within its patience', () => {
    const { T, sl, p, thief } = contest(5);
    p.ind = kerb;
    const r = play(T, p, 12, w => { p.v = w > 2 && w < 3 ? -0.4 : 0; });
    expect(r.waited).toBeGreaterThan(0);
    expect(thief.aim).toBe(''); expect(thief.state).toBe('drive');
    expect(T.thiefIn(sl.id)).toBeNull(); expect(T.taken(sl.id)).toBe(false);
    expect({ met: r.met, jams: thief.jams }).toEqual({ met: 0, jams: 0 });
  });
  it('dives in nose first when you never signal: you lose the space', () => {
    const { T, sl, p, thief } = contest(5);
    const r = play(T, p, 20, w => { p.v = w > 2 && w < 3 ? -0.4 : 0; });   // you reverse, but never signal
    expect(T.thiefIn(sl.id)).toBe(thief); expect(thief.state).toBe('parked'); expect(T.taken(sl.id)).toBe(true);
    expect({ met: r.met, jams: thief.jams }).toEqual({ met: 0, jams: 0 });
    // parked for good, inside the space
    for (let n = 0; n < 120 * 60; n++) T.step(STEP, null);
    expect(thief.state).toBe('parked'); expect(T.taken(sl.id)).toBe(true);
  });
  it('dives in when you signal but start reversing after its patience has run out', () => {
    const { T, sl, p, thief } = contest(3);
    p.ind = kerb;
    let dove = -1;
    play(T, p, 20, w => { p.v = w > 3.5 && w < 4.5 ? -0.4 : 0; if (dove < 0 && thief.state === 'in') dove = w; });
    expect(dove).toBeGreaterThanOrEqual(3); expect(dove).toBeLessThan(3.5);
    expect(T.thiefIn(sl.id)).toBe(thief);
  });
  it('gives up when it comes up behind you already reversing into the space, signal on', () => {
    const { T, sl, p, thief } = contest(5);
    p.ind = kerb; p.v = -0.3;
    T.step(STEP, p);
    expect(thief.aim).toBe('');
    for (let n = 0; n < 20 * 60; n++) T.step(STEP, p);
    expect(T.thiefIn(sl.id)).toBeNull(); expect(thief.jams).toBe(0);
  });
  it('in made-up districts too: you stopped beside a space for a minute, claiming it or not, and nothing touches anything', () => {
    let came = 0;
    for (const [spec, seed, level] of [[MAPS.harbour, 1, 5], [generateDistrict(2, 5), 2, 5], [generateDistrict(1, 9), 1, 9]] as [MapSpec, number, number][]) for (const drive of ['right', 'left'] as Drive[]) {
      const m = buildCity(spec, ATTO2, seed, drive), net = networkOf(m), side = drive === 'right' ? 1 : -1;
      for (const sl of (m.slots.filter(s => s.kind === 'kerb') as KerbSlot[]).filter(s => [0, 1, 2].some(t => diveFor(net, s, t))).slice(0, 2)) for (const claim of [false, true]) {
        const at = parkStart(ATTO2, sl), T = Traffic.spawn(net, seed, DENSITY.busy, at, { leavers: 5, couriers: 2, thieves: level >= 8 ? 2 : 1, patience: level >= 8 ? 3 : 5 });
        if (T.taken(sl.id)) continue;
        const p: PlayerView = { x: at.x, z: at.z, th: at.th, v: 0, L: ATTO2.L, W: ATTO2.W, OVR: ATTO2.OVR, ind: claim ? side : 0, hazard: false, park: true, bay: sl.id };
        let waited = -1, met = 0, touches = 0;
        for (let n = 0; n < 60 * 60; n++) {
          if (waited < 0 && T.cars.some(c => c.aim === sl.id && c.aimT >= 0)) waited = T.t;
          p.v = claim && waited >= 0 && T.t - waited > 1 && T.t - waited < 1.5 ? -0.3 : 0;
          T.step(STEP, p);
          for (let i = 0; i < T.cars.length; i++) {
            const a = T.cars[i];
            if (Math.abs(a.x - p.x) < 9 && Math.abs(a.z - p.z) < 9 && polysOverlap(a.box, playerBox(p))) met++;
            for (let k = i + 1; k < T.cars.length; k++) { const b = T.cars[k]; if (Math.abs(a.x - b.x) < 8 && Math.abs(a.z - b.z) < 8 && polysOverlap(a.box, b.box)) touches++; }
          }
        }
        if (waited >= 0) { came++; expect(!!T.thiefIn(sl.id), `${sl.id} claimed ${claim}`).toBe(!claim); }
        expect({ met, touches, jams: T.cars.reduce((s, c) => s + c.jams, 0), stuck: T.cars.filter(c => c.state === 'in').length }).toEqual({ met: 0, touches: 0, jams: 0, stuck: 0 });
      }
    }
    expect(came).toBeGreaterThan(0);
  }, 120000);
  it('comes for the space of a parked car you are waiting behind to pull out, and waits while it is still there', () => {
    const m = harbour(), net = networkOf(m), T = Traffic.spawn(net, 1, 0, m.start, { leavers: 5, thieves: 1, patience: 5 });
    const thief = T.cars.find(c => c.drv === THIEF)!, L = T.cars.find(c => c.state === 'parked' && c.wakeD > 0 && diveFor(net, m.slots.find(s => s.id === T.places[c.place].slot) as KerbSlot, thief.type))!;
    // move the thief onto the lane 40 m behind the parked car, and you 8 m behind it, signalling towards the kerb
    const lane = net.els[T.places[L.place].el], snap = T.snapshot();
    snap.cars[thief.id] = { ...snap.cars[thief.id], el: lane.id, s: Math.max(1, L.s - 40), v: 5, route: routeFrom(m, lane) };
    T.restore(snap);
    const th = T.cars[thief.id], back = T.cars[L.id].s - TYPES[L.type].OVR, p = standing(lane, back - 8 - (ATTO2.L - ATTO2.OVR), { ind: kerb });
    for (let n = 0; n < 3; n++) T.step(STEP, p);   // it wakes as you come up, and you are waiting for it
    expect(T.cars[L.id].ind).not.toBe(0);
    expect(th.aim).toBe(T.places[L.place].slot);
    for (let n = 0; n < 2 * 60; n++) T.step(STEP, p);
    expect(th.aimT).toBe(-1);   // the space is not free yet, and you are in its way
  });
});
