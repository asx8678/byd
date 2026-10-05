// The course in every car: each lesson's stored route is still the one worked out for that car (the planner, or the
// route written for the scene), clears everything and passes; a driver who does only what the coach says (set the
// wheel, drive, let go when told) passes every lesson, also reacting late, stopping at either end of a mark's window or
// with the wheel a little off; the feedback after a try names what went wrong; and the help steps back as it should.
// UPDATE_ROUTES=1 writes the other cars' routes into content/lessons/course.json; LESSON_DRIVERS=all runs every
// driver in every car (by default the other cars get the guided driver and the late one).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CoachRun, Tracker, feedback, sentence, stepsFor, timingCause, type TrackPt } from '../src/core/coach';
import { ATTO2, VEHICLES, vehicleFor } from '../src/core/content';
import { COURSE, afterTry, checkPass, fillText, freshState, loadLesson, routeFor, type Lesson, type LessonDef } from '../src/core/lesson';
import { lessonSteps, planLesson, routeNote, stepMap, tipsFor } from '../src/core/lessonRoutes';
import { DEG } from '../src/core/math';
import { exactCheck, fieldFor, moves, type Piece } from '../src/core/planner';
import { Recorder, STEP, replayTo, restoreState, stateOf } from '../src/core/replay';
import { DRIVERS, failures, lessonSim } from '../src/core/robot';
import { type ParkedResult, type Sim } from '../src/core/sim';
import type { Vehicle } from '../src/core/vehicle';

const V = ATTO2, CARS = Object.values(VEHICLES);
const LESSONS = COURSE.lessons.filter(l => !l.soon);
const fmt = (r: readonly Piece[]) => r.map(p => `${p.dir > 0 ? 'F' : 'R'}${p.lvl}:${p.len.toFixed(2)}`).join(' ');
const picks = (def: LessonDef) => Object.fromEntries(Object.entries(def.tips ?? {}).map(([k, t]) => [k, t.cue]));
const stepsOf = (L: Lesson) => stepsFor(V, L.scene, L.bay, L.route, picks(L.def));
const newSim = (L: Lesson): Sim => lessonSim(V, L);

/** The result of parking at the route's end, stopped, after par moves. */
function parkedAtEnd(L: Lesson, v: Vehicle = V): ParkedResult | null {
  const sim = lessonSim(v, L), e = L.route[L.route.length - 1].to;
  sim.place(e.x, e.z, e.th); sim.moves = L.par;
  const ev = sim.step(STEP).find(x => x.type === 'parked');
  return ev?.type === 'parked' ? ev.result : null;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
if (process.env.UPDATE_ROUTES) it('writes the other cars\' routes into course.json', () => {
  const course = JSON.parse(JSON.stringify(COURSE)) as typeof COURSE;
  course.lessons = course.lessons.map(def => {
    if (def.soon || !def.route) return def;
    const routes: Record<string, { start: number[]; pieces: number[][] } | null> = {};
    for (const v of CARS) {
      if (v === V) continue;
      const r = planLesson(v, def), s = r?.[0].from;
      routes[v.id] = r && s ? { start: [r6(s.x), r6(s.z), r6(s.th)], pieces: r.map(p => [p.dir, p.lvl, r6(p.len)]) } : null;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(def)) { if (k === 'routes') continue; out[k] = val; if (k === 'route') out.routes = routes; }
    return out as unknown as LessonDef;
  });
  writeFileSync(new URL('../content/lessons/course.json', import.meta.url), JSON.stringify(course, null, 2) + '\n');
}, 600000);

describe('lesson routes', () => {
  it('ten lessons to drive, numbered 1 to 10', () => {
    expect(LESSONS.map(l => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(COURSE.lessons.map(l => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const l of COURSE.lessons) for (const p of [...(l.explain ?? []), ...Object.values(l.tips ?? {})]) for (const s of p.sources ?? []) expect(COURSE.sources[s], `${l.id}: ${s}`).toBeDefined();
  });
  for (const def of LESSONS) for (const v of CARS) {
    it(`${def.n} ${def.title}, ${v.id}: the stored route is still the one worked out for this car, and it passes`, () => {
      // the Atto 2's: planned with the wheel at full lock or straight from the same place, or written for the scene;
      // another car's: the same, keeping the Atto 2's moves where every coached driver can follow them (lessonRoutes.ts)
      const planned = planLesson(v, def), stored = routeFor(v, def);
      if (!planned) { expect(stored, 'stored as not for this car').toBeNull(); return; }
      expect(stored, 'a route stored for this car').toBeTruthy();
      const L = loadLesson(v, def), s = planned[0].from, t = L.route[0].from;
      expect(fmt(L.route)).toBe(fmt(planned));
      expect(Math.hypot(s.x - t.x, s.z - t.z) + Math.abs(s.th - t.th)).toBeLessThan(1e-5);
      expect(exactCheck(v, L.scene, fieldFor(v, L.scene), L.route)).toBeNull();
      expect(lessonSim(v, L).touching()).toBeNull();
      const r = parkedAtEnd(L, v);
      expect(r).not.toBeNull();
      expect(checkPass(r!, def.pass ?? {}, L.par).pass, JSON.stringify(checkPass(r!, def.pass ?? {}, L.par).lines)).toBe(true);
    }, 120000);
  }
  it('the lessons a car cannot do: your garage in the Ram and the S-Class, the tight parallel space in the Ram', () => {
    const not = CARS.flatMap(v => LESSONS.filter(def => routeFor(v, def) === null).map(def => `${def.id}:${v.id}`)).sort();
    expect(not).toEqual(['garage:mercedes-s-class-w223@0', 'garage:mercedes-s-class-w223@10', 'garage:mercedes-s-class-w223@4.5', 'garage:ram-1500-dt', 'parallel-tight:ram-1500-dt']);
  });
});

describe('steps', () => {
  it('say what the handbooks say, with this car\'s numbers', () => {
    const say = (id: string) => { const def = LESSONS.find(l => l.id === id)!, L = loadLesson(V, def); return stepsOf(L).map(sentence); };
    expect(say('bay-forward')[0]).toBe('Drive forward with the wheels straight until your mirror is 55 cm short of the near line of the green bay.');
    expect(say('bay-forward')[1]).toMatch(/^Drive forward with full lock left until the car is straight in the bay, your front bumper about \d+ cm from the back line\.$/);
    expect(say('bay-reverse')[1]).toBe('Reverse with full lock left until the car is straight in the bay.');
    expect(say('parallel-big')[0]).toBe('Drive forward with the wheels straight until your rear bumper is level with the back of the car in front.');
    expect(say('parallel-big')[1]).toBe('Reverse with full lock right, towards the kerb, until the car is at about 50° to the kerb.');
    expect(say('parallel-big')[2]).toMatch(/^Reverse with full lock left, away from the kerb, until the car is straight, tyres about \d+ cm from the kerb\.$/);
    expect(say('parallel-tight')[1]).toBe('Reverse with full lock right, towards the kerb, until the car is at about 45° to the kerb.');
    expect(say('garage')[3]).toMatch(/^Drive forward with the wheels straight until your front bumper is about \d+ cm from the concrete bench\.$/);
  });
  it('one per piece, ending where the piece ends, turns of 10° or more on the angle, in every car', () => {
    for (const v of CARS) for (const def of LESSONS) {
      if (!routeFor(v, def)) continue;
      const L = loadLesson(v, def), S = lessonSteps(v, L);
      expect(S.length).toBe(L.route.length);
      S.forEach((s, i) => { expect(s.to).toEqual(L.route[i].to); expect(s.byHeading, `${v.id} ${def.id} ${i + 1}`).toBe(L.route[i].lvl !== 0 && Math.abs(s.turn) >= 10 * DEG); });
      if (v === V) expect(S.every((s, i) => s.byHeading === (L.route[i].lvl !== 0))).toBe(true);   // all the Atto 2's turns are 10° or more
    }
  });
});

describe('the same lessons in other cars', () => {
  it('keep the tips on the steps they are about', () => {
    const def = LESSONS.find(l => l.id === 'parallel-tight')!;
    expect([...stepMap(def, loadLesson(V, def).route)]).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
    // a route with an extra move: a tip goes where the same two pieces meet, so the mirror rule for turning in off the
    // straight is left out of the Ram's drive-past-and-back-up route; the last step's tip stays on the last step
    const four = LESSONS.find(l => l.id === 'bay-between')!, ram = loadLesson(vehicleFor('ram-1500-dt'), four).route;
    expect(fmt(ram).replace(/:[\d.]+/g, '')).toBe('F0 R1 F-1 F0');
    expect([...stepMap(four, ram)]).toEqual([[2, 3], [3, 4]]);
    expect(Object.keys(tipsFor(four, ram))).toEqual([]);
    // the Smart's three-phase parallel park keeps the line-up tip and the kerb tip
    const six = LESSONS.find(l => l.id === 'parallel-big')!, smart = loadLesson(vehicleFor('smart-fortwo-c453'), six).route;
    expect(fmt(smart).replace(/:[\d.]+/g, '')).toBe('F0 R1 R0 R-1');
    expect(Object.keys(tipsFor(six, smart))).toEqual(['1', '4']);
  });
  it('say on the card how the car does it differently', () => {
    const note = (v: Vehicle, id: string) => { const def = LESSONS.find(l => l.id === id)!; return routeNote(def, v, loadLesson(v, def).route); };
    for (const def of LESSONS) expect(note(V, def.id)).toBe('');
    expect(note(vehicleFor('ram-1500-dt'), 'bay-between')).toBe('The Ram 1500 needs 3 moves here where the Atto 2 needs 1: the coach shows each one.');
    expect(note(vehicleFor('ram-1500-dt'), 'angled')).toMatch(/^The Ram 1500 turns wider, so it comes up the aisle \d\.\d m out from the parked cars rather than 1\.2 m\.$/);
    expect(note(vehicleFor('smart-fortwo-c453'), 'angled')).toBe('');
  });
  it('the Atto 2\'s coach says exactly what it said before other cars came', () => {
    for (const def of LESSONS) { const L = loadLesson(V, def); expect(lessonSteps(V, L)).toEqual(stepsOf(L)); }
  });
  it('name only the parts the car has: a Smart has no back seat', () => {
    const smart = vehicleFor('smart-fortwo-c453');
    for (const def of LESSONS) {
      if (!routeFor(smart, def)) continue;
      const L = loadLesson(smart, def);
      for (const st of lessonSteps(smart, L)) expect(sentence(st) + (st.see ?? ''), def.id).not.toMatch(/back seat/);
    }
  });
  it('say each car\'s own numbers, and the Atto 2\'s words stay as they were', () => {
    const text = (v: Vehicle, id: string, k: number) => { const def = LESSONS.find(l => l.id === id)!; return fillText(def.explain![k].text, v, loadLesson(v, def)); };
    expect(text(V, 'how-a-car-turns', 0)).toBe('On full lock your Atto 2 turns in a circle 10.6 m across, kerb to kerb (BYD\'s figure). The dashed lines on the floor are the path it sweeps on full lock: the inner one is where your inner rear wheel runs, the outer one where your outer front corner swings.');
    expect(text(V, 'bay-forward', 1)).toBe('Here the bay is 2.7 m wide with no cars beside it, so you can watch the rule work. The coach stops you at each mark: set the wheel, then drive on.');
    expect(text(V, 'bay-between', 0)).toBe('The same rule as the last lesson: turn when your mirror reaches the bay\'s near line. The bay is 2.57 m wide and the cars either side are parked off centre, so the mark matters more.');
    expect(text(vehicleFor('ram-1500-dt'), 'how-a-car-turns', 0)).toMatch(/^On full lock your Ram 1500 turns in a circle 14\.08 m across, kerb to kerb \(FCA's figure\)\./);
    expect(text(vehicleFor('mercedes-s-class-w223', 10), 'how-a-car-turns', 0)).toMatch(/^On full lock your S-Class turns in a circle about 10\.0 m across, kerb to kerb, worked out from Mercedes' 10\.79 m wall to wall with 10° rear-axle steering\./);
    expect(text(vehicleFor('ram-1500-dt'), 'bay-forward', 1)).toMatch(/^Here the bay is 2\.95 m wide/);
  });
});

const ALL = process.env.LESSON_DRIVERS === 'all';
describe('guided driving', () => {
  for (const def of LESSONS) for (const v of CARS) {
    if (!routeFor(v, def)) continue;
    const drivers = v === V || ALL ? DRIVERS : DRIVERS.filter(([name]) => name === 'guided' || name.endsWith('late'));
    it(`${def.n} ${def.title}, ${v.id}: a driver who follows the coach passes`, () => {
      const L = loadLesson(v, def);
      expect(failures(v, L, lessonSteps(v, L), drivers)).toEqual([]);
    }, 60000);
  }
  it('the pedals wait for the wheel, only go the step\'s way, and keep to walking pace', () => {
    const L = loadLesson(V, LESSONS.find(l => l.id === 'parallel-big')!), sim = newSim(L), run = new CoachRun(V, stepsOf(L), () => sim.options.lockDeg);
    run.observe(sim);
    expect(run.gate({ fwd: false, rev: true }, sim)).toEqual({ fwd: false, rev: false });   // step 1 drives forward
    expect(run.hint).toBe('This step drives forward');
    sim.wheelAngle = 100;   // not straight: nothing moves until it is
    run.phase = 'wheel';
    expect(run.gate({ fwd: true, rev: false }, sim).fwd).toBe(false);
    expect(run.hint).toBe('Tap Straighten first');
    sim.wheelAngle = 0;
    expect(run.gate({ fwd: true, rev: false }, sim).fwd).toBe(true);
    sim.v = 1.5;
    expect(run.gate({ fwd: true, rev: false }, sim).fwd).toBe(false);
  });
});

describe('feedback', () => {
  /** Drive a lesson's route with a script, carefully (under 0.8 m/s, stopping on each piece's end): the pieces as
   *  planned, but one of them stretched or shortened by `shift` metres (so the next turn comes early or late) or
   *  driven at another steering. */
  function scripted(L: Lesson, change: { piece: number; shift?: number; lvl?: number }): TrackPt[] {
    const sim = newSim(L), tr = new Tracker();
    tr.add(sim);
    L.route.forEach((p, i) => {
      const len = p.len + (i === change.piece ? change.shift ?? 0 : 0), lvl = i === change.piece && change.lvl !== undefined ? change.lvl : p.lvl;
      sim.wheelAngle = lvl * sim.options.lockDeg; sim.input.wheelHeld = true;
      const sx = sim.x, sz = sim.z, sth = sim.th;
      let gone = 0;
      for (let t = 0; t < 60 * 30 && gone < len - 0.005; t++) {
        const go = len - gone > sim.v * sim.v / (2 * V.drive.BRAKE) + 0.01 && Math.abs(sim.v) < 0.8;
        sim.input.fwd = go && p.dir > 0; sim.input.rev = go && p.dir < 0;
        sim.step(STEP); tr.add(sim);
        gone = lvl === 0 ? Math.hypot(sim.x - sx, sim.z - sz) : Math.abs(sim.th - sth) / Math.abs(Math.tan(lvl * V.MAXSTEER * Math.PI / 180) / V.WB);
        if (!go && sim.v === 0) break;
      }
      sim.input.fwd = sim.input.rev = false;
      for (let t = 0; t < 120 && sim.v !== 0; t++) { sim.step(STEP); tr.add(sim); }
    });
    return tr.pts;
  }
  const lesson = (id: string) => loadLesson(V, LESSONS.find(l => l.id === id)!);
  it('a drive that follows the route says so', () => {
    const L = lesson('bay-forward'), f = feedback(V, L.route, stepsOf(L), scripted(L, { piece: -1 }));
    expect(f.at).toBeNull();
    expect(f.text).toBe('You stayed within 30 cm of the route all the way.');
  });
  it('names a turn that came too early or too late, and by how much', () => {
    const L = lesson('bay-between'), S = stepsOf(L);
    const early = feedback(V, L.route, S, scripted(L, { piece: 0, shift: -0.6 }));
    expect(early.text).toMatch(/^You turned to full lock (55|60|65) cm too early: the mark is when your mirror is \d+ cm short of the near line of the green bay\.$/);
    expect(early.step).toBe(2);
    const late = feedback(V, L.route, S, scripted(L, { piece: 0, shift: 0.7 }));
    expect(late.text).toMatch(/^You turned to full lock (65|70|75) cm too late/);
  });
  it('names a stop too soon before reversing, and a wheel short of full lock', () => {
    const L = lesson('parallel-big'), S = stepsOf(L);
    expect(feedback(V, L.route, S, scripted(L, { piece: 0, shift: -0.8 })).text).toMatch(/^You stopped (75|80|85) cm too soon before reversing: the mark is when your rear bumper is level with the back of the car in front\.$/);
    expect(feedback(V, L.route, S, scripted(L, { piece: 1, lvl: 0.5 })).text).toMatch(/^The wheel was only at about half lock: this part needs full lock\.$/);
  });
  it('says when the wheel came off full lock on the way', () => {
    const L = lesson('bay-forward'), pts = scripted(L, { piece: -1 });
    // the same drive with the wheel easing off half way through the turn, as when it self-centres
    const S = stepsOf(L), half = pts.findIndex(p => p.lvl < -0.99) + 40;
    const eased = scripted(L, { piece: -1 }).map((p, k) => (k > half ? { ...p, lvl: -0.55 } : p));
    // the track itself still has to leave the route for there to be anything to say: shift the later points out
    const off = eased.map((p, k) => (k > half ? { ...p, x: p.x + 0.02 * (k - half), z: p.z + 0.01 * (k - half) } : p));
    expect(feedback(V, L.route, S, off).text).toBe('The wheel came off full lock as you drove: keep your finger on it.');
  });
  it('a parallel park that misses the kerb rule by a little names the switch that caused it, in degrees', () => {
    const L = lesson('parallel-big'), S = stepsOf(L), pts = scripted(L, { piece: 1, shift: -0.13 });   // steering away 2° early
    expect(feedback(V, L.route, S, pts).at).toBeNull();   // it never left the route by 30 cm
    expect(timingCause(V, L.route, S, pts)?.text).toBe('You steered the other way 2° too early: the mark is when the car is at about 50° to the kerb.');
    expect(timingCause(V, L.route, S, scripted(L, { piece: -1 }))).toBeNull();   // nothing stands out on a good drive
  });
  it('an overshoot before reversing is named with how far', () => {
    const L = lesson('parallel-big');
    expect(feedback(V, L.route, stepsOf(L), scripted(L, { piece: 0, shift: 0.8 })).text).toMatch(/^You went (75|80|85) cm too far before reversing: the mark is when your rear bumper is level with the back of the car in front\.$/);
  });
  it('an extra move is named as one', () => {
    const L = lesson('bay-forward'), pts = scripted(L, { piece: -1 });
    const extra = [...pts.slice(0, 30), ...pts.slice(30, 40).map(p => ({ ...p, dir: -1 as const, run: 2 }))];
    expect(feedback(V, L.route, stepsOf(L), extra).text).toBe('You needed an extra move here.');
  });
});

describe('help that steps back', () => {
  it('two passes lower it, two fails raise it with slow motion, a pass in the test finishes', () => {
    let s = freshState(), c;
    ({ state: s, change: c } = afterTry(s, true)); expect([s.help, c]).toEqual([0, null]);
    ({ state: s, change: c } = afterTry(s, true)); expect([s.help, c, s.slow]).toEqual([1, 'less', false]);
    ({ state: s, change: c } = afterTry(s, false)); expect([s.help, c]).toEqual([1, null]);
    ({ state: s, change: c } = afterTry(s, false)); expect([s.help, c, s.slow]).toEqual([0, 'more', true]);
    ({ state: s, change: c } = afterTry(s, false)); ({ state: s, change: c } = afterTry(s, false)); expect([s.help, c, s.slow]).toEqual([0, 'slow', true]);
    for (let k = 0; k < 6; k++) ({ state: s } = afterTry(s, true));
    expect([s.help, s.slow, s.done]).toEqual([3, false, false]);
    ({ state: s, change: c } = afterTry(s, true)); expect([s.done, c]).toEqual([true, 'done']);
  });
  it('the pass rules read the result', () => {
    const L = loadLesson(V, LESSONS.find(l => l.id === 'parallel-tight')!), r = parkedAtEnd(L)!;
    expect(checkPass({ ...r, moves: L.par + 2 }, { kerb: 0.3, moves: 'par+1' }, L.par).pass).toBe(false);
    expect(checkPass({ ...r, hits: 1 }, { kerb: 0.3 }, L.par).lines[0]).toEqual({ ok: false, text: '1 touch: a pass needs a clean run' });
    expect(moves(L.route)).toBe(L.par);
  });
});

describe('the coach on long turns and in a lane', () => {
  it('a U-turn is measured the long way round: at its start the mark is the whole 180° arc away', () => {
    const L = loadLesson(V, LESSONS.find(l => l.id === 'how-a-car-turns')!), S = stepsOf(L), sim = newSim(L), run = new CoachRun(V, S, () => sim.options.lockDeg);
    const p = S[1].from; sim.place(p.x, p.z, p.th); run.k = 1; run.phase = 'drive'; run.observe(sim);
    expect(Math.abs(S[1].turn) / DEG).toBeGreaterThan(179);
    expect(run.left).toBeCloseTo(S[1].len, 2);
  });
  it('leaving: parked in the space does not count; out in the lane, straight, does', () => {
    const L = loadLesson(V, LESSONS.find(l => l.id === 'leaving')!), sim = newSim(L);
    expect(L.bay).toBe('exit'); expect(sim.step(STEP).some(e => e.type === 'parked')).toBe(false);
    const r = parkedAtEnd(L)!;
    expect(r.kind).toBe('exit'); expect(Math.abs(r.angle)).toBeLessThan(3);
  });
});

describe('rewind', () => {
  /** A guided try driven by a hand that only does what the coach shows, step by step, with everything recorded. */
  function rig(L: Lesson) {
    const sim = newSim(L), S = stepsOf(L), rec = new Recorder();
    const r = { sim, S, rec, run: new CoachRun(V, S, () => sim.options.lockDeg), tr: new Tracker(), steps: (n: number) => {
      for (let i = 0; i < n; i++) {
        const run = r.run, st = run.step;
        if (st) { const d = run.wheelWant() - sim.wheelAngle; sim.input.wheelHeld = true; sim.wheelAngle += Math.sign(d) * Math.min(Math.abs(d), 360 * STEP); }
        const g = run.gate({ fwd: run.phase === 'drive' && st?.dir === 1, rev: run.phase === 'drive' && st?.dir === -1 }, sim);
        sim.input.fwd = g.fwd; sim.input.rev = g.rev;
        rec.before(sim); sim.step(STEP); rec.after(sim); r.tr.add(sim); run.observe(sim);
      }
    } };
    rec.begin(sim); r.tr.add(sim);
    return r;
  }
  const look = (r: ReturnType<typeof rig>) => ({ x: r.sim.x, z: r.sim.z, th: r.sim.th, v: r.sim.v, wheel: r.sim.wheelAngle, moves: r.sim.moves, k: r.run.k, phase: r.run.phase, track: r.tr.pts.length });
  for (const id of ['parallel-big', 'garage']) {
    it(`${id}: going back 5 s and driving on again ends exactly where never going back does`, () => {
      const L = loadLesson(V, LESSONS.find(l => l.id === id)!);
      const a = rig(L); a.steps(1500);
      const b = rig(L); b.steps(1200);
      // back 300 steps: replay the recording to there, rebuilding the coach and the path as it goes
      const n = b.rec.rec!.steps - 300, run = new CoachRun(V, b.S, () => b.sim.options.lockDeg), tr = new Tracker();
      const p = replayTo(b.rec.rec!, L.scene, V, n, s => run.sync(s), s => { tr.add(s); run.observe(s); });
      restoreState(b.sim, stateOf(p)); b.rec.truncate(n, b.sim);
      Object.assign(b, { run, tr });
      b.steps(600);
      expect(look(b)).toEqual(look(a));
      expect(b.rec.rec!.steps).toBe(1500);
    });
  }
});
