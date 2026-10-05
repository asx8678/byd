// A driver who does what the coach shows and nothing else, for checking that a lesson can be driven as it is taught:
// the tests drive every lesson in every car with them, and a route for another car is only kept if they pass.
import { CoachRun, MARK, Tracker, type Step, type TrackPt } from './coach';
import { checkPass, type Lesson } from './lesson';
import { STEP } from './replay';
import { Sim, type ParkedResult } from './sim';
import type { Vehicle } from './vehicle';

/** guided: the coach gates the pedals and brakes on each mark; otherwise the driver lets go on each cue mark themselves,
 *  `early` metres before it or `late` steps after the moment, or `overshoot.m` metres past the mark of step
 *  `overshoot.step` (0-based). wheelOff: degrees off straight on straight steps; hands: how fast the wheel is turned,
 *  degrees a second. */
export interface Driver { guided?: boolean; early?: number; late?: number; wheelOff?: number; hands?: number; overshoot?: { step: number; m: number } }
export const DRIVERS: readonly (readonly [string, Driver])[] = [
  ['guided', {}],
  ['guided, with the wheel 4° off straight', { wheelOff: 4 }],
  ['guided, letting go 30 cm before each mark', { early: 0.3 }],
  ['guided, with slow hands on the wheel', { hands: 120 }],
  ['cue marks only, letting go on the mark', { guided: false }],
  ['cue marks only, a tenth of a second late', { guided: false, late: 6 }],
];

/** A new try at the lesson's start. */
export function lessonSim(v: Vehicle, L: Lesson): Sim {
  const sim = new Sim(L.scene, v), s = L.route[0].from;
  sim.options.bay = L.bay; sim.resetAt(s.x, s.z, s.th);
  return sim;
}

/**
 * Turn the wheel to what the step wants (holding it there, at `hands` degrees a second), then hold the step's pedal.
 * Guided, the coach lets go of it on the mark; with cue marks only, the driver lets go and keeps to a careful speed.
 * Returns how the try ended, the way the game ends it.
 */
export function coachedDrive(v: Vehicle, L: Lesson, steps: Step[], o: Driver = {}): { r: ParkedResult | null; misses: number; touches: number; track: TrackPt[]; sim: Sim } {
  const guided = o.guided ?? true, sim = lessonSim(v, L), run = new CoachRun(v, steps, () => sim.options.lockDeg, !guided), tr = new Tracker();
  const D = v.drive;
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
      const past = o.overshoot && o.overshoot.step === run.k ? o.overshoot.m : 0;
      if (!guided && pedal && letGoIn < 0 && !stopped && run.left <= brake + 0.05 - past) letGoIn = o.late ?? 0;
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
  return { r, misses, touches, track: tr.pts, sim };
}

/** Cue-mark drivers who go `m` metres past one mark, each step's in turn: a late stop, as a learner makes. */
export const overshooters = (steps: number, m: number): [string, Driver][] =>
  Array.from({ length: steps - 1 }, (_, k): [string, Driver] => [`cue marks only, ${Math.round(m * 100)} cm past mark ${k + 1}`, { guided: false, overshoot: { step: k, m } }]);

/** The drivers who touched something (their names; empty when none did). */
export const touching = (v: Vehicle, L: Lesson, steps: Step[], drivers: readonly (readonly [string, Driver])[]): string[] =>
  drivers.filter(([, o]) => coachedDrive(v, L, steps, o).touches > 0).map(([name]) => name);

/** What went wrong for each driver who did not pass (empty when all of them did). */
export function failures(v: Vehicle, L: Lesson, steps: Step[], drivers: readonly (readonly [string, Driver])[] = DRIVERS): string[] {
  const out: string[] = [];
  for (const [name, o] of drivers) {
    const { r, misses, touches } = coachedDrive(v, L, steps, o), res = r ? checkPass(r, L.def.pass ?? {}, L.par) : null;
    if (misses || touches || !res?.pass) out.push(`${name}: ${misses ? 'missed a mark' : touches ? `${touches} touches` : !r ? 'never parked' : res!.lines.filter(l => !l.ok).map(l => l.text).join('; ')}`);
  }
  return out;
}
