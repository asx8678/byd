// Lessons in every car: the route a lesson teaches, worked out for a car the way the course file's routes are, and the
// lesson's tips matched to that route's steps. The routes stored in content/lessons/course.json come from planLesson;
// the lessons test checks they still do.
import { stepsFor, type CuePick, type Step } from './coach';
import { ATTO2, GARAGE_561 } from './content';
import { heroCorners } from './car';
import { solve } from './generator/level';
import { angled, lessonScene } from './generator/lessonScenes';
import { draft, goalsAtGap } from './generator/templates';
import { loadLesson, storedRoute, type Lesson, type LessonDef, type Para } from './lesson';
import { bayBox } from './parking';
import { clearStart, drive, fieldFor, planToBay, type Piece, type Pose } from './planner';
import { failures, overshooters, touching } from './robot';
import { makeScene } from './scene';
import type { Vehicle } from './vehicle';

/** The shortest piece a lesson route for another car may have: a coach cannot call a move much shorter than its mark window. */
export const MIN_PIECE = 0.3;
const LOCK = [-1, 0, 1] as const;
type Shape = readonly (readonly [1 | -1, number])[];

/**
 * Where each of the lesson's tips goes in a car's route. The tips are written for the Atto 2's steps, and a tip is about
 * the moment its step ends and the next begins ("turn when your mirror reaches the bay's near line"): it goes to the
 * car's step where the same two pieces meet, in order, and the last step's tip to the car's last step if it drives the
 * same way. A tip whose moment the car's route does not have is left out: the car does that part differently.
 */
export function stepMap(def: LessonDef, route: readonly { dir: number; lvl: number }[]): Map<number, number> {
  const ref = def.route!.pieces, n = ref.length, map = new Map<number, number>();
  const is = (k: number, i: number) => route[k].dir === ref[i][0] && route[k].lvl === ref[i][1];
  let j = 0;
  for (let i = 0; i < n - 1; i++) for (let k = j; k + 1 < route.length; k++) if (is(k, i) && is(k + 1, i + 1)) { map.set(i + 1, k + 1); j = k + 1; break; }
  const last = route.length - 1;
  if (last >= j && route[last].dir === ref[n - 1][0]) map.set(n, last + 1);
  return map;
}
/** The lesson's tips keyed by this route's own step numbers. */
export function tipsFor(def: LessonDef, route: readonly { dir: number; lvl: number }[]): Record<string, Para> {
  const out: Record<string, Para> = {};
  for (const [from, to] of stepMap(def, route)) { const t = def.tips?.[String(from)]; if (t) out[String(to)] = t; }
  return out;
}
/** The cue each tip asks for (a part of the car, a landmark), by this route's step numbers. */
export const picksFor = (def: LessonDef, route: readonly { dir: number; lvl: number }[]): Record<string, CuePick | undefined> =>
  Object.fromEntries(Object.entries(tipsFor(def, route)).map(([k, t]) => [k, t.cue]));
/** A lesson's steps for this car's route, with its tips' cues. */
export const lessonSteps = (v: Vehicle, L: Lesson): Step[] => stepsFor(v, L.scene, L.bay, L.route, picksFor(L.def, L.route));

/** Overshooting each mark by these much (one mark at a time), as a learner does. */
const OVERSHOOT = [0.2, 0.35];
const overshoots = (S: Step[]) => OVERSHOOT.flatMap(m => overshooters(S.length, m));
/** Whether the Atto 2 can go past each of the lesson's marks without touching anything (in a parallel park it cannot). */
const survives = new Map<string, boolean>();
function attoSurvives(def: LessonDef): boolean {
  let ok = survives.get(def.id);
  if (ok === undefined) { const L = loadLesson(ATTO2, def), S = lessonSteps(ATTO2, L); ok = touching(ATTO2, L, S, overshoots(S)).length === 0; survives.set(def.id, ok); }
  return ok;
}
/** How a car's route differs from the Atto 2's, which the lesson's words are about ('' when it does not): more moves or
 *  steps, or (angled bays) coming up the aisle further out than Georgia's 1.2 m because the car turns wider. */
export function routeNote(def: LessonDef, v: Vehicle, route: readonly Piece[]): string {
  if (v.id === ATTO2.id) return '';
  const ref = def.route!.pieces, out: string[] = [], sc = def.scene;
  const m0 = ref.reduce((m, p, i) => m + (i === 0 || p[0] !== ref[i - 1][0] ? 1 : 0), 0), m = route.reduce((n, p, i) => n + (i === 0 || p.dir !== route[i - 1].dir ? 1 : 0), 0);
  const same = ref.length === route.length && ref.every((p, i) => p[0] === route[i].dir && p[1] === route[i].lvl);
  if (m !== m0) out.push(`The ${v.short} needs ${m} moves here where the Atto 2 needs ${m0}: the coach shows each one.`);
  else if (!same) out.push(`The ${v.short}'s route here has ${route.length} steps where the Atto 2's has ${ref.length}: the coach shows each one.`);
  if (sc && 'build' in sc && sc.build === 'angled') {
    // the start is (out + half the width) across the aisle from the bays' mouths, which run through the origin at 30°
    const s = route[0].from, across = s.x * Math.sin(Math.PI / 6) + s.z * Math.cos(Math.PI / 6) - v.W / 2;
    if (Math.abs(across - 1.2) > 0.05) out.push(`The ${v.short} turns wider, so it comes up the aisle ${across.toFixed(1)} m out from the parked cars rather than 1.2 m.`);
  }
  return out.join(' ');
}

/** A car can drive the route as it is taught: no piece too short to call, every coached driver passes, and where the
 *  Atto 2 can go 20 or 35 cm past a mark without touching anything, so can this car. */
function drivable(v: Vehicle, def: LessonDef, route: Piece[]): boolean {
  if (!route.length || route.some(p => p.len < MIN_PIECE - 1e-9)) return false;
  const L = loadLesson(v, def, route), S = lessonSteps(v, L);
  return failures(v, L, S).length === 0 && (!attoSurvives(def) || touching(v, L, S, overshoots(S)).length === 0);
}
const fromPieces = (v: Vehicle, s: Pose, P: readonly (readonly number[])[]): Piece[] => storedRoute(v, { start: [s.x, s.z, s.th], pieces: P.map(p => [...p]) });

/** Drive on straight at the end of a route out of a space until the car is 50 cm inside the lane, where a driver who
 *  stops a little short is still out (the Atto 2's route ends just inside it). */
function intoLane(v: Vehicle, L: Lesson, route: Piece[]): Piece[] {
  const [x0, x1, z0, z1] = bayBox(L.scene.bays[L.bay]), field = fieldFor(v, L.scene), last = route[route.length - 1];
  const inside = (q: Pose) => heroCorners(v, q.x, q.z, q.th).every(c => c[0] >= x0 + 0.5 && c[0] <= x1 && c[1] >= z0 && c[1] <= z1);
  for (let e = 0; e <= 4 + 1e-9; e += 0.1) {
    const q = drive(v, last.to, 0, last.dir * e);
    if (!field.free(q.x, q.z, q.th)) break;
    if (!inside(q)) continue;
    if (e < 1e-9) return route;
    const r = Math.round(e * 10) / 10;
    return last.lvl === 0 ? [...route.slice(0, -1), { ...last, len: last.len + r, to: drive(v, last.from, 0, last.dir * (last.len + r)) }] : [...route, { dir: last.dir, lvl: 0, len: r, from: last.to, to: drive(v, last.to, 0, last.dir * r) }];
  }
  return route;
}

/**
 * The route a lesson teaches in a car, or null when the car cannot do the lesson (too big for the bay). The Atto 2's
 * routes are planned freely with the wheel at full lock or straight (or written for the scene), exactly as stored.
 * Another car keeps the Atto 2's moves where it can drive them, since the lesson's words and tips are about them: the
 * same pieces in the same order, then the same with a straight piece at the end, then with a straight between two turns
 * on opposite locks, then any route. A parallel space is
 * tried with the body 15 cm from the kerb, then 20 cm; angled bays from 1.2 m out (Georgia's figure), further out for a
 * car that turns wider. A route is kept only if every coached driver passes it (see robot.ts), and where the Atto 2
 * can overshoot a mark by 20 or 35 cm without touching anything, only if this car can too.
 */
export function planLesson(v: Vehicle, def: LessonDef): Piece[] | null {
  const sc = def.scene!, atto = v.id === ATTO2.id, ref: Shape = def.route!.pieces.map(p => [p[0] as 1 | -1, p[1]] as const);
  // the Atto 2's moves; then with a straight piece at the end; then with a straight between two turns the same way on
  // opposite locks (the three-phase way, which lets a car with a tight circle take out an error before the last turn)
  const last = ref[ref.length - 1], split: Shape = ref.flatMap((p, i) => (i && ref[i - 1][0] === p[0] && ref[i - 1][1] * p[1] < 0 ? [[p[0], 0] as const, p] : [p]));
  const shapes: (Shape | undefined)[] = atto ? [undefined] : [ref, ...(last[1] !== 0 ? [[...ref, [last[0], 0] as const]] : []), ...(split.length > ref.length ? [split] : []), undefined];
  const first = (tries: (() => Piece[])[], fix: (r: Piece[]) => Piece[] = r => r): Piece[] | null => {
    for (const t of tries) { const r = t(); if (atto ? r.length > 0 : r.length > 0 && drivable(v, def, fix(r))) return fix(r); }
    return null;
  };
  if ('build' in sc) {
    if (sc.build === 'angled') {
      if (atto) { const B = angled(v, sc.seed ?? 1); return fromPieces(v, B.start, B.route!); }
      const outs = Array.from({ length: 19 }, (_, k) => 1.2 + k / 10);
      return first(outs.map(out => () => { const B = angled(v, sc.seed ?? 1, Math.round(out * 10) / 10); return fromPieces(v, B.start, B.route!); }));
    }
    const B = lessonScene(v, sc.build, sc.level, sc.seed);
    if (B.route) return first([() => fromPieces(v, B.start, B.route!)]);
    B.spec.starts = { start: B.start };
    const scene = makeScene(B.spec), exit = scene.bays[B.bay].kind === 'exit';
    const plan = (shape?: Shape) => () => planToBay(v, scene, B.start, B.bay, { lvls: LOCK, maxNodes: 60000, shape }).pieces;
    return first(shapes.map(plan), r => (exit && !atto ? intoLane(v, loadLesson(v, def, r), r) : r));
  }
  if ('tow' in sc) return null;   // a towing lesson has no stored route: its coach steers by the trailer's path
  if ('garage' in sc) {
    const s = clearStart(v, GARAGE_561, GARAGE_561.starts[sc.start]);
    return first(shapes.map(shape => () => planToBay(v, GARAGE_561, s, sc.garage, { lvls: LOCK, shape }).pieces));
  }
  const gaps = sc.kerbGap === undefined ? [undefined] : atto ? [sc.kerbGap] : [sc.kerbGap, sc.kerbGap + 0.05];
  const tries = shapes.flatMap(shape => gaps.map(gap => () => {
    const d = draft(v, sc.template, sc.level, sc.seed);
    if (gap !== undefined) d.goals = goalsAtGap(v, d.goals, gap);
    d.spec.starts = { start: { x: d.entry.x0, z: (d.entry.z0 + d.entry.z1) / 2, th: d.entry.th } };
    return solve(v, d, makeScene(d.spec), 60000, { lvls: LOCK, shape }).route;
  }));
  return first(tries);
}
