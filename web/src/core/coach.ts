// The coach: a route turned into steps a driver can follow, each said with things you can see from the seat;
// a guide that follows the car through those steps (guided driving: stop at each mark, set the wheel, drive on);
// and the feedback after a try, which names the first place the drive left the route and why.
// Pure logic with no screen code, like the rest of core/.
import { footprint } from './car';
import { collides } from './collision';
import { DEG, wrapPi, type Pt } from './math';
import { bayBox, tyreGap } from './parking';
import { drive, sample, type Piece, type Pose } from './planner';
import type { Obstacle, Scene } from './scene';
import type { Sim } from './sim';
import type { Vehicle } from './vehicle';

/** Something a driver can line the car up with. */
export interface Landmark { name: string; x: number; z: number }

/** One step of a route: drive one way with the wheel held in one place, until a mark. */
export interface Step {
  n: number;                 // 1-based
  dir: 1 | -1; lvl: number; len: number;
  from: Pose; to: Pose;      // the marks it starts and ends at (rear-axle poses)
  turn: number;              // signed heading change over the step, rad (0 on a straight)
  byHeading: boolean;        // an arc ends when the car points the right way; a straight when it has gone far enough
  last: boolean;
  say: string;               // what to do: 'Reverse with full lock right, towards the kerb'
  until: string;             // when to stop: 'until the car is at about 55° to the kerb'
  see: string;               // what you see at the mark when that is a good second reference ('' if none)
  s0: number; s1: number;    // where the step starts and ends along the route, m
}

const fmt = (m: number): string => (m < 0.95 ? `${Math.max(5, Math.round(m * 20) * 5)} cm` : `${m.toFixed(1)} m`);
const withThe = (name: string): string => (/^(the |pillar \d|bay \d)/.test(name) ? name : 'the ' + name);
const unit = (th: number, d = 1): Pt => [d * Math.cos(th), -d * Math.sin(th)];
/** Curvature of the rear axle's path, 1/m, + turning left (heading grows) when driving forward. */
export const curvature = (v: Vehicle, lvl: number): number => Math.tan(-lvl * v.MAXSTEER * DEG) / v.WB;

/** The parts of the car a driver lines up with things outside, in the rear-axle frame (x forward, z right).
 *  Some only when a lesson asks for them by name (a handbook's own words): the front seat, the steering wheel. */
function parts(v: Vehicle, side: 1 | -1): { name: string; x: number; z: number; asked?: boolean }[] {
  const m = v.mirrors[1], mx = m ? (m[0][0] + m[1][0]) / 2 : 0.7 * v.WB, mz = m ? (m[0][1] + m[2][1]) / 2 : v.W / 2;
  return [
    { name: 'your front seat', x: 0.47 * v.WB, z: side * 0.37, asked: true },
    { name: 'your steering wheel', x: 0.6 * v.WB, z: 0, asked: true },
    { name: 'your front bumper', x: v.WB + v.OVF, z: 0 },
    { name: 'your front wheel', x: v.WB, z: side * v.TRACK / 2 },
    { name: 'your mirror', x: mx, z: side * mz },
    { name: 'your door pillar', x: 0.5 * v.WB, z: side * v.W / 2 },   // the centre pillar between the doors
    { name: 'your back seat', x: 0.45, z: side * v.W / 2 },
    { name: 'your rear wheel', x: 0, z: side * v.TRACK / 2 },
    { name: 'your rear bumper', x: -v.OVR, z: 0 },
  ];
}

/** The end of a parked car's outline nearest a point: the middle of its short side that faces it. */
function endNear(o: Obstacle, x: number, z: number): Pt | null {
  if (o.kind !== 'poly' || o.pts.length !== 4) return null;
  const P = o.pts, mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const short = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) < Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]) ? [mid(P[0], P[1]), mid(P[2], P[3])] : [mid(P[1], P[2]), mid(P[3], P[0])];
  return Math.hypot(short[0][0] - x, short[0][1] - z) < Math.hypot(short[1][0] - x, short[1][1] - z) ? short[0] : short[1];
}

/**
 * What there is to line up with: the target bay's side lines where they meet the aisle (near and far as you
 * arrive) and the lines of the bays either side; the ends of the cars either side of any space along a kerb (the end
 * facing that space); and whatever the scene names itself.
 */
export function landmarksOf(scene: Scene, bayId: string, approach: Pose): Landmark[] {
  const b = scene.bays[bayId], out: Landmark[] = [...scene.landmarks];
  for (const k of Object.values(scene.bays)) {
    if (k.kind !== 'kerb') continue;
    const cx = (k.x0 + k.x1) / 2, cz = (k.z0 + k.z1) / 2;
    for (const o of scene.obstacles) {
      const name = o.name === 'car in front of the space' ? 'the back of the car in front' : o.name === 'car behind the space' ? 'the front of the car behind' : '';
      const e = name ? endNear(o, cx, cz) : null;
      if (e) out.push({ name, x: e[0], z: e[1] });
    }
  }
  if ((b.kind ?? 'bay') !== 'bay') return out;
  // bays open towards +z: a side line meets the aisle at its end with the larger z (the mouth can slant: angled bays)
  const vertical = scene.lines.filter(([x0, , x1]) => Math.abs(x0 - x1) < 0.05).map(([x0, z0, x1, z1]): Pt => (z0 > z1 ? [x0, z0] : [x1, z1]));
  const mouthEnd = (x: number): Pt => vertical.find(m => Math.abs(m[0] - x) < 0.05 && Math.abs(m[1] - b.z1) < 2) ?? [x, b.z1];
  const [ux, uz] = unit(approach.th), ends = [mouthEnd(b.x0), mouthEnd(b.x1)];
  ends.sort((p, q) => (p[0] * ux + p[1] * uz) - (q[0] * ux + q[1] * uz));
  out.push({ name: 'the near line of the green bay', x: ends[0][0], z: ends[0][1] }, { name: 'the far line of the green bay', x: ends[1][0], z: ends[1][1] });
  // the next painted line out on each side, where it meets the line of the mouths
  const W = b.x1 - b.x0, along = (p: Pt) => p[0] * ux + p[1] * uz, n0 = along(ends[0]), n1 = along(ends[1]);
  const slope = (ends[1][1] - ends[0][1]) / ((ends[1][0] - ends[0][0]) || 1), onMouths = (m: Pt) => Math.abs(m[1] - (ends[0][1] + slope * (m[0] - ends[0][0]))) < 0.3;
  let before: Pt | null = null, after: Pt | null = null;
  for (const m of vertical) {
    if (!onMouths(m)) continue;
    const a = along(m);
    if (a < n0 - 0.3 && a > n0 - 1.6 * W && (!before || a > along(before))) before = m;
    if (a > n1 + 0.3 && a < n1 + 1.6 * W && (!after || a < along(after))) after = m;
  }
  if (before) out.push({ name: 'the line before the green bay', x: before[0], z: before[1] });
  if (after) out.push({ name: 'the line after the green bay', x: after[0], z: after[1] });
  return out;
}

/** Which part of the car and which landmark a step's cue should use (a handbook's own pair), when it matters. */
export interface CuePick { part?: string; mark?: string }

/** The best "part of your car level with a landmark" at a pose: the pair closest to level, within 4 m to the side,
 *  or the closest with the part and landmark asked for. "Short of" and "past" are said the way the car is moving
 *  (dir), so they read the same forwards and in reverse. */
export function alignment(v: Vehicle, marks: readonly Landmark[], p: Pose, dir: 1 | -1 = 1, pick: CuePick = {}): { text: string; ahead: number } | null {
  const [ux, uz] = unit(p.th), rx = -uz, rz = ux;   // forward and right, in the world
  let best: { text: string; ahead: number } | null = null;
  for (const L of marks) {
    if (pick.mark && L.name !== pick.mark) continue;
    const side = (L.x - p.x) * rx + (L.z - p.z) * rz >= 0 ? 1 : -1;
    for (const P of parts(v, side)) {
      if ((pick.part && P.name !== pick.part) || (P.asked && pick.part !== P.name)) continue;
      const [px, pz] = footprint(p.x, p.z, p.th, [[P.x, P.z]])[0];
      const ahead = dir * ((L.x - px) * ux + (L.z - pz) * uz), lateral = Math.abs((L.x - px) * rx + (L.z - pz) * rz);
      if (lateral > 4 || (best && Math.abs(ahead) >= Math.abs(best.ahead))) continue;
      const text = Math.abs(ahead) < 0.1 ? `${P.name} is level with ${L.name}` : ahead < 0 ? `${P.name} is ${fmt(-ahead)} past ${L.name}` : `${P.name} is ${fmt(ahead)} short of ${L.name}`;
      best = { text, ahead };
    }
  }
  return best;
}

/** The first thing straight ahead in the direction of travel, and how far (kerbs aside: the tyres stop there, not the body). */
export function nearestAhead(v: Vehicle, scene: Scene, p: Pose, dir: 1 | -1, max = 1.2): { name: string; d: number } | null {
  const obs = scene.obstacles.filter(o => o.cls !== 'kerb'), [ux, uz] = unit(p.th, dir);
  for (let g = 0.05; g <= max + 1e-9; g += 0.05) {
    const hit = collides(v, obs, p.x + g * ux, p.z + g * uz, p.th);
    if (hit) return { name: hit.obstacle.name, d: g };
  }
  return null;
}

const wheelWords = (lvl: number, kerbSide: number): string => {
  if (lvl === 0) return 'with the wheels straight';
  const lr = lvl > 0 ? 'right' : 'left', how = Math.abs(lvl) === 1 ? 'full lock' : 'half lock';
  return `with ${how} ${lr}` + (kerbSide ? (Math.sign(lvl) === kerbSide ? ', towards the kerb' : ', away from the kerb') : '');
};

/**
 * The route as steps, one per piece: what to do and when to stop, with the car's own numbers. Arcs end on an angle
 * (to the aisle or the kerb, or straight in the bay); straights on something you can line up with; the last step
 * on how far the car is from the back line, the kerb or whatever is ahead.
 */
export function stepsFor(v: Vehicle, scene: Scene, bayId: string, route: readonly Piece[], picks: Record<string, CuePick | undefined> = {}): Step[] {
  const b = scene.bays[bayId], kerb = b.kind === 'kerb', exit = b.kind === 'exit', start = route[0].from, lane = start.th;
  const marks = landmarksOf(scene, bayId, start);
  // which side the nearest kerb is on at the start (+1 right): steering towards it or away is how handbooks say it
  let kerbSide = 0, near = 6;
  for (const k of scene.kerbs) {
    const d = k.c - (k.nx * start.x + k.nz * start.z);
    if (d >= 0 && d < near) { near = d; kerbSide = k.nx * Math.sin(start.th) + k.nz * Math.cos(start.th) >= 0 ? 1 : -1; }
  }
  const across = kerbSide ? 'the kerb' : 'the aisle';
  const [bx0, bx1, bz0, bz1] = bayBox(b);
  let s = 0;
  return route.map((p, i): Step => {
    const last = i === route.length - 1, turn = p.dir * p.len * curvature(v, p.lvl), byHeading = Math.abs(turn) >= 10 * DEG;
    const say = `${p.dir > 0 ? 'Drive forward' : 'Reverse'} ${wheelWords(p.lvl, kerbSide)}`;   // said with `until` after it: see sentence()
    const e = p.to, a = alignment(v, marks, e, p.dir, picks[i + 1]) ?? alignment(v, marks, e, p.dir), lead = p.dir > 0 ? v.WB + v.OVF : -v.OVR;
    // pointing along the bay: "straight in the bay" once the car's middle is in it, before that "pointing into it"
    const lined = Math.min(Math.abs(wrapPi(e.th - b.inHeading)), Math.abs(wrapPi(e.th - b.inHeading - Math.PI))) < 3 * DEG;
    const mid = footprint(e.x, e.z, e.th, [[v.WB / 2, 0]])[0], inside = mid[0] > bx0 - 0.3 && mid[0] < bx1 + 0.3 && mid[1] > bz0 - 0.3 && mid[1] < bz1 + 0.3;
    const ang = Math.abs(wrapPi(e.th - lane)) / DEG, toLane = Math.round(Math.min(ang, 180 - ang) / 5) * 5;
    const angleWords = kerb || exit ? (toLane === 0 ? (exit ? 'until the car is straight in the lane' : 'until the car is straight') : `until the car is at about ${toLane}° to ${across}`)
      : lined ? (inside ? 'until the car is straight in the bay' : 'until the car points straight into the green bay') : `until the car is at about ${toLane}° to ${across}`;
    let until: string, see = '';
    if (last) {
      const ahead = nearestAhead(v, scene, e, p.dir, 0.5);
      if (exit) until = byHeading ? angleWords : 'until the car is well clear of the space, in the middle of the lane';
      else if (kerb) until = `${byHeading ? angleWords : 'until you have stopped'}, tyres about ${fmt(tyreGap(v, scene.kerbs, e.x, e.z, e.th))} from the kerb`;
      else {
        // the painted back line under the bumper (it slants in angled bays), else the bay's own
        let backZ = b.z0, best = 1.5;
        const end = footprint(e.x, e.z, e.th, [[lead, 0]])[0];
        for (const [x0, z0, x1, z1] of scene.lines) {
          if (Math.abs(x1 - x0) < 0.05 || end[0] < Math.min(x0, x1) || end[0] > Math.max(x0, x1)) continue;
          const z = z0 + (z1 - z0) * (end[0] - x0) / (x1 - x0);
          if (Math.abs(z - b.z0) < best) { best = Math.abs(z - b.z0); backZ = z; }
        }
        const gap = Math.abs(end[1] - backZ);
        const where = `your ${p.dir > 0 ? 'front' : 'rear'} bumper ${byHeading ? '' : 'is '}about ${ahead ? `${fmt(ahead.d)} from ${withThe(ahead.name)}` : `${fmt(gap)} from the back line`}`;
        until = byHeading ? `${angleWords}, ${where}` : `until ${where}`;
      }
    } else if (byHeading) {
      until = angleWords;
      // what you see at the mark: the lesson's own pair (a handbook's) even when it is not level, else a close one
      if (a && Math.abs(a.ahead) <= (picks[i + 1] ? 3 : 0.3)) see = a.text;
    } else {
      const next = route[i + 1], ahead = next.dir !== p.dir ? nearestAhead(v, scene, e, p.dir) : null;
      until = ahead ? `until you are about ${fmt(ahead.d)} from ${withThe(ahead.name)}` : a && Math.abs(a.ahead) < 1.5 ? `until ${a.text}` : `for about ${fmt(p.len)}`;
      if (ahead && a && Math.abs(a.ahead) < 1.5) see = a.text;
    }
    const step: Step = { n: i + 1, dir: p.dir, lvl: p.lvl, len: p.len, from: p.from, to: p.to, turn, byHeading, last, say, until, see, s0: s, s1: s + p.len };
    s += p.len;
    return step;
  });
}

/** A step as one sentence. */
export const sentence = (s: Step): string => `${s.say}${s.say.includes(',') ? ',' : ''} ${s.until}.`;

/** Sideways from the planned final pose, across the way the car ends up pointing (m). */
export function lateralOff(steps: readonly Step[], F: Pose): number { const T = steps[steps.length - 1].to; return (F.x - T.x) * Math.sin(T.th) + (F.z - T.z) * Math.cos(T.th); }
/** Where the car ends up if it switches to step k + 1 at Q and drives the rest as planned: arcs to their angle,
 *  straights their length (the last straight is left out: it only goes deeper). null if an arc cannot get there. */
export function finishFrom(v: Vehicle, steps: readonly Step[], k: number, Q: Pose): Pose | null {
  for (let j = k + 1; j < steps.length; j++) {
    const s = steps[j];
    if (s.byHeading) {
      const len = (s.to.th - Q.th) / (s.dir * curvature(v, s.lvl));   // headings never wrap here: a U-turn is 180°, not -180°
      if (len < -0.05) return null;
      Q = drive(v, Q, s.lvl, s.dir * Math.max(0, len));
    } else if (!s.last) Q = drive(v, Q, s.lvl, s.dir * s.len);
  }
  return Q;
}
/** How far the finish moves sideways per metre that step k ends late (0 when where it ends does not matter). */
export function endSensitivity(v: Vehicle, steps: readonly Step[], k: number): number {
  const s = steps[k]; if (s.last) return 0;
  const a = finishFrom(v, steps, k, drive(v, s.from, s.lvl, s.dir * (s.len - 0.2))), b = finishFrom(v, steps, k, drive(v, s.from, s.lvl, s.dir * (s.len + 0.2)));
  return a && b ? Math.abs(lateralOff(steps, b) - lateralOff(steps, a)) / 0.4 : 0;
}

// ---- guided driving ----

/** Steering-wheel degrees off the step's setting that still count as set: straight and full lock are exact with
 *  Straighten and the wheel's stop, so those are tight. */
const WHEEL_TOL = (lvl: number) => (lvl === 0 || Math.abs(lvl) === 1 ? 5 : 15);
/** The mark's window: stop within `short` before it or `past` after it; further past, or `off` to the side, is a miss.
 *  The car keeps to walking pace (m/s), and to a crawl in the last `zone` metres, so a stop lands on the mark. */
export const MARK = { short: 0.15, past: 0.25, off: 0.6, walk: 1.4, crawl: 0.6, zone: 1.0 };

export type CoachPhase = 'wheel' | 'drive' | 'missed' | 'done';
export interface CoachSnap { k: number; phase: CoachPhase; left: number; off: number; note: string; pastBy: number; missedBy: number; moved: boolean }
export type CoachEvent = { type: 'mark'; n: number; past: number } | { type: 'missed'; n: number; by: number; why: 'past' | 'off' } | { type: 'done' };

/**
 * Follows the car through the steps. Each step: set the wheel (the pedals wait), then drive to the mark and stop
 * there. The pedals only move the car the step's way, at walking pace; a miss holds the car until it is put back.
 * Call gate() just before each sim step and observe() just after it.
 *
 * Marks follow the car. Where a step ends decides where the car finishes (one degree late on the first arc of a
 * parallel park puts the tyres 11 cm further out), so a step whose end matters ends where the rest of the route,
 * driven as planned from the car's real position, lands on the planned line into the space: small errors made
 * earlier are taken out at the next mark, as an instructor would by watching the kerb.
 */
export class CoachRun {
  k = 0;
  phase: CoachPhase = 'wheel';
  left = 0;            // m to the mark along the route (negative: past it); on an arc, from the angle still to turn
  off = 0;             // m to the side of the step's path
  release = false;     // let go now and the car stops on the mark
  note = '';           // a short nudge for the card
  hint = '';           // this moment's nudge from the pedals: the wrong one, or the wheel not set yet
  pastBy = 0;          // how far past the last mark the car stopped (m)
  missedBy = 0;
  private moved = false;
  private readonly paths: Pt[][];
  private readonly adapt: boolean[];   // whether moving this step's end moves where the car finishes

  /** passive: with cue marks only nothing is held back; the coach just keeps up with the car, moving on at each
   *  mark the car stops on or drives past, and giving up only when it is well off the route. */
  constructor(readonly v: Vehicle, readonly steps: readonly Step[], private readonly lockDeg: () => number, readonly passive = false) {
    this.paths = steps.map(s => sample(v, [{ dir: s.dir, lvl: s.lvl, len: s.len, from: s.from, to: s.to }], 0.1).map((q): Pt => [q.x, q.z]));
    this.adapt = steps.map((_, k) => endSensitivity(v, steps, k) > 0.1);
  }
  /** The pose the current step should end at, from where the car is now. */
  markPose(sim: Sim): Pose | null {
    const st = this.step; if (!st) return null;
    return drive(this.v, { x: sim.x, z: sim.z, th: sim.th }, st.lvl, st.dir * this.left);
  }
  get step(): Step | undefined { return this.steps[this.k]; }
  /** Steering-wheel degrees this step wants. */
  wheelWant(): number { return (this.step?.lvl ?? 0) * this.lockDeg(); }
  wheelSet(sim: Sim): boolean { const st = this.step; return !!st && Math.abs(sim.wheelAngle - st.lvl * this.lockDeg()) <= WHEEL_TOL(st.lvl); }

  /** What the held pedals may do this step: only the step's way, not before the wheel is set or after a miss;
   *  let go for a moment whenever the car is above walking pace, or above a crawl near the mark (so the
   *  hold-to-speed-up ramp starts over and the car settles at that speed); and let go when the car would stop on
   *  the mark, so in guided driving the coach brakes there for you. */
  gate(raw: { fwd: boolean; rev: boolean }, sim: Sim): { fwd: boolean; rev: boolean } {
    const st = this.step;
    this.sync(sim);
    const onMark = !!st && this.phase === 'drive' && Math.sign(sim.v) === st.dir && this.left <= sim.v * sim.v / (2 * this.v.drive.BRAKE) + 0.005;
    const allow = this.phase === 'drive' && st && !onMark ? st.dir : 0, fast = Math.abs(sim.v) > (this.left < MARK.zone ? MARK.crawl : MARK.walk);
    this.hint = '';
    if (st && this.phase === 'drive' && !onMark && ((raw.fwd && allow < 0) || (raw.rev && allow > 0))) this.hint = allow > 0 ? 'This step drives forward' : 'This step is in reverse';
    if (st && this.phase === 'wheel' && (raw.fwd || raw.rev)) this.hint = st.lvl === 0 ? 'Tap Straighten first' : `Turn the wheel to ${Math.abs(st.lvl) === 1 ? 'full lock' : 'half lock'} ${st.lvl > 0 ? 'right' : 'left'}${this.moved ? ' again: hold it there' : ' first'}`;
    return { fwd: raw.fwd && allow > 0 && !fast, rev: raw.rev && allow < 0 && !fast };
  }

  /** Wheel set: on to driving; wheel off the lock while driving: set it again first. gate() does this; with cue marks
   *  only (nothing held back), call it on its own before each sim step. */
  sync(sim: Sim): void {
    const st = this.step;
    if (this.phase === 'wheel' && st && this.wheelSet(sim)) this.phase = 'drive';
    if (this.phase === 'drive' && st && Math.abs(sim.wheelAngle - this.wheelWant()) > 3 * WHEEL_TOL(st.lvl)) this.phase = 'wheel';   // the wheel was moved off: set it again first
  }

  /** After each sim step: how far to the mark, whether to let go now, and whether the car stopped on it or missed it. */
  observe(sim: Sim): CoachEvent[] {
    const ev: CoachEvent[] = [], st = this.step;
    this.release = false;
    if (!st || this.phase === 'done' || this.phase === 'missed') return ev;
    const moving = Math.abs(sim.v) > 0.02;
    this.left = this.leftOf(st, sim);
    this.off = Math.min(...this.paths[this.k].map(q => Math.hypot(q[0] - sim.x, q[1] - sim.z)));
    if (this.phase !== 'drive') return ev;
    if (moving) this.moved = true;
    if (!this.moved) return ev;   // nothing to miss before the car has moved (an accepted overshoot can start below zero)
    const past = this.passive ? 1.0 : MARK.past, wide = this.passive ? 1.0 : MARK.off;
    if (this.passive && this.left <= MARK.short && (!moving || this.left < -0.05) && !st.last) return this.next(st, ev);
    if (this.left < -past || this.off > wide) {
      this.phase = 'missed'; this.missedBy = Math.max(-this.left, 0);
      const why = this.off > MARK.off ? 'off' : 'past';
      this.note = why === 'off' ? `${fmt(this.off)} off the route` : `${fmt(this.missedBy)} past the mark`;
      ev.push({ type: 'missed', n: st.n, by: why === 'off' ? this.off : this.missedBy, why });
      return ev;
    }
    const D = this.v.drive;
    if (moving) {
      this.release = Math.sign(sim.v) === st.dir && this.left <= sim.v * sim.v / (2 * D.BRAKE) + 0.05;
      const want = this.wheelWant();
      if (st.lvl !== 0 && Math.abs(sim.wheelAngle - want) > 3 * WHEEL_TOL(st.lvl)) this.note = 'Keep the wheel at full lock: hold it there';
      else if (this.note.startsWith('Keep the wheel')) this.note = '';
      return ev;
    }
    if (this.left > MARK.short) { this.note = `A little further: ${fmt(this.left)}`; return ev; }
    if (st.last && !sim.parked) {
      this.phase = 'missed'; this.missedBy = 0; this.note = 'Stopped, but not in the space';
      ev.push({ type: 'missed', n: st.n, by: 0, why: 'off' });
      return ev;
    }
    return this.next(st, ev);
  }

  /** Stopped on the mark (or a little past it): on to the next step. */
  private next(st: Step, ev: CoachEvent[]): CoachEvent[] {
    this.pastBy = Math.max(0, -this.left); this.moved = false;
    this.note = this.pastBy > MARK.short ? `${fmt(this.pastBy)} past the mark` : '';
    ev.push({ type: 'mark', n: st.n, past: this.pastBy });
    this.k++;
    if (this.k >= this.steps.length) { this.phase = 'done'; ev.push({ type: 'done' }); }
    else this.phase = 'wheel';
    return ev;
  }

  /** Metres still to go to the end of a step: along the line on a straight, from the angle still to turn on an arc;
   *  for a step whose end matters, to the point where switching lands the rest of the route on the planned line. */
  private leftOf(st: Step, sim: Sim): number {
    const planned = st.byHeading ? (st.to.th - sim.th) * Math.sign(st.turn) / Math.abs(curvature(this.v, st.lvl))
      : (() => { const [ux, uz] = unit(st.from.th, st.dir); return (st.to.x - sim.x) * ux + (st.to.z - sim.z) * uz; })();
    if (!this.adapt[this.k]) return planned;
    const P: Pose = { x: sim.x, z: sim.z, th: sim.th };
    let best = planned, bestE = Infinity;
    for (let d = Math.max(-0.3, planned - 1); d <= planned + 1 + 1e-9; d += 0.02) {
      const F = finishFrom(this.v, this.steps, this.k, drive(this.v, P, st.lvl, st.dir * d));
      if (!F) continue;
      const e = Math.abs(lateralOff(this.steps, F));
      if (e < bestE) { bestE = e; best = d; }
    }
    return best;
  }

  /** Where the coach is, to put back after a rewind. */
  snapshot(): CoachSnap { return { k: this.k, phase: this.phase, left: this.left, off: this.off, note: this.note, pastBy: this.pastBy, missedBy: this.missedBy, moved: this.moved }; }
  restore(s: CoachSnap): void { Object.assign(this, { k: s.k, phase: s.phase, left: s.left, off: s.off, note: s.note, pastBy: s.pastBy, missedBy: s.missedBy, moved: s.moved }); this.hint = ''; this.release = false; }

  /** Pick up from wherever the car is (help asked for part way through a try): the step whose path is nearest. */
  jumpTo(sim: Sim): void {
    let best = 0, d = Infinity;
    this.paths.forEach((path, k) => { for (const q of path) { const e = Math.hypot(q[0] - sim.x, q[1] - sim.z); if (e < d) { d = e; best = k; } } });
    this.k = best; this.phase = 'wheel'; this.moved = false; this.note = '';
  }

  /** Back to the mark after a miss: where to put the car (the start of the step), with the wheel where the step before left it. */
  backToMark(): { pose: Pose; wheel: number } {
    const st = this.steps[this.k];
    this.phase = 'wheel'; this.note = ''; this.missedBy = 0; this.moved = false;
    return { pose: st.from, wheel: (this.steps[this.k - 1]?.lvl ?? 0) * this.lockDeg() };
  }
}

// ---- feedback after a try ----

/** The car as it was driven: a point every 5 cm, with its direction, steering (-1 … 1) and which move it was in. */
export interface TrackPt { x: number; z: number; th: number; dir: 1 | -1; lvl: number; run: number }
export class Tracker {
  pts: TrackPt[] = [];
  reset(): void { this.pts = []; }
  add(sim: Sim): void {
    const l = this.pts[this.pts.length - 1];
    if (l && (Math.abs(sim.v) < 0.02 || Math.hypot(sim.x - l.x, sim.z - l.z) < 0.05)) return;
    this.pts.push({ x: sim.x, z: sim.z, th: sim.th, dir: sim.v < 0 ? -1 : 1, lvl: sim.steerDeg / sim.vehicle.MAXSTEER, run: Math.max(1, sim.moves) });
  }
}

export interface Feedback { text: string; step: number; at: Pt | null; off: number }

interface PlanPt { x: number; z: number; fx: number; fz: number; s: number; run: number; i: number }
function planPts(v: Vehicle, route: readonly Piece[]): PlanPt[] {
  const out: PlanPt[] = [];
  let s = 0, run = 0;
  sample(v, route as Piece[], 0.05).forEach((q, k, a) => {
    if (k) { s += Math.hypot(q.x - a[k - 1].x, q.z - a[k - 1].z); if (q.dir !== a[k - 1].dir) run++; }
    out.push({ x: q.x, z: q.z, fx: q.x + v.WB * Math.cos(q.th), fz: q.z - v.WB * Math.sin(q.th), s, run, i: q.i });
  });
  return out;
}
function nearest(pts: readonly PlanPt[], x: number, z: number, front = false): { k: number; d: number } {
  let k = -1, d = Infinity;
  pts.forEach((p, j) => { const e = front ? Math.hypot(p.fx - x, p.fz - z) : Math.hypot(p.x - x, p.z - z); if (e < d) { d = e; k = j; } });
  return { k, d };
}

/**
 * Where a drive first left the route by more than `tol` (rear or front axle, compared within the same move),
 * and the likely reason, worded for the driver: a turn or a stop too early or too late, the wheel not at full lock,
 * or an extra move. The step it names is the one to focus on next time. A try can fail without drifting 30 cm
 * (parallel parking turns on centimetres): then look again more closely, with a smaller tol.
 */
export function feedback(v: Vehicle, route: readonly Piece[], steps: readonly Step[], track: readonly TrackPt[], tol = 0.3): Feedback {
  const P = planPts(v, route), runs: PlanPt[][] = [];
  for (const p of P) (runs[p.run] ??= []).push(p);
  const runDir = (r: number) => route[runs[r][0].i].dir;
  let at = -1, off = 0, extra = false;
  for (let t = 0; t < track.length; t++) {
    const q = track[t], r = q.run - 1;
    if (!runs[r] || (t > 0 && runDir(r) !== q.dir)) { at = t; extra = true; break; }
    const fx = q.x + v.WB * Math.cos(q.th), fz = q.z - v.WB * Math.sin(q.th);
    const d = Math.max(nearest(runs[r], q.x, q.z).d, nearest(runs[r], fx, fz, true).d);
    if (d > tol) { at = t; off = d; break; }
  }
  if (at < 0) return { text: `You stayed within ${Math.round(tol * 100)} cm of the route all the way.`, step: 0, at: null, off: 0 };
  const q = track[at], pt: Pt = [q.x, q.z];
  if (extra) {
    const prev = track[at - 1], i = prev && runs[prev.run - 1] ? runs[prev.run - 1][nearest(runs[prev.run - 1], prev.x, prev.z).k].i : 0;
    return { text: route[i + 1] && route[i + 1].dir === q.dir ? 'You changed direction before the route does here.' : 'You needed an extra move here.', step: i + 1, at: pt, off: 0 };
  }
  // the step the drift happened in, and what the wheel was doing there against what that step wants
  const run = runs[q.run - 1], j = nearest(run, q.x, q.z).k, i = run[j].i, st = steps[i], sAt = run[j].s;
  const sOf = (t: TrackPt) => run[nearest(run, t.x, t.z).k].s;
  const recent = track.slice(Math.max(0, at - 8), at + 1).filter(t => t.run === q.run).map(t => t.lvl).sort((a, b) => a - b);
  const held = recent[recent.length >> 1] ?? q.lvl, fits = (l: number) => Math.abs(held - l) <= 0.25;
  const same = (k: number) => !!route[k] && route[k].dir === route[i].dir;
  const lockName = (l: number) => `${Math.abs(l) === 1 ? 'full lock' : 'half lock'} ${l > 0 ? 'right' : 'left'}`;
  const cueOf = (k: number) => (k > 0 && steps[k - 1].until.startsWith('until ') ? `: the mark is when ${steps[k - 1].until.slice(6)}` : '');
  /** The first point of this move, between k0 and k1, where the wheel was at least half way from one setting to the next. */
  const crossing = (from: number, to: number, k0: number, k1: number) => {
    for (let k = Math.max(0, k0); k <= Math.min(track.length - 1, k1); k++) if (track[k].run === q.run && Math.abs(track[k].lvl - from) >= Math.abs(to - from) / 2 - 1e-9) return k;
    return -1;
  };
  // how big a timing error has to be to name: 25 cm, or less when looking closely (parallel parking turns on centimetres)
  const minErr = Math.min(0.25, tol * 0.8);
  /** "You turned to full lock 60 cm too early": an arc's end said in degrees from the car's heading (that is how
   *  its mark is said), a straight's in cm along the route. */
  const turned = (k: number, e: number, at?: TrackPt) => {
    const from = route[k - 1]?.lvl ?? 0, to = route[k].lvl, prev = steps[k - 1];
    const what = to === 0 ? 'straightened the wheel' : from !== 0 && Math.sign(from) !== Math.sign(to) ? 'steered the other way' : 'turned to full lock';
    const deg = prev?.byHeading && at ? (at.th - prev.to.th) * Math.sign(prev.turn) / DEG : null;
    if (deg !== null) e = deg;
    const by = deg !== null ? `${Math.max(1, Math.round(Math.abs(deg)))}°` : fmt(Math.abs(e));
    return `You ${what} ${by} too ${e < 0 ? 'early' : 'late'}${cueOf(k)}.`;
  };
  const startOfMove = track.findIndex(t => t.run === q.run);
  // on past the end of the move, where the route stops to change direction (or finishes): how far, to where the car stopped
  if (j >= run.length - 2) {
    const E = run[run.length - 1];
    let over = 0;
    for (let k = at; k < track.length && track[k].run === q.run; k++) over = Math.max(over, Math.hypot(track[k].x - E.x, track[k].z - E.z));
    const nx = route[i + 1];
    if (!nx) return { text: `You went ${fmt(over)} past where the car should stop.`, step: i + 1, at: pt, off };
    if (nx.dir !== route[i].dir) return { text: `You went ${fmt(over)} too far before ${nx.dir < 0 ? 'reversing' : 'driving forward again'}${cueOf(i + 1)}.`, step: i + 1, at: pt, off };
  }
  if (!fits(route[i].lvl)) {
    const prevFits = same(i - 1) && fits(route[i - 1].lvl), nextFits = same(i + 1) && fits(route[i + 1].lvl);
    if (nextFits && (!prevFits || sAt - st.s0 > st.s1 - sAt)) {
      // already on the next step's steering: turned before its mark
      const c = crossing(route[i].lvl, route[i + 1].lvl, startOfMove, at);
      if (c >= 0) return { text: turned(i + 1, sOf(track[c]) - steps[i + 1].s0, track[c]), step: i + 2, at: pt, off };
    } else if (prevFits) {
      // still on the last step's steering: turned after this step's mark (or not at all)
      const c = crossing(route[i - 1].lvl, route[i].lvl, at, track.length - 1);
      if (c < 0) return { text: route[i].lvl === 0 ? "You didn't straighten the wheel here." : `You didn't turn to ${lockName(route[i].lvl)} here.`, step: i + 1, at: pt, off };
      return { text: turned(i, Math.max(minErr, sOf(track[c]) - st.s0), track[c]), step: i + 1, at: pt, off };
    } else {
      // neither: the wheel was somewhere else, often a lock that came off as the car rolled
      const seg = track.slice(Math.max(startOfMove, 0), at + 1).filter(t => t.run === q.run && sOf(t) >= st.s0 - 0.05);
      const top = Math.max(0, ...seg.map(t => Math.abs(t.lvl))), want = Math.abs(route[i].lvl);
      if (want && top >= want - 0.05) return { text: 'The wheel came off full lock as you drove: keep your finger on it.', step: i + 1, at: pt, off };
      if (want) return { text: `The wheel was only at about ${Math.abs(Math.abs(held) - 0.5) < 0.13 ? 'half' : `${Math.round(Math.abs(held) * 100)}%`} lock: this part needs ${want === 1 ? 'full lock' : 'half lock'}.`, step: i + 1, at: pt, off };
      return { text: 'The wheels were not straight here: tap Straighten.', step: i + 1, at: pt, off };
    }
  }
  // the wheel is where this step wants it: what went wrong is where the step began
  const prev = route[i - 1];
  if (prev && prev.dir !== route[i].dir) {
    let stopT: TrackPt | undefined;
    for (let k = at - 1; k >= 0 && !stopT; k--) if (track[k].run === q.run - 1) stopT = track[k];
    const pr = runs[q.run - 2];
    if (stopT && pr) {
      const e = pr[nearest(pr, stopT.x, stopT.z).k].s - st.s0;
      if (Math.abs(e) >= minErr) return { text: `You ${e < 0 ? 'stopped' : 'went'} ${fmt(Math.abs(e))} ${e < 0 ? 'too soon' : 'too far'} before ${route[i].dir < 0 ? 'reversing' : 'driving forward again'}${cueOf(i)}.`, step: i + 1, at: pt, off };
    }
  } else if (prev && prev.lvl !== route[i].lvl) {
    const c = crossing(prev.lvl, route[i].lvl, startOfMove, at);
    if (c >= 0) { const e = sOf(track[c]) - st.s0; if (Math.abs(e) >= minErr) return { text: turned(i, e, track[c]), step: i + 1, at: pt, off }; }
  }
  return { text: `You drifted ${fmt(off)} off the route in step ${i + 1}.`, step: i + 1, at: pt, off };
}

/**
 * For a try that stayed near the route but did not finish well: of the moments the driver stopped to change
 * direction or switched the steering, the one whose timing moved the finish most (how far off it was, times how far
 * the finish moves per metre there). null when the moves do not line up with the route's, or nothing stands out.
 */
export function timingCause(v: Vehicle, route: readonly Piece[], steps: readonly Step[], track: readonly TrackPt[]): Feedback | null {
  const P = planPts(v, route), runs: PlanPt[][] = [];
  for (const p of P) (runs[p.run] ??= []).push(p);
  const runOf = (k: number) => P.find(p => p.i === k)?.run ?? 0;
  let best: { k: number; e: number; impact: number; stop: boolean } | null = null;
  for (let k = 0; k < steps.length - 1; k++) {
    const a = steps[k], b = steps[k + 1], r = runOf(k), run = runs[r], mine = track.filter(t => t.run === r + 1);
    if (!run || !mine.length) continue;
    const sOf = (t: TrackPt) => run[nearest(run, t.x, t.z).k].s;
    let at: TrackPt | undefined;
    if (a.dir !== b.dir) at = mine[mine.length - 1];
    else if (a.lvl !== b.lvl) at = mine.find(t => Math.abs(t.lvl - a.lvl) >= Math.abs(b.lvl - a.lvl) / 2 - 1e-9 && sOf(t) >= a.s0 - 1);
    if (!at) continue;
    // how far past the mark (m along the route; on an arc, from how far round the car had turned)
    const e = a.byHeading ? (at.th - a.to.th) * Math.sign(a.turn) / Math.abs(curvature(v, a.lvl)) : sOf(at) - a.s1;
    const impact = Math.abs(e) * endSensitivity(v, steps, k);
    if (!best || impact > best.impact) best = { k, e, impact, stop: a.dir !== b.dir };
  }
  if (!best || best.impact < 0.05) return null;
  const { k, e } = best, a = steps[k], b = steps[k + 1], cue = a.until.startsWith('until ') ? `: the mark is when ${a.until.slice(6)}` : '';
  const by = a.byHeading ? `${Math.max(1, Math.round(Math.abs(e) * Math.abs(curvature(v, a.lvl)) / DEG))}°` : fmt(Math.abs(e));
  const what = best.stop ? (e < 0 ? 'stopped' : 'went on') : b.lvl === 0 ? 'straightened the wheel' : a.lvl !== 0 && Math.sign(a.lvl) !== Math.sign(b.lvl) ? 'steered the other way' : 'turned to full lock';
  const text = best.stop ? `You ${what} ${by} ${e < 0 ? 'too soon' : 'too far'} before ${b.dir < 0 ? 'reversing' : 'driving forward again'}${cue}.` : `You ${what} ${by} too ${e < 0 ? 'early' : 'late'}${cue}.`;
  const q = a.to;
  return { text, step: k + 2, at: [q.x, q.z], off: best.impact };
}
