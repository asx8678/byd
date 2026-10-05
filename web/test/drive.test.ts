// Your drive on the street (core/sim.ts with core/traffic.ts and core/rules.ts): indicators that cancel themselves after
// a turn, the faults the rules note (a red light, speeding, hitting a car), how long you hold up traffic, a parked car
// that will pull out as your car meets it, and a recording with traffic in it that replays and rewinds exactly.
import { describe, expect, it } from 'vitest';
import { buildCity, parkStart, slotNear, type CityMap, type KerbSlot } from '../src/core/city';
import { ATTO2, MAPS } from '../src/core/content';
import { clamp } from '../src/core/math';
import { Recorder, STEP, playback, replayTo, stateOf } from '../src/core/replay';
import { Rules, SPEED_SLACK } from '../src/core/rules';
import { Sim, type SimEvent } from '../src/core/sim';
import { CYCLE, DENSITY, TYPES, Traffic, exitFor, lightAt, networkOf, poseOn, type El, type Extras, type Light, type TrafficSnap } from '../src/core/traffic';

/** Harbour with its road network, a sim in Drive mode on it, and traffic of n cars per km (0: just the lights), with the
 *  extra cars asked for. */
function street(perKm = 0, seed = 1, more: Extras = {}): { m: CityMap; sim: Sim } {
  const m = buildCity(MAPS.harbour, ATTO2, seed), net = networkOf(m), sim = new Sim(m.scene, ATTO2);
  m.scene.net = net;
  sim.reset('start'); sim.setMode('drive');
  sim.traffic = Traffic.spawn(net, seed, perKm, m.start, more); sim.rules = new Rules(net);
  return { m, sim };
}
/** The way on from lane el: straight on where it can. */
function routeFrom(m: CityMap, el: El): number[] {
  const net = networkOf(m), route: number[] = [];
  for (let e = el; route.length < 3;) { const n = e.kind === 'lane' ? e.next.find(id => net.els[id].turn === 'straight') ?? e.next[0] : e.next[0]; route.push(n); e = net.els[n]; }
  return route;
}
/** Hold kmh along a straight road for secs (wheel straight), collecting the events. */
function cruise(sim: Sim, kmh: number, secs: number, out: SimEvent[] = []): SimEvent[] {
  for (let n = 0; n < secs * 60; n++) {
    const e = kmh / 3.6 - sim.v; sim.input.acc = clamp(2 * e, 0, 1); sim.input.brk = clamp(-2 * e, 0, 1); sim.input.wheelHeld = true;
    out.push(...sim.step(STEP));
  }
  return out;
}
const faults = (evs: SimEvent[]) => evs.flatMap(e => (e.type === 'fault' ? [e.fault] : []));
/** The first time from t0 on that the light for lane `el` has been `want` for `ahead` seconds already. */
function timeWhen(m: CityMap, el: El, want: Light, ahead: number): number {
  const net = networkOf(m), J = net.junctions[el.j];
  for (let t = 0; t < 2 * CYCLE; t += 0.05) if (lightAt(J, el.axis, t) === want && lightAt(J, el.axis, t - ahead) === want) return t;
  throw new Error('no such time');
}

describe('your indicators', () => {
  const { sim } = street();
  it('cancel themselves once the wheel has been turned their way and comes back', () => {
    sim.ind = 1; sim.input.wheelHeld = true;
    for (const w of [40, 80, 60, 0]) { sim.wheelAngle = w; sim.step(STEP); }
    expect(sim.ind).toBe(1);   // never past a quarter turn: still on (changing lanes)
    for (const w of [120, 200, 120, 40, 10]) { sim.wheelAngle = w; sim.step(STEP); }
    expect(sim.ind).toBe(0);
    sim.ind = -1;
    for (const w of [200, 10]) { sim.wheelAngle = w; sim.step(STEP); }
    expect(sim.ind).toBe(-1);  // turned the other way: still on
    for (const w of [-200, -10]) { sim.wheelAngle = w; sim.step(STEP); }
    expect(sim.ind).toBe(0);
  });
});

describe('the rules', () => {
  // the long lane of Harbour Street that ends at the lights with Market Street
  const lightsLane = (m: CityMap): El => { const net = networkOf(m); return net.els.filter(e => e.kind === 'lane' && e.street === 'harbour' && net.junctions[e.j].control === 'lights').sort((a, b) => b.len - a.len)[0]; };
  /** Your car 15 m short of that lane's stop line at 25 km/h, the lights at `t`. */
  const atLine = (t: number) => {
    const { m, sim } = street(), el = lightsLane(m), [x, z, th] = poseOn(el, el.len - 15 - (ATTO2.L - ATTO2.OVR));
    sim.place(x, z, th); sim.v = 25 / 3.6; sim.traffic!.t = t;
    return { m, sim, el };
  };
  it('note a red light when your front bumper crosses the stop line on red', () => {
    const { m, sim, el } = atLine(0), t = timeWhen(m, el, 'red', 0);
    sim.traffic!.t = t - 0.1;   // red from now on for a good while: crossing in about 2 s
    expect(lightAt(networkOf(m).junctions[el.j], el.axis, t + 5)).toBe('red');
    const f = faults(cruise(sim, 25, 4));
    expect(f.map(q => q.kind)).toEqual(['red']);
    expect(f[0].text).toBe(`You went through on red at ${networkOf(m).junctions[el.j].name}.`);
  });
  it('let you through on green, and on amber', () => {
    for (const light of ['green', 'amber'] as const) {
      const probe = atLine(0), J = networkOf(probe.m).junctions[probe.el.j];
      // the light `light` from when you cross (about 2.2 s from now) until you are well over the line
      let t0 = 0;
      for (let t = 0; t < 2 * CYCLE; t += 0.05) if (lightAt(J, probe.el.axis, t + 1.8) === light && lightAt(J, probe.el.axis, t + 2.8) === light) { t0 = t; break; }
      const { sim } = atLine(t0);
      expect(faults(cruise(sim, 25, 4))).toEqual([]);
    }
  });
  it('note speeding once a spell, more than 3 km/h over the limit for more than a second', () => {
    const run = (plan: [number, number][]) => {
      const { m, sim } = street(), lane = networkOf(m).els.find(e => e.kind === 'lane' && e.street === 'harbour' && e.side === 1)!;
      const [x, z, th] = poseOn(lane, 2);
      sim.place(x, z, th); sim.traffic = null;   // no lights to mind
      const out: SimEvent[] = [];
      for (const [kmh, secs] of plan) { sim.v = kmh / 3.6; cruise(sim, kmh, secs, out); }
      return faults(out);
    };
    expect(run([[50 + SPEED_SLACK - 0.5, 4]])).toEqual([]);
    expect(run([[57, 0.8], [45, 1]])).toEqual([]);   // over, but not for a second
    const one = run([[57, 2.5]]);
    expect(one.map(f => [f.kind, f.text])).toEqual([['speed', '57 km/h in a 50 on Harbour Street.']]);
    expect(run([[57, 1.5], [45, 2.5], [58, 1.5]]).length).toBe(2);   // two spells
    expect(run([[57, 1.5], [45, 1], [58, 1.5]]).map(f => f.text)).toEqual(['58 km/h in a 50 on Harbour Street.']);   // one spell: its top speed
  });
  it('note driving into a car in traffic, as a touch and a fault', () => {
    // a car waiting at the red light; you come up behind it at 15 km/h and do not stop
    const { m, sim } = street(), el = lightsLane(m), ty = TYPES[2];
    const t = timeWhen(m, el, 'red', 0), front = el.len - 0.4, s = front - (ty.L - ty.OVR);   // where it settles at its line
    const snap: TrafficSnap = { t, r: 1, cars: [{ id: 0, type: 2, drv: 0, el: el.id, s, v: 0, acc: 0, route: routeFrom(m, el), ind: 0, wait: true, commit: -1, inAt: 1e9, jams: 0, moved: 0 }] };
    sim.traffic!.restore(snap);
    const [x, z, th] = poseOn(el, s - ty.OVR - 12 - (ATTO2.L - ATTO2.OVR));
    sim.place(x, z, th); sim.v = 15 / 3.6;
    const evs: SimEvent[] = [];
    for (let n = 0; n < 6 * 60; n++) { sim.input.acc = 0.15; sim.input.brk = 0; evs.push(...sim.step(STEP)); }
    const touches = evs.flatMap(e => (e.type === 'touch' ? [e.name] : []));
    expect(touches.length).toBeGreaterThan(0); expect(new Set(touches)).toEqual(new Set(['crossover in traffic']));   // pressing on touches again
    expect(faults(evs).map(f => f.kind)).toEqual(['crash']);
    expect(sim.traffic!.cars[0].jams).toBe(0);   // it never moved into you either
  });
  it('count how long you hold up traffic: while a car waits behind you and you are not waiting yourself', () => {
    const { m, sim } = street(), net = networkOf(m), lane = net.els.filter(e => e.kind === 'lane' && e.street === 'harbour').sort((a, b) => b.len - a.len)[0];
    const [x, z, th] = poseOn(lane, lane.len - 30);
    sim.place(x, z, th); sim.v = 0;
    sim.traffic!.restore({ t: 0, r: 1, cars: [{ id: 0, type: 2, drv: 0, el: lane.id, s: 5, v: 12, acc: 0, route: routeFrom(m, lane), ind: 0, wait: false, commit: -1, inAt: 1e9, jams: 0, moved: 0 }] });
    for (let n = 0; n < 30 * 60; n++) sim.step(STEP);
    const held = sim.rules!.heldUp;
    expect(held).toBeGreaterThan(20); expect(held).toBeLessThan(30);   // from when it had to stop behind you
    expect(sim.rules!.heldCars.size).toBe(1);
    cruise(sim, 20, 8);
    expect(sim.rules!.heldUp - held).toBeLessThan(1.5);
  });
});

describe('a parked car that will pull out', () => {
  // Harbour: a space long enough for a city car parked at the back of it (it never wakes in this test) and your car in
  // front of it, in the first layout that has one
  const [m, net, slot] = [1, 2, 3, 4, 5, 6].map(seed => { const mm = buildCity(MAPS.harbour, ATTO2, seed), nn = networkOf(mm); return [mm, nn, mm.slots.find((s): s is KerbSlot => s.kind === 'kerb' && s.length > 9.5 && !!exitFor(nn, s, 0))] as const; }).find(q => q[2])!, ex = exitFor(net, slot!, 0)!;
  const atBack = () => {
    const sim = new Sim(m.scene, ATTO2), ty = TYPES[0];
    m.scene.net = net; sim.traffic = new Traffic(net); sim.rules = new Rules(net);
    sim.traffic.restore({ t: 0, r: 1, x: 1, base: 0, places: [{ slot: slot!.id, type: 0 }], cars: [{ id: 0, type: 0, drv: 0, el: ex.el, s: ex.s0, v: 0, acc: 0, route: routeFrom(m, net.els[ex.el]), ind: 0, wait: true, commit: -1, inAt: 1e9, jams: 0, moved: 0, state: 'parked', place: 0, until: 1e9 }] });
    // your car in the space just in front of it, 60 cm from its front bumper, facing the same way
    const u = ty.L - ty.OVR + 0.6 + ATTO2.OVR, h = Math.atan2(-ex.uz, ex.ux);
    sim.reset('start'); sim.place(ex.x0 + u * ex.ux, ex.z0 + u * ex.uz, h); sim.setMode('park');
    return sim;
  };
  it('takes its space until it has gone: you cannot park there', () => {
    const sim = atBack(), free = (s: { id: string }) => !sim.traffic!.taken(s.id), p = parkStart(ATTO2, slot!);
    expect(sim.traffic!.taken(slot!.id)).toBe(true);
    expect(slotNear(m, ATTO2, p.x, p.z, p.th)?.id).toBe(slot!.id);
    expect(slotNear(m, ATTO2, p.x, p.z, p.th, free)).toBeNull();
  });
  it('is a parked car to your car: your sensors hear it, your path stops at it, and backing into it is a touch, not a crash', () => {
    const sim = atBack(), evs: SimEvent[] = [];
    evs.push(...sim.step(STEP));
    expect(sim.pdc.rear).toBeLessThan(0.75);
    const pred = sim.predict(-1);
    expect(pred.hit?.name).toBe('parked car'); expect(pred.dist).toBeGreaterThan(0.5); expect(pred.dist).toBeLessThan(0.65);
    sim.input.rev = true;
    for (let n = 0; n < 6 * 60 && !evs.some(e => e.type === 'touch'); n++) evs.push(...sim.step(STEP));
    expect(evs.flatMap(e => (e.type === 'touch' ? [e.name] : []))).toEqual(['parked car']);
    expect(faults(evs)).toEqual([]);   // in Park mode a touch is the parking's own business
  });
});

describe('a recording with traffic', () => {
  /** 40 s on the street in busy traffic: pull away, a turn of the wheel, brake, signal, go again. */
  function drive(): { sim: Sim; rec: Recorder; at: Record<number, string> } {
    const { sim } = street(DENSITY.busy, 2, { leavers: 5, couriers: 2 }), rec = new Recorder(), at: Record<number, string> = {};
    rec.begin(sim);
    for (let n = 0; n < 40 * 60; n++) {
      sim.input.acc = n < 600 || n > 1500 ? 0.35 : 0; sim.input.brk = n >= 900 && n < 1500 ? 0.6 : 0;
      sim.input.wheelHeld = true; sim.wheelAngle = n > 300 && n < 380 ? 30 : n > 1600 && n < 1650 ? -20 : 0;
      if (n === 1000) sim.ind = 1;
      if (n === 1400) sim.hazard = true;
      rec.before(sim); sim.step(STEP); rec.after(sim);
      if (n === 1199) at[1200] = JSON.stringify(stateOf(sim));
    }
    return { sim, rec, at };
  }
  const { sim, rec, at } = drive();
  it('plays back exactly: your car, the traffic and the rules', () => {
    const p = playback(rec.rec!, sim.scene, sim.vehicle);
    while (p.step());
    expect(JSON.stringify(stateOf(p.sim))).toBe(JSON.stringify(stateOf(sim)));
    expect(sim.traffic!.cars.length).toBeGreaterThan(20);
  });
  it('survives a round trip through JSON', () => {
    const p = playback(JSON.parse(JSON.stringify(rec.rec)), sim.scene, sim.vehicle);
    while (p.step());
    expect(JSON.stringify(p.sim.world())).toBe(JSON.stringify(sim.world()));
  });
  it('rewinds to exactly where everything was', () => {
    expect(JSON.stringify(stateOf(replayTo(rec.rec!, sim.scene, sim.vehicle, 1200)))).toBe(at[1200]);
    // and again from the same recording: its start was copied, not used up
    expect(JSON.stringify(stateOf(replayTo(rec.rec!, sim.scene, sim.vehicle, 1200)))).toBe(at[1200]);
  });
  it('rewinds from its checkpoints to exactly where replaying it all would', () => {
    expect(rec.rec!.marks!.map(m => m.step)).toEqual([600, 1200, 1800, 2400]);
    for (const n of [1199, 1200, 1500, 2399]) {
      const all = replayTo(rec.rec!, sim.scene, sim.vehicle, n, () => {});   // a hook: from the start
      expect(JSON.stringify(stateOf(replayTo(rec.rec!, sim.scene, sim.vehicle, n)))).toBe(JSON.stringify(stateOf(all)));
    }
  });
});
