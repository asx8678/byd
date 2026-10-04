// Route search over position and heading (hybrid A*): finds a way for a car into a bay, for
// Show me, par and the coach. Rear-axle poses; forward is (cos th, -sin th); steering right is
// positive and curvature k = tan(-steer) / WB, exactly as Sim.step moves the car.
import { collides } from './collision';
import { Field } from './field';
import { DEG, wrapPi } from './math';
import { parkedIn } from './parking';
import type { Bay, Scene } from './scene';
import type { Vehicle } from './vehicle';

export interface Pose { x: number; z: number; th: number }
/** One straight or curved piece of a route, in driving order. lvl is the steering: -1 full left … 1 full right. */
export interface Piece { dir: 1 | -1; lvl: number; len: number; from: Pose; to: Pose }
export interface Plan { status: 'found' | 'none' | 'gave-up'; pieces: Piece[]; nodes: number; cost: number }
/** A route sampled for drawing and replay: poses with the direction they are driven in and their piece. */
export type RoutePoint = Pose & { dir: 1 | -1; i: number };

export const LVLS = [-1, -0.5, 0, 0.5, 1];
const SUB = 0.1, XY = 0.1, TH = 5 * DEG;
const TIGHT = [0.2, 0.5], OPEN = [0.6, 1.2];   // short moves where it is tight, long ones in open space

/** Pose after driving a signed distance s with steering lvl. */
export function drive(v: Vehicle, p: Pose, lvl: number, s: number): Pose {
  const k = Math.tan(-lvl * v.MAXSTEER * DEG) / v.WB;
  if (Math.abs(k) < 1e-9) return { x: p.x + s * Math.cos(p.th), z: p.z - s * Math.sin(p.th), th: p.th };
  const th = p.th + s * k;
  return { x: p.x + (Math.sin(th) - Math.sin(p.th)) / k, z: p.z + (Math.cos(th) - Math.cos(p.th)) / k, th };
}

interface Node { p: Pose; g: number; f: number; dir: 0 | 1 | -1; lvl: number; len: number; parent: Node | null }
class Heap {
  private a: Node[] = [];
  get size(): number { return this.a.length; }
  push(n: Node): void { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= n.f) break; a[i] = a[p]; i = p; } a[i] = n; }
  pop(): Node {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < (m === i ? last.f : a[m].f)) m = l; if (r < a.length && a[r].f < (m === i ? last.f : a[m].f)) m = r; if (m === i) break; a[i] = a[m]; i = m; } a[i] = last; }
    return top;
  }
}

export interface SearchOpts {
  /** Search outward from the parked pose and return the route reversed (the generator's way). */
  outward?: boolean;
  /** Give up after this many expanded poses. A step limit, never a time limit, so every device finds the same route. */
  maxNodes?: number;
  /** Costs: per metre reversing, per direction change, per step of steering change, for driving close to things. */
  reverseCost?: number; shuntCost?: number; steerCost?: number; clearCost?: number; weight?: number;
  /** Heading the done-region wants, so the search can finish with an arc and a straight line. */
  shotHeading?: number;
}

/** Clearance at a pose: the quick bound first, the exact outline only when something is close. */
function clear(field: Field, q: Pose): number {
  const rough = field.roughClearance(q.x, q.z, q.th);
  return rough < 0.45 ? field.clearance(q.x, q.z, q.th) : rough;
}
type ShotPiece = { dir: 1 | -1; lvl: number; len: number; to: Pose };
function run(v: Vehicle, field: Field, p: Pose, dir: 1 | -1, lvl: number, maxLen: number, minC: number, stop: (q: Pose) => boolean): ShotPiece | null {
  for (let s = 0.1; s <= maxLen + 1e-9; s += 0.1) {
    const q = drive(v, p, lvl, dir * s);
    if (!field.free(q.x, q.z, q.th) || clear(field, q) < minC) return null;
    if (stop(q)) return { dir, lvl, len: s, to: q };
  }
  return null;
}
/** Straight into the region, or an arc until lined up and then straight. Never tighter than where it starts. */
function finishShot(v: Vehicle, field: Field, p: Pose, done: (p: Pose) => boolean, th: number, lastDirs: (1 | -1)[]): ShotPiece[] | null {
  const minC = Math.min(0.2, clear(field, p) - 0.02);
  const aligned = (q: Pose) => Math.abs(wrapPi(q.th - th)) < 2 * DEG;
  if (Math.abs(wrapPi(p.th - th)) < 8 * DEG) for (const d of lastDirs) { const st = run(v, field, p, d, 0, 30, minC, done); if (st) return [st]; }
  for (const dir of [1, -1] as const) for (const lvl of [-1, 1, -0.5, 0.5]) {
    const arc = run(v, field, p, dir, lvl, 9, minC, aligned);
    if (!arc) continue;
    for (const d of lastDirs) { const st = run(v, field, arc.to, d, 0, 30, minC, done); if (st) return [arc, st]; }
  }
  return null;
}

/**
 * Search from `starts` until `done(pose)`. With outward=true the starts are parked poses and the route
 * comes back reversed: from where the search ended into the space. A car can drive any route backwards,
 * so the reversed route is valid and keeps its moves; reversing is costed in the parking direction.
 */
export function search(v: Vehicle, field: Field, starts: Pose | Pose[], done: (p: Pose) => boolean, heur: (p: Pose) => number, o: SearchOpts = {}): Plan {
  const maxNodes = o.maxNodes ?? 60000;
  const rev = o.reverseCost ?? 1.0, shunt = o.shuntCost ?? 3.0, steerC = o.steerCost ?? 0.2, clearC = o.clearCost ?? 6.0, w = o.weight ?? 1.8;
  const open = new Heap(), best = new Map<number, number>();
  const key = (p: Pose, dir: number) => ((Math.round(p.x / XY) + 4000) * 8000 + (Math.round(p.z / XY) + 4000)) * 160 + (((Math.round(wrapPi(p.th) / TH) % 72) + 72) % 72) * 2 + (dir > 0 ? 1 : 0);
  const S = (Array.isArray(starts) ? starts : [starts]).filter(p => field.freeExact(p.x, p.z, p.th));
  if (!S.length) return { status: 'none', pieces: [], nodes: 0, cost: 0 };
  for (const p of S) open.push({ p, g: 0, f: w * heur(p), dir: 0, lvl: 0, len: 0, parent: null });
  let nodes = 0, goal: Node | null = null;
  while (open.size) {
    const n = open.pop();
    if (done(n.p) && (!o.outward || n.dir === -1)) { goal = n; break; }
    const seen = best.get(key(n.p, n.dir));
    if (seen !== undefined && seen < n.g - 1e-9) continue;
    if (++nodes > maxNodes) return { status: 'gave-up', pieces: [], nodes, cost: 0 };
    // finishing shots are worth trying near the goal, and only now and then: each one is a long roll-out
    if (o.shotHeading !== undefined && (nodes <= 40 || nodes % 4 === 0) && heur(n.p) < 25) {
      const shot = finishShot(v, field, n.p, done, o.shotHeading, o.outward ? [-1] : [1, -1]);
      if (shot) { let last: Node = n; for (const sp of shot) last = { p: sp.to, g: last.g + sp.len, f: 0, dir: sp.dir, lvl: sp.lvl, len: sp.len, parent: last }; goal = last; break; }
    }
    const lens = field.roughClearance(n.p.x, n.p.z, n.p.th) < 0.35 ? TIGHT : OPEN;
    for (const dir of [1, -1] as const) for (const lvl of LVLS) for (const len of lens) {
      let q = n.p, ok = true, c = Infinity;
      const steps = Math.max(1, Math.round(len / SUB));
      for (let k = 1; k <= steps; k++) { q = drive(v, n.p, lvl, dir * len * k / steps); if (!field.free(q.x, q.z, q.th)) { ok = false; break; } c = Math.min(c, clear(field, q)); }
      if (!ok) continue;
      const parkDir = o.outward ? -dir : dir;
      const near = Math.max(0, 0.3 - c) + (c < 0.08 ? 0.5 * (0.08 - c) / 0.08 : 0);   // keep a margin like a driver would
      const g = n.g + len * (parkDir < 0 ? rev : 1) + (n.dir !== 0 && n.dir !== dir ? shunt : 0) + steerC * Math.abs(lvl - n.lvl) / 0.5 + clearC * near * len;
      const kq = key(q, dir), old = best.get(kq);
      if (old !== undefined && old <= g) continue;
      best.set(kq, g);
      open.push({ p: q, g, f: g + w * heur(q), dir, lvl, len, parent: n });
    }
  }
  if (!goal) return { status: 'none', pieces: [], nodes, cost: 0 };
  const chain: Node[] = []; for (let n: Node | null = goal; n; n = n.parent) chain.push(n);
  chain.reverse();
  let pieces: Piece[] = [];
  for (let i = 1; i < chain.length; i++) pieces.push({ dir: chain[i].dir as 1 | -1, lvl: chain[i].lvl, len: chain[i].len, from: chain[i - 1].p, to: chain[i].p });
  if (o.outward) pieces = pieces.reverse().map(pc => ({ dir: (-pc.dir) as 1 | -1, lvl: pc.lvl, len: pc.len, from: pc.to, to: pc.from }));
  return { status: 'found', pieces: merge(pieces), nodes, cost: goal.g };
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

/** Sample a route every `step` metres. */
export function sample(v: Vehicle, pieces: Piece[], step = 0.05): RoutePoint[] {
  const out: RoutePoint[] = [];
  pieces.forEach((pc, i) => {
    const n = Math.max(1, Math.round(pc.len / step));
    for (let k = 0; k <= n; k++) { if (k === 0 && i > 0) continue; out.push({ ...drive(v, pc.from, pc.lvl, pc.dir * pc.len * k / n), dir: pc.dir, i }); }
  });
  return out;
}

/** Number of moves: runs driven in one direction. */
export const moves = (pieces: Piece[]): number => pieces.reduce((m, p, i) => m + (i === 0 || p.dir !== pieces[i - 1].dir ? 1 : 0), 0);

/** The name of the first thing the route touches with the exact collision check, or null when it is clear. */
export function exactCheck(v: Vehicle, scene: Scene, field: Field, pieces: Piece[]): string | null {
  for (const q of sample(v, pieces, 0.05)) {
    const hit = collides(v, scene.obstacles, q.x, q.z, q.th);
    if (hit) return hit.obstacle.name + (hit.part ? ` (${hit.part})` : '');
    if (!field.wheelsOk(q.x, q.z, q.th)) return 'the kerb';
  }
  return null;
}

// one field per car and scene: building it takes a moment, using it is fast
const fields = new WeakMap<Scene, Map<Vehicle, Field>>();
export function fieldFor(v: Vehicle, scene: Scene): Field {
  let m = fields.get(scene); if (!m) fields.set(scene, m = new Map());
  let f = m.get(v);
  if (!f) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    if (scene.lot) [x0, x1, z0, z1] = scene.lot;
    else for (const o of scene.obstacles) { x0 = Math.min(x0, o.bx0); x1 = Math.max(x1, o.bx1); z0 = Math.min(z0, o.bz0); z1 = Math.max(z1, o.bz1); }
    f = new Field(v, scene.obstacles, x0 - 1, x1 + 1, z0 - 1, z1 + 1);
    m.set(v, f);
  }
  return f;
}

/** Nose-in poses inside a bay (bays open towards +z, head towards -z), from deep to shallow. */
export function bayPoses(v: Vehicle, b: Bay): Pose[] {
  const cx = (b.x0 + b.x1) / 2, out: Pose[] = [];
  for (let front = b.headZ + 0.35; front + v.L <= b.z1 + b.mouthTol - 0.02; front += 0.1) out.push({ x: cx, z: front + (v.L - v.OVR), th: b.inHeading });
  return out;
}

/**
 * A route from a pose into a bay, nose in. Ends with the car settled at least 30 cm short of
 * whatever is ahead in the bay. 'none' straight away when no parked pose in the bay is free.
 */
export function planToBay(v: Vehicle, scene: Scene, from: Pose, bayId: string, o: { maxNodes?: number } = {}): Plan & { field: Field } {
  const field = fieldFor(v, scene), b = scene.bays[bayId];
  const goals = b ? bayPoses(v, b).filter(p => field.freeExact(p.x, p.z, p.th)) : [];
  if (!goals.length) return { status: 'none', pieces: [], nodes: 0, cost: 0, field };
  const ideal = goals[Math.floor(goals.length / 2)];
  const done = (p: Pose) => parkedIn(v, b, p.x, p.z, p.th)?.noseIn ?? false;
  const heur = (p: Pose) => Math.hypot(p.x - ideal.x, p.z - ideal.z) + 0.5 * v.R_REAR * Math.abs(wrapPi(p.th - b.inHeading));
  const plan = search(v, field, from, done, heur, { maxNodes: o.maxNodes ?? 20000, shotHeading: b.inHeading });
  if (plan.status === 'found') settle(v, field, plan.pieces, done);
  return { ...plan, field };
}

/** Roll straight on in the last direction while it stays parked and keeps 30 cm clear ahead (at most 3 m). */
function settle(v: Vehicle, field: Field, pieces: Piece[], done: (p: Pose) => boolean): void {
  const last = pieces[pieces.length - 1], start = last.to;
  let len = 0;
  for (let s = 0.05; s <= 3; s += 0.05) {
    const q = drive(v, start, 0, last.dir * s), ahead = drive(v, start, 0, last.dir * (s + 0.3));
    if (!done(q) || !field.free(ahead.x, ahead.z, ahead.th)) break;
    len = s;
  }
  if (len < 0.05) return;
  const to = drive(v, start, 0, last.dir * len);
  if (last.lvl === 0) pieces[pieces.length - 1] = { ...last, len: last.len + len, to };
  else pieces.push({ dir: last.dir, lvl: 0, len, from: start, to });
}
