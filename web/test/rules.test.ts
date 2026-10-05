// The rules of the road (core/rules.ts) and the countries' (core/country.ts): signalling before you turn at a junction,
// pull in to park and pull out again; not blocking a junction; not parking where it is not allowed; hazard lights only as
// the country allows; and what a thief taking your space means there. Each rule is driven through directly, pose by pose.
import { describe, expect, it } from 'vitest';
import { buildCity, parkStart, type KerbSlot } from '../src/core/city';
import { ATTO2, MAPS } from '../src/core/content';
import { COUNTRIES, countryOf, theftNote, type Country } from '../src/core/country';
import { STEP } from '../src/core/replay';
import { Rules, type Driven, type Fault } from '../src/core/rules';
import { Sim, type SimEvent } from '../src/core/sim';
import { CYCLE, Traffic, lightAt, networkOf, poseOn, type El } from '../src/core/traffic';

const m = buildCity(MAPS.harbour, ATTO2, 1), net = networkOf(m), E = net.els;
const car = (x: number, z: number, th: number, v = 0, more: Partial<Driven> = {}): Driven =>
  ({ x, z, th, v, L: ATTO2.L, W: ATTO2.W, OVR: ATTO2.OVR, drive: true, ind: 0, hazard: false, bay: '', parked: false, ...more });
/** Steps along a lane, then a path through its junction, then 25 m of the lane after it, at v m/s, with the indicator
 *  `ind` on from the start (or only from `from` m before the junction). */
function through(rules: Rules, path: El, ind: -1 | 0 | 1, from = Infinity, v = 5): Fault[] {
  const out: Fault[] = [], lane = E[path.from], next = E[path.next[0]];
  const ways: [El, number, number][] = [[lane, lane.len - 30, lane.len], [path, 0, path.len], [next, 0, 25]];
  let t = 0;
  for (const [e, s0, s1] of ways) for (let s = s0; s < s1; s += v * STEP) {
    const [x, z, th] = poseOn(e, s), toLine = e === lane ? lane.len - s : 0;
    out.push(...rules.step(car(x, z, th, v, { ind: toLine <= from ? ind : 0 }), null, t += STEP, STEP, null));
  }
  return out;
}
const kinds = (fs: Fault[]) => fs.map(f => f.kind);

describe('signalling', () => {
  const J = net.junctions.findIndex(j => j.name === 'Harbour Street and Market Street');
  const pathFor = (turn: 'straight' | 'near' | 'far') => E.find(e => e.kind === 'path' && e.j === J && e.turn === turn && e.street === 'harbour')!;
  it('notes a turn at a junction without the indicator on as you came into it', () => {
    for (const turn of ['near', 'far'] as const) {
      const p = pathFor(turn), way = p.dh > 0 ? 'left' : 'right';
      const fs = through(new Rules(net), p, 0);
      expect(kinds(fs)).toEqual(['signal']);
      expect(fs[0].text).toBe(`You turned ${way} at Harbour Street and Market Street without signalling.`);
      expect(through(new Rules(net), p, p.dh > 0 ? -1 : 1)).toEqual([]);   // signalled the right way
      expect(kinds(through(new Rules(net), p, p.dh > 0 ? 1 : -1))).toEqual(['signal']);   // the wrong way
      expect(through(new Rules(net), p, p.dh > 0 ? -1 : 1, 10)).toEqual([]);   // from 10 m before the junction
    }
    expect(through(new Rules(net), pathFor('straight'), 0)).toEqual([]);   // straight on needs no signal
  });
  it('wants the signal before you come into the junction, not only once you are turning', () => {
    const p = pathFor('far'), ind = p.dh > 0 ? -1 : 1;
    expect(kinds(through(new Rules(net), p, ind, -3))).toEqual(['signal']);   // switched on 3 m into the junction
  });
  const slot = m.slots.find((s): s is KerbSlot => s.kind === 'kerb' && s.street.id === 'harbour' && s.side === 1)!, start = parkStart(ATTO2, slot);
  it('notes pulling in to park without signalling towards the kerb, judged as you first reverse into the space', () => {
    const go = (ind: -1 | 0 | 1, at = 0) => {
      const rules = new Rules(net), out: Fault[] = [];
      for (let n = 0; n < 6 * 60; n++) {   // 3 s stopped beside the space, then reversing
        const rev = n >= 180, s = rev ? (n - 180) * 0.5 * STEP : 0;
        out.push(...rules.step(car(start.x - s * Math.cos(start.th), start.z + s * Math.sin(start.th), start.th, rev ? -0.5 : 0, { drive: false, bay: slot.id, ind: n >= at * 60 ? ind : 0 }), null, n * STEP, STEP, null));
      }
      return out;
    };
    const fs = go(0);
    expect(kinds(fs)).toEqual(['signal']);
    expect(fs[0].text).toBe(`You pulled in to park on ${slot.street.name} without signalling right.`);
    expect(go(1)).toEqual([]);
    expect(kinds(go(1, 4))).toEqual(['signal']);   // only once you were reversing: too late
  });
  it('notes pulling out of a space at the kerb without signalling away from it', () => {
    const go = (ind: -1 | 0 | 1) => {
      const rules = new Rules(net), out: Fault[] = [];
      for (let n = 0; n < 5 * 60; n++) {   // parked for a second, then Drive on: forward out of the space
        const off = n >= 60, s = off ? (n - 60) * STEP : 0;
        out.push(...rules.step(car(start.x + s * Math.cos(start.th), start.z - s * Math.sin(start.th), start.th, off ? 1 : 0, { drive: false, bay: off ? '' : slot.id, parked: !off, ind: off ? ind : 0 }), null, n * STEP, STEP, null));
      }
      return out;
    };
    expect(kinds(go(0))).toEqual(['signal']); expect(go(0)[0].text).toBe('You pulled out without signalling left.');
    expect(go(-1)).toEqual([]);
    expect(kinds(go(1))).toEqual(['signal']);   // towards the kerb
  });
});

describe('blocking a junction', () => {
  /** Into a junction along a straight path until your front is 6 m into it, then stopped there for `secs`, the traffic's
   *  clock at t0. */
  function stopIn(rules: Rules, path: El, secs: number, t0: number, ind: -1 | 0 | 1 = 0): Fault[] {
    const traffic = new Traffic(net), out: Fault[] = [], lane = E[path.from], J = net.junctions[path.j], nose = ATTO2.L - ATTO2.OVR;
    const [x0, x1, z0, z1] = J.rect, inside = (s: number) => { const [x, z, th] = poseOn(path, s), fx = x + nose * Math.cos(th), fz = z - nose * Math.sin(th); return fx >= x0 && fx <= x1 && fz >= z0 && fz <= z1; };
    let edge = 0; while (!inside(edge)) edge += 0.05;   // where along the path your front comes into the junction
    traffic.t = t0;
    let t = 0, last = car(0, 0, 0);
    for (let s = lane.len - 20; s < lane.len + edge + 6; s += 4 * STEP) {
      const e = s <= lane.len ? lane : path, [x, z, th] = poseOn(e, s <= lane.len ? s : s - lane.len);
      out.push(...rules.step(last = car(x, z, th, 4, { ind }), traffic, t += STEP, STEP, null)); traffic.t += STEP;
    }
    for (let n = 0; n < secs * 60; n++) { out.push(...rules.step({ ...last, v: 0 }, traffic, t += STEP, STEP, null)); traffic.t += STEP; }
    return out;
  }
  const giveway = net.junctions.findIndex(j => j.control === 'giveway'), major = E.find(e => e.kind === 'path' && e.j === giveway && e.turn === 'straight' && e.axis !== net.junctions[giveway].minor)!;
  it('notes stopping in it for 3 s', () => {
    expect(stopIn(new Rules(net), major, 2.5, 0)).toEqual([]);
    const fs = stopIn(new Rules(net), major, 4, 0);
    expect(kinds(fs)).toEqual(['block']); expect(fs[0].text).toBe(`You stopped in the junction at ${net.junctions[giveway].name}.`);
  });
  it('lets you wait in it to turn across the oncoming lane, signalling', () => {
    expect(stopIn(new Rules(net), major, 10, 0, -1)).toEqual([]);   // keeping right: the far turn is left
  });
  it('at the lights, lets you wait in it while they are with you, and not once they have turned red', () => {
    const J = net.junctions.findIndex(j => j.name === 'Harbour Street and Market Street'), p = E.find(e => e.kind === 'path' && e.j === J && e.turn === 'straight' && e.street === 'harbour')!;
    let green = 0;
    for (let t = 0; t < CYCLE; t += 0.05) if (lightAt(net.junctions[J], p.axis, t) === 'green' && lightAt(net.junctions[J], p.axis, t + 12) === 'green') { green = t; break; }
    expect(stopIn(new Rules(net), p, 8, green)).toEqual([]);
    expect(kinds(stopIn(new Rules(net), p, 30, green))).toEqual(['block']);   // still there well into the red
  });
});

describe('parking where it is not allowed', () => {
  /** Stopped for `secs` with your car parked at the kerb, its middle at along (x on Harbour Street's north side, driving west). */
  function parkedAt(x: number, secs: number, rules = new Rules(net)): Fault[] {
    const th = Math.PI, z = -(5.35 - 0.2 - ATTO2.W / 2), out: Fault[] = [];   // the north kerb is at z = -5.35
    for (let n = 0; n < secs * 60; n++) out.push(...rules.step(car(x + (ATTO2.L / 2 - ATTO2.OVR), z, th, 0, { drive: false }), null, n * STEP, STEP, null));
    return out;
  }
  it('notes parking in a bus stop for 10 s, once', () => {
    expect(parkedAt(45, 9)).toEqual([]);
    const fs = parkedAt(45, 30);
    expect(kinds(fs)).toEqual(['zone']); expect(fs[0].text).toBe('You parked in a bus stop on Harbour Street.');
  });
  it('notes parking by a junction, and not in a space between the cars', () => {
    const J = m.junctions.find(r => r[2] < 0 && r[3] > 0 && r[0] > 0)!;   // the first junction east of the middle on Harbour Street
    expect(parkedAt(J[0] - 3, 12).map(f => f.text)).toEqual(['You parked in the kerb by a junction on Harbour Street.']);
    const sl = m.slots.find((s): s is KerbSlot => s.kind === 'kerb' && s.street.id === 'harbour' && s.side === -1)!;
    expect(parkedAt((sl.a0 + sl.a1) / 2, 12)).toEqual([]);
  });
});

describe('hazard lights, by country', () => {
  function run(c: Country, moving: boolean, secs: number): Fault[] {
    const rules = new Rules(net, c), out: Fault[] = [], [x, z, th] = poseOn(E[0], 10);
    for (let n = 0; n < secs * 60; n++) out.push(...rules.step(car(x + (moving ? n * STEP * Math.cos(th) : 0), z - (moving ? n * STEP * Math.sin(th) : 0), th, moving ? 1 : 0, { hazard: true }), null, n * STEP, STEP, null));
    return out;
  }
  it('in the UK: only while you are stopped (Highway Code rule 116)', () => {
    expect(run(COUNTRIES.gb, false, 20)).toEqual([]);
    const fs = run(COUNTRIES.gb, true, 3);
    expect(kinds(fs)).toEqual(['hazard']); expect(fs[0].text).toContain('Highway Code rule 116');
  });
  it('in Germany: only for danger (StVO §16), so not even while waiting', () => {
    expect(run(COUNTRIES.de, false, 2.5)).toEqual([]);
    const fs = run(COUNTRIES.de, false, 4);
    expect(kinds(fs)).toEqual(['hazard']); expect(fs[0].text).toContain('StVO §16');
  });
  it('in Morocco: not scored, since the rule is not checked yet', () => {
    expect(run(COUNTRIES.ma, true, 10)).toEqual([]); expect(run(COUNTRIES.ma, false, 10)).toEqual([]);
  });
});

describe('the countries', () => {
  it('keep to their side of the road, and settings saved before there was a choice keep theirs', () => {
    expect([COUNTRIES.ma.drive, COUNTRIES.de.drive, COUNTRIES.gb.drive]).toEqual(['right', 'right', 'left']);
    expect(countryOf({})).toBe('ma'); expect(countryOf({ drive: 'left' })).toBe('gb'); expect(countryOf({ drive: 'right' })).toBe('ma');
    expect(countryOf({ country: 'de', drive: 'left' })).toBe('de'); expect(countryOf({ country: 'xx', drive: 'left' })).toBe('gb');
  });
  it('say what a thief taking your space means there', () => {
    expect(theftNote(COUNTRIES.de)).toContain('broke the law (StVO §12(5))');
    expect(theftNote(COUNTRIES.gb)).toContain('only rude');
    expect(theftNote(COUNTRIES.ma)).toContain('not in the game yet');
  });
});

describe('your drive, with the rules in the sim', () => {
  it('notes reversing into a space on the street without signalling, as a fault the game shows', () => {
    const net2 = networkOf(m), sim = new Sim(m.scene, ATTO2), slot = m.slots.find((s): s is KerbSlot => s.kind === 'kerb')!, at = parkStart(ATTO2, slot);
    m.scene.net = net2; sim.traffic = new Traffic(net2); sim.rules = new Rules(net2, COUNTRIES.gb);
    sim.reset('start'); sim.place(at.x, at.z, at.th); sim.options.bay = slot.id; sim.setMode('park');
    const evs: SimEvent[] = [];
    sim.input.rev = true;
    for (let n = 0; n < 60; n++) evs.push(...sim.step(STEP));
    expect(evs.flatMap(e => (e.type === 'fault' ? [e.fault.kind] : []))).toEqual(['signal']);
    expect(sim.rules.snapshot().country).toBe('gb');
  });
});
