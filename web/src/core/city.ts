// The map kit: a district from a short spec (content/maps/*.json): roads with their lanes, parking lanes and
// pavements, the junctions where they cross, bus stops and loading bays, and who is parked. It compiles to what the game
// needs: a scene (kerbs, buildings, parked cars, lamp posts), the free spaces on the street the chosen car fits, and
// the layers the plan draws. The game never sees the spec, only this. The same spec, car and seed always give the same
// district.
//
// World frame as everywhere: x east, z south (down the plan). The spec's y runs north, so z = -y.
import { CARS, carBox, mulberry32, pickFrom } from './generator/templates';
import { wrapPi, type Pt } from './math';
import { exactCheck, planBack, type Pose } from './planner';
import { makeScene, type Bay, type Kerb, type Obstacle, type Rect, type Scene, type SceneObstacleSpec, type SceneSpec } from './scene';
import type { Vehicle } from './vehicle';

export interface SideSpec { park?: number; walk: number }
export interface RoadSpec { id: string; name: string; axis: 'x' | 'y'; at: number; lane: number; limit: number; right: SideSpec; left: SideSpec }
export interface ZoneSpec { road: string; side: 'left' | 'right'; from: number; to: number; kind: 'bus' | 'loading' }
/** The file format (see content/maps/). */
export interface MapSpec {
  format: 1; id: string; name: string; notes?: string[];
  drive: 'right';                        // traffic keeps right (driving on the left comes later)
  bounds: number[];                      // [x0, y0, x1, y1]
  corner?: number;                       // the kerb's radius at a junction's corners, m
  roads: RoadSpec[];
  zones?: ZoneSpec[];
  harbourSide?: 'south';                 // the water beyond the outermost road on that side
  fill: { occupancy: number; sloppiness: number; guarantee: number };
  start: { road: string; at: number; dir: 1 | -1 };
}

/** One side of a street: its parking lane (0: none) and pavement, the heading of the traffic in its lane, and how far
 *  its kerb is from the centre line. */
export interface StreetSide { park: number; walk: number; th: number; hw: number }
/** A street in the world frame. It runs along x (centre line at z = c) or along z (at x = c), from s0 to s1 along it.
 *  Side +1 is the +z side of a street along x and the +x side of a street along z. */
export interface Street {
  id: string; name: string; limit: number; along: 'x' | 'z'; c: number; lane: number; s0: number; s1: number;
  side: Record<1 | -1, StreetSide>;
}
/** A free stretch of kerb between parked cars, along a street from a0 to a1, on one side, long enough for the chosen
 *  car (its length plus 0.8 m, as the hardest kerb level). guaranteed: one of the spaces the fill promised (1.4 to 2.6 m
 *  to spare). parkable: whether the route planner can park the car in it, once someone has asked (see checkSlot). */
export interface Slot { id: string; street: Street; side: 1 | -1; a0: number; a1: number; length: number; guaranteed: boolean; parkable?: boolean; th: number; bay: Bay }
/** What the plan draws for a street map, besides what every scene has. */
export interface CityLayers {
  bounds: Rect;
  ring: { rect: Rect; r: number };                 // the outer edge of the outermost roads, with its corner radius
  blocks: { rect: Rect; r: number }[];             // the blocks between the streets, pavement included
  buildings: Pt[][];
  water: Rect | null;
  zones: { kind: 'bus' | 'loading'; pts: Pt[]; at: Pt; th: number }[];
  names: { text: string; x: number; z: number; th: number }[];
  streets: Street[];
}
export interface CityMap { spec: MapSpec; seed: number; scene: Scene; streets: Street[]; slots: Slot[]; start: Pose; junctions: Rect[] }

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** No parking this close to a junction: 5 m from where the kerbs would meet, and clear of the corner's curve. */
const clearOf = (corner: number) => Math.max(5, corner + 1);

/** A point of a street at a distance s along it and t across (towards side +1). */
export function streetPt(st: Street, s: number, t: number): Pt { return st.along === 'x' ? [s, st.c + t] : [st.c + t, s]; }
/** Which way along the street the traffic on a side drives: +1 towards s1, -1 towards s0. */
export const sideDir = (st: Street, side: 1 | -1): 1 | -1 => (st.along === 'x' ? side : (-side as 1 | -1));

function toStreet(r: RoadSpec): Street {
  const mk = (sp: SideSpec, th: number): StreetSide => ({ park: sp.park ?? 0, walk: sp.walk, th, hw: r.lane + (sp.park ?? 0) });
  // a road along x: its right side (as you drive east) is south, +z; a road along y: its right side (driving north) is east, +x
  return r.axis === 'x'
    ? { id: r.id, name: r.name, limit: r.limit, along: 'x', c: -r.at, lane: r.lane, s0: 0, s1: 0, side: { 1: mk(r.right, 0), [-1]: mk(r.left, Math.PI) } as Record<1 | -1, StreetSide> }
    : { id: r.id, name: r.name, limit: r.limit, along: 'z', c: r.at, lane: r.lane, s0: 0, s1: 0, side: { 1: mk(r.right, Math.PI / 2), [-1]: mk(r.left, -Math.PI / 2) } as Record<1 | -1, StreetSide> };
}

/** A rectangle's outline with rounded corners, clockwise on the plan (z down): n segments per corner. */
export function roundRect([x0, x1, z0, z1]: Rect, r: number, n: number): Pt[] {
  const pts: Pt[] = [];
  const corner = (cx: number, cz: number, a0: number) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * Math.PI / 2; pts.push([r3(cx + r * Math.cos(a)), r3(cz + r * Math.sin(a))]); } };
  corner(x1 - r, z0 + r, -Math.PI / 2); corner(x1 - r, z1 - r, 0); corner(x0 + r, z1 - r, Math.PI / 2); corner(x0 + r, z0 + r, Math.PI);
  return pts;
}

/**
 * The district for car v. Every road runs the whole grid (from the outermost road across it to the one on the far
 * side), so the streets form blocks with a ring of roads round them. The fill (who is parked) comes from the seed, and
 * leaves at least fill.guarantee spaces the car fits: its length plus 1.4 to 2.6 m.
 */
export function buildCity(spec: MapSpec, v: Vehicle, seed: number): CityMap {
  const rnd = mulberry32(seed * 7907 + 17), r = (a: number, b: number) => a + (b - a) * rnd();
  const R = spec.corner ?? 6, [bx0, by0, bx1, by1] = spec.bounds, bounds: Rect = [bx0, bx1, -by1, -by0];
  const streets = spec.roads.map(toStreet);
  const alongX = streets.filter(s => s.along === 'x').sort((a, b) => a.c - b.c);   // north to south
  const alongZ = streets.filter(s => s.along === 'z').sort((a, b) => a.c - b.c);   // west to east
  if (alongX.length < 2 || alongZ.length < 2) throw new Error(`${spec.id}: a district needs two roads each way`);
  // the ring's outer edge: the outermost roads' outer kerbs
  const W = alongZ[0], E = alongZ[alongZ.length - 1], N = alongX[0], S = alongX[alongX.length - 1];
  const ring: Rect = [W.c - W.side[-1].hw, E.c + E.side[1].hw, N.c - N.side[-1].hw, S.c + S.side[1].hw];
  for (const s of alongX) { s.s0 = ring[0]; s.s1 = ring[1]; }
  for (const s of alongZ) { s.s0 = ring[2]; s.s1 = ring[3]; }
  // where the streets cross: along a street, each crossing street's carriageway
  const crossings = (st: Street): [number, number][] => (st.along === 'x' ? alongZ : alongX).map(o => [o.c - o.side[-1].hw, o.c + o.side[1].hw]);
  const junctions: Rect[] = [];
  for (const a of alongX) for (const b of alongZ) junctions.push([b.c - b.side[-1].hw, b.c + b.side[1].hw, a.c - a.side[-1].hw, a.c + a.side[1].hw]);

  const obstacles: SceneObstacleSpec[] = [], kerbs: NonNullable<SceneSpec['kerbs']> = [], buildings: Pt[][] = [];
  // kerbs: round each block, the pavement inside (clockwise), and round the ring, the pavement outside
  const blocks: CityLayers['blocks'] = [];
  const addKerbs = (rect: Rect, rad: number, walks: [number, number, number, number], outside: boolean) => {   // walks: N, E, S, W
    const n = 4, pts = roundRect(rect, rad, n), seq = outside ? pts.slice().reverse() : pts;
    // which edge each piece belongs to: corners NE, SE, SW, NW come as n pieces each, then the edge to the next corner
    const per = n + 1;
    for (let i = 0; i < seq.length; i++) {
      // k: the piece's place in the clockwise outline (piece k runs from point k to point k + 1)
      const a = seq[i], b = seq[(i + 1) % seq.length], k = outside ? (2 * seq.length - 2 - i) % seq.length : i;
      const ci = Math.floor(k / per), straight = k % per === n;
      // clockwise: after corner ci (NE, SE, SW, NW) comes edge E, S, W, N; a corner piece takes the narrower walk
      const edgeAfter = [1, 2, 3, 0][ci], edgeBefore = [0, 1, 2, 3][ci];
      const depth = straight ? walks[edgeAfter] : Math.min(walks[edgeAfter], walks[edgeBefore]);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) kerbs.push({ name: 'kerb', a: [...a], b: [...b], depth });
    }
  };
  for (let i = 0; i + 1 < alongZ.length; i++) for (let j = 0; j + 1 < alongX.length; j++) {
    const w = alongZ[i], e = alongZ[i + 1], n = alongX[j], s = alongX[j + 1];
    const rect: Rect = [w.c + w.side[1].hw, e.c - e.side[-1].hw, n.c + n.side[1].hw, s.c - s.side[-1].hw];
    const walks: [number, number, number, number] = [n.side[1].walk, e.side[-1].walk, s.side[-1].walk, w.side[1].walk];
    blocks.push({ rect, r: R }); addKerbs(rect, R, walks, false);
    addBuildings(rect, walks, rnd, buildings, obstacles);
  }
  const ringR = R + Math.min(N.side[-1].hw + N.side[1].hw, W.side[-1].hw + W.side[1].hw);
  addKerbs(ring, ringR, [N.side[-1].walk, E.side[1].walk, S.side[1].walk, W.side[-1].walk], true);
  // round the outside: buildings along the ring, or the harbour's water and its quay wall
  let water: Rect | null = null;
  const out: Rect = [ring[0] - W.side[-1].walk, ring[1] + E.side[1].walk, ring[2] - N.side[-1].walk, ring[3] + S.side[1].walk];
  if (spec.harbourSide === 'south') {
    water = [bounds[0], bounds[1], out[3] + 0.5, bounds[3]];
    obstacles.push({ kind: 'poly', pts: [[bounds[0], out[3]], [bounds[1], out[3]], [bounds[1], out[3] + 0.5], [bounds[0], out[3] + 0.5]], name: 'quay wall', h: 0.5, cls: 'lowwall' });
  }
  const rows: [Rect, boolean][] = [
    [[out[0], out[1], out[2] - 14.4, out[2] - 0.4], true],                             // north
    [[out[0] - 14.4, out[0] - 0.4, out[2], out[3]], false],                            // west
    [[out[1] + 0.4, out[1] + 14.4, out[2], out[3]], false],                            // east
  ];
  if (!water) rows.push([[out[0], out[1], out[3] + 0.4, out[3] + 14.4], true]);
  for (const [rect, horizontal] of rows) row(rect, horizontal, rnd, buildings, obstacles);

  // parking stretches: each side with a parking lane, between the junctions, clear of them and of the zones
  interface Stretch { st: Street; side: 1 | -1; a0: number; a1: number }
  const stretches: Stretch[] = [];
  const zonesDrawn: CityLayers['zones'] = [];
  for (const st of streets) for (const side of [1, -1] as const) {
    const sd = st.side[side], zs = (spec.zones ?? []).filter(z => z.road === st.id && (z.side === 'right') === (side === 1))
      .map(z => ({ kind: z.kind, a: (st.along === 'x' ? [z.from, z.to] : [-z.to, -z.from]) as [number, number] }));
    for (const { kind, a: [k0, k1] } of zs) {   // the zone's paint along the kerb
      const t0 = side * (sd.hw - Math.max(sd.park, 1.8)), t1 = side * sd.hw;
      const pts: Pt[] = [streetPt(st, k0, t0), streetPt(st, k1, t0), streetPt(st, k1, t1), streetPt(st, k0, t1)];
      zonesDrawn.push({ kind, pts, at: streetPt(st, (k0 + k1) / 2, (t0 + t1) / 2), th: sd.th });
    }
    if (!sd.park) continue;
    const xs = crossings(st).sort((a, b) => a[0] - b[0]);
    for (let k = 0; k + 1 < xs.length; k++) {
      let pieces: [number, number][] = [[xs[k][1] + clearOf(R), xs[k + 1][0] - clearOf(R)]];
      for (const { a: [z0, z1] } of zs) pieces = pieces.flatMap(([p0, p1]) => (z1 <= p0 || z0 >= p1 ? [[p0, p1]] : [[p0, z0], [z1, p1]].filter(([q0, q1]) => q1 - q0 > 1)) as [number, number][]);
      for (const [a0, a1] of pieces) if (a1 - a0 > 3) stretches.push({ st, side, a0, a1 });
    }
  }
  // guaranteed spaces, spread over the stretches long enough for one
  const reserved = new Map<Stretch, [number, number][]>();
  const spare = () => 1.4 + 1.2 * rnd();
  for (let g = 0, tries = 0; g < spec.fill.guarantee && tries < 200; tries++) {
    const st = stretches[Math.floor(rnd() * stretches.length)], need = v.L + spare();
    if (st.a1 - st.a0 < need + 2) continue;
    const a = st.a0 + 1 + rnd() * (st.a1 - st.a0 - need - 2), list = reserved.get(st) ?? [];
    if (list.some(([p0, p1]) => a < p1 + 6 && a + need > p0 - 6)) continue;
    list.push([a, a + need]); reserved.set(st, list); g++;
  }
  // the parked cars: packed along each stretch with gaps, an empty run now and then, never in a reserved space
  const sl = spec.fill.sloppiness, parkedAt = new Map<Stretch, [number, number][]>();
  for (const st of stretches) {
    const res = (reserved.get(st) ?? []).sort((p, q) => p[0] - q[0]), cars: [number, number][] = [];
    let pos = st.a0 + r(0, 1.2);
    const place = (p: number, c: (typeof CARS)[number]) => {
      const [L, Wc, , label] = c, sd = st.st.side[st.side];
      const off = sd.hw - 0.12 - sl * 1.5 * rnd() - Wc / 2, mid = streetPt(st.st, p + L / 2, st.side * off);
      const th = sd.th + (rnd() - 0.5) * 2 * sl * 2.5 * Math.PI / 180;
      obstacles.push({ kind: 'poly', pts: carBox(mid[0], mid[1], th, L, Wc).map(q => q.map(r3)), name: 'parked car', h: 1.5, cls: 'car', label });
      cars.push([p, p + L]);
    };
    for (const [ra, rb] of [...res, [st.a1 + 99, st.a1 + 99] as [number, number]]) {
      // up to the reserved space: the last car before it ends close to its start
      for (;;) {
        const c = pickFrom(rnd, CARS), lim = Math.min(ra, st.a1);
        if (pos + c[0] > lim) {
          const fit = CARS.filter(q => pos + q[0] <= lim && lim - (pos + q[0]) < 1.5);
          if (fit.length && ra < st.a1) place(lim - r(0.05, 0.3) - fit[fit.length - 1][0], fit[fit.length - 1]);
          break;
        }
        if (rnd() > spec.fill.occupancy) { pos += r(3, 8); continue; }
        place(pos, c); pos += c[0] + r(0.5, 1.3);
      }
      if (ra < st.a1) pos = rb + r(0.05, 0.3);   // the first car after it starts right at its end
    }
    parkedAt.set(st, cars.sort((p, q) => p[0] - q[0]));
  }
  // lamp posts on the pavements, 0.6 m in from the kerb, about every 27 m along each block and the ring
  for (const st of streets) for (const side of [1, -1] as const) {
    const sd = st.side[side], xs = crossings(st).sort((a, b) => a[0] - b[0]);
    for (let k = 0; k + 1 < xs.length; k++) {
      const s0 = xs[k][1] + R + 2, s1 = xs[k + 1][0] - R - 2;
      for (let s = s0 + r(0, 8); s < s1; s += r(24, 30)) {
        const p = streetPt(st, s, side * (sd.hw + 0.6));
        obstacles.push({ kind: 'circle', x: r3(p[0]), z: r3(p[1]), r: 0.11, name: 'lamp post', h: 5, cls: 'wall' });
      }
    }
  }
  // the free spaces: between the parked cars, and between a car and the end of its stretch
  const slots: Slot[] = [], bays: Record<string, Bay> = {};
  for (const st of stretches) {
    const cars = parkedAt.get(st)!, edges = [st.a0, ...cars.flat(), st.a1];
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a0 = edges[i], a1 = edges[i + 1], len = a1 - a0;
      if (len < v.L + 0.8) continue;
      const id = `${st.st.id}:${st.side}:${slots.length + 1}`, bay = slotBay(v, st.st, st.side, a0, a1);
      const guaranteed = (reserved.get(st) ?? []).some(([ra, rb]) => ra >= a0 - 1e-6 && rb <= a1 + 1e-6);
      slots.push({ id, street: st.st, side: st.side, a0, a1, length: len, guaranteed, th: st.st.side[st.side].th, bay });
      bays[id] = bay;
    }
  }
  // lanes: dashed centre lines between the junctions, and the edge of each parking lane
  const dashes: number[][] = [];
  for (const st of streets) {
    const xs = crossings(st).sort((a, b) => a[0] - b[0]);
    for (let k = 0; k + 1 < xs.length; k++) {
      const s0 = xs[k][1], s1 = xs[k + 1][0];
      dashes.push([...streetPt(st, s0 + 1, 0), ...streetPt(st, s1 - 1, 0)].map(r3));
      for (const side of [1, -1] as const) if (st.side[side].park) dashes.push([...streetPt(st, s0 + clearOf(R), side * st.lane), ...streetPt(st, s1 - clearOf(R), side * st.lane)].map(r3));
    }
  }
  // where you start: in your lane on the start road, facing along it
  const sr = streets.find(s => s.id === spec.start.road)!, sside = spec.start.dir;
  const sAt = sr.along === 'x' ? spec.start.at : -spec.start.at, sp = streetPt(sr, sAt, sside * sr.lane / 2);
  const start: Pose = { x: r3(sp[0]), z: r3(sp[1]), th: sr.side[sside].th };
  const names: CityLayers['names'] = [];
  for (const st of streets) {
    const xs = crossings(st).sort((a, b) => a[0] - b[0]);
    for (let k = 0; k + 1 < xs.length; k++) { const p = streetPt(st, (xs[k][1] + xs[k + 1][0]) / 2, 0); names.push({ text: st.name, x: p[0], z: p[1], th: st.along === 'x' ? 0 : Math.PI / 2 }); }
  }
  const floors = streets.map(st => (st.along === 'x' ? [st.s0, st.s1, st.c - st.side[-1].hw, st.c + st.side[1].hw] : [st.c - st.side[-1].hw, st.c + st.side[1].hw, st.s0, st.s1]).map(r3));
  const sceneSpec: SceneSpec = {
    format: 1, id: `city-${spec.id}-${seed}`, name: spec.name, layoutVersion: 1,
    lot: bounds, areaView: bounds, defaultBay: '', bays, defaultStart: 'start',
    starts: { start: { x: start.x, z: start.z, th: start.th, label: 'Drive along the streets and park in a free space on your right, between the cars.' } },
    lines: [], dashes, kerbs, floors, obstacles,
  };
  const layers: CityLayers = { bounds, ring: { rect: ring, r: ringR }, blocks, buildings, water, zones: zonesDrawn, names, streets };
  return { spec, seed, scene: { ...makeScene(sceneSpec), city: layers }, streets, slots, start, junctions };
}

/** A space along the kerb as a bay: the tyres within reach of the kerb, between the cars, facing the way the lane runs. */
function slotBay(v: Vehicle, st: Street, side: 1 | -1, a0: number, a1: number): Bay {
  const sd = st.side[side], kerb = st.c + side * sd.hw, lo = side > 0 ? kerb - 0.5 - v.W - 0.05 : kerb - 0.1, hi = side > 0 ? kerb + 0.1 : kerb + 0.5 + v.W + 0.05;
  const inner = st.c + side * (sd.hw - sd.park), dir = sideDir(st, side);
  const box: Rect = st.along === 'x' ? [r3(a0 - 0.05), r3(a1 + 0.05), r3(lo), r3(hi)] : [r3(lo), r3(hi), r3(a0 - 0.05), r3(a1 + 0.05)];
  const lane: [number, number] = [Math.min(inner, kerb), Math.max(inner, kerb)];
  // parked: the body 15-20 cm from the kerb, between the cars with 30 cm to spare at each end
  const goals: Pose[] = [], rear = dir > 0 ? a0 : a1;
  for (const out of [0.15, 0.2]) for (let s = 0.3 + v.OVR; s + (v.L - v.OVR) <= a1 - a0 - 0.3 + 1e-9; s += 0.2) {
    const p = streetPt(st, rear + dir * s, side * (sd.hw - out - v.W / 2));
    goals.push({ x: r3(p[0]), z: r3(p[1]), th: sd.th });
  }
  return st.along === 'x'
    ? { x0: r3(a0), x1: r3(a1), z0: r3(lane[0]), z1: r3(lane[1]), headZ: r3(lane[0]), sideTol: 0, mouthTol: 0, inHeading: sd.th, face: 'in', kind: 'kerb', box, goals }
    : { x0: r3(lane[0]), x1: r3(lane[1]), z0: r3(a0), z1: r3(a1), headZ: r3(a0), sideTol: 0, mouthTol: 0, inHeading: sd.th, face: 'in', kind: 'kerb', box, goals };
}

/** Buildings round a block, behind its pavements: a row along each side with a courtyard in the middle. */
function addBuildings(rect: Rect, walks: [number, number, number, number], rnd: () => number, buildings: Pt[][], obs: SceneObstacleSpec[]): void {
  const [x0, x1, z0, z1] = [rect[0] + walks[3] + 0.4, rect[1] - walks[1] - 0.4, rect[2] + walks[0] + 0.4, rect[3] - walks[2] - 0.4];
  const d = Math.max(6, Math.min(14, Math.min(x1 - x0, z1 - z0) / 2 - 3));
  row([x0, x1, z0, z0 + d], true, rnd, buildings, obs); row([x0, x1, z1 - d, z1], true, rnd, buildings, obs);
  if (z1 - z0 > 2 * d + 4) { row([x0, x0 + d, z0 + d, z1 - d], false, rnd, buildings, obs); row([x1 - d, x1, z0 + d, z1 - d], false, rnd, buildings, obs); }
}
/** A row of buildings filling a strip, split into houses 14-30 m long with an alley now and then. */
function row([x0, x1, z0, z1]: Rect, horizontal: boolean, rnd: () => number, buildings: Pt[][], obs: SceneObstacleSpec[]): void {
  const len = horizontal ? x1 - x0 : z1 - z0;
  if (len < 4 || (horizontal ? z1 - z0 : x1 - x0) < 3) return;
  for (let s = 0; s < len - 3;) {
    const l = Math.min(len - s, 14 + 16 * rnd());
    const pts: Pt[] = horizontal ? [[x0 + s, z0], [x0 + s + l, z0], [x0 + s + l, z1], [x0 + s, z1]] : [[x0, z0 + s], [x1, z0 + s], [x1, z0 + s + l], [x0, z0 + s + l]];
    const P = pts.map(p => p.map(r3) as Pt);
    buildings.push(P); obs.push({ kind: 'poly', pts: P, name: 'building', h: 10, cls: 'wall' });
    s += l + (rnd() < 0.3 ? 2 + 2 * rnd() : 0);
  }
}

/** The street a point is on (its carriageway), preferring the one running the way th points. */
export function streetAt(city: CityMap, x: number, z: number, th = 0): Street | null {
  const on = city.streets.filter(st => {
    const [s, t] = st.along === 'x' ? [x, z - st.c] : [z, x - st.c];
    return s >= st.s0 && s <= st.s1 && t >= -st.side[-1].hw && t <= st.side[1].hw;
  });
  if (on.length < 2) return on[0] ?? null;
  const alongX = Math.abs(Math.cos(th)) > Math.abs(Math.sin(th));
  return on.find(st => (st.along === 'x') === alongX) ?? on[0];
}

/**
 * A space the car has stopped beside, ready to park in: on its right, the car in the lane next to the parking lane
 * and facing along it, its back bumper somewhere between a metre short of the space and four metres past it (the
 * classic start is level with the car in front). The nearest such space, or null.
 */
export function slotNear(city: CityMap, v: Vehicle, x: number, z: number, th: number): Slot | null {
  let best: Slot | null = null, bestD = Infinity;
  const fx = Math.cos(th), fz = -Math.sin(th), rx = x - fx * v.OVR, rz = z - fz * v.OVR, mx = x + fx * (v.L / 2 - v.OVR), mz = z + fz * (v.L / 2 - v.OVR);
  for (const s of city.slots) {
    if (s.parkable === false || Math.abs(wrapPi(th - s.th)) > 25 * Math.PI / 180) continue;
    const st = s.street, sd = st.side[s.side], dir = sideDir(st, s.side);
    const [along, across] = st.along === 'x' ? [rx, mz - st.c] : [rz, mx - st.c];
    const lat = sd.hw - s.side * across;   // the car's middle from the kerb
    if (lat < sd.park + v.W / 2 - 0.4 || lat > sd.park + st.lane + 1.0) continue;
    const front = dir > 0 ? s.a1 : s.a0, u = (along - front) * dir;   // the back bumper past the space's front end
    if (u < -(s.length + 1) || u > 4) continue;
    if (Math.abs(u - 0.5) < bestD) { bestD = Math.abs(u - 0.5); best = s; }
  }
  return best;
}

/** Where Park mode starts for a space when you do it by the book: stopped in the lane beside the car in front of it,
 *  70 cm out from the parked cars, back bumpers about level. */
export function parkStart(v: Vehicle, s: Slot): Pose {
  const st = s.street, sd = st.side[s.side], dir = sideDir(st, s.side), front = dir > 0 ? s.a1 : s.a0;
  const p = streetPt(st, front + dir * (0.5 + v.OVR), s.side * (sd.hw - sd.park - 0.7 - v.W / 2));
  return { x: p[0], z: p[1], th: s.th };
}
/** Whether the route planner can park car v in a space from where Park mode starts by the book, on a route that clears
 *  everything under the exact collision test, worked out once (a tight space can be out of reach for a car whose tail
 *  swings out, like the S-Class's with 10° of rear-axle steering). */
export function checkSlot(city: CityMap, v: Vehicle, s: Slot): boolean {
  if (s.parkable === undefined) {
    const local = localScene(city, s), plan = planBack(v, local, parkStart(v, s), s.id, { maxNodes: 6000 });
    s.parkable = plan.status === 'found' && !exactCheck(v, local, plan.field, plan.pieces);
  }
  return s.parkable;
}

/** The street around a space as a scene of its own, for the route planner: the stretch of street between the junctions
 *  either side, its parked cars and lamp posts, its two kerbs and its spaces. One per stretch, kept, so the planner's
 *  map of it is only made once. */
const locals = new WeakMap<CityMap, Map<string, Scene>>();
export function localScene(city: CityMap, slot: Slot): Scene {
  const st = slot.street, sc = city.scene;
  const xs = (st.along === 'x' ? city.junctions.map(j => [j[0], j[1]]) : city.junctions.map(j => [j[2], j[3]])).sort((a, b) => a[0] - b[0]);
  let s0 = st.s0, s1 = st.s1;
  for (const [j0, j1] of xs) { if (j1 <= slot.a0 && j1 > s0) s0 = j1; if (j0 >= slot.a1 && j0 < s1) s1 = j0; }
  let byKey = locals.get(city); if (!byKey) locals.set(city, byKey = new Map());
  const key = `${st.id}:${s0}:${s1}`, had = byKey.get(key);
  if (had) return had;
  const t0 = st.c - st.side[-1].hw - 1.5, t1 = st.c + st.side[1].hw + 1.5;
  const lot: Rect = st.along === 'x' ? [s0, s1, t0, t1] : [t0, t1, s0, s1];
  const inLot = (o: Obstacle) => !(o.bx1 < lot[0] || o.bx0 > lot[1] || o.bz1 < lot[2] || o.bz0 > lot[3]);
  // only the straight kerbs along this street, across it from each other: a kerb is a half-plane to the planner, and the
  // corners' would cut across the street. A kerb running on past this stretch (the ring's outer one) counts too.
  const ux = st.along === 'x' ? 1 : 0, uz = 1 - ux, along = (p: Pt) => (st.along === 'x' ? p[0] : p[1]), across = (p: Pt) => (st.along === 'x' ? p[1] : p[0]);
  const kerbs = sc.kerbs.filter((k: Kerb) => {
    const dx = k.b[0] - k.a[0], dz = k.b[1] - k.a[1], l = Math.hypot(dx, dz);
    if (l <= 5 || Math.abs(dx * ux + dz * uz) / l <= 0.999) return false;
    const t = across(k.a), k0 = Math.min(along(k.a), along(k.b)), k1 = Math.max(along(k.a), along(k.b));
    return t >= t0 && t <= t1 && k1 > s0 && k0 < s1;
  });
  const bays = Object.fromEntries(city.slots.filter(q => q.street === st && q.a0 >= s0 && q.a1 <= s1).map(q => [q.id, q.bay]));
  const local: Scene = { ...sc, id: `${sc.id}:${key}`, obstacles: sc.obstacles.filter(inLot), kerbs, bays, defaultBay: slot.id, lot, areaView: lot, city: undefined };
  byKey.set(key, local);
  return local;
}
