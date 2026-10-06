// A street map as a graph (content/maps/*.json, format 2, made from OpenStreetMap by scripts/osm-map.mjs): straight
// roads between junctions at any angle, one-way or two-way, with the real buildings. It compiles to the same CityMap as
// the grid districts (core/city.ts): a scene (kerbs round every junction's corners, buildings, parked cars), the free
// spaces the chosen car fits, the layers the plan draws, and what the road network needs (core/graphNet.ts). The same
// spec, car and seed always give the same map.
//
// Each road is a Street with a frame: s along it from its node a towards b, t across it, + to the right going from a to b
// (side +1). World frame as everywhere: x east, z south; the spec's y runs north, so z = -y.
import { clearOf, type CityLayers, type CityMap, type Drive, type KerbSlot, type SideSpec, type Slot, type Street, type StreetSide } from './city';
import { CARS, carBox, mulberry32, pickFrom } from './generator/templates';
import { wrapPi, type Pt } from './math';
import type { Pose } from './planner';
import { makeScene, type Bay, type Rect, type SceneObstacleSpec, type SceneSpec } from './scene';
import type { Vehicle } from './vehicle';

export interface GraphNode { id: string; x: number; y: number; lights?: boolean; edge?: boolean }
export interface GraphRoad { id: string; name: string; a: string; b: string; lane: number; limit: number; oneway?: 1 | -1; major?: boolean; right: SideSpec; left: SideSpec }
/** The file format (see content/README.md). */
export interface GraphMapSpec {
  format: 2; id: string; name: string; notes?: string[];
  credit: string;                              // whose map it is (OpenStreetMap's licence asks for the credit)
  source?: { box: number[]; date: string; queries: Record<string, string> };
  drive: Drive; bounds: number[]; corner?: number;
  nodes: GraphNode[]; roads: GraphRoad[]; buildings: number[][][];
  fill: { occupancy: number; sloppiness: number; guarantee: number; spare?: number[] };
  start: { road: string; at: number; dir: 1 | -1 } | null;
}
/** A street's frame on a graph map: from (ox, oz) along (ux, uz) for len m; its kerbs run straight from kerb[side][0] to
 *  kerb[side][1] (s, between the junctions' corners); its traffic only one way (1: from a to b, -1: from b to a) or both
 *  (0); the nodes it joins; and, once the network is made, the light group of each side's lane at the junction it comes
 *  to (core/graphNet.ts). */
export interface StreetFrame {
  ox: number; oz: number; ux: number; uz: number; len: number; kerb: Record<1 | -1, [number, number]>; oneway: 0 | 1 | -1; a: string; b: string;
  edge: [boolean, boolean];                   // whether each end runs off the map
  axis?: Partial<Record<1 | -1, 'x' | 'z'>>;
}
/** An arm of a junction: the street, which end of it is there, the way out along it (unit), and how far along it (s from
 *  the junction) its lanes may start or end: where its corners' curves end. */
export interface Arm { st: Street; end: 'a' | 'b'; dx: number; dz: number; back: number }
export interface GNode { id: string; x: number; z: number; lights: boolean; edge: boolean; arms: Arm[]; poly: Pt[] }
export interface GraphInfo { nodes: GNode[] }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const headingOf = (ux: number, uz: number): number => Math.atan2(-uz, ux);

/** A point of a frame street at s along it and t across. */
export const framePt = (f: StreetFrame, s: number, t: number): Pt => [f.ox + f.ux * s - f.uz * t, f.oz + f.uz * s + f.ux * t];
/** s along and t across a frame street of a map point. */
export const frameST = (f: StreetFrame, x: number, z: number): [number, number] => { const dx = x - f.ox, dz = z - f.oz; return [dx * f.ux + dz * f.uz, -dx * f.uz + dz * f.ux]; };

/** Whether a point is inside a polygon. */
export function inPoly(p: Pt, poly: readonly Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < (xj - xi) * (p[1] - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}
/** A simple polygon cut into triangles (ear clipping): the collision test only knows convex shapes. */
export function triangles(poly: readonly Pt[]): Pt[][] {
  const P = poly.slice(), out: Pt[][] = [];
  let area = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) P.reverse();
  const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: Pt, a: Pt, b: Pt, c: Pt) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  for (let guard = 0; P.length > 3 && guard < 2000; guard++) {
    let cut = false;
    for (let i = 0; i < P.length; i++) {
      const a = P[(i + P.length - 1) % P.length], b = P[i], c = P[(i + 1) % P.length];
      if (cross(a, b, c) <= 1e-9) continue;
      if (P.some(q => q !== a && q !== b && q !== c && inTri(q, a, b, c))) continue;
      out.push([a, b, c]); P.splice(i, 1); cut = true; break;
    }
    if (!cut) break;   // not simple: what is left as it is
  }
  if (P.length >= 3) out.push(P);
  return out;
}

/** The streets of a graph map, each with its frame. Traffic keeps to `drive`; a one-way street's traffic goes its way
 *  whatever the side. */
function streetsOfGraph(spec: GraphMapSpec, drive: Drive): Street[] {
  const at = new Map(spec.nodes.map(n => [n.id, n]));
  return spec.roads.map(r => {
    const A = at.get(r.a)!, B = at.get(r.b)!, ax = A.x, az = -A.y, bx = B.x, bz = -B.y, len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
    const hu = headingOf(ux, uz), half = r.oneway ? r.lane / 2 : r.lane;
    // two-way: keeping right, side +1's traffic goes from a to b; one-way: both sides face the way it runs
    const th = (side: 1 | -1) => (r.oneway ? (r.oneway > 0 ? hu : wrapPi(hu + Math.PI)) : ((side > 0) === (drive === 'right') ? hu : wrapPi(hu + Math.PI)));
    const mk = (sp: SideSpec, side: 1 | -1): StreetSide => ({ park: sp.park ?? 0, walk: sp.walk, th: th(side), hw: half + (sp.park ?? 0) });
    const f: StreetFrame = { ox: ax, oz: az, ux, uz, len, kerb: { 1: [0, len], [-1]: [0, len] } as Record<1 | -1, [number, number]>, oneway: r.oneway ?? 0, a: r.a, b: r.b, edge: [!!A.edge, !!B.edge] };
    return { id: r.id, name: r.name, limit: r.limit, along: 'x', c: 0, lane: r.lane, s0: 0, s1: len, side: { 1: mk(r.right, 1), [-1]: mk(r.left, -1) } as Record<1 | -1, StreetSide>, f };
  });
}

/**
 * The junctions: at each node its arms in order round it, where each arm's kerbs stop being straight (the corners
 * between neighbouring arms are arcs of radius R tangent to both kerbs), the kerb pieces round the corners, and the
 * junction's outline (the road surface inside the corners). A node at the map's edge has one arm and no corners.
 */
function junctionsOf(spec: GraphMapSpec, streets: Street[], R: number): { nodes: GNode[]; corners: { a: Pt; b: Pt; walk: number; node: GNode }[] } {
  const nodes: GNode[] = spec.nodes.map(n => ({ id: n.id, x: n.x, z: -n.y, lights: !!n.lights, edge: !!n.edge, arms: [], poly: [] }));
  const byId = new Map(nodes.map(n => [n.id, n])), corners: { a: Pt; b: Pt; walk: number; node: GNode }[] = [];
  for (const st of streets) {
    const f = st.f!;
    byId.get(f.a)!.arms.push({ st, end: 'a', dx: f.ux, dz: f.uz, back: 0 });
    byId.get(f.b)!.arms.push({ st, end: 'b', dx: -f.ux, dz: -f.uz, back: 0 });
  }
  // an arm's kerb towards the next arm round (angles increasing) is on the side whose normal is (-dz, dx): side +1 for
  // the street's a end, -1 for its b end; towards the previous arm, the other side
  const sideTo = (m: Arm, next: boolean): 1 | -1 => ((m.end === 'a') === next ? 1 : -1);
  const setKerb = (m: Arm, side: 1 | -1, s: number) => { const k = m.st.f!.kerb[side]; if (m.end === 'a') k[0] = Math.max(k[0], s); else k[1] = Math.min(k[1], m.st.f!.len - s); };
  for (const n of nodes) {
    n.arms.sort((p, q) => Math.atan2(p.dz, p.dx) - Math.atan2(q.dz, q.dx));
    if (n.arms.length < 2) continue;
    for (let i = 0; i < n.arms.length; i++) {
      const A = n.arms[i], B = n.arms[(i + 1) % n.arms.length], sA = sideTo(A, true), sB = sideTo(B, false);
      const wA = A.st.side[sA].hw, wB = B.st.side[sB].hw;
      let phi = Math.atan2(B.dz, B.dx) - Math.atan2(A.dz, A.dx); if (phi <= 0) phi += 2 * Math.PI;
      // the two kerbs' lines: from the node, out along each arm, offset across it to its kerb
      const mA: Pt = [-A.dz, A.dx], mB: Pt = [B.dz, -B.dx];   // towards the corner from each arm's centre line
      const pA: Pt = [n.x + mA[0] * wA, n.z + mA[1] * wA], pB: Pt = [n.x + mB[0] * wB, n.z + mB[1] * wB];
      let sa = 0, sb = 0, arc: Pt[] = [];
      // where the kerbs' lines cross (s along each)
      const det = A.dx * (-B.dz) - A.dz * (-B.dx), qx = pB[0] - pA[0], qz = pB[1] - pA[1];
      const s1 = Math.abs(det) > 1e-9 ? (qx * (-B.dz) - qz * (-B.dx)) / det : -1, s2 = Math.abs(det) > 1e-9 ? (A.dx * qz - A.dz * qx) / det : -1;
      const room = Math.min(A.st.f!.len, B.st.f!.len) * (A.st === B.st ? 0.5 : 0.45);
      if (phi < 150 * Math.PI / 180 && s1 >= 0 && s2 >= 0 && s1 < room && s2 < room) {
        // the arc tangent to both (as tight as R, or tighter where the arms are short)
        const rr = Math.max(0.5, Math.min(R, (Math.min(room - s1, room - s2)) * Math.tan(phi / 2)));
        const T = rr / Math.tan(phi / 2);
        sa = Math.max(0, s1 + T); sb = Math.max(0, s2 + T);
        const ta: Pt = [pA[0] + A.dx * sa, pA[1] + A.dz * sa], tb: Pt = [pB[0] + B.dx * sb, pB[1] + B.dz * sb];
        // the arc's centre: rr in from the tangent point on A's kerb, towards the corner (along mA)
        const c: Pt = [ta[0] + mA[0] * rr, ta[1] + mA[1] * rr], a0 = Math.atan2(ta[1] - c[1], ta[0] - c[0]), a1 = Math.atan2(tb[1] - c[1], tb[0] - c[0]);
        let da = wrapPi(a1 - a0); if (Math.abs(da) > Math.PI - 1e-6) da = -da;
        const k = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 12)));
        for (let j = 0; j <= k; j++) { const a = a0 + da * j / k; arc.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]); }
      } else arc = [pA, pB];   // nearly straight on, or the outside of a bend: a straight piece between the kerbs
      setKerb(A, sA, sa); setKerb(B, sB, sb);
      for (let j = 0; j + 1 < arc.length; j++) if (Math.hypot(arc[j + 1][0] - arc[j][0], arc[j + 1][1] - arc[j][1]) > 1e-3) corners.push({ a: arc[j], b: arc[j + 1], walk: Math.min(A.st.side[sA].walk, B.st.side[sB].walk), node: n });
      n.poly.push(...arc);
    }
    for (const m of n.arms) m.back = Math.max(...([1, -1] as const).map(sd => (m.end === 'a' ? m.st.f!.kerb[sd][0] : m.st.f!.len - m.st.f!.kerb[sd][1])));
  }
  return { nodes, corners };
}

/** A space along a frame street's kerb as a bay, in the street's own frame (s along, t across: as a grid street along x). */
function frameBay(v: Vehicle, st: Street, side: 1 | -1, a0: number, a1: number): Bay {
  const f = st.f!, sd = st.side[side], rot = headingOf(f.ux, f.uz), kerb = side * sd.hw, inner = side * (sd.hw - sd.park), dir = frameDir(st, side);
  const lo = side > 0 ? kerb - 0.5 - v.W - 0.05 : kerb - 0.1, hi = side > 0 ? kerb + 0.1 : kerb + 0.5 + v.W + 0.05;
  const lane: [number, number] = [Math.min(inner, kerb), Math.max(inner, kerb)], th = wrapPi(sd.th - rot);
  const goals: Pose[] = [], rear = dir > 0 ? a0 : a1;
  for (const out of [0.15, 0.2]) for (let s = 0.3 + v.OVR; s + (v.L - v.OVR) <= a1 - a0 - 0.3 + 1e-9; s += 0.2) goals.push({ x: r3(rear + dir * s), z: r3(side * (sd.hw - out - v.W / 2)), th });
  return { x0: r3(a0), x1: r3(a1), z0: r3(lane[0]), z1: r3(lane[1]), headZ: r3(lane[0]), sideTol: 0, mouthTol: 0, inHeading: th, face: 'in', kind: 'kerb', box: [r3(a0 - 0.05), r3(a1 + 0.05), r3(lo), r3(hi)], goals, frame: { x: f.ox, z: f.oz, rot } };
}
/** Which way along a frame street (+1: as s grows) the traffic on a side drives. */
export const frameDir = (st: Street, side: 1 | -1): 1 | -1 => (Math.cos(st.side[side].th - headingOf(st.f!.ux, st.f!.uz)) > 0 ? 1 : -1);
/** Whether a side's kerb is the one you park at: on your right as its traffic drives (your left, keeping left). */
export function kerbSideOf(st: Street, side: 1 | -1, drive: Drive): boolean {
  const dir = frameDir(st, side);
  return (side * dir > 0) === (drive === 'right');   // side +1 is to the right going as s grows
}

/**
 * The map for car v. The fill (who is parked) comes from the seed and leaves at least fill.guarantee spaces the car fits.
 * Traffic keeps to the spec's side, or to `drive`.
 */
export function buildGraphCity(spec: GraphMapSpec, v: Vehicle, seed: number, drive: Drive = spec.drive): CityMap {
  const rnd = mulberry32(seed * 7907 + 17), r = (a: number, b: number) => a + (b - a) * rnd();
  const R = spec.corner ?? 5, [bx0, by0, bx1, by1] = spec.bounds, bounds: Rect = [bx0, bx1, -by1, -by0];
  const streets = streetsOfGraph(spec, drive), { nodes, corners } = junctionsOf(spec, streets, R);
  const obstacles: SceneObstacleSpec[] = [], kerbs: NonNullable<SceneSpec['kerbs']> = [];
  // kerbs, the pavement on the side away from the road: along each street between its corners, and round each corner
  const kerbPiece = (a: Pt, b: Pt, away: Pt, depth: number) => {
    const nx = -(b[1] - a[1]), nz = b[0] - a[0], mx = (a[0] + b[0]) / 2 - away[0], mz = (a[1] + b[1]) / 2 - away[1];
    const [p, q] = nx * mx + nz * mz >= 0 ? [a, b] : [b, a];
    kerbs.push({ name: 'kerb', a: p.map(r3), b: q.map(r3), depth });
  };
  for (const st of streets) for (const side of [1, -1] as const) {
    const f = st.f!, [k0, k1] = f.kerb[side], t = side * st.side[side].hw;
    if (k1 - k0 > 1e-3) kerbPiece(framePt(f, k0, t), framePt(f, k1, t), framePt(f, (k0 + k1) / 2, 0), st.side[side].walk);
  }
  for (const c of corners) kerbPiece(c.a, c.b, [c.node.x, c.node.z], c.walk);
  // the buildings (each cut into triangles for the collision test; the plan draws the outline), and at each road's end
  // at the map's edge a low barrier across it
  const buildings: Pt[][] = spec.buildings.map(b => b.map(([x, y]): Pt => [x, -y]));
  for (const b of buildings) for (const tri of triangles(b)) obstacles.push({ kind: 'poly', pts: tri.map(p => p.map(r3)), name: 'building', h: 10, cls: 'wall' });
  for (const st of streets) {
    const f = st.f!;
    for (const [k, at] of [[0, -4.6], [1, f.len + 4]] as const) {   // 4 m off the map: a car leaving it has room to stop
      if (!f.edge[k]) continue;
      const w0 = -st.side[-1].hw - 1, w1 = st.side[1].hw + 1;
      obstacles.push({ kind: 'poly', pts: [framePt(f, at, w0), framePt(f, at + 0.6, w0), framePt(f, at + 0.6, w1), framePt(f, at, w1)].map(p => p.map(r3)), name: 'end of the map', h: 0.9, cls: 'lowwall' });
    }
  }
  // parking stretches: each side with a parking lane, clear of the corners
  interface Stretch { st: Street; side: 1 | -1; a0: number; a1: number; free: boolean }
  const stretches: Stretch[] = [];
  for (const st of streets) for (const side of [1, -1] as const) {
    const sd = st.side[side], f = st.f!; if (!sd.park) continue;
    const a0 = f.kerb[side][0] + (f.edge[0] ? 3 : clearOf(R)), a1 = f.kerb[side][1] - (f.edge[1] ? 3 : clearOf(R));
    if (a1 - a0 > 3) stretches.push({ st, side, a0, a1, free: kerbSideOf(st, side, drive) });
  }
  // guaranteed spaces on the kerbs you park at, spread over the stretches long enough for one
  const reserved = new Map<Stretch, [number, number][]>(), open = stretches.filter(s => s.free);
  const [sp0, sp1] = spec.fill.spare ?? [1.4, 2.6], spare = () => sp0 + (sp1 - sp0) * rnd();
  for (let g = 0, tries = 0; g < spec.fill.guarantee && tries < 2000 && open.length; tries++) {
    const st = open[Math.floor(rnd() * open.length)], need = v.L + spare();
    if (st.a1 - st.a0 < need + 2) continue;
    const a = st.a0 + 1 + rnd() * (st.a1 - st.a0 - need - 2), list = reserved.get(st) ?? [];
    if (list.some(([p0, p1]) => a < p1 + 9 && a + need > p0 - 9)) continue;
    list.push([a, a + need]); reserved.set(st, list); g++;
  }
  // the parked cars, as on the grid's streets
  const sl = spec.fill.sloppiness, parkedAt = new Map<Stretch, [number, number][]>();
  for (const st of stretches) {
    const res = (reserved.get(st) ?? []).sort((p, q) => p[0] - q[0]), cars: [number, number][] = [], f = st.st.f!;
    let pos = st.a0 + r(0, 1.2);
    const place = (p: number, c: (typeof CARS)[number]) => {
      const [L, Wc, , label] = c, sd = st.st.side[st.side];
      const off = sd.hw - 0.12 - sl * 1.5 * rnd() - Wc / 2, mid = framePt(f, p + L / 2, st.side * off);
      const th = sd.th + (rnd() - 0.5) * 2 * sl * 2.5 * Math.PI / 180;
      obstacles.push({ kind: 'poly', pts: carBox(mid[0], mid[1], th, L, Wc).map(q => q.map(r3)), name: 'parked car', h: 1.5, cls: 'car', label });
      cars.push([p, p + L]);
    };
    let after = false;
    for (const [ra, rb] of [...res, [st.a1 + 99, st.a1 + 99] as [number, number]]) {
      for (;;) {
        const c = pickFrom(rnd, CARS), lim = Math.min(ra, st.a1);
        if (pos + c[0] > lim) {
          const fit = CARS.filter(q => pos + q[0] <= lim && lim - (pos + q[0]) < 1.5);
          if (fit.length && ra < st.a1) place(lim - r(0.05, 0.3) - fit[fit.length - 1][0], fit[fit.length - 1]);
          break;
        }
        if (!after && rnd() > spec.fill.occupancy) { pos += r(3, 8); continue; }
        place(pos, c); pos += c[0] + r(0.5, 1.3); after = false;
      }
      if (ra < st.a1) { pos = rb + r(0.05, 0.3); after = true; }
    }
    parkedAt.set(st, cars.sort((p, q) => p[0] - q[0]));
  }
  // the free spaces: between the parked cars on the kerbs you park at
  const slots: Slot[] = [], bays: Record<string, Bay> = {};
  for (const st of stretches) {
    if (!st.free) continue;
    const cars = parkedAt.get(st)!, edges = [st.a0, ...cars.flat(), st.a1], f = st.st.f!;
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a0 = edges[i], a1 = edges[i + 1], len = a1 - a0;
      if (len < v.L + 0.8) continue;
      const id = `${st.st.id}:${st.side}:${slots.length + 1}`, bay = frameBay(v, st.st, st.side, a0, a1);
      const guaranteed = (reserved.get(st) ?? []).some(([ra, rb]) => ra >= a0 - 1e-6 && rb <= a1 + 1e-6);
      const dir = frameDir(st.st, st.side), kerbEnd = dir > 0 ? f.kerb[st.side][1] : f.kerb[st.side][0];
      const slot: KerbSlot = { kind: 'kerb', id, street: st.st, side: st.side, a0, a1, length: len, guaranteed, th: st.st.side[st.side].th, bay, kerbEnd };
      slots.push(slot); bays[id] = bay;
    }
  }
  // lane markings: a dashed centre line on two-way streets, and each parking lane's edge
  const dashes: number[][] = [];
  for (const st of streets) {
    const f = st.f!, s0 = Math.max(f.kerb[1][0], f.kerb[-1][0]), s1 = Math.min(f.kerb[1][1], f.kerb[-1][1]);
    if (s1 - s0 < 3) continue;
    if (!f.oneway) dashes.push([...framePt(f, s0 + 1, 0), ...framePt(f, s1 - 1, 0)].map(r3));
    for (const side of [1, -1] as const) if (st.side[side].park && s1 - s0 > 2 * clearOf(R)) { const t = side * (st.side[side].hw - st.side[side].park); dashes.push([...framePt(f, s0 + clearOf(R), t), ...framePt(f, s1 - clearOf(R), t)].map(r3)); }
  }
  // where you start: in your lane on the start road, facing along it (the spec's, or 15 m into the longest main road
  // that comes in from the map's edge)
  const start = startOf(spec, streets, drive);
  const names: CityLayers['names'] = streets.filter(st => st.name && st.f!.len > 30).map(st => { const f = st.f!, p = framePt(f, f.len / 2, 0); return { text: st.name, x: p[0], z: p[1], th: headingOf(f.ux, f.uz) }; });
  const surface: Pt[][] = [...streets.map(st => { const f = st.f!, k = f.kerb; return [framePt(f, k[1][0], st.side[1].hw), framePt(f, k[1][1], st.side[1].hw), framePt(f, k[-1][1], -st.side[-1].hw), framePt(f, k[-1][0], -st.side[-1].hw)]; }), ...nodes.filter(n => n.poly.length > 2).map(n => n.poly)];
  const sceneSpec: SceneSpec = {
    format: 1, id: `city-${spec.id}-${seed}${drive === 'left' ? '-left' : ''}`, name: spec.name, layoutVersion: 1,
    lot: bounds, areaView: bounds, defaultBay: '', bays, defaultStart: 'start',
    starts: { start: { x: start.x, z: start.z, th: start.th, label: `Drive along the streets and park in a free space on your ${drive}, between the cars.` } },
    lines: [], dashes, kerbs, floors: [], obstacles,
  };
  const layers: CityLayers = { bounds, ring: { rect: bounds, r: 0 }, blocks: [], buildings, water: null, zones: [], names, streets, lots: [], arrows: [], surface, credit: spec.credit };
  const junctions: Rect[] = nodes.filter(n => n.poly.length > 2).map(n => [Math.min(...n.poly.map(p => p[0])), Math.max(...n.poly.map(p => p[0])), Math.min(...n.poly.map(p => p[1])), Math.max(...n.poly.map(p => p[1]))]);
  return { spec, seed, drive, scene: { ...makeScene(sceneSpec), city: layers }, streets, lots: [], slots, start, junctions, graph: { nodes } };
}

function startOf(spec: GraphMapSpec, streets: Street[], drive: Drive): Pose {
  const pick = (st: Street, at: number, dir: 1 | -1): Pose => {
    const f = st.f!, side = ([1, -1] as const).find(sd => frameDir(st, sd) === dir) ?? 1, t = f.oneway ? 0 : side * st.lane / 2;
    const p = framePt(f, at, t);
    return { x: r3(p[0]), z: r3(p[1]), th: st.side[side].th };
  };
  if (spec.start) { const st = streets.find(s => s.id === spec.start!.road)!; return pick(st, spec.start.at, spec.start.dir); }
  const cand = streets.filter(st => st.f!.edge[0] !== st.f!.edge[1]).sort((p, q) => Number(!!spec.roads.find(r => r.id === q.id)?.major) - Number(!!spec.roads.find(r => r.id === p.id)?.major) || q.f!.len - p.f!.len);
  for (const st of cand) {
    const f = st.f!, inward: 1 | -1 = f.edge[0] ? 1 : -1;
    if (f.oneway && f.oneway !== inward) continue;
    return pick(st, inward > 0 ? f.kerb[1][0] + 15 : f.kerb[1][1] - 15, inward);
  }
  void drive;
  throw new Error(`${spec.id}: no road comes in from the map's edge to start on`);
}
