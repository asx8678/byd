// Your drive on the street (core/sim.ts with core/traffic.ts and core/rules.ts): indicators that cancel themselves after
// a turn, the faults the rules note (a red light, speeding, hitting a car), and a recording with traffic in it that
// replays and rewinds exactly.
import { describe, expect, it } from 'vitest';
import { buildCity, type CityMap } from '../src/core/city';
import { ATTO2, MAPS } from '../src/core/content';
import { clamp } from '../src/core/math';
import { Recorder, STEP, playback, replayTo, stateOf } from '../src/core/replay';
import { Rules, SPEED_SLACK } from '../src/core/rules';
import { Sim, type SimEvent } from '../src/core/sim';
import { CYCLE, DENSITY, TYPES, Traffic, lightAt, networkOf, poseOn, type El, type Light, type TrafficSnap } from '../src/core/traffic';

/** Harbour with its road network, a sim in Drive mode on it, and traffic of n cars per km (0: just the lights). */
function street(perKm = 0, seed = 1): { m: CityMap; sim: Sim } {
  const m = buildCity(MAPS.harbour, ATTO2, seed), net = networkOf(m), sim = new Sim(m.scene, ATTO2);
  m.scene.net = net;
  sim.reset('start'); sim.setMode('drive');
  sim.traffic = Traffic.spawn(net, seed, perKm, m.start); sim.rules = new Rules(net);
  return { m, sim };
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
    const { m, sim } = street(), net = networkOf(m), el = lightsLane(m), ty = TYPES[2];
    const t = timeWhen(m, el, 'red', 0), front = el.len - 0.4, s = front - (ty.L - ty.OVR);   // where it settles at its line
    const route: number[] = []; for (let e = el; route.length < 3;) { const n = e.kind === 'lane' ? e.next.find(id => net.els[id].turn === 'straight')! : e.next[0]; route.push(n); e = net.els[n]; }
    const snap: TrafficSnap = { t, r: 1, cars: [{ id: 0, type: 2, drv: 0, el: el.id, s, v: 0, acc: 0, route, ind: 0, wait: true, commit: -1, inAt: 1e9, jams: 0, moved: 0 }] };
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
});

describe('a recording with traffic', () => {
  /** 40 s on the street in busy traffic: pull away, a turn of the wheel, brake, signal, go again. */
  function drive(): { sim: Sim; rec: Recorder; at: Record<number, string> } {
    const { sim } = street(DENSITY.busy, 2), rec = new Recorder(), at: Record<number, string> = {};
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
