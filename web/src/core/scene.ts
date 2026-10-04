// A scene from its data file (content/scenes/*.json): what the car can touch, the painted lines,
// the bays it can park in and where it can start. World frame in metres, x to the right,
// z down the plan; rear-axle poses with heading th (0 = driving to the right, +90° = up the plan).
import { DEG, type Pt } from './math';

export type Rect = [number, number, number, number];   // [x0, x1, z0, z1]

/** What the car can touch. h is the height in metres (door mirrors only meet things taller than the car's mirror height). */
export type ObstacleClass = 'wall' | 'low' | 'lowwall' | 'car';
interface ObstacleBase { name: string; fill: string; h: number; cls: ObstacleClass; label: string; bx0: number; bx1: number; bz0: number; bz1: number; cx: number; cz: number }
export type Obstacle = (ObstacleBase & { kind: 'poly'; pts: Pt[] }) | (ObstacleBase & { kind: 'circle'; x: number; z: number; r: number });

/** A bay you can park in, and how strictly "parked" is judged. */
export interface Bay {
  x0: number; x1: number; z0: number; z1: number;   // painted lines
  headZ: number;                                    // how far in the car may reach (the wall behind a bench, say)
  sideTol: number; mouthTol: number;                // allowed over the side lines and out of the mouth
  inHeading: number;                                // heading when parked nose-in (radians); reversed in is the opposite
}
export interface Start { x: number; z: number; th: number; label: string }

/** The file format. */
export interface SceneSpec {
  format: 1; id: string; name: string; notes?: string[];
  layoutVersion: number;
  lot?: number[]; areaView: number[];
  defaultBay: string; bays: Record<string, Bay>;
  defaultStart: string; starts: Record<string, { x: number; z: number; th?: number; thDeg?: number; label?: string }>;
  lines: number[][];
  marks?: { text: (string | number)[][]; manhole?: number[] };
  floors?: number[][]; pit?: number[]; door?: number[];
  obstacles: SceneObstacleSpec[];
}
export type SceneObstacleSpec = ({ kind: 'poly'; pts: number[][] } | { kind: 'circle'; x: number; z: number; r: number }) & { name: string; fill?: string; h: number; cls: string; label?: string };

export interface Scene {
  readonly id: string; readonly name: string; readonly layoutVersion: number;
  readonly obstacles: readonly Obstacle[];
  readonly bays: Readonly<Record<string, Bay>>; readonly defaultBay: string;
  readonly starts: Readonly<Record<string, Start>>; readonly defaultStart: string;
  readonly lines: readonly [number, number, number, number][];
  readonly marks: { text: [string, number, number][]; manhole: Rect | null };
  readonly floors: readonly Rect[]; readonly pit: Rect | null; readonly door: [number, number] | null;
  readonly areaView: Rect; readonly lot: Rect | null;
}

const rect = (a: number[] | undefined): Rect | null => (a ? [a[0], a[1], a[2], a[3]] : null);

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
  const starts: Record<string, Start> = {};
  for (const [k, p] of Object.entries(s.starts)) starts[k] = { x: p.x, z: p.z, th: p.th ?? (p.thDeg ?? 0) * DEG, label: p.label ?? '' };
  return {
    id: s.id, name: s.name, layoutVersion: s.layoutVersion, obstacles,
    bays: s.bays, defaultBay: s.defaultBay, starts, defaultStart: s.defaultStart,
    lines: s.lines.map(l => [l[0], l[1], l[2], l[3]] as [number, number, number, number]),
    marks: { text: (s.marks?.text ?? []).map(t => [String(t[0]), Number(t[1]), Number(t[2])] as [string, number, number]), manhole: rect(s.marks?.manhole) },
    floors: (s.floors ?? []).map(f => rect(f)!), pit: rect(s.pit), door: s.door ? [s.door[0], s.door[1]] : null,
    areaView: rect(s.areaView)!, lot: rect(s.lot),
  };
}
