// Street lessons: a drive through a district in traffic to a space, by a way the lesson sets (turn by turn at its
// junctions), and parking in it within the rules (core/rules.ts). The district, its traffic and the lesson's own cars (a
// parked car that pulls out, a spot thief) come from the lesson's numbers, so every try meets the same street. The coach
// says what is coming as you near each junction and the space; leave the way and it finds a new one to the same space.
// Pure logic with no screen code, like the rest of core/.
import { buildCity, parkStart, type CityMap, type Drive, type KerbSlot } from './city';
import { MAPS } from './content';
import type { Help, LessonDef, PassLine } from './lesson';
import { wrapPi } from './math';
import type { Fault, FaultKind } from './rules';
import type { ParkedResult } from './sim';
import { TYPES, exitFor, networkOf, poseOn, type Approach, type El, type Extras, type Network } from './traffic';
import type { Vehicle } from './vehicle';

export type TurnWord = 'left' | 'right' | 'straight';
/** The lesson file's street block: the district and its layout, cars per km of lane, the way (what to do at each
 *  junction in turn from the district's start), and the space at the end: one the district promises your car, or one a
 *  parked car leaves as you come (wakeD m behind it), with a spot thief following you (behind m back) who waits patience s. */
export interface StreetDef {
  map: string; seed: number; perKm: number; turns: TurnWord[];
  space: 'promised' | 'leaver'; wakeD?: number; thief?: { behind: number; patience: number };
  /** Where traffic keeps left the kerb you park at is the other one: the layout and way for that side, if they differ. */
  left?: { seed: number; turns: TurnWord[] };
}
/** The lesson's street block for the side traffic keeps to. */
export const streetFor = (sd: StreetDef, drive: Drive): StreetDef => (drive === 'left' && sd.left ? { ...sd, ...sd.left } : sd);
/** A junction on the way: where along the way its path begins and ends (m), the turn, how the junction is run for you
 *  (lights, a give-way line on your side, or nothing to stop for), its name, the street you turn into, the junction, your
 *  approach to it (with its line; null without lights or a line) and where along the way that line is. */
export interface NavStep { at: number; end: number; turn: TurnWord; control: 'lights' | 'giveway' | 'none'; name: string; into: string; j: number; ap: Approach | null; line: number }
export interface WayPt { x: number; z: number; s: number }
/** A street lesson ready to drive: the district for your car, its road network, the way (lanes and the paths through
 *  junctions, in order), the points along it every metre to where you stop beside the space, the junctions on it, the
 *  space, and the traffic's extras. */
export interface StreetLesson { def: LessonDef; map: CityMap; net: Network; way: number[]; pts: WayPt[]; nav: NavStep[]; slot: KerbSlot; extras: Extras; perKm: number; seed: number }

/** The faults that fail a street lesson (touching anything fails it too). */
export const STREET_FAULTS: readonly FaultKind[] = ['red', 'speed', 'crash', 'touch', 'giveway', 'signal', 'block', 'zone'];

/** What each help level means in a street lesson (the parking lessons' are in lesson.ts). */
export const STREET_HELP: readonly string[] = [
  'the blue line to the space, and the coach says what is coming at each junction and when to signal',
  'the blue line, and a word before each junction: the signals are up to you',
  'no line: Show me puts it on the plan',
  'no help, and the stars count',
];
export const turnOf = (e: El): TurnWord => (e.turn === 'straight' ? 'straight' : e.dh > 0 ? 'left' : 'right');
/** The indicator for a turn (-1 left, 1 right). */
export const indFor = (t: TurnWord): -1 | 0 | 1 => (t === 'left' ? -1 : t === 'right' ? 1 : 0);

/** The lane or path you are on: the nearest whose way runs within 60° of your heading, within 4.5 m of you. */
export function elAt(net: Network, x: number, z: number, th: number, kinds: El['kind'][] = ['lane', 'path']): El | null {
  let best: El | null = null, bd = 4.5;
  for (const e of net.els) {
    if (!kinds.includes(e.kind)) continue;
    for (let s = 0; s <= e.len; s += 1) {
      const [px, pz, ph] = poseOn(e, s), d = Math.hypot(px - x, pz - z);
      if (d < bd && Math.abs(wrapPi(ph - th)) < Math.PI / 3) { bd = d; best = e; }
    }
  }
  return best;
}
/** How far along lane or path e the point is (m), by the nearest of its points every 0.5 m. */
function sOn(e: El, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let s = 0; s <= e.len + 1e-9; s += 0.5) { const [px, pz] = poseOn(e, Math.min(s, e.len)), d = Math.hypot(px - x, pz - z); if (d < bd) { bd = d; best = Math.min(s, e.len); } }
  return best;
}

/** The shortest way over the network from el to the lane `goal` (lanes and paths in order, both ends included), or null. */
export function wayTo(net: Network, from: number, goal: number): number[] | null {
  const E = net.els, dist = E.map(() => Infinity), prev = E.map(() => -1), done = E.map(() => false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < E.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) return null;
    if (u === goal) break;
    done[u] = true;
    for (const n of E[u].next) if (dist[u] + E[u].len < dist[n]) { dist[n] = dist[u] + E[u].len; prev[n] = u; }
  }
  const out: number[] = [];
  for (let u = goal; u >= 0; u = prev[u]) out.unshift(u);
  return out;
}

/** The points every metre along a way, from s0 on the first element to `stop` on the last (where you stop beside the
 *  space), and the junctions on it. */
export function trace(net: Network, way: readonly number[], s0: number, stop: number): { pts: WayPt[]; nav: NavStep[] } {
  const pts: WayPt[] = [], nav: NavStep[] = [];
  let acc = 0;
  way.forEach((id, i) => {
    const e = net.els[id], a = i === 0 ? s0 : 0, b = i === way.length - 1 ? stop : e.len;
    if (e.kind === 'path') {
      const J = net.junctions[e.j], ap = J.approaches.find(q => q.el === e.from) ?? null, from = net.els[e.from], [lx, lz, lh] = poseOn(from, from.len);
      const line = ap ? acc - ((lx - (ap.line[0][0] + ap.line[1][0]) / 2) * Math.cos(lh) - (lz - (ap.line[0][1] + ap.line[1][1]) / 2) * Math.sin(lh)) : acc;
      nav.push({ at: acc, end: acc + (b - a), turn: turnOf(e), control: J.control === 'lights' ? 'lights' : ap?.minor ? 'giveway' : 'none', name: J.name, into: net.els[e.next[0]].name, j: e.j, ap: J.control === 'lights' || ap?.minor ? ap : null, line });
    }
    for (let s = a; s < b; s += 1) { const [x, z] = poseOn(e, s); pts.push({ x, z, s: acc + (s - a) }); }
    acc += b - a;
  });
  const last = net.els[way[way.length - 1]], [x, z] = poseOn(last, stop);
  pts.push({ x, z, s: acc });
  return { pts, nav };
}

/** The lesson's district for your car (traffic keeps to `drive`), the way by its turns, and its space; null when the
 *  district has no such space for your car. */
export function loadStreetLesson(v: Vehicle, def: LessonDef, drive: Drive): StreetLesson | null {
  const sd = streetFor(def.street!, drive), spec = MAPS[sd.map], map = buildCity(spec, v, sd.seed, drive), net = networkOf(map);
  map.scene.net = net;
  const st = map.start, first = elAt(net, st.x, st.z, st.th, ['lane']);
  if (!first) throw new Error(`lesson ${def.id}: the start is on no lane`);
  const way = [first.id];
  for (const t of sd.turns) {
    const lane = net.els[way[way.length - 1]], p = lane.next.map(n => net.els[n]).find(e => turnOf(e) === t);
    if (!p) throw new Error(`lesson ${def.id}: no way ${t} at ${net.junctions[lane.j].name}`);
    way.push(p.id, p.next[0]);
  }
  const last = net.els[way[way.length - 1]], s0 = sOn(first, st.x, st.z);
  // the space: on the last lane's kerb, ahead of where you come into it, stopped beside it short of the lane's end
  // (where you stop beside it, by your front bumper, as the way is followed)
  const along = (sl: KerbSlot) => {
    const p = parkStart(v, sl), fx = p.x + (v.L - v.OVR) * Math.cos(p.th), fz = p.z - (v.L - v.OVR) * Math.sin(p.th), s = sOn(last, fx, fz), [lx, lz] = poseOn(last, s);
    return { sl, s, ok: Math.hypot(lx - fx, lz - fz) < 3 };
  };
  const kerb = map.slots.filter((s): s is KerbSlot => s.kind === 'kerb' && s.street.id === last.street && s.side === last.side).map(along)
    .filter(c => c.ok && c.s > (way.length > 1 ? 18 : s0 + 30) && c.s < last.len - 1).sort((a, b) => a.s - b.s);
  const pick = sd.space === 'promised' ? (kerb.find(c => c.sl.guaranteed) ?? kerb[0])
    : [...kerb.filter(c => !c.sl.guaranteed), ...kerb.filter(c => c.sl.guaranteed)].find(c => TYPES.some((ty, t) => ty.share > 0 && exitFor(net, c.sl, t)));
  if (!pick) return null;
  const { pts, nav } = trace(net, way, s0, pick.s);
  const extras: Extras = {};
  if (sd.space === 'leaver') extras.leaveAt = { slot: pick.sl.id, wakeD: sd.wakeD ?? 25 };
  if (sd.thief) {   // on a lane that leads into the first, `behind` m back from where you start, coming your way
    const feed = net.els.filter(e => e.kind === 'path' && e.next[0] === first.id).sort((a, b) => Number(turnOf(b) === 'straight') - Number(turnOf(a) === 'straight'))[0];
    if (!feed) throw new Error(`lesson ${def.id}: no way into the start lane for the thief`);
    const lane = net.els[feed.from];
    extras.thiefAt = { el: lane.id, s: Math.max(5, lane.len - Math.max(5, sd.thief.behind - s0 - feed.len)), via: [feed.id, ...way] };   // following your way
    extras.patience = sd.thief.patience;
  }
  return { def, map, net, way, pts, nav, slot: pick.sl, extras, perKm: sd.perKm, seed: sd.seed };
}

/** What the coach says: a banner (tone '' plain, 'bad' a warning), or that it found a new way (pts and nav changed). */
export type StreetEvent = { type: 'say'; key: string; title: string; text: string; tone: '' | 'bad' | 'good'; ms: number } | { type: 'reroute' };
const say = (key: string, title: string, text: string, ms = 5000, tone: '' | 'bad' | 'good' = ''): StreetEvent => ({ type: 'say', key, title, text, tone, ms });

/** The way in words, for the lesson card and the test's one banner: "Left at the lights into Market Street, then …". */
export function wayWords(L: StreetLesson, kerb: 'left' | 'right'): string {
  const parts = L.nav.map(n => `${n.turn === 'straight' ? 'straight on' : n.turn} at ${n.control === 'lights' ? 'the lights' : n.control === 'giveway' ? 'the give-way line' : n.name}${n.turn === 'straight' ? '' : ` into ${n.into}`}`);
  const end = `park in the space on your ${kerb}`;
  if (!parts.length) return end[0].toUpperCase() + end.slice(1) + '.';
  return (parts.join(', then ') + `, then ${end}.`).replace(/^./, c => c.toUpperCase());
}

/**
 * The coach on the street. It follows how far along the way you are (by your front bumper), and as you near each
 * junction says what to do there: guided (help 0) early, with the signal and the line to stop at, and again if you have
 * not signalled 35 m before it; with cue marks (help 1) only which way, nearer. Then the space: where it is and how
 * Park mode takes over. Off the way by 8 m, it finds a new way from the lane you are on to the same space.
 */
export class StreetCoach {
  s = 0;               // how far along the way you are (m)
  private s0 = -1;     // where along it the try began: the coach waits until you have moved off (the lesson's banner first)
  k = 0;               // the next junction on it
  told = new Set<string>();
  pts: WayPt[]; nav: NavStep[];
  constructor(readonly L: StreetLesson, readonly help: Help, readonly kerb: 'left' | 'right') { this.pts = L.pts; this.nav = L.nav; }

  /** The way still ahead of you, for the plan. */
  ahead(): WayPt[] { return this.pts.filter(p => p.s >= this.s - 1); }

  observe(v: Vehicle, x: number, z: number, th: number, ind: number): StreetEvent[] {
    const out: StreetEvent[] = [], fx = x + (v.L - v.OVR) * Math.cos(th), fz = z - (v.L - v.OVR) * Math.sin(th);
    // where along the way: the nearest point a little behind to well ahead of the last, else anywhere
    const near = (lo: number, hi: number) => { let b: WayPt | null = null, bd = Infinity; for (const p of this.pts) { if (p.s < lo || p.s > hi) continue; const d = Math.hypot(p.x - fx, p.z - fz); if (d < bd) { bd = d; b = p; } } return { b, bd }; };
    let { b, bd } = near(this.s - 5, this.s + 30);
    if (bd > 8) ({ b, bd } = near(-Infinity, Infinity));
    if (bd > 8 || !b) {
      const e = elAt(this.L.net, fx, fz, th);
      const goal = this.L.way[this.L.way.length - 1], from = e && (e.kind === 'lane' ? e.id : e.next[0]);
      const way = from !== null && from !== undefined ? wayTo(this.L.net, from, goal) : null;
      if (e && way) {
        const end = this.pts[this.pts.length - 1], last = this.L.net.els[goal], stop = sOn(last, end.x, end.z);
        ({ pts: this.pts, nav: this.nav } = trace(this.L.net, way, e.kind === 'lane' ? sOn(e, fx, fz) : 0, stop));
        this.s = 0; this.k = 0;
        out.push({ type: 'reroute' });
        if (this.help <= 1) out.push(say('reroute', 'A new way', 'You left the way: the coach has found another way to the same space. Follow the line.', 4000));
      }
      return out;
    }
    this.s = Math.max(this.s, b.s);
    if (this.s0 < 0) this.s0 = this.s;
    if (this.s < this.s0 + 4) return out;
    while (this.k < this.nav.length && this.s > this.nav[this.k].end) this.k++;
    const n = this.nav[this.k];
    if (n) {
      const d = n.at - this.s, key = `j${this.k}:${n.at.toFixed(0)}`, want = indFor(n.turn), side = n.turn === 'left' ? 'left' : 'right';
      const where = n.control === 'lights' ? 'At the lights' : n.control === 'giveway' ? 'At the give-way line' : `At ${n.name}`;
      if (this.help === 0 && d < 90 && !this.told.has(key)) {
        this.told.add(key);
        const what = n.turn === 'straight' ? `${where}, go straight on.` : `${where}, turn ${n.turn} into ${n.into}. Mirrors, then signal ${side} now, well before the turn.`;
        const stop = n.control === 'lights' ? ' Stop at the white line if the light is red, or amber and you can stop in time.' : n.control === 'giveway' ? ` Wait at the broken line for a gap in the traffic on the main road.` : '';
        out.push(say(key, n.turn === 'straight' ? 'Straight on' : `Turn ${n.turn}`, what + stop, 6000));
      }
      if (this.help === 1 && d < 50 && !this.told.has(key)) { this.told.add(key); out.push(say(key, n.turn === 'straight' ? 'Straight on' : `Turn ${n.turn}`, `${n.turn === 'straight' ? 'Straight on' : `${n.turn[0].toUpperCase()}${n.turn.slice(1)}`} ${n.control === 'lights' ? 'at the lights' : n.control === 'giveway' ? 'at the give-way line' : `at ${n.name}`}${n.turn === 'straight' ? '' : ` into ${n.into}`}.`, 3500)); }
      if (this.help === 0 && want && d < 35 && d > 0 && ind !== want && !this.told.has(`${key}:sig`)) { this.told.add(`${key}:sig`); out.push(say(`${key}:sig`, `Signal ${side}`, `The ${side} indicator, now: the turn comes in ${Math.max(5, Math.round(d / 5) * 5)} m.`, 3500, 'bad')); }
    } else {
      const left = this.pts[this.pts.length - 1].s - this.s;
      if (this.help <= 1 && left < 70 && !this.told.has('space')) {
        this.told.add('space');
        out.push(say('space', 'Your space', this.help === 0
          ? `On your ${this.kerb}, about ${Math.max(10, Math.round(left / 10) * 10)} m ahead: the marked one. Signal ${this.kerb}, then stop beside it, level with the car in front of it, and Park mode takes over.`
          : `On your ${this.kerb}, about ${Math.max(10, Math.round(left / 10) * 10)} m ahead.`, 6000));
      }
    }
    return out;
  }
}

/** Whether a street lesson's try passes, one line per thing it needs: no faults on the way (each kind once, with what it
 *  was), parked in the lesson's space and nothing touched. How neatly is for lessons 6 and 7: here it is the traffic. */
export function checkStreetPass(r: ParkedResult | null, slot: string, faults: readonly Fault[]): { pass: boolean; lines: PassLine[] } {
  const lines: PassLine[] = [];
  const bad = faults.filter(f => STREET_FAULTS.includes(f.kind)), kinds = [...new Set(bad.map(f => f.kind))];
  lines.push(bad.length ? { ok: false, text: kinds.map(k => bad.find(f => f.kind === k)!.brief).join('; ') } : { ok: true, text: 'No faults on the way' });
  if (!r || r.bay !== slot) { lines.push({ ok: false, text: 'Not parked in the lesson\'s space' }); return { pass: false, lines }; }
  lines.push({ ok: true, text: 'Parked in the space' });
  lines.push({ ok: r.hits === 0, text: r.hits ? `${r.hits} touch${r.hits > 1 ? 'es' : ''}: a pass needs a clean run` : 'Nothing touched' });
  return { pass: lines.every(l => l.ok), lines };
}
