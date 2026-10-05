// The course: every lesson's stored route is still the one the planner finds, clears everything and passes;
// a driver who does only what the coach says (set the wheel, drive, let go when told) passes every lesson, also
// reacting late, stopping at either end of a mark's window or with the wheel a little off; the feedback after a
// try names what went wrong; and the help steps back as it should.
import { describe, expect, it } from 'vitest';
import { CoachRun, MARK, Tracker, feedback, sentence, stepsFor, timingCause, type Step, type TrackPt } from '../src/core/coach';
import { ATTO2, GARAGE_561 } from '../src/core/content';
import { solve } from '../src/core/generator/level';
import { draft } from '../src/core/generator/templates';
import { COURSE, afterTry, checkPass, freshState, loadLesson, type Lesson, type LessonDef } from '../src/core/lesson';
import { exactCheck, fieldFor, moves, planToBay, type Piece } from '../src/core/planner';
import { makeScene } from '../src/core/scene';
import { STEP } from '../src/core/replay';
import { Sim, type ParkedResult } from '../src/core/sim';

const V = ATTO2, LOCK = [-1, 0, 1];
const LESSONS = COURSE.lessons.filter(l => !l.soon);
const fmt = (r: readonly Piece[]) => r.map(p => `${p.dir > 0 ? 'F' : 'R'}${p.lvl}:${p.len.toFixed(2)}`).join(' ');
const picks = (def: LessonDef) => Object.fromEntries(Object.entries(def.tips ?? {}).map(([k, t]) => [k, t.cue]));
const stepsOf = (L: Lesson) => stepsFor(V, L.scene, L.bay, L.route, picks(L.def));

function newSim(L: Lesson): Sim {
  const sim = new Sim(L.scene, V), s = L.route[0].from;
  sim.options.bay = L.bay; sim.resetAt(s.x, s.z, s.th);
  return sim;
}

/** The result of parking at the route's end, stopped, after par moves. */
function parkedAtEnd(L: Lesson): ParkedResult | null {
  const sim = newSim(L), e = L.route[L.route.length - 1].to;
  sim.place(e.x, e.z, e.th); sim.moves = L.par;
  const ev = sim.step(STEP).find(x => x.type === 'parked');
  return ev?.type === 'parked' ? ev.result : null;
}

describe('lesson routes', () => {
  it('six lessons to drive, four still to come, numbered 1 to 10', () => {
    expect(LESSONS.map(l => l.n)).toEqual([3, 4, 5, 6, 7, 10]);
    expect(COURSE.lessons.map(l => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const l of COURSE.lessons) for (const p of [...(l.explain ?? []), ...Object.values(l.tips ?? {})]) for (const s of p.sources ?? []) expect(COURSE.sources[s], `${l.id}: ${s}`).toBeDefined();
  });
  for (const def of LESSONS) {
    it(`${def.n} ${def.title}: the planner still finds the stored route, and it passes`, () => {
      const L = loadLesson(V, def), sc = def.scene!;
      // the planner with the wheel at full lock or straight, from the same place: the route stored in course.json
      let planned: Piece[];
      if ('garage' in sc) planned = planToBay(V, GARAGE_561, GARAGE_561.starts[sc.start], sc.garage, { lvls: LOCK }).pieces;
      else {
        const d = draft(V, sc.template, sc.level, sc.seed), K = sc.kerbGap;
        if (K !== undefined) d.goals = d.goals.filter(g => Math.abs(g.z - (-K - V.W / 2)) < 1e-6);   // the kerb is at z = 0
        d.spec.starts = { start: { x: d.entry.x0, z: (d.entry.z0 + d.entry.z1) / 2, th: d.entry.th } };
        planned = solve(V, d, makeScene(d.spec), 60000, { lvls: LOCK }).route;
        const s = planned[0].from, t = L.route[0].from;
        expect(Math.hypot(s.x - t.x, s.z - t.z) + Math.abs(s.th - t.th)).toBeLessThan(1e-5);
      }
      expect(fmt(L.route)).toBe(fmt(planned));
      expect(exactCheck(V, L.scene, fieldFor(V, L.scene), L.route)).toBeNull();
      expect(newSim(L).touching()).toBeNull();
      const r = parkedAtEnd(L);
      expect(r).not.toBeNull();
      expect(checkPass(r!, def.pass ?? {}, L.par).pass, JSON.stringify(checkPass(r!, def.pass ?? {}, L.par).lines)).toBe(true);
    });
  }
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
  it('one per piece, ending where the piece ends, arcs on the angle', () => {
    for (const def of LESSONS) {
      const L = loadLesson(V, def), S = stepsOf(L);
      expect(S.length).toBe(L.route.length);
      S.forEach((s, i) => { expect(s.to).toEqual(L.route[i].to); expect(s.byHeading).toBe(L.route[i].lvl !== 0); });
    }
  });
});

interface Driver { guided?: boolean; early?: number; late?: number; wheelOff?: number; hands?: number }
/**
 * A driver who does what the coach shows and nothing else: turn the wheel to what the step wants (holding it
 * there, at `hands` degrees a second), then hold the step's pedal. Guided, the coach lets go of it on the mark;
 * with cue marks only, the driver lets go, `early` metres before the mark or `late` steps after the moment, and
 * keeps to a careful speed. Returns how the try ended.
 */
function drive(L: Lesson, o: Driver = {}): { r: ParkedResult | null; misses: number; touches: number; track: TrackPt[]; steps: Step[]; sim: Sim } {
  const guided = o.guided ?? true, sim = newSim(L), steps = stepsOf(L), run = new CoachRun(V, steps, () => sim.options.lockDeg, !guided), tr = new Tracker();
  const D = V.drive;
  let pedal = false, letGoIn = -1, misses = 0, touches = 0, r: ParkedResult | null = null, early = -1, still = 0;
  tr.add(sim);
  for (let t = 0; t < 60 * 180 && !r; t++) {
    const st = run.step;
    if (!guided) run.sync(sim);
    if (run.phase === 'missed') { misses++; break; }
    if (st) {   // the hand on the wheel turns it to where the step wants it, and holds it there
      const want = run.wheelWant() + (st.lvl === 0 ? (o.wheelOff ?? 0) : 0), d = want - sim.wheelAngle;
      sim.input.wheelHeld = true; sim.wheelAngle += Math.sign(d) * Math.min(Math.abs(d), (o.hands ?? 360) * STEP);
      if (run.phase === 'wheel') pedal = false;
    }
    if (st && run.phase === 'drive') {
      const stopped = Math.abs(sim.v) < 0.02, brake = sim.v * sim.v / (2 * D.BRAKE);
      if (!pedal && letGoIn < 0 && stopped) pedal = true;   // go (again, after "a little further")
      if (pedal && letGoIn < 0 && !stopped && early !== run.k && (o.early ?? 0) > 0 && run.left <= brake + o.early!) { pedal = false; early = run.k; }   // once per step
      if (!guided && pedal && letGoIn < 0 && !stopped && run.left <= brake + 0.05) letGoIn = o.late ?? 0;
      if (letGoIn >= 0 && letGoIn-- === 0) { pedal = false; letGoIn = -1; }
    }
    let fwd = pedal && st?.dir === 1, rev = pedal && st?.dir === -1;
    if (guided) ({ fwd, rev } = run.gate({ fwd, rev }, sim));
    else if (Math.abs(sim.v) > (run.left < MARK.zone ? MARK.crawl : MARK.walk)) fwd = rev = false;   // a careful driver's own speed
    sim.input.fwd = fwd; sim.input.rev = rev;
    for (const e of sim.step(STEP)) if (e.type === 'touch') touches++;
    const ev = run.observe(sim); tr.add(sim);
    // the try ends as the game ends it: guided, when the coach says the last step is done; otherwise once the
    // car has sat parked for a second
    still = sim.parked && Math.abs(sim.v) < 0.02 && !fwd && !rev ? still + 1 : 0;
    if (guided ? ev.some(e => e.type === 'done') : still >= 60) r = sim.parkedResult();
  }
  return { r, misses, touches, track: tr.pts, steps, sim };
}

describe('guided driving', () => {
  const DRIVERS: [string, Driver][] = [
    ['guided', {}],
    ['guided, with the wheel 4° off straight', { wheelOff: 4 }],
    ['guided, letting go 30 cm before each mark', { early: 0.3 }],
    ['guided, with slow hands on the wheel', { hands: 120 }],
    ['cue marks only, letting go on the mark', { guided: false }],
    ['cue marks only, a tenth of a second late', { guided: false, late: 6 }],
  ];
  for (const def of LESSONS) {
    it(`${def.n} ${def.title}: a driver who follows the coach passes`, () => {
      const L = loadLesson(V, def), out: string[] = [];
      for (const [name, o] of DRIVERS) {
        const { r, misses, touches } = drive(L, o);
        const res = r ? checkPass(r, def.pass ?? {}, L.par) : null;
        if (misses || touches || !res?.pass) out.push(`${name}: ${misses ? 'missed a mark' : touches ? `${touches} touches` : !r ? 'never parked' : res!.lines.filter(l => !l.ok).map(l => l.text).join('; ')}`);
      }
      expect(out).toEqual([]);
    });
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
