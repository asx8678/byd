// Route search over position and heading (hybrid A*), in the core's conventions:
// rear-axle pose (x, z, th); forward is (cos th, -sin th); steering right is positive and
// curvature k = tan(-steer) / WB, exactly as Sim.step and predictPath move the car.
import { ATTO2 as CAR } from '../../../src/core/content';
import { DEG } from '../../../src/core/math';
import type { Field } from './field';

export interface Pose { x: number; z: number; th: number }
/** One straight or curved piece of a route, in driving order. lvl is the steering: -1 full left … 1 full right. */
export interface Piece { dir: 1 | -1; lvl: number; len: number; from: Pose; to: Pose }
export interface Plan { status: 'found' | 'none' | 'gave-up'; pieces: Piece[]; nodes: number; ms: number; cost: number }

export const LVLS = [-1, -0.5, 0, 0.5, 1];
const SUB = 0.1, XY = 0.1, TH = 5 * DEG;
// short moves where it is tight, long ones in open space
const TIGHT = [0.2, 0.5], OPEN = [0.6, 1.2];

/** Pose after driving a signed distance s with steering lvl. */
export function drive(p: Pose, lvl: number, s: number): Pose {
  const k = Math.tan(-lvl * CAR.MAXSTEER * DEG) / CAR.WB;
  if (Math.abs(k) < 1e-9) return { x: p.x + s * Math.cos(p.th), z: p.z - s * Math.sin(p.th), th: p.th };
  const th = p.th + s * k;
  return { x: p.x + (Math.sin(th) - Math.sin(p.th)) / k, z: p.z + (Math.cos(th) - Math.cos(p.th)) / k, th };
}
export const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

interface Node { p: Pose; g: number; f: number; dir: 0 | 1 | -1; lvl: number; len: number; parent: Node | null }

class Heap {
  private a: Node[] = [];
  get size(): number { return this.a.length; }
  push(n: Node): void { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= n.f) break; a[i] = a[p]; i = p; } a[i] = n; }
  pop(): Node { const a = this.a, top = a[0], last = a.pop()!; if (a.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < (m === i ? last.f : a[m].f)) m = l; if (r < a.length && a[r].f < (m === i ? last.f : a[m].f)) m = r; if (m === i) break; a[i] = a[m]; i = m; } a[i] = last; } return top; }
}

export interface SearchOpts {
  /** Search outward from the parked pose and return the route reversed (the generator's way). */
  outward: boolean;
  maxNodes?: number; maxMs?: number;
  /** Cost per metre reversing, per direction change, per step of steering change, for driving close to things. */
  reverseCost?: number; shuntCost?: number; steerCost?: number; clearCost?: number; weight?: number;
  /** Heading the done-region wants, for straight shots into it. */
  shotHeading?: number;
}

/**
 * Search from `start` until `done(pose)`. With outward=true, start is the parked pose and the
 * route returned runs the other way: from where the search ended back into the space.
 * Every move a car makes can be driven backwards, so the reversed route is valid and keeps
 * its number of direction changes; the cost of reversing is applied in the parking direction.
 */
export function search(field: Field, starts: Pose | Pose[], done: (p: Pose) => boolean, heur: (p: Pose) => number, o: SearchOpts): Plan {
  const t0 = performance.now(), maxNodes = o.maxNodes ?? 120000, maxMs = o.maxMs ?? 4000;
  const rev = o.reverseCost ?? 1.0, shunt = o.shuntCost ?? 3.0, steerC = o.steerCost ?? 0.2, clearC = o.clearCost ?? 6.0, w = o.weight ?? 1.8;
  const open = new Heap(), best = new Map<number, number>();
  const key = (p: Pose, dir: number) => ((Math.round(p.x / XY) + 4000) * 8000 + (Math.round(p.z / XY) + 4000)) * 160 + (((Math.round(wrap(p.th) / TH) % 72) + 72) % 72) * 2 + (dir > 0 ? 1 : 0);
  // several starting poses are allowed (any good parked position): the search picks the cheapest
  const S = (Array.isArray(starts) ? starts : [starts]).filter(p => field.free(p.x, p.z, p.th));
  if (!S.length) return { status: 'none', pieces: [], nodes: 0, ms: 0, cost: 0 };
  for (const p of S) open.push({ p, g: 0, f: w * heur(p), dir: 0, lvl: 0, len: 0, parent: null });
  let nodes = 0, goal: Node | null = null;
  while (open.size) {
    const n = open.pop();
    if (done(n.p) && (!o.outward || n.dir === -1)) { goal = n; break; }
    const kn = key(n.p, n.dir);
    const seen = best.get(kn);
    if (seen !== undefined && seen < n.g - 1e-9) continue;
    if (++nodes > maxNodes || (nodes % 512 === 0 && performance.now() - t0 > maxMs)) return { status: 'gave-up', pieces: [], nodes, ms: performance.now() - t0, cost: 0 };
    // try to finish in one go: an arc until lined up with the done-region, then straight into it
    if (o.shotHeading !== undefined) {
      const shot = finishShot(field, n.p, done, o.shotHeading, o.outward ? [-1] : [1, -1]);
      if (shot) {
        let last: Node = n;
        for (const sp of shot) last = { p: sp.to, g: last.g + sp.len, f: 0, dir: sp.dir, lvl: sp.lvl, len: sp.len, parent: last };
        goal = last; break;
      }
    }
    const lens = field.roughClearance(n.p.x, n.p.z, n.p.th) < 0.35 ? TIGHT : OPEN;
    for (const dir of [1, -1] as const) for (const lvl of LVLS) for (const len of lens) {
      // drive the primitive in small steps, checking each
      let q = n.p, ok = true, c = Infinity;
      const steps = Math.max(1, Math.round(len / SUB));
      for (let k = 1; k <= steps; k++) {
        q = drive(n.p, lvl, dir * len * k / steps);
        if (!field.free(q.x, q.z, q.th)) { ok = false; break; }
        c = Math.min(c, clear(field, q));
      }
      if (!ok) continue;
      const parkDir = o.outward ? -dir : dir;
      // keep a margin like a driver would
      const near = Math.max(0, 0.3 - c) + (c < 0.08 ? 0.5 * (0.08 - c) / 0.08 : 0);
      const g = n.g + len * (parkDir < 0 ? rev : 1) + (n.dir !== 0 && n.dir !== dir ? shunt : 0) + steerC * Math.abs(lvl - n.lvl) / 0.5 + clearC * near * len;
      const kq = key(q, dir), old = best.get(kq);
      if (old !== undefined && old <= g) continue;
      best.set(kq, g);
      open.push({ p: q, g, f: g + w * heur(q), dir, lvl, len, parent: n });
    }
  }
  const ms = performance.now() - t0;
  if (!goal) return { status: 'none', pieces: [], nodes, ms, cost: 0 };
  // unwind: chain of nodes from start to goal; each node holds the primitive that reached it
  const chain: Node[] = []; for (let n: Node | null = goal; n; n = n.parent) chain.push(n);
  chain.reverse();
  let pieces: Piece[] = [];
  for (let i = 1; i < chain.length; i++) pieces.push({ dir: chain[i].dir as 1 | -1, lvl: chain[i].lvl, len: chain[i].len, from: chain[i - 1].p, to: chain[i].p });
  if (o.outward) pieces = pieces.reverse().map(pc => ({ dir: (-pc.dir) as 1 | -1, lvl: pc.lvl, len: pc.len, from: pc.to, to: pc.from }));
  return { status: 'found', pieces: merge(pieces), nodes, ms, cost: goal.g };
}

/** Clearance at a pose: the quick bound first, the exact outline only when something is close. */
function clear(field: Field, q: Pose): number {
  const rough = field.roughClearance(q.x, q.z, q.th);
  return rough < 0.45 ? field.clearance(q.x, q.z, q.th) : rough;
}
type ShotPiece = { dir: 1 | -1; lvl: number; len: number; to: Pose };
/** Drive one way with fixed steering until `stop`, never closer to things than `minC`. */
function run(field: Field, p: Pose, dir: 1 | -1, lvl: number, maxLen: number, minC: number, stop: (q: Pose) => boolean): ShotPiece | null {
  for (let s = 0.1; s <= maxLen + 1e-9; s += 0.1) {
    const q = drive(p, lvl, dir * s);
    if (!field.free(q.x, q.z, q.th) || clear(field, q) < minC) return null;
    if (stop(q)) return { dir, lvl, len: s, to: q };
  }
  return null;
}
/** Straight into the region, or a full-lock arc until lined up and then straight. Must not get tighter than where it starts. */
function finishShot(field: Field, p: Pose, done: (p: Pose) => boolean, th: number, lastDirs: (1 | -1)[]): ShotPiece[] | null {
  const minC = Math.min(0.2, clear(field, p) - 0.02);
  const aligned = (q: Pose) => Math.abs(wrap(q.th - th)) < 2 * DEG;
  for (const d of lastDirs) {
    if (Math.abs(wrap(p.th - th)) < 8 * DEG) { const st = run(field, p, d, 0, 30, minC, done); if (st) return [st]; }
  }
  for (const dir of [1, -1] as const) for (const lvl of [-1, 1, -0.5, 0.5]) {
    const arc = run(field, p, dir, lvl, 9, minC, aligned);
    if (!arc) continue;
    for (const d of lastDirs) { const st = run(field, arc.to, d, 0, 30, minC, done); if (st) return [arc, st]; }
  }
  return null;
}

/** Join consecutive pieces that drive the same way with the same steering. */
export function merge(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const l = out[out.length - 1];
    if (l && l.dir === p.dir && l.lvl === p.lvl) out[out.length - 1] = { ...l, len: l.len + p.len, to: p.to };
    else out.push({ ...p });
  }
  return out;
}

/** Sample a route every `step` metres: poses with the direction they are driven in. */
export function sample(pieces: Piece[], step = 0.05): (Pose & { dir: 1 | -1; i: number })[] {
  const out: (Pose & { dir: 1 | -1; i: number })[] = [];
  pieces.forEach((pc, i) => {
    const n = Math.max(1, Math.round(pc.len / step));
    for (let k = 0; k <= n; k++) { if (k === 0 && i > 0) continue; const q = drive(pc.from, pc.lvl, pc.dir * pc.len * k / n); out.push({ ...q, dir: pc.dir, i }); }
  });
  return out;
}

/** Number of moves: runs driven in one direction. */
export const moves = (pieces: Piece[]): number => pieces.reduce((m, p, i) => m + (i === 0 || p.dir !== pieces[i - 1].dir ? 1 : 0), 0);
