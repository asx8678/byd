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
// Some of the parked cars pull out: each sits at the back of a free space on the street. When you come up behind one (or
// when its time comes anyway) its indicator starts blinking; after three seconds, once neither you nor anyone else is in
// its way or coming too fast, it pulls out on an S-curve onto its lane's line and drives on, and the space is free.
// Couriers drive vans and now and then stop in their lane, hazards on, for 30 to 60 s. A driver held up by you, or by a
// car stopped in the lane, honks once its patience runs out (an impatient one sooner, and more often).
//
// Spot thieves cruise slowly, looking for a space. When you stop beside a space to park in it, or wait behind a parked car
// that is pulling out, the nearest thief (on hard levels the two nearest) within 250 m comes for it along the lanes and
// waits in the lane with its nose at the back of the space. Signal towards the kerb and start reversing into the space
// before its patience runs out (from when it got there and the space was free) and the space is yours; hesitate and it
// dives in nose first. You lose the space, not points.
//
// A car held up behind your car, or behind a courier stopped in the lane, pulls out round it once it has waited a moment,
// if it can get back in well before the junction and nobody coming the other way would get there first: it sweeps out
// to the other lane's line on a smooth curve, passes, and comes back. A car coming the other way stops for one that is
// out in its lane. Behind a stopped courier a car waits 7 m back, with room to pull out.
//
// Everything steps with the simulation's fixed steps and draws random numbers only from its own seed, so the same
// district and seed give the same traffic, and a snapshot between steps brings it back exactly (replays, rewinds).
import { footprint } from './car';
import { sideDir, streetPt, type CityMap, type Drive, type KerbSlot, type Street } from './city';
import type { CarPart } from './collision';
import { circleHitsPoly, polysOverlap } from './geometry';
import { wrapPi, type Pt } from './math';
import type { Obstacle, Rect } from './scene';
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
export function poseOn(e: { pieces: readonly Piece[] }, s: number): [number, number, number] {
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
  const use = els.map(e => sweepClear(map, e.pieces, e.len, ty, 2 * SAMPLE));
  for (let changed = true; changed;) {
    changed = false;
    for (const e of els) if (use[e.id] && (e.kind === 'lane' ? !e.next.some(p => use[p]) : !use[e.next[0]])) { use[e.id] = false; changed = true; }
  }
  return use;
}

/** Whether a size of car driven along these pieces keeps its body (a little oversize) clear of everything on the map and
 *  its tyres off the kerbs, looked at every `step` m (and its body where `inside` says it may be). */
function sweepClear(map: CityMap, pieces: readonly Piece[], len: number, ty: CarType, step = SAMPLE, inside?: (box: Pt[]) => boolean): boolean {
  const obs = map.scene.obstacles, tr = ty.W - 0.26, big = { L: ty.L + 0.1, W: ty.W + 0.06, OVR: ty.OVR + 0.05 };
  const tyres: Pt[][] = [0, ty.WB].flatMap(ax => [-1, 1].map(sg => [[ax - 0.4, sg * tr / 2 - 0.14], [ax + 0.4, sg * tr / 2 - 0.14], [ax + 0.4, sg * tr / 2 + 0.14], [ax - 0.4, sg * tr / 2 + 0.14]] as Pt[]));
  for (let s = 0; s <= len + 1e-9; s += step) {
    const [x, z, h] = poseOn({ pieces }, s), box = boxAt(big, x, z, h);
    if (inside && !inside(box)) return false;
    for (const o of nearby(obs, x, z, ty.L + 1)) {
      if (o.cls === 'kerb') { if (o.kind === 'poly' && tyres.some(w => polysOverlap(footprint(x, z, h, w), o.pts))) return false; continue; }
      if (o.kind === 'poly' ? polysOverlap(box, o.pts) : circleHitsPoly(o.x, o.z, o.r, box)) return false;
    }
  }
  return true;
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
 *  saloon's are estimated); and a van, which only couriers drive (a Ford Transit Custom's length, width and wheelbase, its
 *  overhang estimated). */
export interface CarType { name: string; L: number; W: number; WB: number; OVR: number; share: number }
export const TYPES: readonly CarType[] = [
  { name: 'city car', L: 2.70, W: 1.66, WB: 1.87, OVR: 0.40, share: 0.5 },
  { name: 'hatchback', L: 4.06, W: 1.75, WB: 2.54, OVR: 0.69, share: 5 },
  { name: 'crossover', L: 4.33, W: 1.83, WB: 2.62, OVR: 0.83, share: 5 },
  { name: 'estate', L: 4.69, W: 1.83, WB: 2.69, OVR: 1.09, share: 2 },
  { name: 'saloon', L: 5.00, W: 1.90, WB: 2.95, OVR: 1.10, share: 1.5 },
  { name: 'pickup', L: 5.92, W: 2.08, WB: 3.67, OVR: 1.24, share: 0.4 },
  { name: 'van', L: 4.97, W: 1.99, WB: 2.93, OVR: 1.09, share: 0 },
];
/** A driver: the speed wanted (a share of the limit), the time gap kept to the car ahead (s), acceleration and comfortable
 *  braking (m/s²), the gap left when stopped (m), how hard a curve may push them sideways (m/s²), the hardest they will
 *  brake to stop for amber rather than drive on (m/s²), the time to spare they want when they give way (s), and how long
 *  they wait behind you, or behind a car stopped in the lane, before they honk (s). Couriers and thieves come only with
 *  the Extras. */
export interface Driver { name: string; share: number; v0: number; T: number; a: number; b: number; s0: number; lat: number; amber: number; gap: number; patience: number }
export const DRIVERS: readonly Driver[] = [
  { name: 'calm', share: 6, v0: 1.0, T: 1.4, a: 1.4, b: 2.0, s0: 2.0, lat: 2.0, amber: 3.0, gap: 1.6, patience: 14 },
  { name: 'cautious', share: 2, v0: 0.7, T: 2.0, a: 1.0, b: 1.6, s0: 2.5, lat: 1.5, amber: 4.5, gap: 2.6, patience: 25 },
  { name: 'fast', share: 2, v0: 1.15, T: 0.8, a: 2.2, b: 2.6, s0: 1.5, lat: 2.6, amber: 1.8, gap: 1.0, patience: 6 },
  { name: 'courier', share: 0, v0: 0.95, T: 1.5, a: 1.4, b: 2.0, s0: 2.0, lat: 1.8, amber: 3.5, gap: 1.4, patience: 10 },
  { name: 'thief', share: 0, v0: 0.65, T: 1.2, a: 1.8, b: 2.4, s0: 1.8, lat: 2.2, amber: 2.5, gap: 1.2, patience: 5 },
];
const VAN = TYPES.findIndex(t => t.name === 'van'), COURIER = DRIVERS.findIndex(d => d.name === 'courier'), THIEF = DRIVERS.findIndex(d => d.name === 'thief');
/** The sizes a thief drives, and how often: small cars, that dive into a space easily. */
const THIEF_TYPES: readonly { t: number; share: number }[] = [{ t: 0, share: 2 }, { t: 1, share: 3 }, { t: 2, share: 1 }];
/** Cars per kilometre of lane: light traffic and busy. */
export const DENSITY = { light: 12, busy: 24 } as const;
/** The cars besides the traffic itself: parked ones that will pull out, couriers and spot thieves, and how long a thief
 *  waits for you to claim a space before it dives in (s; on easy levels 8, on hard ones 3). */
export interface Extras { leavers?: number; couriers?: number; thieves?: number; patience?: number }

/** Driving; parked at the kerb (el and s say where its rear axle is along its lane: one that will pull out, or a thief
 *  that has taken a space); pulling out of its space (el and s likewise, as it goes); diving into a space; stopped in its
 *  lane to deliver. */
export type CarState = 'drive' | 'parked' | 'out' | 'in' | 'stop';
export interface TCar {
  id: number; type: number; drv: number;
  el: number; s: number; v: number; acc: number;   // where along which lane or path (its rear axle's middle), speed (m/s), acceleration
  route: number[];                                   // the lanes and paths after this one (three at least)
  ind: -1 | 0 | 1;                                   // indicating left (-1) or right
  wait: boolean;                                     // holding at its line: red, giving way, no room beyond
  commit: number;                                    // the junction it drives on through at amber (-1: none)
  inAt: number;                                      // when its front crossed into the junction it is in (the first in goes first)
  jams: number; moved: number;                       // times the last-resort check held it back, and metres driven (for the tests)
  state: CarState;
  place: number; xs: number;                         // parked or pulling out: its place at the kerb (Traffic.places), how far along its way out
  until: number;                                     // parked: when it wakes anyway, then since when it has signalled; stopped: when it drives on
  wakeD: number;                                     // parked: it wakes as your car comes this close behind it (m; 0: only when its time comes)
  haz: boolean; honk: number; hold: number;          // its hazard lights, when it last honked, how long it has been held up (s)
  lineT: number;                                     // how long it has been waiting at its line (s): the longer, the smaller the gap it takes
  imp: boolean;                                      // an impatient driver: honks sooner, and more often
  stopS: number; nextStop: number;                   // a courier: where along its lane it is stopping (-1: nowhere yet), when it next delivers
  aim: string; aimT: number; seen: number;           // a thief: the space it is after (''), when its patience began to run (-1: not yet), what it saw you do (1: signal, 2: reverse)
  pass: number; passTo: number; passBy: number;      // passing: along its lane where it pulls out and where it is back in (-1: not passing), and whom (-2: you)
  x: number; z: number; h: number; box: Pt[];        // where it is, from its lane or path (or its way out of a space)
}
/** What a car that just drives has of the rest. */
const FRESH = { state: 'drive' as CarState, place: -1, xs: 0, until: 0, wakeD: 0, haz: false, honk: -1, hold: 0, lineT: 0, imp: false, stopS: -1, nextStop: 0, aim: '', aimT: -1, seen: 0, pass: -1, passTo: 0, passBy: -1 };
/** Passing: the length of the curve out to the other lane and back (m), and the speed it passes at, at most (m/s). */
const SWERVE = 10, PASS_V = 9;
type Later = keyof typeof FRESH;
export type CarSnap = Omit<TCar, 'x' | 'z' | 'h' | 'box' | Later> & Partial<Pick<TCar, Later>>;
/** The traffic between two steps: its clock, its two streams of random numbers (the traffic's own, and the one for
 *  everything that came after it), how many of the cars are the traffic itself, the ways between the lanes and the kerb,
 *  the thieves' patience (and whether two come), and the spaces thieves have come for. */
export interface TrafficSnap {
  t: number; r: number; x?: number; base?: number; places?: { slot: string; type: number; kind?: 'out' | 'in' }[];
  patience?: number; pair?: boolean; called?: string[]; cars: CarSnap[];
}
/** What a car does this step: how hard it brakes or accelerates, whether it holds at its line, the junction it drives on
 *  through at amber, and what holds it up if anything does: you, or a car stopped in the lane. */
interface Plan { a: number; wait: boolean; commit: number; by: '' | 'you' | 'stop' }
const STILL: Plan = { a: 0, wait: true, commit: -1, by: '' };
/** Your car as the traffic sees it: where it is, its speed (m/s, + forward), size, signals, whether you are parking, and
 *  the space you are parking in (its id: '' for none). */
export interface PlayerView { x: number; z: number; th: number; v: number; L: number; W: number; OVR: number; ind: -1 | 0 | 1; hazard: boolean; park: boolean; bay?: string }
interface Shape extends PlayerView { boxes: Pt[][]; bb: [number, number, number, number] }

const NEVER = 1e9;
/** How far away by the lanes a thief may be to come for the space you are after (m). */
const CALL = 250;
/** The random numbers (mulberry32) with their state in the open, so a snapshot can carry it. */
function rand(st: { r: number }): number {
  const a = st.r = (st.r + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pickShare = (list: readonly { share: number }[], u: number): number => {
  let x = u * list.reduce((m, q) => m + q.share, 0), last = 0;
  for (let i = 0; i < list.length; i++) { if (!list[i].share) continue; last = i; x -= list[i].share; if (x <= 0) return i; }
  return last;   // never one with no share
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

/** A way between a lane and a place at the kerb: out of a free space for a parked car that pulls out (from its place at
 *  the back of the space onto the lane's line), or into one, nose first, for a thief (from the lane to near the front of
 *  the space). Each is an S-curve: an arc, a straight, an arc. */
export interface Kerbside {
  kind: 'out' | 'in'; slot: string; type: number;
  el: number;                               // the lane
  s0: number; joinS: number;                // where along the lane its rear axle is at the start (out: parked; in: still in the lane) and at the end (out: on the lane's line; in: parked)
  pieces: Piece[]; len: number;
  side: -1 | 1;                             // the indicator a car pulling out shows: away from the kerb (a thief shows none)
  sweep: Pt[][];                            // its box (5 cm to spare) every 50 cm along the way
  x0: number; z0: number; ux: number; uz: number;   // where its rear axle is at the start, and the way the lane runs
}
const ways = new WeakMap<Network, Map<string, Kerbside | null>>();
const cached = (net: Network, key: string, make: () => Kerbside | null): Kerbside | null => {
  let m = ways.get(net);
  if (!m) ways.set(net, m = new Map());
  if (!m.has(key)) m.set(key, make());
  return m.get(key)!;
};
/** The way out of a free space for a parked car of a given size, worked out once: the shortest S-curve (its first arc
 *  from a 4.5 m radius, more for the long cars; the second as gentle as it needs to be) that keeps its body and tyres clear
 *  of the car ahead, the kerb and everything else, keeps it on its own side of the centre line (10 cm to spare: the nose
 *  swings out as it turns back) and joins its lane at least 10 m before the lane ends. Null if there is none, if the
 *  parked car would be in the way of the traffic or less than 12 m into its lane (a car coming off the junction behind
 *  could not stop for it), or if its size does not fit the lane. */
export const exitFor = (net: Network, sl: KerbSlot, type: number): Kerbside | null => cached(net, `out:${sl.id}:${type}`, () => makeExit(net, sl, type));
/** A thief's way into a free space, nose first, worked out once: from the lane, its nose no more than 50 cm past the back
 *  of the space (where it waits), the shortest S-curve (an arc towards the kerb from a 4.5 m radius, a straight, an arc
 *  back) that ends with its front 50 to 80 cm short of the car in front, 25 to 40 cm out from the kerb and up to 6° nose
 *  in (in a hurry), its body and tyres clear of everything. Null if there is none for that size, or the car would be in
 *  the traffic's way parked there. */
export const diveFor = (net: Network, sl: KerbSlot, type: number): Kerbside | null => cached(net, `in:${sl.id}:${type}`, () => makeDive(net, sl, type));

/** The lane a space on the street lies along. */
function laneOf(net: Network, sl: KerbSlot): El | null {
  const st = sl.street, dir = sideDir(st, sl.side);
  return net.els.find(e => {
    if (e.kind !== 'lane' || e.street !== st.id || e.side !== sl.side) return false;
    const p = e.pieces[0], a = st.along === 'x' ? p.x : p.z, b = a + dir * e.len;
    return Math.min(a, b) <= sl.a0 && Math.max(a, b) >= sl.a1;
  }) ?? null;
}
/** Pieces from a pose, each a length and a curvature. */
function sCurve(x: number, z: number, h: number, parts: [number, number][]): { pieces: Piece[]; len: number } {
  const pieces: Piece[] = [];
  let s = 0;
  for (const [len, k] of parts) {
    if (len < 1e-6) continue;
    const pc: Piece = { s0: s, len, x, z, h, k };
    pieces.push(pc); [x, z, h] = poseOn({ pieces: [pc] }, s + len); s += len;
  }
  return { pieces, len: s };
}
/** A size of car's box (5 cm to spare) every 50 cm along pieces, and at their end. */
function sweepOf(pieces: Piece[], len: number, ty: CarType): Pt[][] {
  const big = { L: ty.L + 0.1, W: ty.W + 0.1, OVR: ty.OVR + 0.05 }, out: Pt[][] = [];
  for (let u = 0; u < len + 0.5; u += 0.5) { const [x, z, h] = poseOn({ pieces }, Math.min(u, len)); out.push(boxAt(big, x, z, h)); }
  return out;
}
function makeExit(net: Network, sl: KerbSlot, type: number): Kerbside | null {
  const ty = TYPES[type], st = sl.street, sd = st.side[sl.side], dir = sideDir(st, sl.side), side = sl.side, lane = laneOf(net, sl);
  if (sl.length < 0.3 + ty.L + 1.2 || !lane || !net.ok[type][lane.id]) return null;
  const rear = dir > 0 ? sl.a0 : sl.a1, [x0, z0] = streetPt(st, rear + dir * (0.3 + ty.OVR), side * (sd.hw - 0.2 - ty.W / 2)), h = sd.th;
  const ux = Math.cos(h), uz = -Math.sin(h), lp = lane.pieces[0], s0 = (x0 - lp.x) * ux + (z0 - lp.z) * uz;
  const D = sd.hw - 0.2 - ty.W / 2 - (st.lane / 2 - OFF), k1 = net.drive === 'right' ? 1 : -1;   // away from the kerb: left, keeping right
  if (s0 < 12 || !clearOfTraffic(net, boxAt(ty, x0, z0, h))) return null;   // a car coming into the lane can stop behind it
  const across = (p: Pt) => side * ((st.along === 'x' ? p[1] : p[0]) - st.c), R0 = ty.L > 5.5 ? 6 : ty.L > 4.8 ? 5 : 4.5;
  let best: { pieces: Piece[]; len: number; X: number } | null = null;
  for (let R1 = R0; R1 <= R0 + 2 + 1e-9; R1 += 0.5) for (const R2 of [R1, 6, 8, 10, 12, 15, 18, 22, 27]) for (let deg = 50; deg >= 10; deg -= 4) {
    const p = deg * Math.PI / 180, dl = (D - (R1 + R2) * (1 - Math.cos(p))) / Math.sin(p), X = (R1 + R2) * Math.sin(p) + dl * Math.cos(p);
    if (R2 < R1 || dl < 0 || s0 + X > lane.len - 10 || (best && X >= best.X)) continue;
    const c = sCurve(x0, z0, h, [[R1 * p, k1 / R1], [dl, 0], [R2 * p, -k1 / R2]]);
    if (sweepClear(net.map, c.pieces, c.len, ty, SAMPLE, b => b.every(q => across(q) >= 0.1))) best = { ...c, X };
  }
  if (!best) return null;
  return { kind: 'out', slot: sl.id, type, el: lane.id, s0, joinS: s0 + best.X, pieces: best.pieces, len: best.len, side: k1 > 0 ? -1 : 1, sweep: sweepOf(best.pieces, best.len, ty), x0, z0, ux, uz };
}
function makeDive(net: Network, sl: KerbSlot, type: number): Kerbside | null {
  const ty = TYPES[type], st = sl.street, sd = st.side[sl.side], dir = sideDir(st, sl.side), side = sl.side, lane = laneOf(net, sl);
  if (sl.length < ty.L + 1 || !lane || !net.ok[type][lane.id]) return null;
  const h = sd.th, ux = Math.cos(h), uz = -Math.sin(h), lp = lane.pieces[0], k1 = net.drive === 'right' ? -1 : 1;   // towards the kerb: right, keeping right
  const front = dir > 0 ? sl.a1 : sl.a0, back = dir > 0 ? sl.a0 : sl.a1, tLane = st.lane / 2 - OFF, nose = ty.L - ty.OVR;
  let best: { pieces: Piece[]; len: number; X: number; s0: number; x0: number; z0: number } | null = null;
  for (const psi of [0, 3, 6]) for (const gF of [0.5, 0.8]) for (const gK of [0.25, 0.4]) {
    // the end: the front bumper's middle gF short of the space's front, the kerb-side front corner gK from the kerb
    const ps = psi * Math.PI / 180, aE = front - dir * (gF + nose * Math.cos(ps)), D = sd.hw - gK - (ty.W / 2) * Math.cos(ps) - nose * Math.sin(ps) - tLane;
    for (let R1 = 4.5; R1 <= 9 + 1e-9; R1 += 0.5) for (const R2 of [R1, 6, 8, 10]) for (let deg = 50; deg >= 12; deg -= 4) {
      const p = deg * Math.PI / 180;
      if (p <= ps + 0.05) continue;
      const dl = (D - R1 * (1 - Math.cos(p)) - R2 * (Math.cos(ps) - Math.cos(p))) / Math.sin(p), X = R1 * Math.sin(p) + dl * Math.cos(p) + R2 * (Math.sin(p) - Math.sin(ps));
      if (dl < 0 || (best && X >= best.X)) continue;
      const aS = aE - dir * X, [x0, z0] = streetPt(st, aS, side * tLane), s0 = (x0 - lp.x) * ux + (z0 - lp.z) * uz;
      if (s0 < 1 || (aS - back) * dir + nose > 0.5) continue;
      const c = sCurve(x0, z0, h, [[R1 * p, k1 / R1], [dl, 0], [R2 * (p - ps), -k1 / R2]]);
      if (sweepClear(net.map, c.pieces, c.len, ty)) best = { ...c, X, s0, x0, z0 };
    }
  }
  if (!best) return null;
  const [ex, ez, eh] = poseOn({ pieces: best.pieces }, best.len);
  if (!clearOfTraffic(net, boxAt(ty, ex, ez, eh))) return null;
  return { kind: 'in', slot: sl.id, type, el: lane.id, s0: best.s0, joinS: best.s0 + best.X, pieces: best.pieces, len: best.len, side: k1 > 0 ? -1 : 1, sweep: sweepOf(best.pieces, best.len, ty), x0: best.x0, z0: best.z0, ux, uz };
}
/** Whether a parked car's box is clear, with 15 cm to spare, of every size of car on every lane and path it fits. */
function clearOfTraffic(net: Network, box: Pt[]): boolean {
  const xs = box.map(p => p[0]), zs = box.map(p => p[1]), bx0 = Math.min(...xs) - 7, bx1 = Math.max(...xs) + 7, bz0 = Math.min(...zs) - 7, bz1 = Math.max(...zs) + 7;
  for (const e of net.els) {
    const ends = e.pieces.flatMap(p => [[p.x, p.z], poseOn({ pieces: [p] }, p.s0 + p.len)]);
    if (ends.every(q => q[0] < bx0) || ends.every(q => q[0] > bx1) || ends.every(q => q[1] < bz0) || ends.every(q => q[1] > bz1)) continue;
    for (let t = 0; t < TYPES.length; t++) {
      if (!net.ok[t][e.id]) continue;
      const ty = TYPES[t], big = { L: ty.L + 0.3, W: ty.W + 0.3, OVR: ty.OVR + 0.15 };
      for (let s = 0; s <= e.len + 1e-9; s += 2 * SAMPLE) {
        const [x, z, h] = poseOn(e, s);
        if (x > bx0 && x < bx1 && z > bz0 && z < bz1 && polysOverlap(boxAt(big, x, z, h), box)) return false;
      }
    }
  }
  return true;
}

export class Traffic {
  t = 0;
  cars: TCar[] = [];
  /** The ways between the lanes and the kerb that cars are on or parked at the end of (TCar.place). */
  places: Kerbside[] = [];
  /** The cars your car held up in the last step (their ids): waiting behind it while it was not waiting itself. */
  held: number[] = [];
  private base = 0;                  // how many of the cars are the traffic itself (the rest came after, with numbers of their own)
  private readonly rs = { r: 1 };
  private readonly rx = { r: 1 };    // the random numbers of everything that came after the traffic itself
  private readonly on: TCar[][];     // who is on each lane and path, in order along it (made each step)
  private readonly into: number[][]; // the paths leading into each lane
  private blame = false;             // this step: whether whoever waits behind your car is held up by you
  /** How long a thief waits for you to claim a space (s). */
  patience = 5;
  private pair = false;              // whether two thieves come for a space
  private called: string[] = [];     // the spaces thieves have come for (each only once)
  private readonly kerbSlots: Map<string, KerbSlot>;
  private readonly opp: number[];    // the lane the other way along the same stretch of street (-1: none)

  constructor(readonly net: Network) {
    this.on = net.els.map(() => []); this.into = net.els.map(() => []);
    for (const e of net.els) if (e.kind === 'path') this.into[e.next[0]].push(e.id);
    const lanes = net.els.filter(e => e.kind === 'lane');
    this.opp = net.els.map(e => (e.kind !== 'lane' ? -1 : lanes.find(o => o.street === e.street && o.side !== e.side && Math.abs(laneS(o, poseOn(e, e.len / 2).slice(0, 2) as Pt) - o.len / 2) < o.len / 2)?.id ?? -1));
    this.kerbSlots = new Map(net.map.slots.filter((s): s is KerbSlot => s.kind === 'kerb').map(s => [s.id, s]));
  }

  /** Traffic for a district: perKm cars per kilometre of lane, placed and chosen from the seed, none within 35 m of `avoid`
   *  (where you start); then, with random numbers of their own, the parked cars that will pull out and the couriers. */
  static spawn(net: Network, seed: number, perKm: number, avoid: { x: number; z: number } | null, more: Extras = {}): Traffic {
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
      const c: TCar = { id: T.cars.length, type, drv, el: e.id, s, v: 0.6 * DRIVERS[drv].v0 * e.limit / 3.6, acc: 0, route: [], ind: 0, wait: false, commit: -1, inAt: NEVER, jams: 0, moved: 0, ...FRESH, x, z, h, box: boxAt(ty, x, z, h) };
      T.extend(c, T.rs); T.signal(c); T.cars.push(c);
    }
    T.base = T.cars.length;
    T.rx.r = Math.imul(seed, 2246822519) ^ 0x27d4eb2f;
    for (const c of T.cars) c.imp = rand(T.rx) < 0.25;
    if (more.leavers) T.addLeavers(more.leavers);
    if (more.couriers) T.addCouriers(more.couriers, avoid);
    if (more.thieves) T.addThieves(more.thieves, avoid);
    T.patience = more.patience ?? 5; T.pair = (more.thieves ?? 0) > 1;
    return T;
  }
  /** n parked cars that will pull out, each at the back of a free space on the street that was not promised to your car
   *  (the spaces in an order of their own), its size as common as in traffic among those that can pull out of it. */
  private addLeavers(n: number): void {
    const net = this.net, order = net.map.slots.filter((s): s is KerbSlot => s.kind === 'kerb' && !s.guaranteed).map(s => ({ s, u: rand(this.rx) })).sort((a, b) => a.u - b.u);
    const sizes = TYPES.map((_, t) => t).filter(t => TYPES[t].share > 0).sort((a, b) => TYPES[b].share - TYPES[a].share);
    for (const { s: sl } of order) {
      if (this.places.length >= n) break;
      const want = pickShare(TYPES, rand(this.rx)), t = [want, ...sizes.filter(q => q !== want)].find(q => exitFor(net, sl, q));
      if (t === undefined) continue;
      const ex = exitFor(net, sl, t)!, ty = TYPES[t], [x, z, h] = poseOn(ex, 0), box = boxAt(ty, x, z, h);
      if (this.cars.some(o => Math.abs(o.x - x) < 12 && Math.abs(o.z - z) < 12 && polysOverlap(o.box, box))) continue;
      const drv = pickShare(DRIVERS, rand(this.rx)), until = 90 + 600 * rand(this.rx), wakeD = rand(this.rx) < 0.75 ? 15 + 30 * rand(this.rx) : 0;
      const c: TCar = { id: this.cars.length, type: t, drv, el: ex.el, s: ex.s0, v: 0, acc: 0, route: [], ind: 0, wait: false, commit: -1, inAt: NEVER, jams: 0, moved: 0,
        ...FRESH, state: 'parked', place: this.places.length, until, wakeD, imp: rand(this.rx) < 0.25, x, z, h, box };
      this.places.push(ex); this.extend(c); this.cars.push(c);
    }
  }
  /** n couriers in vans, placed like the traffic: they drive like anyone else until a delivery is due. */
  private addCouriers(n: number, avoid: { x: number; z: number } | null): void {
    const net = this.net, ty = TYPES[VAN], lanes = net.els.filter(e => e.kind === 'lane' && net.ok[VAN][e.id] && e.len > ty.L + 20);
    for (let k = 0, tries = 0; k < n && lanes.length && tries < 50 * n; tries++) {
      const e = lanes[Math.floor(rand(this.rx) * lanes.length)], s = ty.OVR + 6 + rand(this.rx) * (e.len - ty.L - 16);
      if (this.cars.some(o => o.state !== 'parked' && o.el === e.id && Math.abs(o.s - s) < (TYPES[o.type].L + ty.L) / 2 + 5)) continue;
      const [x, z, h] = poseOn(e, s);
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < 35) continue;
      const c: TCar = { id: this.cars.length, type: VAN, drv: COURIER, el: e.id, s, v: 0.6 * DRIVERS[COURIER].v0 * e.limit / 3.6, acc: 0, route: [], ind: 0, wait: false, commit: -1, inAt: NEVER, jams: 0, moved: 0,
        ...FRESH, nextStop: 20 + 60 * rand(this.rx), imp: rand(this.rx) < 0.25, x, z, h, box: boxAt(ty, x, z, h) };
      this.extend(c); this.signal(c); this.cars.push(c); k++;
    }
  }

  /** n spot thieves in small cars, placed like the traffic: they cruise slowly until you are after a space. */
  private addThieves(n: number, avoid: { x: number; z: number } | null): void {
    const net = this.net, lanes = net.els.filter(e => e.kind === 'lane' && e.len > 25);
    for (let k = 0, tries = 0; k < n && lanes.length && tries < 50 * n; tries++) {
      const e = lanes[Math.floor(rand(this.rx) * lanes.length)], type = THIEF_TYPES[pickShare(THIEF_TYPES, rand(this.rx))].t, ty = TYPES[type], s = ty.OVR + 6 + rand(this.rx) * (e.len - ty.L - 16);
      if (!net.ok[type][e.id] || this.cars.some(o => o.state !== 'parked' && o.el === e.id && Math.abs(o.s - s) < (TYPES[o.type].L + ty.L) / 2 + 5)) continue;
      const [x, z, h] = poseOn(e, s);
      if (avoid && Math.hypot(x - avoid.x, z - avoid.z) < 35) continue;
      const c: TCar = { id: this.cars.length, type, drv: THIEF, el: e.id, s, v: 0.6 * DRIVERS[THIEF].v0 * e.limit / 3.6, acc: 0, route: [], ind: 0, wait: false, commit: -1, inAt: NEVER, jams: 0, moved: 0,
        ...FRESH, imp: rand(this.rx) < 0.5, x, z, h, box: boxAt(ty, x, z, h) };
      this.extend(c); this.signal(c); this.cars.push(c); k++;
    }
  }

  snapshot(): TrafficSnap {
    return {
      t: this.t, r: this.rs.r, x: this.rx.r, base: this.base, places: this.places.map(p => ({ slot: p.slot, type: p.type, kind: p.kind })),
      patience: this.patience, pair: this.pair, called: this.called.slice(),
      cars: this.cars.map(({ x: _x, z: _z, h: _h, box: _b, route, ...c }) => ({ ...c, route: route.slice() })),
    };
  }
  restore(s: TrafficSnap): void {
    this.t = s.t; this.rs.r = s.r; this.rx.r = s.x ?? 1; this.base = s.base ?? s.cars.length;
    this.patience = s.patience ?? 5; this.pair = s.pair ?? false; this.called = (s.called ?? []).slice();
    this.places = (s.places ?? []).map(p => (p.kind === 'in' ? diveFor : exitFor)(this.net, this.kerbSlots.get(p.slot)!, p.type)!);
    this.cars = s.cars.map(c => {
      const car = { ...c, route: c.route.slice() } as TCar;   // in the snapshot's order, so the next snapshot reads the same
      for (const [k, v] of Object.entries(FRESH)) if ((car as unknown as Record<string, unknown>)[k] === undefined) (car as unknown as Record<string, unknown>)[k] = v;   // one made before these existed
      [car.x, car.z, car.h] = this.poseOf(car); car.box = boxAt(TYPES[car.type], car.x, car.z, car.h);
      return car;
    });
  }

  /** The light the lane `el` has at its junction now. */
  lightFor(ap: Approach): Light { return lightAt(this.net.junctions[ap.j], this.net.els[ap.el].axis, this.t); }

  /** Advance by dt: the parked cars wake and pull out, the couriers stop and go, every car decides from where everyone is,
   *  the ones held up count their patience, then they all move. */
  step(dt: number, p: PlayerView | null): void {
    this.t += dt;
    for (const l of this.on) l.length = 0;
    for (const c of this.cars) if (c.state !== 'parked') this.on[c.el].push(c);
    for (const l of this.on) if (l.length > 1) l.sort((a, b) => a.s - b.s);
    const pv = p ? shapeOf(p) : null;
    this.blame = !!pv && !this.queued(pv);
    const sought = this.contested(pv);
    if (sought) this.call(sought);
    for (const c of this.cars) {
      if (c.state === 'parked') this.parked(c, pv);
      else if (c.drv === COURIER) this.deliver(c);
      else if (c.aim && c.state === 'drive') this.hunt(c, pv);
      else if (c.aim && c.state === 'in' && c.xs < 0.5 && pv && pv.v < -0.05) this.balk(c);   // you began to reverse in as it began to dive
      if (c.state === 'drive' && c.pass < 0 && !c.aim && c.stopS < 0) this.overtake(c, pv);
    }
    const plans = this.cars.map(c => (c.state === 'parked' ? STILL : this.decide(c, pv)));
    this.held = [];
    this.cars.forEach((c, i) => {
      const pl = plans[i];
      c.wait = pl.wait; c.commit = pl.commit;
      c.lineT = pl.wait && c.v < 0.5 ? c.lineT + dt : c.v > 2 ? 0 : c.lineT;
      // held up by you, or by a car stopped in the lane: it honks once its patience runs out, and again every few seconds
      if (pl.by && c.v < 0.5) { c.hold += dt; if (pl.by === 'you') this.held.push(c.id); } else c.hold = 0;
      if (c.hold >= DRIVERS[c.drv].patience * (c.imp ? 0.4 : 1) && this.t - c.honk >= (c.imp ? 3 : 6)) c.honk = this.t;
    });
    for (let i = 0; i < this.cars.length; i++) if (this.cars[i].state !== 'parked') this.move(this.cars[i], plans[i].a, dt, pv);
  }

  /** What your car (v at rear-axle pose x, z, th) would touch of the traffic: a car's body, or with a door mirror (they
   *  are all taller than the mirrors). A car still parked at the kerb is a parked car. */
  touch(v: Vehicle, x: number, z: number, th: number): { name: string; part: CarPart; parked: boolean } | null {
    let B: Pt[] | null = null, M: Pt[][] = [];
    for (const c of this.cars) {
      const ty = TYPES[c.type];
      if (Math.abs(c.x - x) > v.REACH + ty.L || Math.abs(c.z - z) > v.REACH + ty.L) continue;
      if (!B) { B = footprint(x, z, th, v.body); M = v.mirrors.map(m => footprint(x, z, th, m)); }
      const parked = c.state === 'parked', name = parked ? 'parked car' : `${ty.name} in traffic`;
      if (polysOverlap(B, c.box)) return { name, part: '', parked };
      for (let k = 0; k < M.length; k++) if (polysOverlap(M[k], c.box)) return { name, part: k ? 'right mirror' : 'left mirror', parked };
    }
    return null;
  }
  /** The cars within r of (x, z) as obstacles (only those parked at the kerb: parkedOnly), for your parking sensors and
   *  for where your drawn path would touch. */
  near(x: number, z: number, r: number, parkedOnly = false): Obstacle[] {
    const out: Obstacle[] = [];
    for (const c of this.cars) {
      if ((parkedOnly && c.state !== 'parked') || Math.abs(c.x - x) > r || Math.abs(c.z - z) > r) continue;
      const xs = c.box.map(p => p[0]), zs = c.box.map(p => p[1]), bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs);
      out.push({ kind: 'poly', pts: c.box, name: c.state === 'parked' ? 'parked car' : `${TYPES[c.type].name} in traffic`, fill: '', h: 1.5, cls: 'car', label: '', bx0, bx1, bz0, bz1, cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2 });
    }
    return out;
  }
  /** Whether a free space on the street has a car in it now: one parked there, pulling out of it, or diving into it. */
  taken(slot: string): boolean {
    return this.cars.some(c => (c.state === 'parked' || c.state === 'out' || c.state === 'in') && this.places[c.place].slot === slot);
  }
  /** The thief that has taken a space (diving into it or parked there), or null. */
  thiefIn(slot: string): TCar | null {
    return this.cars.find(c => (c.state === 'in' || c.state === 'parked') && c.place >= 0 && this.places[c.place].kind === 'in' && this.places[c.place].slot === slot) ?? null;
  }

  /** How hard a car brakes or accelerates this step, whether it holds at its line, the junction it now drives on through
   *  at amber, and who holds it up. */
  private decide(c: TCar, pv: Shape | null): Plan {
    if (c.state === 'stop') return { a: -9, wait: false, commit: c.commit, by: '' };
    const way = c.state === 'in' ? this.places[c.place] : null;   // diving into a space: no junction to mind, and it stops at the end
    const E = this.net.els, el = E[c.el], ty = TYPES[c.type], d = DRIVERS[c.drv], v = c.v;
    const nose = ty.L - ty.OVR, front = c.s + nose, look = Math.max(40, v * 4 + 20);
    const want = (e: El) => d.v0 * e.limit / 3.6, curve = (e: El) => (e.kmax ? Math.sqrt(d.lat / e.kmax) : Infinity);
    // what is ahead: the gap from the front bumper, its speed, the gap to keep when stopped, and who it is (1: you, when you
    // are not waiting yourself; 2: a car stopped in the lane)
    const obs: [number, number, number, number][] = [];
    let commit = c.commit, wait = false;
    // the cars ahead along the route, and on paths setting off from the same lane (they overlap at first)
    let off = -c.s;
    for (let i = -1; i < c.route.length && off < look; i++) {
      const e = i < 0 ? el : E[c.route[i]];
      if (e.kind === 'path') for (const sb of e.siblings) for (const o of this.on[sb.el]) {
        if (o.s <= sb.shared + 1 && !(e === el && o.s <= c.s)) obs.push([off + o.s - TYPES[o.type].OVR - nose, o.v, d.s0, 0]);
      }
      const o = this.on[e.id].find(q => q !== c && !(e === el && q.s <= c.s) && q.id !== c.passBy);   // not the one it is passing
      if (o) { obs.push([off + o.s - TYPES[o.type].OVR - nose, o.v, o.state === 'stop' && o.haz ? 7 : d.s0, o.state === 'stop' ? 2 : 0]); break; }   // room to pull out round a courier
      off += e.len;
    }
    // the speed wanted here (pulling out of a space or diving into one, walking pace); slowing in time for a curve or a
    // lower limit ahead
    const v0 = Math.min(want(el), curve(el), c.state === 'out' || way ? 3 : c.pass >= 0 ? PASS_V : Infinity);
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
    if (way) obs.push([way.len - c.xs, 0, 0, 0]);
    else if (toLine >= 0 && toLine < look) {
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
      if (hold) { obs.push([toLine, 0, 0.4, 0]); wait = true; }
    } else if (el.kind === 'path' || toLine < 0) {
      // over the line: through the junction, stopping short of a zone someone else has
      const p = el.kind === 'path' ? el : E[c.route[0]], at = el.kind === 'path' ? c.s : c.s - el.len, b = this.blocker(c, p, at, true);
      if (b) { obs.push([b.a0 - at, 0, 0.3, 0]); wait = b.why === 'gap'; }
    }
    // a courier coming to its stop
    if (c.stopS >= 0 && el.kind === 'lane') obs.push([c.stopS - c.s, 0, 0, 0]);
    // a car the other way out in this lane passing (it goes on: it was clear when it set off): stop short of where it will
    // still be out in it, 3 m before it is back in
    if (el.kind === 'lane' && this.opp[el.id] >= 0) for (const o of this.on[this.opp[el.id]]) {
      if (o.pass < 0) continue;
      const [x, z, h] = this.shifted(o, Math.max(o.s, o.passTo - 3));
      let near = Infinity;
      for (const q of [...o.box, ...boxAt(TYPES[o.type], x, z, h)]) { const s = laneS(el, q); if (s > c.s) near = Math.min(near, s); }
      if (near < c.s + nose + look) obs.push([near - c.s - nose, 0, 1.5, 0]);
    }
    // your car: in the way, or about to be
    if (pv) {
      const hit = this.corridor(c, pv, look), who = this.blame ? 1 : 0;
      if (hit) {
        if (hit.ahead && toLine >= 0) { obs.push([toLine, 0, 0.4, who]); wait = true; }   // in the junction, or crossing its way: wait at the line
        else obs.push([hit.gap, hit.v, hit.room ? 7 : d.s0, who]);
      }
    }
    let by: Plan['by'] = '';
    for (const [gap, vl, s0, who] of obs) {
      const ai = gap <= 0.05 ? -9 : d.a * (1 - (v / Math.max(0.1, v0)) ** 4 - ((s0 + Math.max(0, v * d.T + v * (v - vl) / (2 * Math.sqrt(d.a * d.b)))) / gap) ** 2);
      if (ai < a) { a = ai; by = who === 1 ? 'you' : who === 2 ? 'stop' : ''; }
    }
    return { a: Math.max(-9, Math.min(a, d.a)), wait, commit, by };
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
    // the time to spare it wants before someone else gets there: after 15 s waiting at its line it settles for less, down
    // to 30% of it after half a minute more (it never goes when the other would be there before it is across)
    const spare = d.gap * Math.max(0.3, 1 - Math.max(0, c.lineT - 15) / 30);
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
        if (tO < tClear + spare) { best = { why: 'gap', a0: lo }; break; }
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

  /** Your car on the way ahead of car c: the first place along its route (out of a space or into one first, if it is
   *  pulling out or diving in), half a metre at a time, where its body (30 cm to spare all round: a turn swings its front
   *  wide) would touch your car, or where your car will be in 0.7 s and 1.4 s. With how far it can go before that, your
   *  speed along its way, whether that is only where you are going (or inside the junction: it then waits at its line),
   *  and whether to leave room (you are slow and signalling to park, have your hazards on, or are parking). */
  private corridor(c: TCar, pv: Shape, look: number): { gap: number; v: number; ahead: boolean; room: boolean } | null {
    const E = this.net.els, ty = TYPES[c.type], nose = ty.L - ty.OVR, big = { L: ty.L + 0.6, W: ty.W + 0.6, OVR: ty.OVR + 0.3 }, r = Math.hypot(Math.max(nose, ty.OVR) + 0.3, ty.W / 2 + 0.3);
    if (Math.abs(pv.x - c.x) > look + nose + 10 || Math.abs(pv.z - c.z) > look + nose + 10) return null;
    const [bx0, bx1, bz0, bz1] = pv.bb, ex = c.state === 'out' || c.state === 'in' ? this.places[c.place] : null;
    const line = ex ? (ex.kind === 'in' ? Infinity : ex.len - c.xs + E[ex.el].len - ex.joinS) : E[c.el].kind === 'lane' ? E[c.el].len - c.s : -Infinity;
    let off = 0, e: { pieces: readonly Piece[]; len: number } = ex ?? E[c.el], s = ex ? c.xs : c.s, k = -1, out = !!ex;
    for (let u = 0; u <= nose + look; u += 0.5) {
      for (;;) {   // on along the way: off the way out onto the lane, then lane by lane, path by path
        if (s + (u - off) <= e.len) break;
        if (out && ex!.kind === 'in') break;   // diving in: it ends there
        if (out) { off += e.len - s; s = ex!.joinS; e = E[ex!.el]; out = false; continue; }
        if (k + 1 >= c.route.length) break;
        off += e.len - s; s = 0; e = E[c.route[++k]];
      }
      const [x, z, h] = e === E[c.el] && c.pass >= 0 ? this.shifted(c, s + (u - off)) : poseOn(e, s + (u - off));
      if (x < bx0 - r || x > bx1 + r || z < bz0 - r || z > bz1 + r) continue;
      let box: Pt[] | null = null;
      for (let b = 0; b < pv.boxes.length; b++) {
        // where you will be counts only when you are crossing its way (or coming at it), not following it
        if (b > 0 && Math.abs(wrapPi(pv.th - h)) < 0.7) continue;
        box ??= boxAt(big, x, z, h);
        if (!polysOverlap(box, pv.boxes[b])) continue;
        const along = Math.max(0, pv.v * Math.cos(pv.th - h)), now = b === 0, kerb = this.net.drive === 'right' ? 1 : -1;
        return { gap: u, v: now ? along : 0, ahead: !now || u + nose > line + 0.5, room: now && !c.aim && Math.abs(pv.v) < 1.5 && (pv.park || pv.hazard || pv.ind === kerb) };   // a thief leaves you no room
      }
    }
    return null;
  }

  /** A parked car that will pull out: it wakes as your car comes up behind it (or when its time comes), signals, and after
   *  three seconds pulls out once the way is clear. */
  private parked(c: TCar, pv: Shape | null): void {
    const ex = this.places[c.place];
    if (ex.kind === 'in') return;   // a thief that has taken a space stays in it
    if (!c.ind) {
      const g = pv && c.wakeD > 0 ? this.behind(c, pv) : null;
      if (this.t >= c.until || (g !== null && g > 0 && g < c.wakeD)) { c.ind = ex.side; c.until = this.t; }
    } else if (this.t - c.until >= 3 && this.clearOut(c, ex, pv)) c.state = 'out';
  }
  /** How far your car's front bumper is behind a parked car's back bumper, along its lane, when you are in the lane beside
   *  its row facing the way it does (null otherwise; below 0 once you are level with it). */
  private behind(c: TCar, pv: Shape): number | null {
    if (Math.cos(pv.th - c.h) < 0.8) return null;
    const ex = this.places[c.place], back = TYPES[c.type].OVR, nose = pv.L - pv.OVR;
    const dx = c.x - back * ex.ux - (pv.x + nose * Math.cos(pv.th)), dz = c.z - back * ex.uz - (pv.z - nose * Math.sin(pv.th));
    return Math.abs(dx * ex.uz - dz * ex.ux) < 5 ? dx * ex.ux + dz * ex.uz : null;
  }
  /** Whether a way between the lane and the kerb is clear for car c: of your car (where it is and where it is going) and
   *  of every other car. */
  private wayClear(c: TCar, way: Kerbside, pv: Shape | null): boolean {
    for (const b of way.sweep) {
      if (pv && pv.boxes.some(q => polysOverlap(b, q))) return false;
      for (const o of this.cars) if (o !== c && Math.abs(o.x - c.x) < 25 && Math.abs(o.z - c.z) < 25 && polysOverlap(b, o.box)) return false;
    }
    return true;
  }
  /** Whether a parked car can pull out now: its way out clear, and nobody coming along the lane (you included) who would
   *  have to brake harder than they like for it. */
  private clearOut(c: TCar, ex: Kerbside, pv: Shape | null): boolean {
    if (!this.wayClear(c, ex, pv)) return false;
    // a car beside it, or past it and not yet clear of its way out, that is still moving counts as coming too
    const clearAt = ex.joinS + TYPES[c.type].L;
    for (const [o, gap] of this.coming(this.net.els[ex.el], c.s - TYPES[c.type].OVR, 90)) {
      const D = DRIVERS[o.drv];
      if (o.v > 0.3 && (gap > 0 ? gap < D.s0 + o.v * D.T + (o.v * o.v) / (2 * D.b) : o.s - TYPES[o.type].OVR < clearAt + 1)) return false;
    }
    const g = pv && pv.v > 0.3 ? this.behind(c, pv) : null;
    return !(g !== null && g > -1 && g < 2 + pv!.v * 1.4 + (pv!.v * pv!.v) / 4);
  }
  /** The cars on their way to the point s along lane `lane` (on it, on a path into it, or on a lane before that path and
   *  turning onto it), within `horizon` m, and the ones on the lane already past it: each with the distance from its front
   *  bumper to that point (below 0 for those past it). */
  private coming(lane: El, s: number, horizon: number): [TCar, number][] {
    const E = this.net.els, out: [TCar, number][] = [];
    const add = (e: El, off: number, then: number) => {
      for (const o of this.on[e.id]) {
        const gap = off - (o.s + TYPES[o.type].L - TYPES[o.type].OVR);
        if ((gap > 0 || e === lane) && gap < horizon && (then < 0 || o.route[0] === then)) out.push([o, gap]);
      }
    };
    add(lane, s, -1);
    for (const p of this.into[lane.id]) { const P = E[p], a = E[P.from]; add(P, P.len + s, -1); add(a, a.len + P.len + s, p); }
    return out;
  }
  /** A courier: once a delivery is due it picks where to stop in its lane (well short of the junction ahead), stops there
   *  with its hazards on for 30 to 60 s, then drives on. */
  private deliver(c: TCar): void {
    const el = this.net.els[c.el], ty = TYPES[c.type];
    if (c.state === 'stop') {
      if (this.t >= c.until) { c.state = 'drive'; c.haz = false; c.stopS = -1; c.nextStop = this.t + 90 + 120 * rand(this.rx); }
      return;
    }
    if (c.stopS >= 0) {
      if (c.v < 0.05 && c.stopS - c.s < 1) { c.state = 'stop'; c.haz = true; c.until = this.t + 30 + 30 * rand(this.rx); }
      return;
    }
    if (this.t < c.nextStop || el.kind !== 'lane') return;
    const at = c.s + Math.max(12, (c.v * c.v) / 2 + 6);
    if (at + ty.L - ty.OVR <= el.len - 25) c.stopS = at;
  }
  /** The space you are after: the one Park mode is for (on the street), or the one a parked car you are waiting behind
   *  (stopped within 15 m of it, signalling towards the kerb) is pulling out of. */
  private contested(pv: Shape | null): KerbSlot | null {
    if (!pv) return null;
    if (pv.bay) { const sl = this.kerbSlots.get(pv.bay); return sl && !this.thiefIn(sl.id) ? sl : null; }
    if (Math.abs(pv.v) > 0.3 || pv.ind !== (this.net.drive === 'right' ? 1 : -1)) return null;
    for (const c of this.cars) {
      if ((c.state !== 'parked' && c.state !== 'out') || !c.ind || this.places[c.place].kind !== 'out') continue;
      const g = this.behind(c, pv);
      if (g !== null && g > -0.5 && g < 15) return this.kerbSlots.get(this.places[c.place].slot) ?? null;
    }
    return null;
  }
  /** Send the nearest thief (on hard levels the two nearest) after a space: one that can dive into it and is no more than
   *  CALL m away by the lanes. Only once for each space. */
  private call(sl: KerbSlot): void {
    if (this.called.includes(sl.id)) return;
    this.called.push(sl.id);
    const found: { c: TCar; route: number[]; d: number }[] = [];
    for (const c of this.cars) {
      if (c.drv !== THIEF || c.state !== 'drive' || c.aim) continue;
      const dv = diveFor(this.net, sl, c.type), r = dv && this.routeTo(c, dv.el, dv.s0, CALL);
      if (r) found.push({ c, ...r });
    }
    found.sort((a, b) => a.d - b.d || a.c.id - b.c.id);
    for (const f of found.slice(0, this.pair ? 2 : 1)) { f.c.aim = sl.id; f.c.aimT = -1; f.c.seen = 0; f.c.route = f.route; this.extend(f.c); }
  }
  /** The way for car c to the point s along lane `goal`: the lanes and paths after the one it is on (keeping to a path it
   *  is on or has committed to), as short as its size allows, and how far that is; null if further than `max`. */
  private routeTo(c: TCar, goal: number, s: number, max: number): { route: number[]; d: number } | null {
    const E = this.net.els, ok = this.net.ok[c.type], el = E[c.el], ty = TYPES[c.type];
    if (c.el === goal && c.s < s) return s - c.s <= max ? { route: c.route, d: s - c.s } : null;
    const keep = el.kind === 'path' || el.len - c.s - (ty.L - ty.OVR) < 15, start = keep ? c.route[0] : c.el, d0 = el.len - c.s + (keep ? E[start].len : 0);
    if (keep && start === goal) return d0 - E[start].len + s <= max ? { route: c.route, d: d0 - E[start].len + s } : null;
    const dist = new Map<number, number>([[start, d0]]), prev = new Map<number, number>(), open = [start];
    let best = Infinity, last = -1;
    while (open.length) {
      open.sort((a, b) => dist.get(a)! - dist.get(b)! || a - b);
      const u = open.shift()!, du = dist.get(u)!;   // du: to the end of u
      if (du + s >= Math.min(best, max)) break;
      for (const n of E[u].next) {
        if (!ok[n]) continue;
        if (n === goal) { if (du + s < best) { best = du + s; last = u; } continue; }
        if (du + E[n].len < (dist.get(n) ?? Infinity)) { dist.set(n, du + E[n].len); prev.set(n, u); if (!open.includes(n)) open.push(n); }
      }
    }
    if (last < 0) return null;
    const route = [goal];
    for (let u = last; u !== start; u = prev.get(u)!) route.unshift(u);
    if (keep) route.unshift(start);
    return { route, d: best };
  }
  /** A thief after a space: it comes along the lanes and waits in the lane with its nose at the back of the space. Once
   *  it is there and the space is free its patience runs, and when it has run out it dives in nose first (as soon as
   *  nothing is in its way), unless you have claimed the space by then: signalled towards the kerb, and begun to reverse
   *  into it once it was free. If you claim it, another thief takes it, or the thief goes past it, it drives on. */
  private hunt(c: TCar, pv: Shape | null): void {
    const sl = this.kerbSlots.get(c.aim)!, dv = diveFor(this.net, sl, c.type)!, free = !this.taken(sl.id);
    const off = () => { c.aim = ''; c.aimT = -1; c.stopS = -1; };
    if (pv) { if (pv.ind === (this.net.drive === 'right' ? 1 : -1)) c.seen |= 1; if (free && pv.v < -0.05) c.seen |= 2; }
    if (c.seen === 3 || this.thiefIn(sl.id) || (c.el === dv.el && c.s > dv.s0 + 0.5)) { off(); return; }
    if (c.el !== dv.el) return;
    c.stopS = dv.s0;
    if (c.aimT < 0) { if (free && Math.abs(c.s - dv.s0) < 0.15 && c.v < 0.1) c.aimT = this.t; return; }
    if (this.t - c.aimT < this.patience || (pv && pv.v < -0.05)) return;   // not while you are reversing: it waits for you to stop
    if (free && this.wayClear(c, dv, pv)) { c.state = 'in'; c.place = this.places.length; this.places.push(dv); c.xs = 0; c.s = dv.s0; c.stopS = -1; c.ind = 0; }
    else if (this.t - c.aimT > this.patience + 10) off();
  }
  /** A thief that had only just begun to dive in (half a metre at most, 3 cm off its lane's line) as you began to reverse
   *  into the space: it stops and is back in the lane, waiting, as it was. */
  private balk(c: TCar): void {
    const way = this.places[c.place], lane = this.net.els[way.el];
    c.state = 'drive'; c.place = -1; c.s = way.s0 + c.xs; c.xs = 0; c.v = 0; c.acc = 0;
    [c.x, c.z, c.h] = poseOn(lane, c.s); c.box = boxAt(TYPES[c.type], c.x, c.z, c.h);
  }
  /** Whether your car is waiting itself (a car in traffic just ahead of it, or a red or amber light, or a give-way line,
   *  just ahead): then whoever waits behind it is not held up by you. */
  private queued(pv: Shape): boolean {
    const nose = pv.L - pv.OVR, ux = Math.cos(pv.th), uz = -Math.sin(pv.th), fx = pv.x + nose * ux, fz = pv.z + nose * uz;
    const probe = footprint(pv.x, pv.z, pv.th, [[nose, -pv.W / 2], [nose + 8, -pv.W / 2], [nose + 8, pv.W / 2], [nose, pv.W / 2]]);
    for (const o of this.cars) if (o.state !== 'parked' && Math.abs(o.x - fx) < 16 && Math.abs(o.z - fz) < 16 && polysOverlap(probe, o.box)) return true;
    for (const J of this.net.junctions) {
      if (J.control === 'none') continue;
      for (const ap of J.approaches) {
        if (J.control === 'giveway' && !ap.minor) continue;
        const ax = Math.cos(ap.th), az = -Math.sin(ap.th), [a, b] = ap.line;
        if (ux * ax + uz * az < 0.7) continue;
        const d = (a[0] - fx) * ax + (a[1] - fz) * az, wx = b[0] - a[0], wz = b[1] - a[1], q = ((fx - a[0]) * wx + (fz - a[1]) * wz) / (wx * wx + wz * wz);
        if (d < -0.5 || d > 12 || q < -0.3 || q > 1.3) continue;
        if (J.control === 'giveway' || lightAt(J, this.net.els[ap.el].axis, this.t) !== 'green') return true;
      }
    }
    return false;
  }

  /** Move a car on by its acceleration: along its way out of a space, onto the next lane or path as it runs off the end
   *  of one; unless that would put it into your car or another (the last resort; the rules above should never let it
   *  come to that). */
  private move(c: TCar, a: number, dt: number, pv: Shape | null): void {
    const E = this.net.els, ty = TYPES[c.type];
    let v1 = c.v + a * dt, ds: number;
    if (v1 <= 0) { ds = a < 0 ? Math.min(c.v * dt, (c.v * c.v) / (-2 * a)) : 0; v1 = 0; } else ds = ((c.v + v1) / 2) * dt;
    if (ds > 0) {
      let el = c.el, s: number, route = c.route, xs = c.xs, out = c.state === 'out' || c.state === 'in', x: number, z: number, h: number;
      if (out) {
        const ex = this.places[c.place];
        xs += ds;
        if (ex.kind === 'in' && (xs >= ex.len || (ex.len - xs < 0.1 && v1 < 0.2))) { xs = ex.len; v1 = 0; }   // in the space (where its way was checked to end)
        if (xs < ex.len || ex.kind === 'in') { [x, z, h] = poseOn(ex, xs); s = ex.s0 + (x - ex.x0) * ex.ux + (z - ex.z0) * ex.uz; }
        else { out = false; s = ex.joinS + xs - ex.len; [x, z, h] = poseOn(E[el], s); }
      } else {
        s = c.s + ds;
        while (s > E[el].len && route.length) { s -= E[el].len; el = route[0]; route = route.slice(1); }
        [x, z, h] = el === c.el && c.pass >= 0 ? this.shifted(c, s) : poseOn(E[el], s);
      }
      const box = boxAt(ty, x, z, h);
      if (this.overlaps(c, box, x, z, pv)) { c.v = 0; c.acc = 0; c.jams++; return; }
      if (el !== c.el && E[el].kind === 'lane') { c.commit = -1; c.inAt = NEVER; }
      if (el !== c.el) c.stopS = -1;
      if (c.pass >= 0 && (el !== c.el || s >= c.passTo)) { c.pass = -1; c.passBy = -1; }   // back in
      if (c.state === 'out' && !out) { c.state = 'drive'; c.place = -1; c.xs = 0; c.ind = 0; } else c.xs = xs;
      if (c.state === 'in' && xs >= this.places[c.place].len) { c.state = 'parked'; c.until = 1e9; c.wakeD = 0; c.aim = ''; }   // parked for good
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
  /** At least three lanes and paths ahead: at each junction, of the ways the car fits, straight on twice as often as each
   *  turn (from the traffic's own random numbers, or for a car that came after it, the others). */
  private extend(c: TCar, r = c.id < this.base ? this.rs : this.rx): void {
    const E = this.net.els;
    while (c.route.length < 3) {
      const last = E[c.route.length ? c.route[c.route.length - 1] : c.el];
      if (last.kind === 'path') { c.route.push(last.next[0]); continue; }
      const fit = last.next.filter(id => this.net.ok[c.type][id]), ps = (fit.length ? fit : last.next).map(id => E[id]), w = ps.map(p => (p.turn === 'straight' ? 2 : 1));
      let u = rand(r) * w.reduce((m, q) => m + q, 0), pick = ps[ps.length - 1].id;
      for (let i = 0; i < ps.length; i++) { u -= w[i]; if (u <= 0) { pick = ps[i].id; break; } }
      c.route.push(pick);
    }
  }
  /** Indicating for a turn from 40 m before it until it is done (a parked car signals as it wakes, until it is out; a car
   *  stopped to deliver shows its hazards). */
  private signal(c: TCar): void {
    if (c.state !== 'drive') { if (c.state === 'stop') c.ind = 0; return; }
    const E = this.net.els, el = E[c.el], p = el.kind === 'path' ? el : el.len - c.s < 40 ? E[c.route[0]] : null;
    c.ind = !p || p.turn === 'straight' ? 0 : p.dh > 0 ? -1 : 1;
  }
  /** Where a car is: along its lane or path, or along its way out of a space. */
  private poseOf(c: TCar): [number, number, number] {
    return c.state === 'parked' || c.state === 'out' || c.state === 'in' ? poseOn(this.places[c.place], c.xs) : c.pass >= 0 ? this.shifted(c, c.s) : poseOn(this.net.els[c.el], c.s);
  }
  /** How far a passing car is out towards the other lane at s along its lane, and how fast that changes along it: out on
   *  a half cosine over SWERVE m, along the other lane's line, back the same way. */
  private lat(c: TCar, s: number): [number, number] {
    if (c.pass < 0 || s <= c.pass || s >= c.passTo) return [0, 0];
    const D = this.net.map.streets.find(st => st.id === this.net.els[c.el].street)!.lane - 2 * OFF, u = Math.min(1, (s - c.pass) / SWERVE, (c.passTo - s) / SWERVE);
    const back = c.passTo - s < s - c.pass ? -1 : 1;
    return u >= 1 ? [D, 0] : [D * (1 - Math.cos(Math.PI * u)) / 2, back * D * Math.PI * Math.sin(Math.PI * u) / (2 * SWERVE)];
  }
  /** A passing car's pose at s along its lane: out from the lane's line towards the other lane, turned with its curve. */
  private shifted(c: TCar, s: number): [number, number, number] {
    const [x, z, h] = poseOn(this.net.els[c.el], s), [lat, slope] = this.lat(c, s), k = this.net.drive === 'right' ? 1 : -1;
    return [x - k * lat * Math.sin(h), z - k * lat * Math.cos(h), h + k * Math.atan(slope)];
  }
  /** A car held up behind your car, or behind a courier stopped in the lane with its hazards on: once it has waited 1.5 s
   *  close behind it, it passes, if it can be back in its lane 8 m before the junction, its way round is clear of what it
   *  passes (30 cm to spare) and of everything parked, you are not in the other lane on its way, and nobody coming the
   *  other way would reach its way round before it is back in (at 4 m/s on average, with 3 s to spare). */
  private overtake(c: TCar, pv: Shape | null): void {
    const E = this.net.els, el = E[c.el], O = this.opp[c.el], ty = TYPES[c.type], nose = ty.L - ty.OVR;
    if (el.kind !== 'lane' || O < 0 || c.hold < 1.5 || c.v > 0.5) return;
    // what it is waiting behind, and how far along the lane that reaches
    let by = -1, lo = Infinity, hi = -Infinity, what: Pt[] = [];
    const ahead = this.on[c.el].find(q => q !== c && q.s > c.s);
    if (ahead && ahead.state === 'stop' && ahead.haz && ahead.until - this.t > 5) { by = ahead.id; what = ahead.box; }
    else if (pv && this.blame) { by = -2; what = pv.boxes[0]; }
    if (by === -1) return;
    for (const q of what) { const s = laneS(el, q); lo = Math.min(lo, s); hi = Math.max(hi, s); }
    if (lo - (c.s + nose) > 12 || lo < c.s) return;
    const plan = { ...c, pass: c.s, passTo: hi + 1.5 + ty.OVR + SWERVE };
    if (plan.passTo > el.len - 8) return;
    // its way round, clear of what it passes and of anything parked (the street's own things, and parked cars in traffic)
    const big = { L: ty.L + 0.6, W: ty.W + 0.6, OVR: ty.OVR + 0.3 }, obs = this.net.map.scene.obstacles;
    for (let s = plan.pass; s <= plan.passTo; s += 0.5) {
      const [x, z, h] = this.shifted(plan, s), box = boxAt(big, x, z, h);
      if (polysOverlap(box, what) || (pv && pv.boxes.some(q => polysOverlap(box, q)))) return;
      for (const o of nearby(obs, x, z, ty.L + 1)) if (o.cls !== 'kerb' && (o.kind === 'poly' ? polysOverlap(box, o.pts) : circleHitsPoly(o.x, o.z, o.r, box))) return;
      for (const o of this.cars) if (o !== c && o.id !== by && Math.abs(o.x - x) < 9 && Math.abs(o.z - z) < 9 && polysOverlap(box, o.box)) return;
    }
    // nobody coming the other way who would get there first: from where its way round ends (the other lane's way), back
    const lane = E[O], [ex, ez] = this.shifted(plan, plan.passTo - SWERVE), far = laneS(lane, [ex, ez]), [sx, sz] = this.shifted(plan, plan.pass + SWERVE), near = laneS(lane, [sx, sz]);
    const need = (plan.passTo - plan.pass) / 4 + 3;
    for (const [o, gap] of this.coming(lane, far, 160)) {
      if (gap > 0 ? gap < Math.max(o.v, DRIVERS[o.drv].v0 * lane.limit / 3.6) * need + 2 : o.s - TYPES[o.type].OVR < near + 2) return;
    }
    if (pv && Math.cos(pv.th - lane.pieces[0].h) > 0.5) {   // you, coming the other way
      const s = laneS(lane, [pv.x, pv.z]);
      if (s < near + 2 && far - s < Math.max(Math.abs(pv.v), 14) * need + 10) return;
    }
    c.pass = plan.pass; c.passTo = plan.passTo; c.passBy = by;
  }
}

/** Where a point is along a lane (straight): from its start, the way it runs. */
function laneS(e: El, p: Pt): number { const q = e.pieces[0]; return (p[0] - q.x) * Math.cos(q.h) - (p[1] - q.z) * Math.sin(q.h); }

/** Your car's box now and where it will be in 0.7 s and 1.4 s if it keeps going as it is, and the box round all three. */
function shapeOf(p: PlayerView): Shape {
  const box = (dx: number, dz: number): Pt[] => footprint(p.x + dx, p.z + dz, p.th, [[-p.OVR, -p.W / 2], [p.L - p.OVR, -p.W / 2], [p.L - p.OVR, p.W / 2], [-p.OVR, p.W / 2]]);
  const boxes = [box(0, 0)];
  if (Math.abs(p.v) > 0.5) for (const t of [0.7, 1.4]) boxes.push(box(p.v * t * Math.cos(p.th), -p.v * t * Math.sin(p.th)));
  const all = boxes.flat();
  return { ...p, boxes, bb: [Math.min(...all.map(q => q[0])), Math.max(...all.map(q => q[0])), Math.min(...all.map(q => q[1])), Math.max(...all.map(q => q[1]))] };
}
