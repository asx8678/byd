// Car parks for the map kit: a lot inside a block, behind its pavements, with rows of bays at 90°, 60° or 45° either side
// of its aisles, a cross aisle at each end, a low wall round it and a driveway in from one road. It compiles to obstacles
// (the wall, the parked cars), painted bay lines, arrows on one-way aisles and its bays, each turned to its own frame
// (see Bay.frame) so that the game judges a car in it and the route planner parks in it like any other bay.
//
// World frame as everywhere: x east, z south. In a lot, s runs along its aisles and t across them.
import { CARS, carBox, pickFrom } from './generator/templates';
import { DEG, type Pt } from './math';
import type { Bay, Rect, SceneObstacleSpec } from './scene';
import type { Vehicle } from './vehicle';

/** The file format (a map's lots, see content/maps/). */
export interface LotSpec {
  id: string; name: string;
  rect: number[];                 // [x0, y0, x1, y1] in the map frame: the car park's surface, inside a block behind its pavements
  aisles: 'x' | 'y';              // which way its aisles run
  angle: 90 | 60 | 45;            // the bays' angle to the aisle
  bay: number[];                  // a bay's width and length, m (the length along its lines' direction, as for a 90° bay)
  aisle: number;                  // aisle width, m: two-way at 90°, one way at 60° and 45°
  cross?: number;                 // the cross aisles at both ends, two-way (m, default 7)
  entry: string;                  // the road the driveway comes in from
  at?: number;                    // about where along that road (map frame); the driveway lines up with the nearest aisle
  limit?: number;                 // km/h (default 10)
  occupancy?: number;             // the share of bays taken (default: the map's fill)
  free?: number;                  // bays kept free whatever the fill (default 3)
}

/** What a lot needs to know about a road: where it runs and how far its kerbs are from its centre line. */
export interface LotRoad { id: string; along: 'x' | 'z'; c: number; hw: Record<1 | -1, number> }

/** An aisle: its centre line across the lot (t), width, and the way it is driven: one way along s (+1 towards +s), or
 *  both ways (0). */
export interface LotAisle { t: number; w: number; dir: 1 | -1 | 0 }
/** A bay of a lot: its number, aisle and row (the side of the aisle it is on, -1 towards -t), the middle of its mouth on
 *  the map and along the aisle, and the bay itself in its own frame. */
export interface LotBay { n: number; aisle: number; row: 1 | -1; mouth: Pt; s: number; bay: Bay }
export interface Lot {
  id: string; name: string; limit: number; angle: number; size: [number, number];   // the bays' width and length
  rect: Rect; along: 'x' | 'z'; s0: number; s1: number; t0: number; t1: number;
  aisles: LotAisle[]; cross: [number, number][];   // the cross aisles' spans along s
  bays: LotBay[];
  gate: Rect;                                       // the driveway: from the road's kerb to the car park
  road: string;                                     // the road it opens onto
  drive: 'right' | 'left';                          // the side of the road traffic keeps to (in a two-way aisle too)
}
/** A lot laid out, and what the rest of the district must leave for it: the kerb it opens (a line along `along` at t,
 *  from a0 to a1), the parking it keeps clear on that road, and the room it takes from buildings and lamp posts. */
export interface LotPlan {
  lot: Lot;
  walls: SceneObstacleSpec[]; lines: number[][]; arrows: { x: number; z: number; th: number }[];
  cut: { along: 'x' | 'z'; t: number; a0: number; a1: number };
  clear: { road: string; side: 1 | -1; a0: number; a1: number };
  avoid: Rect[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** The heading of travel along a lot's aisles (d = +1: towards +s). */
export const alongHeading = (along: 'x' | 'z', d: 1 | -1): number => (along === 'x' ? (d > 0 ? 0 : Math.PI) : (d > 0 ? -Math.PI / 2 : Math.PI / 2));

/** Lay a lot out: aisles, rows, bays, wall, driveway. No randomness: the same spec always gives the same car park. The
 *  spec's rectangle is the room it may take: the lot takes as much of it as its aisles and rows need, against the road
 *  its driveway comes from (and in the middle the other way). */
export function layoutLot(spec: LotSpec, roads: readonly LotRoad[], drive: 'right' | 'left' = 'right'): LotPlan {
  const [mx0, my0, mx1, my1] = spec.rect, room: Rect = [mx0, mx1, -my1, -my0];
  const along = spec.aisles === 'x' ? 'x' : 'z';
  const P = (s: number, t: number): Pt => (along === 'x' ? [s, t] : [t, s]);
  const sx = along === 'x' ? 1 : 0, sz = 1 - sx, tx = sz, tz = sx;   // unit vectors along s and t on the map
  const ang = spec.angle, th = ang * DEG, sin = ang === 90 ? 1 : Math.sin(th), cos = ang === 90 ? 0 : Math.cos(th), cot = cos / sin;
  const [Wb, D] = spec.bay, A = spec.aisle, C = spec.cross ?? 7;
  const deep = D * sin + Wb * cos;                               // a row's depth across the aisle
  const pitch = Wb / sin, module = 2 * deep + A, back = 0.6;    // the outer rows' back lines 60 cm in from the edge
  // the road the driveway comes from, and which side of it the lot is on
  const road = roads.find(r => r.id === spec.entry);
  if (!road) throw new Error(`lot ${spec.id}: no road ${spec.entry}`);
  const across = road.along === 'x' ? [room[2], room[3]] : [room[0], room[1]], side: 1 | -1 = across[0] > road.c ? 1 : -1;
  // as many aisles as fit across, as many bays as fit along
  let [s0, s1, t0, t1] = along === 'x' ? [room[0], room[1], room[2], room[3]] : [room[2], room[3], room[0], room[1]];
  const nMod = Math.floor((t1 - t0 - 2 * back) / module), n = Math.floor((s1 - s0 - 2 * C - deep * cot) / pitch);
  if (nMod < 1 || n < 3) throw new Error(`lot ${spec.id}: too small for one aisle of bays`);
  const tu = nMod * module + 2 * back, su = 2 * C + n * pitch + deep * cot;
  const fit = (a: number, b: number, len: number, face: number): [number, number] => (face > 0 ? [a, a + len] : face < 0 ? [b - len, b] : [(a + b - len) / 2, (a + b + len) / 2]);
  // facing the road: the side of the lot towards it (+1: its low end), else centred
  [t0, t1] = fit(t0, t1, tu, road.along === along ? side : 0).map(r3) as [number, number];
  [s0, s1] = fit(s0, s1, su, road.along === along ? 0 : side).map(r3) as [number, number];
  const rect: Rect = along === 'x' ? [s0, s1, t0, t1] : [t0, t1, s0, s1];
  // the driveway: from the road's kerb to the side of the lot facing it, lined up with a cross aisle (a road running
  // along the aisles) or with the aisle nearest `at` (a road across them)
  const lotT = road.along === 'x' ? [rect[2], rect[3]] : [rect[0], rect[1]];   // the lot across the road
  const kerbT = road.c + side * road.hw[side], faceT = side > 0 ? lotT[0] : lotT[1];
  if ((faceT - kerbT) * side < 0) throw new Error(`lot ${spec.id}: overlaps ${spec.entry}`);
  const atW = spec.at === undefined ? undefined : road.along === 'x' ? spec.at : -spec.at, aisleT = (k: number) => t0 + back + k * module + deep + A / 2;
  const nearest = (xs: number[]) => (atW === undefined ? xs[0] : xs.reduce((p, q) => (Math.abs(q - atW) < Math.abs(p - atW) ? q : p)));
  let gc: number, gw: number, entryAisle = 0;   // the driveway's middle and width along the road; the aisle you come to first
  if (road.along === along) {   // along the aisles: in at a cross aisle, and the aisle nearest the road comes first
    gc = nearest([s0 + C / 2, s1 - C / 2]); gw = C; entryAisle = side > 0 ? 0 : nMod - 1;
  } else {                      // across them: straight into the aisle nearest `at`
    const ts = Array.from({ length: nMod }, (_, k) => aisleT(k));
    gc = nearest(ts); gw = C; entryAisle = ts.indexOf(gc);
  }
  // one way, the aisle you come to first runs away from the driveway's end of the lot, and the others take turns with
  // it, so the cross aisles join them up into a loop
  const away: 1 | -1 = road.along === along ? (gc < (s0 + s1) / 2 ? 1 : -1) : (side > 0 ? 1 : -1);
  const aisles: LotAisle[] = [], bays: LotBay[] = [], lines: number[][] = [], arrows: LotPlan['arrows'] = [];
  const line = (a: Pt, b: Pt) => lines.push([a[0], a[1], b[0], b[1]].map(r3));
  for (let k = 0; k < nMod; k++) {
    const tA = aisleT(k), dir: 1 | -1 | 0 = ang === 90 ? 0 : ((k - entryAisle) % 2 === 0 ? away : (-away as 1 | -1));
    aisles.push({ t: r3(tA), w: A, dir });
    for (const row of [-1, 1] as const) {
      const edge = tA + row * A / 2, tb = edge + row * deep;
      // a bay leans the way the aisle is driven, so you turn into it from there; at 90° it does not lean
      const d = dir || 1, sA = s0 + C, lean = d * deep * cot;
      const first = d > 0 ? sA + pitch / 2 : sA + deep * cot + pitch / 2;   // the first mouth's middle
      // into the bay, nose first: along the aisle (as it is driven) and across into the row
      const ix = d * cos * sx + row * sin * tx, iz = d * cos * sz + row * sin * tz;
      const rot = Math.atan2(-ix, -iz);   // the bay's frame: +z out of it, towards the aisle
      for (let i = 0; i < n; i++) {
        const sm = first + i * pitch, mouth = P(sm, edge), z1 = -Wb / 2 * cot;
        bays.push({
          n: 0, aisle: k, row, mouth: [r3(mouth[0]), r3(mouth[1])], s: r3(sm),
          bay: {
            x0: r3(-Wb / 2), x1: r3(Wb / 2), z0: r3(z1 - D), z1: r3(z1), headZ: r3(z1 - D - 0.3), sideTol: 0.05, mouthTol: 0.4,
            inHeading: Math.PI / 2, face: ang === 90 ? 'either' : 'in', frame: { x: r3(mouth[0]), z: r3(mouth[1]), rot },
          },
        });
      }
      // the lines: one between each pair of bays and at the ends, and along the back of the row
      for (let i = 0; i <= n; i++) { const sm = first - pitch / 2 + i * pitch; line(P(sm, edge), P(sm + lean, tb)); }
      line(P(first - pitch / 2 + lean, tb), P(first - pitch / 2 + n * pitch + lean, tb));
    }
    if (dir) for (let s = s0 + C + 6; s < s1 - C - 4; s += 13) { const p = P(s, tA); arrows.push({ x: r3(p[0]), z: r3(p[1]), th: alongHeading(along, dir) }); }
  }
  // numbered aisle by aisle, along each row
  bays.sort((a, b) => a.aisle - b.aisle || a.row - b.row || a.s - b.s).forEach((b, i) => { b.n = i + 1; });

  const g0 = r3(gc - gw / 2), g1 = r3(gc + gw / 2), lo = Math.min(kerbT, faceT), hi = Math.max(kerbT, faceT);
  const gate: Rect = road.along === 'x' ? [g0, g1, r3(lo), r3(hi)] : [r3(lo), r3(hi), g0, g1];
  // the wall: 20 cm thick, inside the edge, open where the driveway comes in
  const walls: SceneObstacleSpec[] = [], T = 0.2;
  const wall = (x0: number, x1: number, z0: number, z1: number) => { if (x1 - x0 > 0.05 && z1 - z0 > 0.05) walls.push({ kind: 'poly', pts: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(p => p.map(r3)), name: 'car park wall', h: 0.6, cls: 'lowwall' }); };
  const [x0, x1, z0, z1] = rect, gateSide = road.along === 'x' ? (side > 0 ? 'n' : 's') : (side > 0 ? 'w' : 'e');
  const run = (horiz: boolean, fixed0: number, fixed1: number, a: number, b: number, open: boolean) => {
    const pieces: [number, number][] = open ? [[a, g0], [g1, b]] : [[a, b]];
    for (const [p, q] of pieces) if (horiz) wall(p, q, fixed0, fixed1); else wall(fixed0, fixed1, p, q);
  };
  run(true, z0, z0 + T, x0, x1, gateSide === 'n'); run(true, z1 - T, z1, x0, x1, gateSide === 's');
  run(false, x0, x0 + T, z0 + T, z1 - T, gateSide === 'w'); run(false, x1 - T, x1, z0 + T, z1 - T, gateSide === 'e');
  const lot: Lot = {
    id: spec.id, name: spec.name, limit: spec.limit ?? 10, angle: ang, size: [Wb, D],
    rect, along, s0, s1, t0, t1, aisles, cross: [[s0, s0 + C], [s1 - C, s1]], bays, gate, road: road.id, drive,
  };
  const grow = (r: Rect, m: number): Rect => [r[0] - m, r[1] + m, r[2] - m, r[3] + m];
  return {
    lot, walls, lines, arrows,
    cut: { along: road.along, t: kerbT, a0: g0, a1: g1 },
    clear: { road: road.id, side, a0: g0 - 3.5, a1: g1 + 3.5 },   // no parking for 3.5 m either side, to see and to swing in
    avoid: [grow(rect, 0.5), grow(gate, 0.5)],
  };
}

/** Who is parked in a lot, from its own random numbers (so the street's parking does not depend on it): each bay taken
 *  with the lot's occupancy, except the ones kept free. Cars nose in, or in a 90° bay now and then reversed in; a little
 *  off centre and askew, the more so the sloppier the map. Returns the bays left free. */
export function fillLot(lot: Lot, rnd: () => number, occupancy: number, keepFree: number, sloppiness: number, obs: SceneObstacleSpec[]): { free: LotBay[]; kept: Set<LotBay> } {
  const kept = new Set<LotBay>();
  for (let tries = 0; kept.size < Math.min(keepFree, lot.bays.length) && tries < 200; tries++) kept.add(lot.bays[Math.floor(rnd() * lot.bays.length)]);
  const [Wb, D] = lot.size, list = CARS.filter(c => c[0] <= D && c[1] <= Wb - 0.35), free: LotBay[] = [];
  for (const b of lot.bays) {
    const take = rnd() < occupancy;   // drawn for every bay, so keeping one free leaves the rest as they were
    if (kept.has(b) || !take) { free.push(b); continue; }
    const [L, W, , label] = pickFrom(rnd, list), back = lot.angle === 90 && rnd() < 0.3;
    // off centre by up to twice the sloppiness in metres (and never closer than 15 cm to a line), askew by up to ten
    // times it in degrees, the nose 25-60 cm short of the back line (a long car's tail out of the mouth by 25 cm at most)
    const dx = (rnd() - 0.5) * 2 * Math.min(Math.max(0, (Wb - W) / 2 - 0.15), 2 * sloppiness), tilt = (rnd() - 0.5) * 2 * sloppiness * 10 * DEG;
    const gap = 0.25 + rnd() * Math.min(0.35, Math.max(0, D - L));
    const B = b.bay, cz = B.z0 + gap + L / 2, f = B.frame!, c = Math.cos(f.rot), s = Math.sin(f.rot);
    const wx = f.x + dx * c + cz * s, wz = f.z - dx * s + cz * c, h = (back ? -Math.PI / 2 : Math.PI / 2) + tilt + f.rot;
    obs.push({ kind: 'poly', pts: carBox(wx, wz, h, L, W).map(q => q.map(r3)), name: 'parked car', h: 1.5, cls: 'car', label });
  }
  return { free, kept };
}

/** Whether car v fits a lot's bays (an empty string), or why not. Its nose may hang 30 cm over the back line and its
 *  tail 40 cm out of the mouth, as the bays' tolerances allow. */
export function lotFit(lot: Lot, v: Vehicle): string {
  const [Wb, D] = lot.size, room = D + 0.3 + 0.4 - 0.37;
  if (v.L > room + 1e-9) return `The ${v.short} is ${v.L.toFixed(2)} m long: too long for these ${D.toFixed(1)} m bays.`;
  if (v.W > Wb - 0.3) return `The ${v.short} is ${v.W.toFixed(2)} m wide: too wide for these ${Wb.toFixed(1)} m bays.`;
  return '';
}
