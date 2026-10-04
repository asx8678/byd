// The level generator: every level it makes can be driven. The route clears everything with the exact
// collision test, the car starts clear, and the route's end counts as parked, neatly, with three stars.
import { describe, expect, it } from 'vitest';
import { ATTO2 } from '../src/core/content';
import { generate, levelKey, parseKey, type Level } from '../src/core/generator/level';
import { TEMPLATES } from '../src/core/generator/templates';
import { collides } from '../src/core/collision';
import { exactCheck, fieldFor, planBack, sample } from '../src/core/planner';
import { makeScene } from '../src/core/scene';
import { Recorder, STEP, playback } from '../src/core/replay';
import { starsFor } from '../src/core/score';
import { Sim, type SimEvent } from '../src/core/sim';

const SEEDS = Number(process.env.GEN_SEEDS ?? 3);
const route = (L: Level) => L.route.map(p => `${p.dir > 0 ? 'F' : 'R'}${p.lvl}:${p.len.toFixed(2)}`).join(' ');

describe.each(TEMPLATES)('%s', tpl => {
  for (let level = 1; level <= 10; level++) {
    it(`levels ${level}, seeds 1–${SEEDS}`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const L = generate(ATTO2, tpl, level, seed)!, key = levelKey(tpl, level, seed);
        expect(L, key).not.toBeNull();
        expect(exactCheck(ATTO2, L.scene, fieldFor(ATTO2, L.scene), L.route), key).toBeNull();
        const sim = new Sim(L.scene, ATTO2); sim.reset('start');
        expect(sim.touching(), key).toBeNull();
        // the route's end, stopped, after par moves: parked the right way round, neatly, three stars
        const e = L.route[L.route.length - 1].to; sim.place(e.x, e.z, e.th); sim.moves = L.par;
        const parked = sim.step(STEP).find(x => x.type === 'parked');
        expect(parked, `${key}: ${route(L)}`).toBeDefined();
        if (parked?.type === 'parked') expect(starsFor(parked.result, L.par, L.timeLimit).count, key).toBe(3);
        expect(L.par).toBeGreaterThanOrEqual(1); expect(L.measure.score).toBeGreaterThanOrEqual(1);
      }
    });
  }
});

describe('levels', () => {
  it('are the same every time', () => {
    const a = generate(ATTO2, 'kerb', 7, 42)!, b = generate(ATTO2, 'kerb', 7, 42)!;
    expect(route(a)).toBe(route(b)); expect(a.scene.obstacles.length).toBe(b.scene.obstacles.length); expect(a.nodes).toBe(b.nodes);
  });
  it('keys round-trip', () => {
    expect(parseKey(levelKey('bays-back', 10, 4821))).toEqual({ template: 'bays-back', level: 10, seed: 4821 });
    expect(parseKey('garage:1:2')).toBeNull();
  });
  it('reversing in does not count in a nose-first bay, and the other way round', () => {
    for (const [tpl, flip] of [['bays-in', Math.PI], ['bays-back', Math.PI]] as const) {
      const L = generate(ATTO2, tpl, 3, 1)!, e = L.route[L.route.length - 1].to, sim = new Sim(L.scene, ATTO2);
      // the same spot facing the other way: the car's footprint moves, so check the rule directly on a centred pose
      const b = L.scene.bays.target, z = (b.z0 + b.z1) / 2, x = (b.x0 + b.x1) / 2;
      const th = e.th + flip, ax = x - (ATTO2.WB / 2) * Math.cos(th), az = z + (ATTO2.WB / 2) * Math.sin(th);
      sim.place(ax, az, th);
      expect(sim.touching(), tpl).toBeNull();
      expect(sim.step(STEP).some(x => x.type === 'parked'), tpl).toBe(false);
    }
  });
  it('Show me plans back from the space to where the car is, part way in', () => {
    for (const key of [['kerb', 3, 2], ['kerb', 10, 1], ['bays-in', 10, 2]] as const) {
      const L = generate(ATTO2, key[0], key[1], key[2])!, pts = sample(ATTO2, L.route, 0.1), from = pts[Math.floor(pts.length * 0.6)];
      const plan = planBack(ATTO2, L.scene, from, 'target', { maxNodes: 6000 });
      expect(plan.status, key.join(':')).toBe('found');
      expect(exactCheck(ATTO2, L.scene, plan.field, plan.pieces), key.join(':')).toBeNull();
      const s = plan.pieces[0]?.from ?? from; expect(Math.hypot(s.x - from.x, s.z - from.z), key.join(':')).toBeLessThan(0.2);
    }
  });
});

describe('kerbs', () => {
  it('stop the wheels, not the bumpers', () => {
    // a kerb along z = 0 with the pavement below it, and the car nose on to it with the bumper already over it
    const sc = makeScene({ format: 1, id: 'kerb-only', name: 'Kerb', layoutVersion: 1, areaView: [-10, 10, -10, 5], defaultBay: 'a', bays: { a: { x0: -1, x1: 1, z0: 0, z1: 5, headZ: 0, sideTol: 0, mouthTol: 0, inHeading: Math.PI / 2 } },
      defaultStart: 's', starts: { s: { x: 0, z: -ATTO2.WB - 0.5, th: -Math.PI / 2 } }, lines: [], obstacles: [], kerbs: [{ name: 'kerb', a: [-20, 0], b: [20, 0], depth: 3 }] });
    const sim = new Sim(sc, ATTO2); sim.reset('s');
    expect(sim.touching()).toBeNull();                                        // 38 cm of bumper over the kerb is fine
    expect(collides(ATTO2, sc.obstacles, 0, -ATTO2.WB + 0.2, -Math.PI / 2)?.part).toBe('front left wheel');
    sim.input.fwd = true;
    const evs: SimEvent[] = []; for (let i = 0; i < 300 && !evs.length; i++) evs.push(...sim.step(STEP));
    expect(evs[0]?.type).toBe('touch');
    if (evs[0]?.type === 'touch') { expect(evs[0].name).toBe('kerb'); expect(evs[0].part).toMatch(/^front (left|right) wheel$/); }
    expect(sim.z + ATTO2.WB + ATTO2.WR).toBeLessThan(0.01);                    // stopped with the tyre at the kerb
  });
  it('a drive in a level replays exactly, touches and moves included', () => {
    const L = generate(ATTO2, 'kerb', 1, 1)!, sim = new Sim(L.scene, ATTO2), rec = new Recorder();
    sim.reset('start'); rec.begin(sim);
    const live: SimEvent[] = [], steps = (n: number) => { for (let i = 0; i < n; i++) { rec.before(sim); live.push(...sim.step(STEP)); rec.after(sim); } };
    sim.input.fwd = true; steps(120); sim.input.fwd = false; steps(60);
    sim.input.rev = true; steps(60); sim.input.rev = false; steps(40);
    sim.wheelAngle = sim.options.lockDeg; sim.input.fwd = true; steps(400); sim.input.fwd = false; steps(30);
    const p = playback(rec.rec!, L.scene, ATTO2), again: SimEvent[] = [];
    for (let evs = p.step(); evs; evs = p.step()) again.push(...evs);
    expect(again).toEqual(live);
    expect(live.some(e => e.type === 'touch')).toBe(true);
    for (const k of ['x', 'z', 'th', 'v', 'moves', 'hits'] as const) expect(Object.is(p.sim[k], sim[k]), k).toBe(true);
    expect(sim.moves).toBe(3);
  });
});
