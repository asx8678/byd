// A scene from its data file (content/scenes/*.json) or from the level generator: what the car can touch,
// the painted lines, the bays it can park in and where it can start. World frame in metres, x to the right,
// z down the plan; rear-axle poses with heading th (0 = driving to the right, +90° = up the plan).
import type { CityLayers } from './city';
import type { Network } from './traffic';
import { DEG, type Pt } from './math';

export type Rect = [number, number, number, number];   // [x0, x1, z0, z1]

/** What the car can touch. h is the height in metres (door mirrors only meet things taller than the car's mirror height).
 *  A kerb only meets the wheels: the bumpers hang over it. */
export type ObstacleClass = 'wall' | 'low' | 'lowwall' | 'car' | 'kerb';
interface ObstacleBase { name: string; fill: string; h: number; cls: ObstacleClass; label: string; bx0: number; bx1: number; bz0: number; bz1: number; cx: number; cz: number }
export type Obstacle = (ObstacleBase & { kind: 'poly'; pts: Pt[] }) | (ObstacleBase & { kind: 'circle'; x: number; z: number; r: number });

/** A kerb as the route planner sees it: the wheels keep nx·x + nz·z ≤ c. It runs from a to b: on a map with many
 *  streets a kerb only counts for a wheel beside it (see besideKerb). */
export interface Kerb { nx: number; nz: number; c: number; name: string; a: Pt; b: Pt }

/** Whether a point is beside a kerb: level with it somewhere between its ends (20 cm to spare), and less than 6 m out
 *  from it (or up to a metre over it), so that a kerb across a block or on another street does not count. */
export function besideKerb(k: Kerb, x: number, z: number): boolean {
  const ux = k.b[0] - k.a[0], uz = k.b[1] - k.a[1], l = Math.hypot(ux, uz), t = ((x - k.a[0]) * ux + (z - k.a[1]) * uz) / l;
  if (t < -0.2 || t > l + 0.2) return false;
  const g = k.c - (k.nx * x + k.nz * z);
  return g > -1 && g < 6;
}

/** A space you can park in, and how strictly "parked" is judged. */
export interface Bay {
  x0: number; x1: number; z0: number; z1: number;   // painted lines (a kerb space: the gap between the cars)
  headZ: number;                                    // how far in the car may reach (the wall behind a bench, say)
  sideTol: number; mouthTol: number;                // allowed over the side lines and out of the mouth
  inHeading: number;                                // heading when parked nose-in (radians); reversed in is the opposite
  /** Which way round counts: nose in, reversed in ('out'), or either (the default). */
  face?: 'in' | 'out' | 'either';
  /** 'kerb' for a space along a kerb: the result gives the tyres' gap to the kerb. 'exit' for a stretch of lane to
   *  drive out into (leaving a space): parked there means in it and straight. */
  kind?: 'bay' | 'kerb' | 'exit';
  /** Where all four corners must be, [x0, x1, z0, z1]. By default the lines widened by the tolerances, back to headZ. */
  box?: Rect;
  /** Rear-axle poses that count as well parked, for the route planner. By default worked out from the lines. */
  goals?: { x: number; z: number; th: number }[];
  /** A bay turned on the map (a car park's, at any angle): then all its numbers, the box and goals included, are in its
   *  own frame, in which it opens towards +z like every other bay. The frame's origin is at (x, z) on the map and its
   *  x axis points along heading rot, so a heading th in the bay is th + rot on the map. */
  frame?: { x: number; z: number; rot: number };
  /** A space for a trailer: the trailer's box is judged (all four corners in, straight), not the car pulling it. */
  towed?: boolean;
}

/** A map pose [x, z, th] in a bay's own frame (the same numbers for a bay without one). */
export function toBay(b: Bay, x: number, z: number, th: number): [number, number, number] {
  const f = b.frame;
  if (!f) return [x, z, th];
  const c = Math.cos(f.rot), s = Math.sin(f.rot), dx = x - f.x, dz = z - f.z;
  return [dx * c - dz * s, dx * s + dz * c, th - f.rot];
}
/** A pose [x, z, th] in a bay's own frame on the map (the same numbers for a bay without one). */
export function fromBay(b: Bay, x: number, z: number, th = 0): [number, number, number] {
  const f = b.frame;
  if (!f) return [x, z, th];
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  return [f.x + x * c + z * s, f.z - x * s + z * c, th + f.rot];
}
/** A rectangle [x0, x1, z0, z1] in a bay's own frame as four points on the map. */
export const bayRect = (b: Bay, [x0, x1, z0, z1]: Rect): Pt[] => ([[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as Pt[]).map(([x, z]) => { const q = fromBay(b, x, z); return [q[0], q[1]] as Pt; });
export interface Start { x: number; z: number; th: number; label: string }

/** The file format. */
export interface SceneSpec {
  format: 1; id: string; name: string; notes?: string[];
  layoutVersion: number;
  lot?: number[]; areaView: number[];
  defaultBay: string; bays: Record<string, Bay>;
  defaultStart: string; starts: Record<string, { x: number; z: number; th?: number; thDeg?: number; label?: string }>;
  lines: number[][];
  /** Dashed white lines: lane edges and centre lines. */
  dashes?: number[][];
  /** Kerbs from a to b, with the pavement on the right of a → b, depth metres deep. */
  kerbs?: { name: string; a: number[]; b: number[]; depth?: number }[];
  /** Things a coach can line the car up with, besides the bay lines and parked cars it finds itself. */
  landmarks?: { name: string; x: number; z: number }[];
  marks?: { text: (string | number)[][]; manhole?: number[] };
  floors?: number[][]; pit?: number[]; door?: number[];
  obstacles: SceneObstacleSpec[];
}
export type SceneObstacleSpec = ({ kind: 'poly'; pts: number[][] } | { kind: 'circle'; x: number; z: number; r: number }) & { name: string; fill?: string; h: number; cls: string; label?: string };

export interface Scene {
  readonly id: string; readonly name: string; readonly layoutVersion: number;
  readonly obstacles: readonly Obstacle[];
  readonly kerbs: readonly Kerb[];
  readonly bays: Readonly<Record<string, Bay>>; readonly defaultBay: string;
  readonly starts: Readonly<Record<string, Start>>; readonly defaultStart: string;
  readonly lines: readonly [number, number, number, number][];
  readonly dashes: readonly [number, number, number, number][];
  readonly landmarks: readonly { name: string; x: number; z: number }[];
  readonly marks: { text: [string, number, number][]; manhole: Rect | null };
  readonly floors: readonly Rect[]; readonly pit: Rect | null; readonly door: [number, number] | null;
  readonly areaView: Rect; readonly lot: Rect | null;
  /** A street map's extra layers for the plan (core/city.ts); none in a car park or a level. */
  readonly city?: CityLayers;
  /** A street map's road network, once its traffic has been made: replays and rewinds make their traffic on it again. */
  net?: Network;
}

const rect = (a: number[] | undefined): Rect | null => (a ? [a[0], a[1], a[2], a[3]] : null);
const seg = (l: number[]) => [l[0], l[1], l[2], l[3]] as [number, number, number, number];

export function makeScene(s: SceneSpec): Scene {
  const obstacles: Obstacle[] = s.obstacles.map(o => {
    const base = { name: o.name, fill: o.fill ?? '', h: o.h, cls: o.cls as ObstacleClass, label: o.label ?? '' };
    if (o.kind === 'poly') {
      const pts = o.pts.map(([x, z]): Pt => [x, z]), xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs);
      return { kind: 'poly', pts, ...base, bx0, bx1, bz0, bz1, cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2 };
    }
    const bx0 = o.x - o.r, bx1 = o.x + o.r, bz0 = o.z - o.r, bz1 = o.z + o.r;
    return { kind: 'circle', x: o.x, z: o.z, r: o.r, ...base, bx0, bx1, bz0, bz1, cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2 };
  });
  // each kerb is a half-plane for the planner and a strip of pavement that only the wheels can touch
  const kerbs: Kerb[] = [];
  for (const k of s.kerbs ?? []) {
    const [ax, az] = k.a, [bx, bz] = k.b, l = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / l, nz = (bx - ax) / l, d = k.depth ?? 2;
    kerbs.push({ nx, nz, c: nx * ax + nz * az, name: k.name, a: [ax, az], b: [bx, bz] });
    const pts: Pt[] = [[ax, az], [bx, bz], [bx + nx * d, bz + nz * d], [ax + nx * d, az + nz * d]], xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs);
    obstacles.push({ kind: 'poly', pts, name: k.name, fill: '', h: 0.12, cls: 'kerb', label: '', bx0, bx1, bz0, bz1, cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2 });
  }
  const starts: Record<string, Start> = {};
  for (const [k, p] of Object.entries(s.starts)) starts[k] = { x: p.x, z: p.z, th: p.th ?? (p.thDeg ?? 0) * DEG, label: p.label ?? '' };
  return {
    id: s.id, name: s.name, layoutVersion: s.layoutVersion, obstacles, kerbs,
    bays: s.bays, defaultBay: s.defaultBay, starts, defaultStart: s.defaultStart,
    lines: s.lines.map(seg), dashes: (s.dashes ?? []).map(seg), landmarks: (s.landmarks ?? []).map(l => ({ name: l.name, x: l.x, z: l.z })),
    marks: { text: (s.marks?.text ?? []).map(t => [String(t[0]), Number(t[1]), Number(t[2])] as [string, number, number]), manhole: rect(s.marks?.manhole) },
    floors: (s.floors ?? []).map(f => rect(f)!), pit: rect(s.pit), door: s.door ? [s.door[0], s.door[1]] : null,
    areaView: rect(s.areaView)!, lot: rect(s.lot),
  };
}
