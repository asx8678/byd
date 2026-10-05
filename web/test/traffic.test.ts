// Traffic on the street (core/traffic.ts): the road network a district makes, the lights, and the other cars: that they
// never touch each other, a kerb or anything parked, never run a red light, never stall for good, stop behind your car
// and wait for it, and come back exactly from a snapshot. TRAFFIC_SEEDS=n runs n layouts of every district (default 2).
import { describe, expect, it } from 'vitest';
import { buildCity, type CityMap, type Drive, type MapSpec } from '../src/core/city';
import { ATTO2, MAPS, VEHICLES } from '../src/core/content';
import { generateDistrict } from '../src/core/district';
import { footprint } from '../src/core/car';
import { circleHitsPoly, polysOverlap } from '../src/core/geometry';
import type { Pt } from '../src/core/math';
import { STEP } from '../src/core/replay';
import { AMBER, CYCLE, DENSITY, GREEN, TYPES, Traffic, lightAt, networkOf, poseOn, type El, type PlayerView, type TrafficSnap } from '../src/core/traffic';
import { nearby } from '../src/core/world';

const harbour = (seed = 1, drive: Drive = 'right'): CityMap => buildCity(MAPS.harbour, ATTO2, seed, drive);
const SEEDS = Array.from({ length: +(process.env.TRAFFIC_SEEDS ?? 2) }, (_, i) => i + 1);

/** A traffic of one car of a given size and driver, on lane `el` at s, going v, with the route the network gives it. */
function oneCar(map: CityMap, el: El, s: number, v: number, type = 2, drv = 0): Traffic {
  const net = networkOf(map), T = new Traffic(net), route: number[] = [];
  for (let e = el; route.length < 3;) { const n = e.kind === 'lane' ? e.next.find(id => net.els[id].turn === 'straight') ?? e.next[0] : e.next[0]; route.push(n); e = net.els[n]; }
  const snap: TrafficSnap = { t: 0, r: 1, cars: [{ id: 0, type, drv, el: el.id, s, v, acc: 0, route, ind: 0, wait: false, commit: -1, inAt: 1e9, jams: 0, moved: 0 }] };
  T.restore(snap);
  return T;
}
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
  it('is the same every time from the same seed, and carries on exactly from a snapshot', () => {
    const m = harbour(3), net = networkOf(m);
    const a = Traffic.spawn(net, 3, DENSITY.busy, m.start), b = Traffic.spawn(net, 3, DENSITY.busy, m.start);
    for (let n = 0; n < 60 * 60; n++) { a.step(STEP, null); b.step(STEP, null); }
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
    const mid = a.snapshot(), c = new Traffic(net);
    c.restore(JSON.parse(JSON.stringify(mid)));
    for (let n = 0; n < 60 * 60; n++) { a.step(STEP, null); c.step(STEP, null); }
    expect(JSON.stringify(c.snapshot())).toBe(JSON.stringify(a.snapshot()));
    expect(a.cars.length).toBeGreaterThan(20);
  });

  const maps: [string, (seed: number) => MapSpec][] = [['Harbour', () => MAPS.harbour], ['roomy', s => generateDistrict(s, 2)], ['average', s => generateDistrict(s, 5)], ['tight', s => generateDistrict(s, 9)]];
  for (const [name, spec] of maps) for (const seed of SEEDS) for (const drive of ['right', 'left'] as Drive[]) for (const [dname, dens] of Object.entries(DENSITY)) {
    it(`${name} layout ${seed}, keeping ${drive}, ${dname}: four minutes with no touches, no red lights run and no one stuck`, () => {
      const m = buildCity(spec(seed), ATTO2, seed, drive), net = networkOf(m), T = Traffic.spawn(net, seed, dens, m.start), E = net.els;
      let touches = 0, kerbs = 0, reds = 0;
      for (let n = 0; n < 240 * 60; n++) {
        const before = T.cars.map(c => ({ el: c.el, toLine: E[c.el].kind === 'lane' ? E[c.el].len - (c.s + TYPES[c.type].L - TYPES[c.type].OVR) : -1 }));
        T.step(STEP, null);
        T.cars.forEach((c, i) => {   // a front crossing a stop line on red, unless it was going on through at amber
          const b = before[i], e = E[b.el];
          if (b.toLine < 0 || (c.el === b.el && e.len - (c.s + TYPES[c.type].L - TYPES[c.type].OVR) >= 0)) return;
          const J = net.junctions[e.j];
          if (J.control === 'lights' && lightAt(J, e.axis, T.t) === 'red' && c.commit !== e.j) reds++;
        });
        for (let i = 0; i < T.cars.length; i++) for (let k = i + 1; k < T.cars.length; k++) {
          const a = T.cars[i], b = T.cars[k];
          if (Math.abs(a.x - b.x) < 8 && Math.abs(a.z - b.z) < 8 && polysOverlap(a.box, b.box)) touches++;
        }
        if (n % 20) continue;
        for (const c of T.cars) {
          if (!net.ok[c.type][c.el]) touches += 1000;   // only where its size fits
          const ty = TYPES[c.type], tr = ty.W - 0.26;
          const tyres = [0, ty.WB].flatMap(ax => [-1, 1].map(sg => footprint(c.x, c.z, c.h, [[ax - 0.33, sg * tr / 2 - 0.11], [ax + 0.33, sg * tr / 2 - 0.11], [ax + 0.33, sg * tr / 2 + 0.11], [ax - 0.33, sg * tr / 2 + 0.11]])));
          for (const o of nearby(m.scene.obstacles, c.x, c.z, 8)) {
            if (o.cls === 'kerb') { if (o.kind === 'poly' && tyres.some(w => polysOverlap(w, o.pts))) kerbs++; }
            else if (o.kind === 'poly' ? polysOverlap(c.box, o.pts) : circleHitsPoly(o.x, o.z, o.r, c.box)) touches++;
          }
        }
      }
      expect({ touches, kerbs, reds, lastResort: T.cars.reduce((m, c) => m + c.jams, 0) }).toEqual({ touches: 0, kerbs: 0, reds: 0, lastResort: 0 });
      expect(Math.min(...T.cars.map(c => c.moved))).toBeGreaterThan(200);
      expect(T.cars.length).toBeGreaterThan(3);
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
    expect(T.touch(ATTO2, x, z, th)).toEqual({ name: `${ty.name} in traffic`, part: '' });
    expect(T.touch(ATTO2, x, z, th + Math.PI)).not.toBeNull();
    const [x2, z2] = poseOn(lane, 30 + ty.L - ty.OVR + ATTO2.OVR + 0.3);
    expect(T.touch(ATTO2, x2, z2, th)).toBeNull();
    // alongside, a mirror's width away
    const side = ty.W / 2 + 0.97, [sx, sz] = [c.x + side * Math.sin(c.h), c.z + side * Math.cos(c.h)];
    expect(T.touch(VEHICLES['byd-atto2'], sx - (1.9 - ATTO2.WB / 2) * Math.cos(c.h), sz + (1.9 - ATTO2.WB / 2) * Math.sin(c.h), c.h)?.part).toBe('left mirror');
  });
});
