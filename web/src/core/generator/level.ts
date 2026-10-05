// Make a level: build the scene, solve it outward from the parked poses to the entrance, check the route
// with the exact collision test, measure it, and keep it if it is about as hard as asked. A level is a
// template, a difficulty and a seed: the same three always give the same level on the same device.
import { Field } from '../field';
import { clamp, wrapPi } from '../math';
import { bayBox } from '../parking';
import { exactCheck, moves, sample, search, type Piece, type Pose, type SearchOpts } from '../planner';
import { makeScene, type Rect, type Scene } from '../scene';
import type { Vehicle } from '../vehicle';
import { draft, growWidth, type Draft, type Knobs, type TemplateId } from './templates';

export interface Measure { moves: number; length: number; minClear: number; score: number }
export interface Level {
  key: string; template: TemplateId; level: number; seed: number;
  scene: Scene; route: Piece[]; par: number; timeLimit: number;
  measure: Measure; knobs: Knobs;
  knobLevel: number;   // the difficulty the settings were eased or tightened to
  nodes: number;       // search effort, all tries together
}

export const levelKey = (t: TemplateId, level: number, seed: number): string => `${t}:${level}:${seed}`;
export function parseKey(key: string): { template: TemplateId; level: number; seed: number } | null {
  const m = /^(bays-in|bays-back|kerb):(\d+):(\d+)$/.exec(key);
  return m ? { template: m[1] as TemplateId, level: +m[2], seed: +m[3] } : null;
}

/** Seconds allowed for the efficiency star: plenty of room over the planner's route. */
export function timeLimit(route: Piece[]): number {
  const len = route.reduce((s, p) => s + p.len, 0);
  return Math.ceil((20 + 2.5 * len + 12 * moves(route)) / 5) * 5;
}

const inRegion = (e: Draft['entry'], p: Pose) => p.x >= e.x0 && p.x <= e.x1 && p.z >= e.z0 && p.z <= e.z1 && Math.abs(wrapPi(p.th - e.th)) < 8 * Math.PI / 180;

/** Search outward from the parked poses until the car is in the entry region, then turn the route round. */
export function solve(v: Vehicle, d: Draft, scene: Scene, maxNodes: number, extra: SearchOpts = {}): { field: Field; status: 'found' | 'none' | 'gave-up'; route: Piece[]; nodes: number } {
  const [x0, x1, z0, z1] = scene.lot!, e = d.entry;
  const field = new Field(v, scene.obstacles, x0, x1, z0, z1, scene.kerbs);
  const heur = (p: Pose) => Math.hypot(Math.max(e.x0 - p.x, 0, p.x - e.x1), Math.max(e.z0 - p.z, 0, p.z - e.z1)) + 0.5 * v.R_REAR * Math.abs(wrapPi(p.th - e.th));
  const plan = search(v, field, d.goals, p => inRegion(e, p), heur, { ...extra, outward: true, shotHeading: e.th, maxNodes });
  return { field, status: plan.status, route: plan.pieces, nodes: plan.nodes };
}

/** Moves, length, the tightest gap on the way in (before the car is over its space) and a difficulty score 1–10. */
export function measure(v: Vehicle, scene: Scene, field: Field, route: Piece[], knobs: Knobs, back: boolean): Measure {
  const pts = sample(v, route, 0.1), end = pts[pts.length - 1], b = scene.bays[scene.defaultBay];
  const [tx0, tx1, tz0, tz1] = [b.x0, b.x1, b.z0, b.z1];
  let minClear = Infinity;
  for (const q of pts) {
    const cx = q.x + (v.WB / 2) * Math.cos(q.th), cz = q.z - (v.WB / 2) * Math.sin(q.th);
    if (cx > tx0 && cx < tx1 && cz > tz0 && cz < tz1) continue;
    minClear = Math.min(minClear, field.clearance(q.x, q.z, q.th));
  }
  if (!isFinite(minClear)) minClear = field.clearance(end.x, end.z, end.th);
  const length = route.reduce((s, p) => s + p.len, 0), m = moves(route);
  let tpl: number, base: number;
  if (knobs.kind === 'kerb') { tpl = 5 * clamp((2.4 - knobs.spare) / 1.6, 0, 1); base = 2; }
  else { tpl = 2.6 * clamp((7 - knobs.aisle) / 2, 0, 1) + 2.6 * clamp((2.7 - (knobs.bay - growWidth(v))) / 0.4, 0, 1); base = back ? 2 : 1; }
  const score = clamp(1 + 1.7 * Math.max(0, m - base) + 2.0 * clamp((0.6 - minClear) / 0.5, 0, 1) + tpl, 1, 10);
  return { moves: m, length, minClear, score };
}

const INTRO: Record<TemplateId, string> = {
  'bays-in': 'Drive along the aisle and park nose first in the green bay, in the middle.',
  'bays-back': 'Drive past and reverse into the green bay, in the middle.',
  kerb: 'Parallel park in the green space, close to the kerb on your right.',
};

/** The whole level in view: the route, the space and a margin, inside the lot. */
export function areaOf(v: Vehicle, scene: Scene, route: Piece[], bay = scene.defaultBay): Rect {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = (x: number, z: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const p of sample(v, route, 0.5)) { add(p.x - 1.2, p.z - 1.2); add(p.x + 1.2, p.z + 1.2); add(p.x + (v.L - v.OVR) * Math.cos(p.th), p.z - (v.L - v.OVR) * Math.sin(p.th)); }
  const bx = bayBox(scene.bays[bay]); add(bx[0], bx[2]); add(bx[1], bx[3]);
  const [lx0, lx1, lz0, lz1] = scene.lot!;
  return [Math.max(lx0, x0 - 1.5), Math.min(lx1, x1 + 1.5), Math.max(lz0, z0 - 1.5), Math.min(lz1, z1 + 1.5)];
}

/**
 * Deterministic: the same template, level and seed always give the same level. The search stops after a
 * number of steps, never a number of seconds, so a slow phone and a fast laptop make the same level.
 * When no try finds a way in (a big car in a tight space), the settings are eased a step at a time until one does;
 * null only if even level 1 has none.
 */
export function generate(v: Vehicle, template: TemplateId, level: number, seed: number, o: { tries?: number; maxNodes?: number; budget?: number } = {}): Level | null {
  // a search gives up after maxNodes steps, and the tries at the level asked after budget steps in all: a big car in a
  // tight layout can search for a long time, and a level should build in a second or two on a phone
  const tries = o.tries ?? 6, maxNodes = o.maxNodes ?? 5000, budget = o.budget ?? 15000, back = template === 'bays-back';
  let fallback: Level | null = null, knob = level, nodes = 0;
  const attempt = (k: number): Level | null => {
    const d = draft(v, template, knob, seed + k * 100003);
    // a placeholder start to load the scene; the real one is where the route begins
    d.spec.starts = { start: { x: d.entry.x0, z: (d.entry.z0 + d.entry.z1) / 2, th: d.entry.th } };
    let scene = makeScene(d.spec);
    const s = solve(v, d, scene, maxNodes);
    nodes += s.nodes;
    if (s.status !== 'found' || exactCheck(v, scene, s.field, s.route)) return null;
    const m = measure(v, scene, s.field, s.route, d.knobs, back), st = s.route[0].from;
    d.spec.starts = { start: { x: st.x, z: st.z, th: st.th, label: INTRO[template] } };
    d.spec.areaView = areaOf(v, scene, s.route);
    scene = makeScene(d.spec);
    return { key: levelKey(template, level, seed), template, level, seed, scene, route: s.route, par: m.moves, timeLimit: timeLimit(s.route), measure: m, knobs: d.knobs, knobLevel: knob, nodes };
  };
  for (let k = 0; k < tries && nodes < budget; k++) {
    const lvl = attempt(k);
    if (!lvl) continue;
    const off = lvl.measure.score - level;
    if (Math.abs(off) <= 2.5) return lvl;
    // measured far from what was asked: keep trying with the settings eased or tightened a step
    if (!fallback || Math.abs(lvl.measure.score - level) < Math.abs(fallback.measure.score - level)) fallback = lvl;
    knob = clamp(knob - Math.sign(off), 1, 10);
  }
  for (let k = tries; !fallback && knob > 1; k++) { knob--; fallback = attempt(k); }
  if (fallback) fallback.nodes = nodes;
  return fallback;
}
