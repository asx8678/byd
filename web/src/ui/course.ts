// The course in the Play sheet: the ten lessons with where you are in each; the lesson card (what you learn, the
// handbooks' words with their sources, what passing takes); and the result card after a try in a lesson.
// Where you are in each lesson is kept in this browser (localStorage key `atto2-course`).
import { TOW_CAR, vehicleFor } from '../core/content';
import { COURSE, HELP, fillText, freshState, lessonFor, type Lesson, type LessonDef, type LessonState, type PassLine, type PassRule } from '../core/lesson';
import type { Vehicle } from '../core/vehicle';
import type { Stars } from '../core/score';
import type { ParkedResult } from '../core/sim';
import { $, openSheet } from './dom';
import { statsFor } from './levels';

interface Saved { lessons: Record<string, LessonState>; tab: 'course' | 'levels' }
const KEY = 'atto2-course';
const saved: Saved = { lessons: {}, tab: 'course' };
try { Object.assign(saved, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode or blocked storage */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* not saved */ } };

/** Where you are is kept per car: the Atto 2's under the lesson's own id (as before there were other cars), the others'
 *  with the car's id in front. A towing lesson brings its own car, so it has one place whatever car is chosen. */
let carKey = '';
export function setCourseCar(id: string): void { carKey = id === 'byd-atto2' ? '' : id + '|'; }
const keyOf = (id: string): string => (COURSE.lessons.find(l => l.id === id)?.tow ? id : carKey + id);
export const stateOf = (id: string): LessonState => ({ ...freshState(), ...saved.lessons[keyOf(id)] });
export function setState(id: string, s: LessonState): void { saved.lessons[keyOf(id)] = s; save(); }
/** Why a lesson is not for this car, in a few words (the course list) or a sentence (when it is asked for). */
export function notFor(def: LessonDef, v: Vehicle, long = false): string {
  const sc = def.scene;
  if (sc && 'garage' in sc) return long ? `The ${v.short} is ${(v.L + 1e-9).toFixed(2)} m long: it does not fit bay ${sc.garage}.` : `Too big for ${sc.garage}`;
  return long ? `In a space this tight the ${v.short} needs moves the coach cannot mark reliably, so this lesson is not for it.` : 'Too tight here';
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const starText = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

/** What passing takes, as one line. */
export function passText(rule: PassRule = {}): string {
  const need = ['nothing touched'];
  if (rule.face) need.push(rule.face === 'in' ? 'nose in' : 'reversed in');
  if (rule.angle !== undefined) need.push(`within ${rule.angle}° of straight`);
  if (rule.centre !== undefined) need.push(`centred within ${Math.round(rule.centre * 100)} cm`);
  if (rule.kerb !== undefined) need.push(`tyres within ${Math.round(rule.kerb * 100)} cm of the kerb`);
  if (rule.moves === 'par+1') need.push('no more than one move over par');
  return `To pass: ${need.join(', ')}.`;
}
/** Where you are in a lesson, in a few words. */
export function statusText(s: LessonState): string {
  if (s.done) return s.best >= 0 ? starText(s.best) : 'Done';
  return HELP[s.help].name;
}

export interface CourseHooks { open(id: string): void; tab(t: 'course' | 'levels'): void }
let hooks: CourseHooks;

/** The Play sheet's tabs and the course list for car v; `current` is the lesson being played, if any. */
export function renderCourse(current: string | null, v: Vehicle): void {
  const tab = saved.tab;
  $('tabCourse').hidden = tab !== 'course'; $('tabLevels').hidden = tab !== 'levels';
  document.querySelectorAll<HTMLElement>('#playTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('crsList').replaceChildren(...COURSE.lessons.flatMap(l => {
    const b = el('button', 'crsRow'), s = stateOf(l.id), started = !!saved.lessons[keyOf(l.id)], ok = lessonFor(v, l);
    b.type = 'button'; b.dataset.id = l.id; b.disabled = !!l.soon || !ok;
    const t = el('span', 'crsT'); t.append(el('b', '', l.title), el('small', '', l.learn));
    b.append(el('b', 'crsN', String(l.n)), t, el('em', s.done && ok ? 'crsS done' : 'crsS', l.soon ? 'Next update' : !ok ? notFor(l, v) : started ? statusText(s) : 'Start'));
    if (l.id === current) b.classList.add('cur');
    if (!l.chapter) return [b];
    const h = el('div', 'crsChapter'); h.append(el('b', '', l.chapter), el('small', '', l.tow ? `In the ${vehicleFor(TOW_CAR).name} with a box trailer, whichever car you have chosen` : ''));
    return [h, b];
  }));
}

export function bindCourse(h: CourseHooks): void {
  hooks = h;
  $('crsList').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]'); if (b && !b.disabled) hooks.open(b.dataset.id!); });
  $('playTabs').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-tab]'); if (!b) return;
    saved.tab = b.dataset.tab as Saved['tab']; save(); hooks.tab(saved.tab);
  });
}
/** Show the course tab next time the Play sheet is drawn. */
export function courseTab(): void { saved.tab = 'course'; save(); }

/** The lesson card: what you learn and why, with the sources, what passing takes, where you are, and how to start.
 *  The words are filled in for the car (v) and the lesson as loaded for it (L); note says how its route differs. */
export function showLesson(def: LessonDef, s: LessonState, go: { watch(): void; drive(): void; test(): void }, v: Vehicle, L: Lesson, note: string): void {
  $('lsTitle').textContent = `Lesson ${def.n} · ${def.title}`;
  $('lsLearn').textContent = def.learn;
  // sources numbered in the order this lesson first uses them
  const order: string[] = [], num = (id: string) => { if (!order.includes(id)) order.push(id); return order.indexOf(id) + 1; };
  $('lsBody').replaceChildren(...(def.explain ?? []).map(p => {
    const para = el('p', '', fillText(p.text, v, L));
    for (const id of p.sources ?? []) { const a = el('a', 'src', `[${num(id)}]`); a.href = COURSE.sources[id].url; a.target = '_blank'; a.rel = 'noopener'; para.append(' ', a); }
    return para;
  }), ...(note ? [el('p', 'lsCar', note)] : []));
  $('lsPass').textContent = passText(def.pass);
  const h = HELP[s.help];
  $('lsNow').textContent = s.done ? `Done, best ${starText(Math.max(0, s.best))}. Take the test again any time.`
    : `Now: ${h.name}, ${h.what}.` + (s.help < 3 ? ` ${s.passes} of 2 passes${s.slow ? ', in slow motion' : ''}.` : '');
  $('lsSources').replaceChildren(...order.map((id, i) => { const li = el('li'), a = el('a', '', COURSE.sources[id].name); a.href = COURSE.sources[id].url; a.target = '_blank'; a.rel = 'noopener'; li.append(`${i + 1}. `, a); return li; }));
  $('lsSourcesWrap').hidden = !order.length;
  $('lsWatch').onclick = () => go.watch();
  $('lsDrive').onclick = () => go.drive();
  $('lsDrive').textContent = s.help === 3 ? 'Take the test' : 'Drive';
  const t = $('lsTest'); t.hidden = s.help === 3; t.onclick = () => go.test();
  openSheet('sheetLesson');
}

export interface LessonResult {
  title: string; sub: string; pass: boolean; test: boolean; stars: Stars | null; better: boolean;
  lines: PassLine[]; feedback: string | null; change: string | null;
  retry(): void; watch(): void; course(): void; next: (() => void) | null;
}

/** The result card after a try in a lesson: pass or not (stars in the test), why, what to work on, what changes next. */
export function showLessonResult(r: ParkedResult | null, info: LessonResult): void {
  const stars = $('resStars');
  if (info.test && info.stars) {
    stars.replaceChildren(...[0, 1, 2].map(i => el('i', i < info.stars!.count ? 'on' : '', '★')));
    stars.setAttribute('aria-label', `${info.stars.count} of 3 stars`);
  } else {
    stars.replaceChildren(el('b', info.pass ? 'badge ok' : 'badge no', info.pass ? 'Pass' : 'Not yet'));
    stars.setAttribute('aria-label', info.pass ? 'Pass' : 'Not a pass yet');
  }
  $('resTitle').textContent = info.title + (info.better ? ' · new best' : '');
  $('resSub').textContent = info.sub;
  const items: HTMLElement[] = info.lines.map(l => { const li = el('li', l.ok ? 'lok' : 'lno'); li.append(el('i', '', l.ok ? '✓' : '✗'), el('span', '', l.text)); return li; });
  if (info.feedback) { const li = el('li', 'tip'); li.append(el('i', '', '→'), el('span', '', info.feedback)); items.push(li); }
  if (info.change) { const li = el('li', 'next'); li.append(el('i', '', '↑'), el('span', '', info.change)); items.push(li); }
  $('resList').replaceChildren(...items);
  const stats = r ? statsFor(r) : [];
  $('resStats').hidden = !stats.length;
  $('resStats').replaceChildren(...stats.map(([k, v]) => { const d = el('div'); d.append(el('span', '', k), el('b', '', v)); return d; }));
  const nb = $('resNew'), nx = $('resNext'), rt = $('resRetry');
  nb.hidden = false; nb.textContent = 'Watch'; nb.onclick = () => info.watch();
  rt.textContent = 'Try again'; rt.onclick = () => info.retry();
  nx.textContent = info.next ? 'Next lesson' : 'Course'; nx.onclick = () => (info.next ?? info.course)();
  nx.classList.toggle('primary', !!info.next); rt.classList.toggle('primary', !info.next);
  openSheet('sheetResult');
}
