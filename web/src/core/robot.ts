// A driver who does what the coach shows and nothing else, for checking that a lesson can be driven as it is taught:
// the tests drive every lesson in every car with them, and a route for another car is only kept if they pass.
import { CoachRun, MARK, Tracker, type Step, type TrackPt } from './coach';
import type { RigPose } from './generator/towScenes';
import { localScene, sideDir, streetPt } from './city';
import { stepsFor } from './coach';
import { COUNTRIES, type CountryId } from './country';
import { DEG, wrapPi } from './math';
import { drive, planBack, planToBay } from './planner';
import { Rules, type Fault } from './rules';
import { StreetCoach, indFor, type StreetLesson, type WayPt } from './streetLesson';
import { TYPES, Traffic } from './traffic';
import type { Scene } from './scene';
import { TOW_CRAWL, TowCoach, TowPilot, type PilotOpts, type TowPath } from './towing';
import type { Trailer } from './trailer';
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

// ---- towing lessons ----

/** A driver in a towing lesson. guided: the hand follows the coach's target on the wheel (`hands` degrees a second,
 *  `late` steps behind it) and the coach gates the pedals; otherwise the driver steers by eye with a pilot of their own
 *  (`pilot`: how they judge the curve) and keeps to a crawl themselves. */
export interface TowDriver { guided?: boolean; hands?: number; late?: number; pilot?: PilotOpts }
export const TOW_DRIVERS: readonly (readonly [string, TowDriver])[] = [
  ['guided', {}],
  ['guided, with slow hands a little late', { hands: 180, late: 18 }],
  ['guided, a tenth of a second late', { hands: 300, late: 6 }],
  ['cue marks only, steering by eye', { guided: false, pilot: { look: 5.0, gain: 0.6, rate: 220 } }],
];

/** A try at a towing lesson from its start, the way the game ends it: the coach's done (guided), or parked and still for
 *  a second. lost: how often the trailer got away and had to be straightened. */
export function towDrive(v: Vehicle, t: Trailer, scene: Scene, bay: string, start: RigPose, path: TowPath, o: TowDriver = {}, each?: (sim: Sim) => void): { r: ParkedResult | null; touches: number; lost: number; sim: Sim; secs: number } {
  const guided = o.guided ?? true, sim = new Sim(scene, v);
  sim.setTrailer(t); sim.options.bay = bay; sim.resetAt(start.x, start.z, start.th, start.tth);
  const coach = new TowCoach(v, t, path, () => sim.options.lockDeg, !guided), own = guided ? null : new TowPilot(v, t, path, o.pilot);
  const hist: number[] = [];
  let touches = 0, lost = 0, still = 0, r: ParkedResult | null = null, n = 0;
  for (; n < 60 * 240 && !r; n++) {
    // the hand: towards the coach's target (guided) or the driver's own idea, pulling forward with the wheels straight
    if (own && coach.phase === 'reverse') own.steer(sim.x, sim.z, sim.th, sim.tth, sim.options.lockDeg, STEP);
    hist.push(coach.phase === 'forward' ? 0 : own ? own.needle : coach.wheelWant);
    const want = hist[Math.max(0, hist.length - 1 - (o.late ?? 0))], d = want - sim.wheelAngle;
    sim.input.wheelHeld = true; sim.wheelAngle += Math.sign(d) * Math.min(Math.abs(d), (o.hands ?? 360) * STEP);
    // the pedal: reverse along the path (at a crawl, letting go to stop at its end), or forward to straighten
    const brake = sim.v * sim.v / (2 * v.drive.BRAKE), ownLeft = own ? own.progress(sim.x, sim.z, sim.th, sim.tth).left : coach.left;
    let raw = { fwd: false, rev: false };
    if (coach.phase === 'reverse') raw.rev = guided || (ownLeft > brake + 0.03 && Math.abs(sim.v) < TOW_CRAWL);
    else if (coach.phase === 'forward') raw.fwd = Math.abs(sim.wheelAngle) < 20 && Math.abs(coach.phi) >= 3 * DEG;
    raw = coach.gate(raw, sim);
    sim.input.fwd = raw.fwd; sim.input.rev = raw.rev;
    for (const e of sim.step(STEP)) if (e.type === 'touch') touches++;
    each?.(sim);
    for (const e of coach.observe(sim, STEP)) if (e.type === 'lost') { lost++; own?.restart(sim.wheelAngle); } else if (e.type === 'lined') own?.restart(sim.wheelAngle);
    still = sim.parked && Math.abs(sim.v) < 0.02 && !raw.fwd && !raw.rev ? still + 1 : 0;
    if (guided ? coach.phase === 'done' : still >= 60) r = sim.parkedResult();
    if (touches > 3) break;
  }
  return { r, touches, lost, sim, secs: n / 60 };
}

// ---- street lessons ----

/** A driver in a street lesson: a careful one who keeps below the limit (kmh at most), stops for red and amber, waits at
 *  a give-way line for a clear road, keeps a gap to the car ahead, signals 40 m before each turn and before pulling in,
 *  waits behind a car pulling out of the space, then parks as the coach shows (guided). nosignal: never signals; late:
 *  waits this many seconds once stopped beside the space before reversing (a thief may take it). */
export interface StreetDriver { kmh?: number; nosignal?: boolean; late?: number }
export const STREET_DRIVERS: readonly (readonly [string, StreetDriver])[] = [
  ['careful, 25 km/h', { kmh: 25 }],
  ['careful, 35 km/h', { kmh: 35 }],
];
/** Drivers who should not pass: one who never signals, one who waits 12 s beside the space before reversing. */
export const STREET_FAILERS: readonly (readonly [string, StreetDriver])[] = [
  ['never signals', { kmh: 30, nosignal: true }],
  ['waits 12 s before reversing', { kmh: 30, late: 12 }],
];

/** Drive a street lesson as the driver would, in the lesson's own traffic, until parked (or 5 minutes): what happened. */
export function streetDrive(v: Vehicle, L: StreetLesson, o: StreetDriver = {}, country: CountryId = 'ma', each?: (sim: Sim) => void): { r: ParkedResult | null; faults: Fault[]; sim: Sim; secs: number; took: boolean; why: string } {
  const sim = new Sim(L.map.scene, v), st = L.map.start, kerb: 1 | -1 = L.map.drive === 'right' ? 1 : -1;
  sim.resetAt(st.x, st.z, st.th); sim.setMode('drive');
  sim.traffic = Traffic.spawn(L.net, L.seed, L.perKm, st, L.extras); sim.rules = new Rules(L.net, COUNTRIES[country]);
  const T = sim.traffic, coach = new StreetCoach(L, 3, kerb > 0 ? 'right' : 'left'), lock = () => sim.options.lockDeg;
  const end = () => coach.pts[coach.pts.length - 1].s, slot = L.slot;
  const [bx, bz] = streetPt(slot.street, sideDir(slot.street, slot.side) > 0 ? slot.a0 : slot.a1, 0), back = nearS(L.pts, bx, bz, -Infinity, Infinity)!.s;   // the space's back end, along the way
  let phase: 'drive' | 'park' = 'drive', run: CoachRun | null = null, still = 0, waitT = 0, r: ParkedResult | null = null, why = '';
  // a route into the space from exactly where the car is; failing that, the quicker outward search's (which starts within
  // 20 cm of the car), its moves driven from exactly where the car is
  let replans = 0;
  const parkRun = (): CoachRun | null => {
    const from = { x: sim.x, z: sim.z, th: sim.th }, sc = localScene(L.map, slot), exact = planToBay(v, sc, from, slot.id, { maxNodes: 20000 });
    const plan = exact.status === 'found' ? exact : planBack(v, sc, from, slot.id, { maxNodes: 6000 });
    if (plan.status !== 'found' || !plan.pieces.length) return null;
    let p = from;
    const pieces = plan.pieces.map(q => { const to = drive(v, p, q.lvl, q.dir * q.len), r = { ...q, from: p, to }; p = to; return r; });
    return new CoachRun(v, stepsFor(v, sc, slot.id, pieces), lock, false);
  };
  const hand = (want: number) => { const d = want - sim.wheelAngle; sim.input.wheelHeld = true; sim.wheelAngle += Math.sign(d) * Math.min(Math.abs(d), 360 * STEP); };
  const frontOf = () => [sim.x + (v.L - v.OVR) * Math.cos(sim.th), sim.z - (v.L - v.OVR) * Math.sin(sim.th)];
  const at = (s: number) => { const p = coach.pts, i = Math.max(0, Math.min(p.length - 1, p.findIndex(q => q.s >= s))); return p[i < 0 ? p.length - 1 : i]; };
  for (let t = 0; t < 60 * 300 && !r; t++) {
    if (phase === 'drive') {
      coach.observe(v, sim.x, sim.z, sim.th, sim.ind);
      const s = coach.s, [fx, fz] = frontOf();
      // steering: pure pursuit from the rear axle to a point on the way ahead of the front bumper
      const rs = nearS(coach.pts, sim.x, sim.z, s - v.L - 6, s + 2)?.s ?? s - (v.L - v.OVR);   // the rear axle's own place along the way
      const P = at(rs + 3 + 0.4 * sim.v), dx = P.x - sim.x, dz = P.z - sim.z, Ld = Math.max(1, Math.hypot(dx, dz));
      const alpha = wrapPi(Math.atan2(-dz, dx) - sim.th), k = 2 * Math.sin(alpha) / Ld;
      hand(Math.max(-lock(), Math.min(lock(), -Math.atan(k * v.WB) / DEG / v.MAXSTEER * lock())));
      // speed: the limit, slower into a turn, and stops: the line on red or amber (or at a give-way line until the road
      // is clear), the car ahead, a car pulling out of the space, and the end of the way beside the space
      let want = Math.min((o.kmh ?? 30) / 3.6, (sim.rules!.limitAt(fx, fz, sim.th)?.limit ?? 30) / 3.6 - 0.5);
      let stopAt = end() - 0.3;
      const n = coach.nav[coach.k];
      if (n && n.turn !== 'straight' && n.at - s < 30) want = Math.min(want, 14 / 3.6);
      if (n?.ap && s < n.line + 0.5) {
        const light = n.control === 'lights' ? T.lightFor(n.ap) : null, d = n.line - s, need = sim.v * sim.v / (2 * 2.5);
        if (light === 'red' || (light === 'amber' && d > need)) stopAt = Math.min(stopAt, n.line - 1);
        if (n.control === 'giveway') {
          const clear = mainClear(T, n.j);
          if (!clear || (sim.v > 0.3 && d > 2)) stopAt = Math.min(stopAt, clear ? stopAt : n.line - 1);
          if (!clear) waitT = 0; else if (sim.v < 0.1 && d < 3) waitT += STEP;
          if (d < 3 && d > -0.5 && waitT < 0.5) stopAt = Math.min(stopAt, n.line - 1);
        }
      }
      for (const c of T.cars) {   // the car ahead on the way, within 1.8 m of it
        if ((c.state === 'parked' || c.state === 'out') && T.places[c.place]?.slot === slot.id) { stopAt = Math.min(stopAt, Math.max(s, back - 2)); continue; }   // behind the space while its car leaves
        if (c.state === 'parked') continue;
        const cs = nearS(coach.pts, c.x, c.z, s, s + 40);
        if (cs === null || cs.d > 1.8) continue;
        stopAt = Math.min(stopAt, cs.s - TYPES[c.type].L / 2 - 4);
      }
      const left = stopAt - s;
      want = Math.min(want, left <= 0 ? 0 : Math.sqrt(2 * 1.6 * left));
      const e = want - sim.v;
      sim.input.acc = left <= 0.05 ? 0 : Math.max(0, Math.min(1, 1.5 * e)); sim.input.brk = left <= 0.05 ? 1 : Math.max(0, Math.min(1, -0.8 * e));
      // signals: 40 m before each turn, and towards the kerb for the last 60 m
      if (!o.nosignal) {
        const turn = n && n.turn !== 'straight' && n.at - s < 40 ? indFor(n.turn) : 0;
        if (turn && sim.ind !== turn) sim.ind = turn;
        else if (!n && end() - s < 60 && sim.ind !== kerb) sim.ind = kerb;
      }
      // beside the space and stopped: into Park mode, as the game does
      if (end() - s < 1.5 && sim.v < 0.05) {
        sim.setMode('park'); sim.options.bay = slot.id; sim.input.acc = sim.input.brk = 0;
        Object.assign(sim, { hits: 0, elapsed: 0, moves: 0, moveSign: 0, started: false, parked: false });
        run = parkRun(); phase = 'park'; waitT = 0;
        if (!run) { why = 'no way into the space'; break; }
      }
      sim.step(STEP);
    } else {
      const R = run!, stp = R.step;
      if (T.thiefIn(slot.id)) { why = 'a thief took the space'; break; }
      if (stp) hand(R.wheelWant());
      waitT += STEP;
      // a moment after stopping (or `late` s), and not while a car is passing close by: the front swings out into the lane
      const passing = T.cars.some(c => c.state === 'drive' && !c.aim && c.v > 0.5 && Math.hypot(c.x - sim.x, c.z - sim.z) < 15);
      const go = waitT >= (o.late ?? 0.5) && !passing;
      if (R.phase === 'missed') {   // stopped off the coach's route: a new route from here, as a driver would
        if (Math.abs(sim.v) > 0.02 || replans >= 3) { if (replans >= 3) { why = 'missed a mark three times'; break; } sim.input.fwd = sim.input.rev = false; sim.step(STEP); continue; }
        replans++; run = parkRun();
        if (!run) { why = 'no way into the space from where it stopped'; break; }
        continue;
      }
      const { fwd, rev } = R.gate({ fwd: go && stp?.dir === 1, rev: go && stp?.dir === -1 }, sim);
      sim.input.fwd = fwd; sim.input.rev = rev;
      sim.step(STEP);
      const ev = R.observe(sim);
      still = sim.parked && Math.abs(sim.v) < 0.02 ? still + 1 : 0;
      if (ev.some(x => x.type === 'done') || still >= 60) r = sim.parkedResult();
    }
    each?.(sim);
  }
  if (!r && !why) why = phase === 'drive' ? `never reached the space (stopped ${(end() - coach.s).toFixed(0)} m short)` : 'never parked';
  return { r, faults: sim.rules!.faults.slice(), sim, secs: T.t, took: !!T.thiefIn(slot.id), why };
}
/** The nearest point of the way to (x, z) between lo and hi along it, and how far it is. */
function nearS(pts: readonly WayPt[], x: number, z: number, lo: number, hi: number): { s: number; d: number } | null {
  let best: { s: number; d: number } | null = null;
  for (const p of pts) { if (p.s < lo || p.s > hi) continue; const d = Math.hypot(p.x - x, p.z - z); if (!best || d < best.d) best = { s: p.s, d }; }
  return best;
}
/** Whether the main road at junction j is clear: no car in it, and none on a lane into it with right of way that is
 *  less than 5 s (or 15 m) from it. */
function mainClear(T: Traffic, j: number): boolean {
  const J = T.net.junctions[j];
  for (const c of T.cars) {
    if (c.state !== 'drive') continue;
    const e = T.net.els[c.el];
    if (e.kind === 'path' && e.j === j) return false;
    if (e.kind !== 'lane' || e.j !== j) continue;
    const ap = J.approaches.find(a => a.el === e.id);
    if (ap?.minor) continue;
    const d = e.len - c.s;
    if (d < 15 || d / Math.max(c.v, 0.1) < 5) return false;
  }
  return true;
}
