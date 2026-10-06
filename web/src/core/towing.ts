// Reversing a trailer along a path. A trailer pushed backwards does not stay where it is put: any angle grows (see
// trailer.ts), so nobody reverses one with the wheel held still. The pilot here steers the way a trailer-reversing
// assist does: it picks the curve the trailer should follow to reach the path a few metres back (pure pursuit, on the
// trailer's axle), the hitch angle that holds the trailer on that curve, and the car's curvature that brings the hitch
// angle there. The coach shows its wheel as a target for your hand; Show me and the tests drive with it.
// Pure logic with no screen code, like the rest of core/.
import type { PassRule } from './lesson';
import { DEG, clamp, wrapPi } from './math';
import type { ParkedResult } from './sim';
import { angleForTrailerCurve, ballAt, ballBehind, hitchAngle, jackknifeAngle, settledAngle, type Trailer } from './trailer';
import type { Vehicle } from './vehicle';

/** A point on a trailer's path: where its axle should be, the heading it should have there (towards the ball, the
 *  opposite of the way it is going), and how far along the path it is (m). */
export interface PathPt { x: number; z: number; th: number; s: number }
/** A straight piece, or an arc of radius r turning `turn` radians: + turns the trailer's back to its left as it goes
 *  (to the driver's right). */
export type PathSeg = { line: number } | { r: number; turn: number };

const STEP_S = 0.05;

export class TowPath {
  readonly len: number;
  constructor(readonly pts: readonly PathPt[]) { this.len = pts[pts.length - 1].s; }

  /** The path from the trailer's axle at `from` (its heading th points to the ball), reversed along the pieces. */
  static build(from: { x: number; z: number; th: number }, segs: readonly PathSeg[]): TowPath {
    let x = from.x, z = from.z, g = from.th + Math.PI, s = 0;   // g: the way the axle travels
    const pts: PathPt[] = [{ x, z, th: from.th, s: 0 }];
    for (const sg of segs) {
      const L = 'line' in sg ? sg.line : sg.r * Math.abs(sg.turn), n = Math.max(1, Math.round(L / STEP_S)), ds = L / n;
      for (let i = 1; i <= n; i++) {
        if ('line' in sg) { x += ds * Math.cos(g); z -= ds * Math.sin(g); }
        else {
          const k = Math.sign(sg.turn) / sg.r, g1 = g + k * ds;
          x += (Math.sin(g1) - Math.sin(g)) / k; z += (Math.cos(g1) - Math.cos(g)) / k; g = g1;
        }
        s += ds; pts.push({ x, z, th: g - Math.PI, s });
      }
    }
    return new TowPath(pts);
  }

  /** The point s metres along (past the end: on along the last heading). */
  at(s: number): PathPt {
    const P = this.pts;
    if (s >= this.len) { const e = P[P.length - 1], d = s - this.len; return { x: e.x - d * Math.cos(e.th), z: e.z + d * Math.sin(e.th), th: e.th, s }; }
    const i = clamp(Math.floor(s / STEP_S), 0, P.length - 2), a = P[i], b = P[i + 1], f = clamp((s - a.s) / ((b.s - a.s) || 1), 0, 1);
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, th: a.th + wrapPi(b.th - a.th) * f, s };
  }

  /** The nearest point to (x, z), looking from index `from` on (the trailer only goes one way along it). */
  nearest(x: number, z: number, from = 0): { i: number; d: number } {
    let best = from, d = Infinity;
    for (let i = from; i < this.pts.length; i++) {
      const e = Math.hypot(this.pts[i].x - x, this.pts[i].z - z);
      if (e < d) { d = e; best = i; }
      else if (e > d + 3) break;   // well past the nearest point: the path does not come back this way
    }
    return { i: best, d };
  }
}

/** Where the trailer's axle is with the car at (x, z, th) and the trailer at tth. */
export function axleAt(v: Vehicle, t: Trailer, x: number, z: number, th: number, tth: number): [number, number] {
  const [bx, bz] = ballAt(v, x, z, th);
  return [bx - t.L1 * Math.cos(tth), bz + t.L1 * Math.sin(tth)];
}

export interface PilotOpts {
  /** How far back along the path it aims (m; nearer the end, down to lookEnd, so the trailer settles on the last
   *  straight), how fast it brings the hitch angle to where it wants it (per metre), and how fast its hand turns the
   *  wheel (degrees a second). */
  look: number; lookEnd?: number; gain: number; rate: number;
}
export const PILOT: PilotOpts = { look: 4.5, lookEnd: 2.5, gain: 0.5, rate: 200 };

/**
 * Keeps a trailer on a path while the car reverses: the curve the trailer should follow to reach the path `look` metres
 * back (pure pursuit, steering the trailer's axle like a car's), the hitch angle that holds the trailer on that curve
 * (never more than the hitch angle the car settles at on three quarters of its lock, and well short of a jackknife), and
 * the car's curvature that brings the hitch angle there as the car backs up.
 */
export class TowPilot {
  /** The furthest it lets the hitch angle go (rad). */
  readonly maxPhi: number;
  /** How far along the path it has got (an index into its points): it only looks on from there. */
  index = 0;
  constructor(readonly v: Vehicle, readonly t: Trailer, readonly path: TowPath, readonly o: PilotOpts = PILOT) {
    const k75 = Math.tan(0.75 * v.MAXSTEER * DEG) / v.WB;
    this.maxPhi = Math.min(settledAngle(v, t, k75) ?? Math.PI / 4, jackknifeAngle(v, t) - 25 * DEG);
  }

  /** Where the trailer is along the path: the nearest point (moving on from the last one), how far it still has to go,
   *  and how far it is off the path. */
  progress(x: number, z: number, th: number, tth: number): { s: number; left: number; off: number } {
    const [ax, az] = axleAt(this.v, this.t, x, z, th, tth), n = this.path.nearest(ax, az, Math.max(0, this.index - 20));
    this.index = n.i;
    const p = this.path.pts[n.i];
    // along the way the axle travels, past or short of the nearest point
    const g = p.th + Math.PI, along = (ax - p.x) * Math.cos(g) - (az - p.z) * Math.sin(g), s = p.s + along;
    return { s, left: this.path.len - s, off: n.d };
  }

  /** The car's curvature (1/m, + left) that keeps the trailer on the path as the car reverses. */
  curvature(x: number, z: number, th: number, tth: number): number {
    const v = this.v, t = this.t, { s } = this.progress(x, z, th, tth), [ax, az] = axleAt(v, t, x, z, th, tth);
    const look = clamp(0.7 * (this.path.len - s), this.o.lookEnd ?? this.o.look, this.o.look);
    const P = this.path.at(Math.max(0, s) + look), g = tth + Math.PI;
    const alpha = wrapPi(Math.atan2(-(P.z - az), P.x - ax) - g), Ld = Math.max(0.5, Math.hypot(P.x - ax, P.z - az));
    const kt = -2 * Math.sin(alpha) / Ld;   // the trailer's own curvature, as it would be pulled forward
    const want = clamp(angleForTrailerCurve(v, t, kt), -this.maxPhi, this.maxPhi), phi = hitchAngle(th, tth), M = ballBehind(v);
    const k = (Math.sin(phi) / t.L1 + this.o.gain * (phi - want)) / (1 + (M / t.L1) * Math.cos(phi));
    const kMax = Math.tan(v.MAXSTEER * DEG) / v.WB;
    return clamp(k, -kMax, kMax);
  }

  /** The same as a steering-wheel angle (degrees, + clockwise) for a wheel with lockDeg degrees to full lock. */
  wheel(x: number, z: number, th: number, tth: number, lockDeg: number): number {
    const k = this.curvature(x, z, th, tth), steerDeg = -Math.atan(k * this.v.WB) / DEG;
    return clamp(steerDeg / this.v.MAXSTEER * lockDeg, -lockDeg, lockDeg);
  }

  /** Where its hand has the wheel now (degrees): it turns towards wheel() no faster than `rate`, as a hand does, so a
   *  driver can keep up with it. Start it from the wheel as it is (hold()) whenever a reverse begins. */
  needle = 0;
  hold(wheel: number): void { this.needle = wheel; }
  /** Start again from wherever the trailer is now (after pulling forward): look for it along the whole path. */
  restart(wheel: number): void { this.index = 0; this.needle = wheel; }
  steer(x: number, z: number, th: number, tth: number, lockDeg: number, dt: number): number {
    const d = this.wheel(x, z, th, tth, lockDeg) - this.needle, r = this.o.rate * dt;
    this.needle += Math.abs(d) <= r ? d : Math.sign(d) * r;
    return this.needle;
  }
}

// ---- the coach for a towing lesson ----

/** Reversing: let go above this speed (m/s), as the coach keeps a trailer to a crawl. */
export const TOW_CRAWL = 0.55;
/** Past this far off the path (m), or this much beyond the pilot's own limit on the hitch angle, the coach stops you
 *  and has you pull forward to straighten the trailer before trying again. */
const LOST = { off: 0.9, phi: 8 * DEG };
/** Pulling forward to straighten: done once the trailer is this nearly in line (rad) and the car has gone this far (m). */
const LINED = { phi: 3 * DEG, gone: 1.5 };

export type TowPhase = 'reverse' | 'forward' | 'done';
export type TowEvent = { type: 'lost' } | { type: 'lined' } | { type: 'done' };
export interface TowSnap { phase: TowPhase; i: number; needle: number; fwdFrom: [number, number] | null }

/**
 * Follows the rig through a towing lesson. Reversing, the pilot's wheel is the target for your hand (guided: the
 * pedals only reverse, at a crawl, and let go where the trailer reaches the end of its path); if the trailer gets away
 * (too far off its path, or folding beyond what the pilot would ever let it), you stop and pull forward with the wheels
 * straight until it is back in line, then reverse again. passive: only watching (the cue-mark level), nothing held back.
 * Call gate() just before each sim step and observe() just after it.
 */
export class TowCoach {
  phase: TowPhase = 'reverse';
  left = 0; off = 0; phi = 0;   // m still to go along the path, m off it, the hitch angle (rad)
  hint = ''; note = '';
  readonly pilot: TowPilot;
  private fwdFrom: [number, number] | null = null;
  constructor(readonly v: Vehicle, readonly t: Trailer, readonly path: TowPath, private readonly lockDeg: () => number, readonly passive = false, o: PilotOpts = PILOT) {
    this.pilot = new TowPilot(v, t, path, o);
  }
  /** Where the coach wants the wheel (degrees): the pilot's hand reversing, straight pulling forward. */
  get wheelWant(): number { return this.phase === 'forward' ? 0 : this.pilot.needle; }
  /** The step on the card. */
  get say(): string { return this.phase === 'forward' ? 'Pull forward with the wheels straight' : 'Reverse slowly, your hand at the bottom of the wheel'; }
  get until(): string { return this.phase === 'forward' ? 'until the trailer is back in line behind the car' : 'until the trailer is in the green space, straight'; }

  /** What the held pedals may do: the phase's way only, at a crawl, letting go where the trailer would stop at the end
   *  of its path (guided; with passive, everything passes). */
  gate(raw: { fwd: boolean; rev: boolean }, sim: { v: number }): { fwd: boolean; rev: boolean } {
    this.hint = '';
    if (this.passive || this.phase === 'done') return raw;
    if (this.phase === 'forward') {   // straight ahead, the wheel near straight, no faster than walking pace
      if (raw.rev) this.hint = 'Pull forward first, wheels straight';
      else if (raw.fwd && Math.abs(this.wheelNow) >= 60) this.hint = 'Straighten the wheel first';
      return { fwd: raw.fwd && Math.abs(this.wheelNow) < 60 && Math.abs(sim.v) < 1.2, rev: false };
    }
    if (raw.fwd) this.hint = 'This step is in reverse';
    const stop = this.left <= sim.v * sim.v / (2 * this.v.drive.BRAKE) + 0.01;
    return { fwd: false, rev: raw.rev && !stop && Math.abs(sim.v) < TOW_CRAWL };
  }
  /** The wheel as observe() last saw it (degrees). */
  private wheelNow = 0;

  /** After each sim step: the pilot's hand moves on, how far is left, and whether the trailer got away, is back in line
   *  or is in the space. */
  observe(sim: { x: number; z: number; th: number; tth: number; v: number; wheelAngle: number; parked: boolean }, dt: number): TowEvent[] {
    const ev: TowEvent[] = [];
    this.wheelNow = sim.wheelAngle;
    if (this.phase === 'done') return ev;
    const p = this.pilot.progress(sim.x, sim.z, sim.th, sim.tth);
    this.left = Math.max(0, p.left); this.off = p.off; this.phi = hitchAngle(sim.th, sim.tth);
    if (this.phase === 'reverse') {
      this.pilot.steer(sim.x, sim.z, sim.th, sim.tth, this.lockDeg(), dt);
      if (sim.parked && Math.abs(sim.v) < 0.02) { this.phase = 'done'; ev.push({ type: 'done' }); return ev; }
      if (p.off > LOST.off || Math.abs(this.phi) > this.pilot.maxPhi + LOST.phi) {
        this.phase = 'forward'; this.fwdFrom = [sim.x, sim.z];
        this.note = p.off > LOST.off ? 'The trailer is off its line: pull forward to straighten it, then try again' : 'The trailer is folding: stop and pull forward to straighten it';
        ev.push({ type: 'lost' });
      }
      return ev;
    }
    // pulling forward: back to reversing once the trailer is in line again
    const gone = this.fwdFrom ? Math.hypot(sim.x - this.fwdFrom[0], sim.z - this.fwdFrom[1]) : 0;
    if (Math.abs(this.phi) < LINED.phi && gone >= LINED.gone && Math.abs(sim.v) < 0.02) {
      this.phase = 'reverse'; this.fwdFrom = null; this.note = '';
      this.pilot.restart(sim.wheelAngle);
      ev.push({ type: 'lined' });
    }
    return ev;
  }

  snapshot(): TowSnap { return { phase: this.phase, i: this.pilot.index, needle: this.pilot.needle, fwdFrom: this.fwdFrom }; }
  restore(s: TowSnap): void { this.phase = s.phase; this.pilot.index = s.i; this.pilot.needle = s.needle; this.fwdFrom = s.fwdFrom; this.hint = ''; }
}

/** What to work on after a towing try that did not pass: the jackknife first, then a touch, then where the trailer
 *  finished against what the lesson asks for. */
export function towFeedback(r: ParkedResult | null, rule: PassRule, par: number, jack: boolean): string {
  if (jack) return 'The trailer folded into the car: correct earlier and with smaller movements, and pull forward to straighten it as soon as it gets away.';
  if (r?.hits) return 'Something was touched: watch the trailer’s corners on the plan, and correct as soon as it drifts off its line.';
  if (!r) return 'The trailer stopped outside the space: keep reversing slowly until all of it is in, straight.';
  if (rule.angle !== undefined && Math.abs(r.angle) > rule.angle) return `The trailer finished ${Math.abs(r.angle).toFixed(1)}° off straight: bring it into line with the space a little sooner, so it goes in straight.`;
  if (rule.centre !== undefined && Math.abs(r.offCentre) > rule.centre) return `The trailer finished ${Math.round(Math.abs(r.offCentre) * 100)} cm off centre: line it up with the middle of the space before it goes in.`;
  if (rule.moves === 'par+1' && r.moves > par + 1) return `${r.moves} moves: aim to back it in at one go, with small corrections early.`;
  return 'Close: the plan shows where the trailer went against its line.';
}
