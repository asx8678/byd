// Traffic on the street: a road network made from a district's map, and other cars driving it.
//
// The network: a lane each way along every street, between the junctions; at each junction a path from every lane in to
// every lane out but the way back (straight on, a turn on the kerb side, a turn across the oncoming lane), each a line,
// a quarter circle and a line. A junction with four arms, or a T-junction on a 50 km/h road, has traffic lights (one
// street green, then the other); at the other T-junctions the side road gives way; a corner of the ring has nothing to
// decide. Where two paths through a junction cross or merge they share a zone: the lights keep them apart, or one gives
// way (the side road; a turn across the oncoming lane), or the first one there goes.
//
// The cars: each keeps the middle of its rear axle on its lane's line (20 cm in from the middle of the lane, away from
// the parked cars), so in a turn its front swings wide as a real car's does. It takes a curve no faster than its driver
// likes to be pushed sideways, and keeps its distance with the Intelligent Driver Model, a standard model from traffic
// research: a wanted speed, a time gap to the car ahead, its own acceleration and braking. Drivers are calm, cautious or
// fast. A car stops for red, and for amber when it can stop easily enough for its driver; gives way by the time it needs
// to get across; does not drive into a junction it cannot leave; and keeps clear of your car: it stops behind you, leaves
// room when you signal to park, and waits at its line when you are in, or about to cross, its way through the junction.
//
// Everything steps with the simulation's fixed steps and draws random numbers only from its own seed, so the same
// district and seed give the same traffic, and a snapshot between steps brings it back exactly (replays, rewinds).
import { footprint } from './car';
import { sideDir, streetPt, type CityMap, type Drive, type Street } from './city';
import type { CarPart } from './collision';
import { circleHitsPoly, polysOverlap, ptSeg } from './geometry';
import { wrapPi, type Pt } from './math';
import type { Rect } from './scene';
import type { Vehicle } from './vehicle';
import { nearby } from './world';

/** A line (k = 0) or an arc of curvature k (+ turns left), starting s0 along its path at (x, z), heading h. */
export interface Piece { s0: number; len: number; x: number; z: number; h: number; k: number }
export type Turn = 'straight' | 'near' | 'far';
/** How two paths through a junction that share a zone take turns: the lights keep them apart, this one gives way, the
 *  other one does, or the first one there goes. a0-a1 is the zone along this path, b0-b1 along the other: where a car's
 *  rear axle is (before the path starts and after it ends too) while it could touch a car on the other path. */
export interface Conflict { el: number; rule: 'lights' | 'yield' | 'go' | 'first'; a0: number; a1: number; b0: number; b1: number }
/** A lane between two junctions, or a path through one. */
export interface El {
  id: number; kind: 'lane' | 'path'; pieces: Piece[]; len: number;
  limit: number;                 // km/h
  kmax: number;                  // its tightest curvature (0: straight)
  next: number[];                // a lane: the paths at its end; a path: the lane it leads into
  from: number;                  // a path: the lane it starts from (-1 for a lane)
  j: number;                     // the junction at a lane's end, or the one a path crosses
  axis: 'x' | 'z';               // the way the street a lane runs along runs (a path: the one it comes in along)
  street: string; side: 1 | -1;  // that street, and its side
  turn: Turn; dh: number;        // a path: how it turns (heading change, + left)
  conflicts: Conflict[];         // a path: the other paths through its junction it crosses or merges with
  siblings: { el: number; shared: number }[];   // a path: the others from the same lane, and how far along them cars on the two still overlap
  name: string;                  // the street's (a lane) or the junction's (a path)
}
export type Control = 'lights' | 'giveway' | 'none';
/** Where a lane meets a junction with lights or a give-way line: the line across its half of the street, where the light
 *  stands (on the pavement by the line's kerb end), and which way you face. */
export interface Approach { el: number; j: number; line: [Pt, Pt]; head: Pt; th: number; minor: boolean }
export interface Junction { id: string; name: string; rect: Rect; control: Control; arms: number; offset: number; minor: 'x' | 'z' | null; approaches: Approach[] }
/** ok[type][el]: whether that size of car fits the lane or path (tyres off the kerbs, body clear of the parked cars and
 *  lamp posts) and can carry on from it to somewhere it fits again. */
export interface Network { map: CityMap; drive: Drive; els: El[]; junctions: Junction[]; laneLen: number; ok: boolean[][] }

/** The lights: green, amber, then red both ways for a moment before the other street's green (s). */
export const GREEN = 18, AMBER = 3, ALL_RED = 2, CYCLE = 2 * (GREEN + AMBER + ALL_RED);
export type Light = 'green' | 'amber' | 'red';
/** The light for traffic coming along a street running `axis` at time t. */
export function lightAt(j: Junction, axis: 'x' | 'z', t: number): Light {
  let u = (t + j.offset) % CYCLE;
  if (u < 0) u += CYCLE;
  if (axis === 'z') u = (u + CYCLE / 2) % CYCLE;
  return u < GREEN ? 'green' : u < GREEN + AMBER ? 'amber' : 'red';
}

/** The pose (rear-axle middle and heading) s along a lane or path; before its start or past its end, straight on (the
 *  lanes either side are straight). */
export function poseOn(e: El, s: number): [number, number, number] {
  const P = e.pieces;
  if (s < 0) { const p = P[0]; return [p.x + s * Math.cos(p.h), p.z - s * Math.sin(p.h), p.h]; }
  let i = P.length - 1;
  while (i > 0 && P[i].s0 > s) i--;
  const p = P[i], u = s - p.s0;
  if (p.k === 0 || u > p.len) { const [x, z, h] = p.k === 0 ? [p.x, p.z, p.h] : endOf(p); const w = p.k === 0 ? u : u - p.len; return [x + w * Math.cos(h), z - w * Math.sin(h), h]; }
  const h = p.h + p.k * u;
  return [p.x + (Math.sin(h) - Math.sin(p.h)) / p.k, p.z + (Math.cos(h) - Math.cos(p.h)) / p.k, h];
}

const endOf = (p: Piece): [number, number, number] => { const h = p.h + p.k * p.len; return [p.x + (Math.sin(h) - Math.sin(p.h)) / p.k, p.z + (Math.cos(h) - Math.cos(p.h)) / p.k, h]; };

// cars keep 20 cm in from the middle of their lane. Where paths meet is found with the biggest car in traffic (a pickup,
// 15 cm round it) placed every 50 cm along each, from where its nose reaches the junction to where its tail leaves it:
// two paths share a zone where those boxes overlap (and 50 cm either side), measured by where the car's rear axle is.
const OFF = 0.2, WIDE = 2, SAMPLE = 0.25, ZONE = 0.5, BIG = { L: 6.22, W: 2.38, OVR: 1.39 };
const nets = new WeakMap<CityMap, Network>();
/** A district's road network, made once. */
export function networkOf(map: CityMap): Network {
  let n = nets.get(map);
  if (!n) nets.set(map, n = buildNetwork(map));
  return n;
}

function buildNetwork(map: CityMap): Network {
  const R = map.spec.corner ?? 6, drive = map.drive, els: El[] = [], junctions: Junction[] = [];
  const xs = map.streets.filter(s => s.along === 'x').sort((a, b) => a.c - b.c), zs = map.streets.filter(s => s.along === 'z').sort((a, b) => a.c - b.c);
  const byId = new Map<string, Street>(map.streets.map(s => [s.id, s]));
  // the junctions: every street along x crosses every street along z; how many arms each has decides who goes
  const jIndex = new Map<string, number>();
  for (const a of xs) for (const b of zs) {
    const rect: Rect = [b.c - b.side[-1].hw, b.c + b.side[1].hw, a.c - a.side[-1].hw, a.c + a.side[1].hw];
    const w = a.s0 < rect[0] - 0.5, e = a.s1 > rect[1] + 0.5, n = b.s0 < rect[2] - 0.5, s = b.s1 > rect[3] + 0.5, arms = +w + +e + +n + +s;
    const through = arms === 3 ? (w && e ? a : b) : null;   // a T: the street running on through it
    const control: Control = arms === 4 || (through && through.limit >= 50) ? 'lights' : arms === 3 ? 'giveway' : 'none';
    jIndex.set(`${a.id}|${b.id}`, junctions.length);
    junctions.push({ id: `${a.id}|${b.id}`, name: `${a.name} and ${b.name}`, rect, control, arms, offset: (junctions.length * 17) % CYCLE, minor: control === 'giveway' ? (through === a ? 'z' : 'x') : null, approaches: [] });
  }
  // the lanes: between the junctions, from where the kerb's curve ends at one to where it begins at the next (at a corner
  // of the ring, where the ring's outer kerb, which curves wider, begins to curve)
  const ringR = map.scene.city?.ring.r ?? R, startJ = new Map<number, number>();
  const mouth = (J: Junction, st: Street, side: 1 | -1): number => {
    if (J.arms !== 2) return R;
    // round a corner of the ring the outer lane takes a wider turn, so a long car's front clears the outer kerb
    const cross = st.along === 'x' ? J.rect[1] - J.rect[0] : J.rect[3] - J.rect[2], outer = st === xs[0] || st === zs[0] ? -1 : 1;
    return Math.max(R, ringR - cross) + (side === outer ? WIDE : 0);
  };
  for (const st of [...xs, ...zs]) for (const side of [1, -1] as const) {
    const dir = sideDir(st, side), t = side * (st.lane / 2 - OFF), h = st.side[side].th;
    const js = st.along === 'x' ? zs.map(b => jIndex.get(`${st.id}|${b.id}`)!) : xs.map(a => jIndex.get(`${a.id}|${st.id}`)!);
    const order = dir > 0 ? js : js.slice().reverse();
    const span = (J: Junction): [number, number] => (st.along === 'x' ? [J.rect[0], J.rect[1]] : [J.rect[2], J.rect[3]]);
    for (let k = 0; k + 1 < order.length; k++) {
      const A = junctions[order[k]], B = junctions[order[k + 1]];
      const s0 = dir > 0 ? span(A)[1] + mouth(A, st, side) : span(A)[0] - mouth(A, st, side), s1 = dir > 0 ? span(B)[0] - mouth(B, st, side) : span(B)[1] + mouth(B, st, side), len = (s1 - s0) * dir;
      if (len < 5) throw new Error(`${map.spec.id}: ${st.name} between ${A.name} and ${B.name} is too short for traffic`);
      const [x, z] = streetPt(st, s0, t);
      startJ.set(els.length, order[k]);
      els.push({ id: els.length, kind: 'lane', pieces: [{ s0: 0, len, x, z, h, k: 0 }], len, limit: st.limit, kmax: 0, next: [], from: -1, j: order[k + 1], axis: st.along, street: st.id, side, turn: 'straight', dh: 0, conflicts: [], siblings: [], name: st.name });
    }
  }
  const lanes = els.slice();
  // a turn on your kerb side goes round the block's corner on an arc as wide as the corner's kerb plus the further of the
  // two lanes from its kerb: no other arc keeps the inner wheels further from that kerb (the corner's radius plus the nearer
  // lane's distance from its kerb, less half the car). Where one street has a parking lane and the other none, the arc
  // that fits the nearer end would cut the corner, so that end moves back (the lane ends sooner, or the next starts later).
  const until = (a: El, b: El) => { const [ax, az, ah] = poseOn(a, a.len), [bx, bz, bh] = poseOn(b, 0), X: Pt = a.axis === 'x' ? [bx, az] : [ax, bz]; return { dIn: (X[0] - ax) * Math.cos(ah) - (X[1] - az) * Math.sin(ah), dOut: (bx - X[0]) * Math.cos(bh) - (bz - X[1]) * Math.sin(bh), dh: wrapPi(bh - ah) }; };
  const fromKerb = (l: El) => { const st = byId.get(l.street)!; return st.side[l.side].hw - (st.lane / 2 - OFF); }, round = (a: El, b: El) => R + Math.max(fromKerb(a), fromKerb(b));
  const endBack = new Map<number, number>(), startOn = new Map<number, number>();
  junctions.forEach((_, ji) => {
    for (const a of lanes) if (a.j === ji) for (const b of lanes) if (startJ.get(b.id) === ji && a.street !== b.street) {
      const { dIn, dOut, dh } = until(a, b), want = round(a, b);
      if ((dh < 0) !== (drive === 'right')) continue;   // across the oncoming lane: wide enough already
      if (dIn < want) endBack.set(a.id, Math.max(endBack.get(a.id) ?? 0, want - dIn));
      if (dOut < want) startOn.set(b.id, Math.max(startOn.get(b.id) ?? 0, want - dOut));
    }
  });
  for (const l of lanes) {
    const back = Math.min(endBack.get(l.id) ?? 0, 6), on = Math.min(startOn.get(l.id) ?? 0, 6), p = l.pieces[0];
    if (back + on > l.len - 15) throw new Error(`${map.spec.id}: ${l.name} is too short for its turns`);
    p.x += on * Math.cos(p.h); p.z -= on * Math.sin(p.h); l.len -= back + on; p.len = l.len;
  }
  junctions.forEach((J, ji) => {
    const ins = lanes.filter(l => l.j === ji), outs = lanes.filter(l => startJ.get(l.id) === ji), paths: El[] = [];
    for (const a of ins) for (const b of outs) {
      if (a.street === b.street && a.side !== b.side) continue;   // no U-turns
      const [ax, az, ah] = poseOn(a, a.len), [bx, bz, bh] = poseOn(b, 0), dh = wrapPi(bh - ah), pieces: Piece[] = [];
      let turn: Turn = 'straight', s = 0;
      const add = (len: number, x: number, z: number, h: number, k: number) => { if (len > 1e-6) { pieces.push({ s0: s, len, x, z, h, k }); s += len; } };
      if (a.street === b.street) add(Math.hypot(bx - ax, bz - az), ax, az, ah, 0);
      else {
        // a turn on your kerb side or across the oncoming lane: the biggest quarter circle that touches both lane lines
        // between the two ends, with a straight before or after it where one end is further out
        turn = (dh < 0) === (drive === 'right') ? 'near' : 'far';
        const X: Pt = a.axis === 'x' ? [bx, az] : [ax, bz];
        const dIn = (X[0] - ax) * Math.cos(ah) - (X[1] - az) * Math.sin(ah), dOut = (bx - X[0]) * Math.cos(bh) - (bz - X[1]) * Math.sin(bh);
        const rho = Math.min(dIn, dOut, turn === 'near' ? round(a, b) : Infinity);
        add(dIn - rho, ax, az, ah, 0);
        add(rho * Math.abs(dh), X[0] - rho * Math.cos(ah), X[1] + rho * Math.sin(ah), ah, Math.sign(dh) / rho);
        add(dOut - rho, X[0] + rho * Math.cos(bh), X[1] - rho * Math.sin(bh), bh, 0);
      }
      const e: El = { id: els.length, kind: 'path', pieces, len: s, limit: a.limit, kmax: Math.max(...pieces.map(p => Math.abs(p.k))), next: [b.id], from: a.id, j: ji, axis: a.axis, street: a.street, side: a.side, turn, dh, conflicts: [], siblings: [], name: J.name };
      els.push(e); paths.push(e); a.next.push(e.id);
    }
    // each lane's line set back, 25 cm at a time, until the biggest car waiting with its nose at it is clear of everything
    // the paths from the other lanes sweep (a turning car's front swings across the middle of a narrow street); its paths
    // then start with that much more straight
    const sweep = (q: El): Pt[][] => { const out: Pt[][] = []; for (let t = 0; t <= q.len + BIG.OVR + 1e-9; t += SAMPLE) { const [x, z, h] = poseOn(q, t); out.push(boxAt(BIG, x, z, h)); } return out; };
    const swept = paths.map(sweep);
    for (const a of ins) {
      let back = 0;
      for (; back < 8; back += SAMPLE) {
        const [x, z, h] = poseOn(a, a.len - back - (BIG.L - BIG.OVR)), wait = boxAt(BIG, x, z, h);
        if (!paths.some((q, i) => q.from !== a.id && swept[i].some(b => polysOverlap(wait, b)))) break;
      }
      if (back <= 0) continue;
      a.len -= back; a.pieces[0].len -= back;
      for (const q of paths) if (q.from === a.id) {
        const [x, z, h] = poseOn(a, a.len);
        for (const pc of q.pieces) pc.s0 += back;
        q.pieces.unshift({ s0: 0, len: back, x, z, h, k: 0 }); q.len += back;
      }
    }
    // where the paths come close: from the same lane they overlap at first (the car ahead on either is ahead); from
    // different lanes they share a zone, and the junction's rules say who goes
    const boxes = paths.map(p => { const out: { s: number; x: number; z: number; box: Pt[] }[] = []; for (let s = -(BIG.L - BIG.OVR); s <= p.len + BIG.OVR + 1e-9; s += ZONE) { const [x, z, h] = poseOn(p, s); out.push({ s, x, z, box: boxAt(BIG, x, z, h) }); } return out; });
    const reach = Math.hypot(BIG.L - BIG.OVR, BIG.W / 2) * 2;
    for (let i = 0; i < paths.length; i++) for (let k = i + 1; k < paths.length; k++) {
      const p = paths[i], q = paths[k], P = boxes[i], Q = boxes[k], same = p.from === q.from;
      if (same) {   // from the same lane: the one ahead is followed while they overlap side by side
        let shared = 0;
        for (let m = 0; m < Math.min(P.length, Q.length); m++) if (P[m].s >= 0 && polysOverlap(P[m].box, Q[m].box)) shared = P[m].s;
        p.siblings.push({ el: q.id, shared }); q.siblings.push({ el: p.id, shared });
      }
      // a long car's tail can still be in the way of the next one from its lane, going another way: past the line, the
      // first one in goes first
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const A of P) for (const B of Q) {
        if ((same && (A.s < 0 || B.s < 0)) || Math.abs(A.x - B.x) >= reach || Math.abs(A.z - B.z) >= reach || !polysOverlap(A.box, B.box)) continue;
        a0 = Math.min(a0, A.s); a1 = Math.max(a1, A.s); b0 = Math.min(b0, B.s); b1 = Math.max(b1, B.s);
      }
      if (a0 === Infinity) continue;
      // and what lies between two of the places looked at, but never before a nose is over the line: a car waiting at its
      // line is not in anyone's way
      const first = -(BIG.L - BIG.OVR);
      a0 = Math.max(first, a0 - ZONE); a1 += ZONE; b0 = Math.max(first, b0 - ZONE); b1 += ZONE;
      const rule = same ? 'first' : ruleOf(J, p, q);
      p.conflicts.push({ el: q.id, rule, a0, a1, b0, b1 });
      q.conflicts.push({ el: p.id, rule: rule === 'yield' ? 'go' : rule === 'go' ? 'yield' : rule, a0: b0, a1: b1, b0: a0, b1: a1 });
    }
    // the stop lines (lights) and give-way lines, across each lane's half of the street where it meets the junction
    if (J.control !== 'none') for (const a of ins) {
      const st = byId.get(a.street)!, [ex, ez, eh] = poseOn(a, a.len), at = st.along === 'x' ? ex : ez, hw = st.side[a.side].hw;
      J.approaches.push({ el: a.id, j: ji, line: [streetPt(st, at, 0), streetPt(st, at, a.side * hw)], head: streetPt(st, at, a.side * (hw + 0.7)), th: eh, minor: J.control === 'giveway' && a.axis === J.minor });
    }
  });
  return { map, drive, els, junctions, laneLen: lanes.reduce((m, l) => m + l.len, 0), ok: TYPES.map(ty => fitting(map, els, ty)) };
}

/** Where a size of car fits: driven along every lane and path, 50 cm at a time, it and its tyres (a little oversize) must stay off
 *  the kerbs and its body clear of everything else; then only what it can carry on from to more of the same (a long car
 *  that cannot take a tight corner of the ring stays off the lane leading to it). */
function fitting(map: CityMap, els: El[], ty: CarType): boolean[] {
  const obs = map.scene.obstacles, tr = ty.W - 0.26, big = { L: ty.L + 0.1, W: ty.W + 0.06, OVR: ty.OVR + 0.05 };
  const tyres: Pt[][] = [0, ty.WB].flatMap(ax => [-1, 1].map(sg => [[ax - 0.4, sg * tr / 2 - 0.14], [ax + 0.4, sg * tr / 2 - 0.14], [ax + 0.4, sg * tr / 2 + 0.14], [ax - 0.4, sg * tr / 2 + 0.14]] as Pt[]));
  const use = els.map(e => {
    for (let s = 0; s <= e.len + 1e-9; s += 2 * SAMPLE) {
      const [x, z, h] = poseOn(e, s), box = boxAt(big, x, z, h);
      for (const o of nearby(obs, x, z, ty.L + 1)) {
        if (o.cls === 'kerb') { if (o.kind === 'poly' && tyres.some(w => polysOverlap(footprint(x, z, h, w), o.pts))) return false; continue; }
        if (o.kind === 'poly' ? polysOverlap(box, o.pts) : circleHitsPoly(o.x, o.z, o.r, box)) return false;
      }
    }
    return true;
  });
  for (let changed = true; changed;) {
    changed = false;
    for (const e of els) if (use[e.id] && (e.kind === 'lane' ? !e.next.some(p => use[p]) : !use[e.next[0]])) { use[e.id] = false; changed = true; }
  }
  return use;
}

/** Who goes where two paths through junction J share a zone, as seen from p. */
function ruleOf(J: Junction, p: El, q: El): Conflict['rule'] {
  if (J.control === 'lights' && p.axis !== q.axis) return 'lights';
  const major = (e: El) => J.control !== 'giveway' || e.axis !== J.minor;
  if (major(p) !== major(q)) return major(p) ? 'go' : 'yield';
  if ((p.turn === 'far') !== (q.turn === 'far')) return p.turn === 'far' ? 'yield' : 'go';
  return 'first';
}

/** A car in traffic, by size: as common as the parked ones (generator/templates.ts), each with the wheelbase and rear
 *  overhang of a real car its size (Smart fortwo, Peugeot 208, BYD Atto 2, Škoda Octavia estate, Ram 1500; the
 *  saloon's are estimated). */
export interface CarType { name: string; L: number; W: number; WB: number; OVR: number; share: number }
export const TYPES: readonly CarType[] = [
  { name: 'city car', L: 2.70, W: 1.66, WB: 1.87, OVR: 0.40, share: 0.5 },
  { name: 'hatchback', L: 4.06, W: 1.75, WB: 2.54, OVR: 0.69, share: 5 },
  { name: 'crossover', L: 4.33, W: 1.83, WB: 2.62, OVR: 0.83, share: 5 },
  { name: 'estate', L: 4.69, W: 1.83, WB: 2.69, OVR: 1.09, share: 2 },
  { name: 'saloon', L: 5.00, W: 1.90, WB: 2.95, OVR: 1.10, share: 1.5 },
  { name: 'pickup', L: 5.92, W: 2.08, WB: 3.67, OVR: 1.24, share: 0.4 },
];
/** A driver: the speed wanted (a share of the limit), the time gap kept to the car ahead (s), acceleration and comfortable
 *  braking (m/s²), the gap left when stopped (m), how hard a curve may push them sideways (m/s²), the hardest they will
 *  brake to stop for amber rather than drive on (m/s²), and the time to spare they want when they give way (s). */
export interface Driver { name: string; share: number; v0: number; T: number; a: number; b: number; s0: number; lat: number; amber: number; gap: number }
export const DRIVERS: readonly Driver[] = [
  { name: 'calm', share: 6, v0: 1.0, T: 1.4, a: 1.4, b: 2.0, s0: 2.0, lat: 2.0, amber: 3.0, gap: 1.6 },
  { name: 'cautious', share: 2, v0: 0.7, T: 2.0, a: 1.0, b: 1.6, s0: 2.5, lat: 1.5, amber: 4.5, gap: 2.6 },
  { name: 'fast', share: 2, v0: 1.15, T: 0.8, a: 2.2, b: 2.6, s0: 1.5, lat: 2.6, amber: 1.8, gap: 1.0 },
];
/** Cars per kilometre of lane: light traffic and busy. */
export const DENSITY = { light: 12, busy: 24 } as const;

export interface TCar {
  id: number; type: number; drv: number;
  el: number; s: number; v: number; acc: number;   // where along which lane or path (its rear axle's middle), speed (m/s), acceleration
  route: number[];                                   // the lanes and paths after this one (three at least)
  ind: -1 | 0 | 1;                                   // indicating left (-1) or right
  wait: boolean;                                     // holding at its line: red, giving way, no room beyond
  commit: number;                                    // the junction it drives on through at amber (-1: none)
  inAt: number;                                      // when its front crossed into the junction it is in (the first in goes first)
  jams: number; moved: number;                       // times the last-resort check held it back, and metres driven (for the tests)
  x: number; z: number; h: number; box: Pt[];        // where it is, from its lane or path
}
export type CarSnap = Omit<TCar, 'x' | 'z' | 'h' | 'box'>;
export interface TrafficSnap { t: number; r: number; cars: CarSnap[] }
/** Your car as the traffic sees it: where it is, its speed (m/s, + forward), size, signals, and whether you are parking. */
export interface PlayerView { x: number; z: number; th: number; v: number; L: number; W: number; OVR: number; ind: -1 | 0 | 1; hazard: boolean; park: boolean }
interface Shape extends PlayerView { boxes: Pt[][]; bb: [number, number, number, number] }

const NEVER = 1e9;
/** The random numbers (mulberry32) with their state in the open, so a snapshot can carry it. */
function rand(st: { r: number }): number {
  const a = st.r = (st.r + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pickShare = (list: readonly { share: number }[], u: number): number => {
  let x = u * list.reduce((m, q) => m + q.share, 0);
  for (let i = 0; i < list.length; i++) { x -= list[i].share; if (x <= 0) return i; }
  return list.length - 1;
};
const boxAt = (ty: { L: number; W: number; OVR: number }, x: number, z: number, h: number): Pt[] => footprint(x, z, h, [[-ty.OVR, -ty.W / 2], [ty.L - ty.OVR, -ty.W / 2], [ty.L - ty.OVR, ty.W / 2], [-ty.OVR, ty.W / 2]]);
/** A shared zone a0-a1 (where the biggest car's rear axle is while it could touch a car on the other path) as it is for car
 *  c: a smaller car fits inside the big one's box placed anywhere from its own nose back to its own tail, so it can only
 *  touch anything while all those places are in the zone: from a0 plus the difference in noses to a1 less the difference
 *  in tails. */
function zoneFor(c: TCar, a0: number, a1: number): [number, number] {
  const ty = TYPES[c.type];
  return [a0 + (BIG.L - BIG.OVR) - (ty.L - ty.OVR), a1 - (BIG.OVR - ty.OVR)];
}
/** How long a car going v with acceleration a, up to speed cap, takes to cover d (a car above cap slows to it). */
function travel(v: number, a: number, cap: number, d: number): number {
  if (d <= 0) return 0;
  if (v >= cap) return d / Math.max(cap, 0.1);
  const d1 = (cap * cap - v * v) / (2 * a);
  return d <= d1 ? (Math.sqrt(v * v + 2 * a * d) - v) / a : (cap - v) / a + (d - d1) / cap;
}
function distTo(P: Pt[], x: number, z: number): number {
  let inside = false, m = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    m = Math.min(m, ptSeg(x, z, a[0], a[1], b[0], b[1]));
  }
  return inside ? 0 : m;
}

export class Traffic {
  t = 0;
  cars: TCar[] = [];
  private readonly rs = { r: 1 };
  private readonly on: TCar[][];   // who is on each lane and path, in order along it (made each step)

  constructor(readonly net: Network) { this.on = net.els.map(() => []); }

  /** Traffic for a district: perKm cars per kilometre of lane, placed and chosen from the seed, none within 35 m of `avoid`
   *  (where you start). */
  static spawn(net: Network, seed: number, perKm: number, avoid: { x: number; z: number } | null): Traffic {
    const T = new Traffic(net), lanes = net.els.filter(e => e.kind === 'lane'), n = Math.round(net.laneLen / 1000 * perKm);
    T.rs.r = Math.imul(seed, 2654435761) ^ 0x5bd1e995;
    for (let tries = 0; T.cars.length < n && tries < 40 * n; tries++) {
      let u = rand(T.rs) * net.laneLen, e = lanes[lanes.length - 1];
      for (const l of lanes) { if (u < l.len) { e = l; break; } u -= l.len; }
      const type = pickShare(TYPES, rand(T.rs)), drv = pickShare(DRIVERS, rand(T.rs)), ty = TYPES[type], room = e.len - ty.L - 16;
      const s = ty.OVR + 6 + rand(T.rs) * Math.max(0, room);
      if (room <= 0 || !net.ok[type][e.id] || T.cars.some(o => o.el === e.id && Math.abs(o.s - s) < (TYPES[o.type].L + ty.L) / 2 + 5)) continue;
      const [x, z, h] = poseOn(e, s);
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < 35) continue;
      const c: TCar = { id: T.cars.length, type, drv, el: e.id, s, v: 0.6 * DRIVERS[drv].v0 * e.limit / 3.6, acc: 0, route: [], ind: 0, wait: false, commit: -1, inAt: NEVER, jams: 0, moved: 0, x, z, h, box: boxAt(ty, x, z, h) };
      T.extend(c); T.signal(c); T.cars.push(c);
    }
    return T;
  }

  snapshot(): TrafficSnap {
    return { t: this.t, r: this.rs.r, cars: this.cars.map(({ x: _x, z: _z, h: _h, box: _b, route, ...c }) => ({ ...c, route: route.slice() })) };
  }
  restore(s: TrafficSnap): void {
    this.t = s.t; this.rs.r = s.r;
    this.cars = s.cars.map(c => { const [x, z, h] = poseOn(this.net.els[c.el], c.s); return { ...c, route: c.route.slice(), x, z, h, box: boxAt(TYPES[c.type], x, z, h) }; });
  }

  /** The light the lane `el` has at its junction now. */
  lightFor(ap: Approach): Light { return lightAt(this.net.junctions[ap.j], this.net.els[ap.el].axis, this.t); }

  /** Advance by dt: every car decides from where everyone is, then they all move. */
  step(dt: number, p: PlayerView | null): void {
    this.t += dt;
    for (const l of this.on) l.length = 0;
    for (const c of this.cars) this.on[c.el].push(c);
    for (const l of this.on) if (l.length > 1) l.sort((a, b) => a.s - b.s);
    const pv = p ? shapeOf(p) : null, plans = this.cars.map(c => this.decide(c, pv));
    this.cars.forEach((c, i) => { c.wait = plans[i].wait; c.commit = plans[i].commit; });
    for (let i = 0; i < this.cars.length; i++) this.move(this.cars[i], plans[i].a, dt, pv);
  }

  /** What your car (v at rear-axle pose x, z, th) would touch in traffic: a car's body, or with a door mirror (they are
   *  all taller than the mirrors). */
  touch(v: Vehicle, x: number, z: number, th: number): { name: string; part: CarPart } | null {
    let B: Pt[] | null = null, M: Pt[][] = [];
    for (const c of this.cars) {
      const ty = TYPES[c.type];
      if (Math.abs(c.x - x) > v.REACH + ty.L || Math.abs(c.z - z) > v.REACH + ty.L) continue;
      if (!B) { B = footprint(x, z, th, v.body); M = v.mirrors.map(m => footprint(x, z, th, m)); }
      const name = `${ty.name} in traffic`;
      if (polysOverlap(B, c.box)) return { name, part: '' };
      for (let k = 0; k < M.length; k++) if (polysOverlap(M[k], c.box)) return { name, part: k ? 'right mirror' : 'left mirror' };
    }
    return null;
  }

  /** How hard a car brakes or accelerates this step, whether it holds at its line, and the junction it now drives on
   *  through at amber. */
  private decide(c: TCar, pv: Shape | null): { a: number; wait: boolean; commit: number } {
    const E = this.net.els, el = E[c.el], ty = TYPES[c.type], d = DRIVERS[c.drv], v = c.v;
    const nose = ty.L - ty.OVR, front = c.s + nose, look = Math.max(40, v * 4 + 20);
    const want = (e: El) => d.v0 * e.limit / 3.6, curve = (e: El) => (e.kmax ? Math.sqrt(d.lat / e.kmax) : Infinity);
    const obs: [number, number, number][] = [];   // what is ahead: the gap from the front bumper, its speed, the gap to keep when stopped
    let commit = c.commit, wait = false;
    // the cars ahead along the route, and on paths setting off from the same lane (they overlap at first)
    let off = -c.s;
    for (let i = -1; i < c.route.length && off < look; i++) {
      const e = i < 0 ? el : E[c.route[i]];
      if (e.kind === 'path') for (const sb of e.siblings) for (const o of this.on[sb.el]) {
        if (o.s <= sb.shared + 1 && !(e === el && o.s <= c.s)) obs.push([off + o.s - TYPES[o.type].OVR - nose, o.v, d.s0]);
      }
      const o = this.on[e.id].find(q => q !== c && !(e === el && q.s <= c.s));
      if (o) { obs.push([off + o.s - TYPES[o.type].OVR - nose, o.v, d.s0]); break; }
      off += e.len;
    }
    // the speed wanted here; slowing in time for a curve or a lower limit ahead
    const v0 = Math.min(want(el), curve(el));
    let a = d.a * (1 - (v / Math.max(0.1, v0)) ** 4);
    off = el.len - c.s;
    for (const id of c.route) {
      if (off > look) break;
      const e = E[id], vt = Math.min(want(e), curve(e));
      if (v > vt) a = Math.min(a, (vt * vt - v * v) / (2 * Math.max(off, 0.5)));
      off += e.len;
    }
    // the junction ahead: the lights, room beyond it, someone to give way to; inside one, whoever got in first
    const toLine = el.kind === 'lane' ? el.len - front : -1;
    if (toLine >= 0 && toLine < look) {
      const J = this.net.junctions[el.j], p = E[c.route[0]];
      let hold = false;
      if (J.control === 'lights' && commit !== el.j) {
        const L = lightAt(J, el.axis, this.t);
        if (L === 'red') hold = true;
        else if (L === 'amber') { if (v * v / (2 * Math.max(0.5, toLine)) <= d.amber) hold = true; else commit = el.j; }
      }
      if (!hold) {
        // a turn across the oncoming lane at green waits for its gap in the junction (the end of the green lets it go),
        // unless someone is waiting there already or there is no room for it before the zone
        const b = this.blocker(c, p, c.s - el.len, false), green = J.control === 'lights' && lightAt(J, el.axis, this.t) === 'green';
        hold = !!b && (b.why !== 'gap' || !(green && p.turn === 'far' && !this.on[p.id].length && b.a0 > ty.OVR + 0.5));
      }
      if (hold) { obs.push([toLine, 0, 0.4]); wait = true; }
    } else if (el.kind === 'path' || toLine < 0) {
      // over the line: through the junction, stopping short of a zone someone else has
      const p = el.kind === 'path' ? el : E[c.route[0]], at = el.kind === 'path' ? c.s : c.s - el.len, b = this.blocker(c, p, at, true);
      if (b) { obs.push([b.a0 - at, 0, 0.3]); wait = b.why === 'gap'; }
    }
    // your car: in the way, or about to be
    if (pv) {
      const hit = this.corridor(c, pv, look);
      if (hit) {
        if (hit.ahead && toLine >= 0) { obs.push([toLine, 0, 0.4]); wait = true; }   // in the junction, or crossing its way: wait at the line
        else obs.push([hit.gap, hit.v, hit.room ? 7 : d.s0]);
      }
    }
    for (const [gap, vl, s0] of obs) {
      if (gap <= 0.05) { a = -9; continue; }
      const ss = s0 + Math.max(0, v * d.T + v * (v - vl) / (2 * Math.sqrt(d.a * d.b)));
      a = Math.min(a, d.a * (1 - (v / Math.max(0.1, v0)) ** 4 - (ss / gap) ** 2));
    }
    return { a: Math.max(-9, Math.min(a, d.a)), wait, commit };
  }

  /** The cars in the junction on path q: on it, about to be on it with their front over the line or too close to stop
 *  short of it, or just off it with their tail still in the junction; with where their rear axle is along q. */
  private committed(q: El): { c: TCar; s: number }[] {
    const out: { c: TCar; s: number }[] = [], lane = this.net.els[q.from];
    for (const o of this.on[q.id]) out.push({ c: o, s: o.s });
    for (const o of this.on[lane.id]) if (o.route[0] === q.id && (o.s + TYPES[o.type].L - TYPES[o.type].OVR >= lane.len || this.pastStopping(o, lane))) out.push({ c: o, s: o.s - lane.len });
    for (const o of this.on[q.next[0]]) { if (o.s > BIG.OVR + 1) break; out.push({ c: o, s: q.len + o.s }); }
    return out;
  }

  /** What stops car c going on along path p from `at` (where its rear axle is along p; < 0 before its line), and the zone
   *  to stop short of: no room beyond the junction ('room': at its line), someone in the junction who goes first
   *  ('busy'), or someone coming who goes first and would be there before c is across, with its driver's time to spare
   *  ('gap'). Who goes first: anyone in a zone; a car c gives way to; a car that got into the junction before c did (or
   *  that is in it while c is not), unless it gives way to c. A car held by the lights is not coming. */
  private blocker(c: TCar, p: El, at: number, inside: boolean): { why: 'room' | 'busy' | 'gap'; a0: number } | null {
    const E = this.net.els, ty = TYPES[c.type], d = DRIVERS[c.drv], J = this.net.junctions[p.j];
    if (!inside) {
      const out = this.on[p.next[0]][0];
      if (out && out.s - TYPES[out.type].OVR < ty.L + 1.5 && out.v < 2) return { why: 'room', a0: 0 };
    }
    const cap = Math.min(d.v0 * p.limit / 3.6, p.kmax ? Math.sqrt(d.lat / p.kmax) : Infinity);
    // once in the junction a car drives on through, stopping only for someone in its way; but a turn across the oncoming
    // lane at lights waits in the junction for its gap
    const gapsInside = J.control === 'lights' && p.turn === 'far';
    let best: { why: 'busy' | 'gap'; a0: number } | null = null;
    for (const cf of p.conflicts) {
      const [lo, hi] = zoneFor(c, cf.a0, cf.a1);
      if (lo > hi || at >= lo || (best && best.a0 <= lo)) continue;   // never in it, in it already, or stopping before an earlier one
      const q = E[cf.el], tClear = travel(c.v, d.a, cap, hi - at);
      const busy = this.committed(q).some(o => {
        const [olo, ohi] = zoneFor(o.c, cf.b0, cf.b1);
        if (o.c === c || olo > ohi || o.s > ohi) return false;
        if (o.s >= olo || cf.rule === 'yield') return true;   // in the zone, or it goes first
        if (cf.rule === 'go') return !inside && !o.c.wait && this.reach(o.c, olo - o.s) < tClear + 0.5;   // gives way to c, but is on its way in already
        return !inside || o.c.inAt < c.inAt || (o.c.inAt === c.inAt && o.c.id < c.id);   // the first one in goes first
      });
      if (busy) { best = { why: 'busy', a0: lo }; continue; }
      // someone coming, from another lane: the queue there in order, none sooner at its line than the car in front of it,
      // and none behind a car that is waiting
      if ((cf.rule !== 'yield' && cf.rule !== 'first') || q.from === p.from || (inside && !gapsInside) || (!inside && this.pastStopping(c, E[p.from]))) continue;
      const lane = E[q.from], tMe = this.reach(c, lo - at), queue = this.on[lane.id];
      const held = J.control === 'lights' ? lightAt(J, lane.axis, this.t) : 'green';
      if (held === 'red') continue;
      let ahead = 0;
      for (let k = queue.length - 1; k >= 0 && ahead < Infinity; k--) {
        const o = queue[k], oty = TYPES[o.type], toLine = lane.len - (o.s + oty.L - oty.OVR);
        if (toLine <= 0) continue;   // over its line already: committed, above
        if (toLine > 80) break;
        ahead = o.wait || (held === 'amber' && o.commit !== p.j) ? Infinity : Math.max(this.reach(o, toLine), ahead + 1);
        const [olo, ohi] = zoneFor(o, cf.b0, cf.b1);
        if (o.route[0] !== q.id || olo > ohi || ahead === Infinity) continue;
        const tO = Math.max(ahead, this.reach(o, lane.len - o.s + olo));
        if (cf.rule === 'first' && (tMe < tO || (tMe === tO && c.id < o.id))) continue;
        if (tO < tClear + d.gap) { best = { why: 'gap', a0: lo }; break; }
      }
    }
    return best;
  }
  /** Too close to its line, at its speed, to stop short of it comfortably: it will go on in (the others see it as in). */
  private pastStopping(o: TCar, lane: El): boolean {
    const toLine = lane.len - (o.s + TYPES[o.type].L - TYPES[o.type].OVR);
    return o.v * o.v / (2 * Math.max(0.1, toLine)) > DRIVERS[o.drv].b;
  }
  /** The soonest car o could be d further on. */
  private reach(o: TCar, d: number): number {
    const D = DRIVERS[o.drv];
    return travel(o.v, D.a, Math.max(o.v, D.v0 * this.net.els[o.el].limit / 3.6), d);
  }

  /** Your car on the way ahead of car c: the first place along its route, half a metre at a time, where your car (or where
   *  it will be in 0.7 s and 1.4 s) comes within its half width and 30 cm of its line. With the gap from its front bumper,
   *  your speed along its way, whether that is only where you are going (or inside the junction: it then waits at its
   *  line), and whether to leave room (you are slow and signalling to park, have your hazards on, or are parking). */
  private corridor(c: TCar, pv: Shape, look: number): { gap: number; v: number; ahead: boolean; room: boolean } | null {
    const E = this.net.els, ty = TYPES[c.type], nose = ty.L - ty.OVR, r = ty.W / 2 + 0.3;
    if (Math.abs(pv.x - c.x) > look + nose + 10 || Math.abs(pv.z - c.z) > look + nose + 10) return null;
    const [bx0, bx1, bz0, bz1] = pv.bb, line = E[c.el].kind === 'lane' ? E[c.el].len - c.s : -Infinity;
    let off = 0, e = E[c.el], s = c.s, k = -1;
    for (let u = 0; u <= nose + look; u += 0.5) {
      while (s + (u - off) > e.len && k + 1 < c.route.length) { off += e.len - s; s = 0; e = E[c.route[++k]]; }
      const [x, z, h] = poseOn(e, s + (u - off));
      if (x < bx0 - r || x > bx1 + r || z < bz0 - r || z > bz1 + r) continue;
      for (let b = 0; b < pv.boxes.length; b++) {
        // where you will be counts only when you are crossing its way (or coming at it), not following it
        if ((b > 0 && Math.abs(wrapPi(pv.th - h)) < 0.7) || distTo(pv.boxes[b], x, z) >= r) continue;
        const along = Math.max(0, pv.v * Math.cos(pv.th - h)), now = b === 0, kerb = this.net.drive === 'right' ? 1 : -1;
        return { gap: Math.max(0, u - nose), v: now ? along : 0, ahead: !now || u > line + 0.5, room: now && Math.abs(pv.v) < 1.5 && (pv.park || pv.hazard || pv.ind === kerb) };
      }
    }
    return null;
  }

  /** Move a car on by its acceleration, onto the next lane or path as it runs off the end of one: unless that would put it
   *  into your car or another (the last resort; the rules above should never let it come to that). */
  private move(c: TCar, a: number, dt: number, pv: Shape | null): void {
    const E = this.net.els, ty = TYPES[c.type];
    let v1 = c.v + a * dt, ds: number;
    if (v1 <= 0) { ds = a < 0 ? Math.min(c.v * dt, (c.v * c.v) / (-2 * a)) : 0; v1 = 0; } else ds = ((c.v + v1) / 2) * dt;
    if (ds > 0) {
      let el = c.el, s = c.s + ds, route = c.route;
      while (s > E[el].len && route.length) { s -= E[el].len; el = route[0]; route = route.slice(1); }
      const [x, z, h] = poseOn(E[el], s), box = boxAt(ty, x, z, h);
      if (this.overlaps(c, box, x, z, pv)) { c.v = 0; c.acc = 0; c.jams++; return; }
      if (el !== c.el && E[el].kind === 'lane') { c.commit = -1; c.inAt = NEVER; }
      c.el = el; c.s = s; c.route = route; c.x = x; c.z = z; c.h = h; c.box = box; c.moved += ds;
      if (c.inAt === NEVER && (E[el].kind === 'path' || s + ty.L - ty.OVR >= E[el].len)) c.inAt = this.t;
      this.extend(c);
    }
    c.v = v1; c.acc = a;
    this.signal(c);
  }
  private overlaps(c: TCar, box: Pt[], x: number, z: number, pv: Shape | null): boolean {
    if (pv && Math.abs(pv.x - x) < 12 && Math.abs(pv.z - z) < 12 && polysOverlap(box, pv.boxes[0])) return true;
    for (const o of this.cars) if (o !== c && Math.abs(o.x - x) < 8 && Math.abs(o.z - z) < 8 && polysOverlap(box, o.box)) return true;
    return false;
  }
  /** At least three lanes and paths ahead: at each junction, of the ways the car fits, straight on twice as often as each turn. */
  private extend(c: TCar): void {
    const E = this.net.els;
    while (c.route.length < 3) {
      const last = E[c.route.length ? c.route[c.route.length - 1] : c.el];
      if (last.kind === 'path') { c.route.push(last.next[0]); continue; }
      const fit = last.next.filter(id => this.net.ok[c.type][id]), ps = (fit.length ? fit : last.next).map(id => E[id]), w = ps.map(p => (p.turn === 'straight' ? 2 : 1));
      let u = rand(this.rs) * w.reduce((m, q) => m + q, 0), pick = ps[ps.length - 1].id;
      for (let i = 0; i < ps.length; i++) { u -= w[i]; if (u <= 0) { pick = ps[i].id; break; } }
      c.route.push(pick);
    }
  }
  /** Indicating for a turn from 40 m before it until it is done. */
  private signal(c: TCar): void {
    const E = this.net.els, el = E[c.el], p = el.kind === 'path' ? el : el.len - c.s < 40 ? E[c.route[0]] : null;
    c.ind = !p || p.turn === 'straight' ? 0 : p.dh > 0 ? -1 : 1;
  }
}

/** Your car's box now and where it will be in 0.7 s and 1.4 s if it keeps going as it is, and the box round all three. */
function shapeOf(p: PlayerView): Shape {
  const box = (dx: number, dz: number): Pt[] => footprint(p.x + dx, p.z + dz, p.th, [[-p.OVR, -p.W / 2], [p.L - p.OVR, -p.W / 2], [p.L - p.OVR, p.W / 2], [-p.OVR, p.W / 2]]);
  const boxes = [box(0, 0)];
  if (Math.abs(p.v) > 0.5) for (const t of [0.7, 1.4]) boxes.push(box(p.v * t * Math.cos(p.th), -p.v * t * Math.sin(p.th)));
  const all = boxes.flat();
  return { ...p, boxes, bb: [Math.min(...all.map(q => q[0])), Math.max(...all.map(q => q[0])), Math.min(...all.map(q => q[1])), Math.max(...all.map(q => q[1]))] };
}
