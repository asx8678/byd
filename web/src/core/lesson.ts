// The course: lessons as data (content/lessons/course.json), each a scene, a stored route, words with their
// sources and a rule for passing; and how the help steps back as you pass. Pure logic, like the rest of core/.
import course from '../../content/lessons/course.json';
import { GARAGE_561 } from './content';
import { areaOf, timeLimit } from './generator/level';
import { lessonScene, type LessonSceneId } from './generator/lessonScenes';
import { draft, type TemplateId } from './generator/templates';
import { drive, moves, type Piece, type Pose } from './planner';
import { makeScene, type Scene } from './scene';
import type { ParkedResult } from './sim';
import type { Vehicle } from './vehicle';

export interface Source { name: string; url: string }
export interface Para { text: string; sources?: string[]; cue?: { part?: string; mark?: string } }
/** What passing a lesson takes, besides touching nothing: degrees off straight, metres off centre, the tyres' gap
 *  to the kerb, no more than one move over par, and which way round. */
export interface PassRule { angle?: number; centre?: number; kerb?: number; moves?: 'par+1'; face?: 'in' | 'out' }
export interface LessonDef {
  id: string; n: number; title: string; learn: string; soon?: boolean;
  scene?: { template: TemplateId; level: number; seed: number; kerbGap?: number } | { garage: string; start: string } | { build: LessonSceneId; level?: number; seed?: number };
  /** authored: written for the lesson (a cone course), not found by the planner. */
  route?: { start: number[]; pieces: number[][]; authored?: boolean };
  explain?: Para[]; tips?: Record<string, Para>; pass?: PassRule;
}
export interface Course { format: 1; sources: Record<string, Source>; lessons: LessonDef[] }
export const COURSE = course as unknown as Course;
export const lessonById = (id: string): LessonDef | undefined => COURSE.lessons.find(l => l.id === id && !l.soon);

/** A lesson ready to drive: its scene, the bay, the route the coach teaches, par and the time for the efficiency star. */
export interface Lesson { def: LessonDef; scene: Scene; bay: string; route: Piece[]; par: number; limit: number }

/** The route from its stored pieces, driven out from the stored start. */
export function storedRoute(v: Vehicle, r: NonNullable<LessonDef['route']>): Piece[] {
  const out: Piece[] = [];
  let p: Pose = { x: r.start[0], z: r.start[1], th: r.start[2] };
  for (const [dir, lvl, len] of r.pieces) { const to = drive(v, p, lvl, dir * len); out.push({ dir: dir as 1 | -1, lvl, len, from: p, to }); p = to; }
  return out;
}

/** The lesson's scene (a template's first draft for its level and seed, or your garage) with the car at the route's start. */
export function loadLesson(v: Vehicle, def: LessonDef): Lesson {
  const route = storedRoute(v, def.route!), s = route[0].from, sc = def.scene!;
  if ('garage' in sc) return { def, scene: GARAGE_561, bay: sc.garage, route, par: moves(route), limit: timeLimit(route) };
  if ('build' in sc) {
    const B = lessonScene(v, sc.build, sc.level, sc.seed);
    B.spec.starts = { start: { x: s.x, z: s.z, th: s.th, label: def.learn } };
    B.spec.areaView = areaOf(v, makeScene(B.spec), route, B.bay);
    const scene = makeScene(B.spec);
    return { def, scene, bay: B.bay, route, par: moves(route), limit: timeLimit(route) };
  }
  const d = draft(v, sc.template, sc.level, sc.seed);
  d.spec.starts = { start: { x: s.x, z: s.z, th: s.th, label: def.learn } };
  d.spec.areaView = areaOf(v, makeScene(d.spec), route);
  const scene = makeScene(d.spec);
  return { def, scene, bay: scene.defaultBay, route, par: moves(route), limit: timeLimit(route) };
}

export interface PassLine { ok: boolean; text: string }
const cm = (m: number) => `${Math.round(Math.abs(m) * 100)} cm`;

/** Whether a parked result passes the lesson, one line per thing it needs. */
export function checkPass(r: ParkedResult, rule: PassRule, par: number): { pass: boolean; lines: PassLine[] } {
  const lines: PassLine[] = [{ ok: r.hits === 0, text: r.hits ? `${r.hits} touch${r.hits > 1 ? 'es' : ''}: a pass needs a clean run` : 'Nothing touched' }];
  if (rule.face) { const ok = rule.face === 'in' ? r.noseIn : !r.noseIn; lines.push({ ok, text: ok ? (rule.face === 'in' ? 'Nose in' : 'Reversed in') : `This lesson wants the car ${rule.face === 'in' ? 'nose in' : 'reversed in'}` }); }
  if (rule.angle !== undefined) lines.push({ ok: Math.abs(r.angle) <= rule.angle, text: `Straight: ${Math.abs(r.angle).toFixed(1)}° off (${rule.angle}° or less)` });
  if (rule.centre !== undefined) lines.push({ ok: Math.abs(r.offCentre) <= rule.centre, text: `Centred: ${cm(r.offCentre)} off (${cm(rule.centre)} or less)` });
  if (rule.kerb !== undefined) lines.push({ ok: r.kerbGap <= rule.kerb, text: `Tyres ${cm(r.kerbGap)} from the kerb (${cm(rule.kerb)} or less)` });
  if (rule.moves === 'par+1') lines.push({ ok: r.moves <= par + 1, text: `${r.moves} ${r.moves === 1 ? 'move' : 'moves'} (par ${par}, one more allowed)` });
  return { pass: lines.every(l => l.ok), lines };
}

/** What to change, from the first thing a parked result missed (when the route comparison has nothing to say). */
export function endHint(r: ParkedResult, rule: PassRule, par: number): string | null {
  if (r.hits) return 'Watch the red outline on the plan: it shows where the car would touch first.';
  if (rule.face && (rule.face === 'in') !== r.noseIn) return `This lesson wants the car ${rule.face === 'in' ? 'nose in' : 'reversed in'}.`;
  if (rule.kerb !== undefined && r.kerbGap > rule.kerb) return `Your tyres finished ${cm(r.kerbGap)} from the kerb: stay on the first lock a little longer before steering away.`;
  if (rule.centre !== undefined && Math.abs(r.offCentre) > rule.centre) return `The car finished ${cm(r.offCentre)} ${r.offCentre > 0 ? 'right' : 'left'} of centre: start the turn ${r.offCentre > 0 ? 'a little earlier' : 'a little later'}.`;
  if (rule.angle !== undefined && Math.abs(r.angle) > rule.angle) return `The car finished ${Math.abs(r.angle).toFixed(1)}° off straight: stop when it is straight in the bay.`;
  if (rule.moves === 'par+1' && r.moves > par + 1) return `${r.moves} moves: follow the marks to keep to ${par}.`;
  return null;
}

/** How much help a try gets: the full coach, cue marks only, help on request, none (the test). */
export type Help = 0 | 1 | 2 | 3;
export const HELP: readonly { name: string; what: string }[] = [
  { name: 'Guided', what: 'the coach shows each step, the route and the next mark, and brakes for you on each mark' },
  { name: 'Cue marks', what: 'only the marks where the steering or direction changes' },
  { name: 'Practice', what: 'no marks; Show me and the coach on request' },
  { name: 'Test', what: 'no help, and the stars count' },
];

/** Where you are in a lesson. */
export interface LessonState { help: Help; passes: number; fails: number; slow: boolean; done: boolean; best: number; focus: number }
export const freshState = (): LessonState => ({ help: 0, passes: 0, fails: 0, slow: false, done: false, best: -1, focus: 0 });
export type HelpChange = 'less' | 'more' | 'slow' | 'done' | null;

/**
 * After a try: two passes lower the help a level (a pass in the test finishes the lesson), two fails raise it
 * again and turn on slow motion. Counts start over whenever the level changes.
 */
export function afterTry(s: LessonState, pass: boolean): { state: LessonState; change: HelpChange } {
  const n = { ...s };
  if (pass) {
    if (n.help === 3) { n.done = true; n.passes = n.fails = 0; return { state: n, change: 'done' }; }
    if (++n.passes < 2) return { state: n, change: null };
    n.help = (n.help + 1) as Help; n.passes = n.fails = 0; n.slow = false;
    return { state: n, change: 'less' };
  }
  if (++n.fails < 2) return { state: n, change: null };
  n.passes = n.fails = 0; n.slow = true;
  if (n.help === 0) return { state: n, change: 'slow' };
  n.help = (n.help - 1) as Help;
  return { state: n, change: 'more' };
}
