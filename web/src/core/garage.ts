// The garage around bay 561, in metres.
// x → right along the bays as you face the 561 wall, z → towards the aisle and on across it. Bay 561 is centred on x=0;
// the wall of the 561/562 technical room is z=0 and the aisle line of the bays is z=5.15.
// The layout is a photo survey (scaled from the Atto 2's rear track and wheelbase, the Clio's track and the drain cover),
// kept in that survey's frame so the numbers can be checked against it: u to the right from the 560|561 line,
// v from the aisle line towards the 561 wall. SU/SV turn it into world x/z.
import { DEG, type Pt } from './math';
import { carCorners } from './car';

export const SU = (u: number): number => u - 1.205;
export const SV = (v: number): number => 5.15 - v;
export const LAYOUT_V = 2;
export const FRONT_Z = SV(0);
export const LOT = { x0: -11.9, x1: 17.1, z0: -5.1, z1: 14.4 } as const;

export interface Bay { x0: number; x1: number; z0: number; z1: number }
export const BAYS: Record<string, Bay> = {
  '561': { x0: SU(0), x1: SU(2.41), z0: SV(4.72), z1: FRONT_Z },
  '560': { x0: SU(-2.35), x1: SU(0), z0: SV(4.5), z1: FRONT_Z },
};
// Painted lines, 10 cm wide: aisle line of 559–561, the bay sides, the head of 561 and inner edge of 562, the parallel spot 562,
// the back of 560 with the double line behind the pillar, 559, the 208's place. Each is [x0, z0, x1, z1].
export const LINES: [number, number, number, number][] = ([
  [-5.05, 0, 2.41, 0], [0, 0, 0, 4.72], [2.41, 0, 2.41, 4.72], [0, 4.72, 7.9, 4.72], [2.41, 2.44, 7.9, 2.44], [7.9, 2.44, 7.9, 4.72],
  [-2.35, 4.5, 0, 4.5], [-2.35, 2.2, -2.35, 4.5], [-2.63, 2.2, -2.63, 4.5], [-5.05, 4.5, -2.63, 4.5], [-5.05, 0, -5.05, 4.5], [-3.75, -2.6, -8.6, -2.6],
] as const).map(([u0, v0, u1, v1]) => [SU(u0), SV(v0), SU(u1), SV(v1)]);
export const MARKS = {
  text: [['559', SU(-3.85), SV(0.55)], ['560', SU(-1.17), SV(0.55)], ['561', SU(1.205), SV(0.55)]] as [string, number, number][],
  manhole: [SU(1.04), SU(1.59), SV(-1.47), SV(-1.97)] as Rect,
};
export type Rect = [number, number, number, number];   // [x0, x1, z0, z1]
export const FLOORS: Rect[] = [[LOT.x0, LOT.x1, LOT.z0, SV(-5.25)], [SU(5.6), LOT.x1, SV(-5.25), LOT.z1]];
export const PIT: Rect = [SU(-2.26), SU(5.6), SV(-5.25), SV(-11.5)];   // the lower level seen over the low wall
export const DOOR: [number, number] = [SU(4.06) - 0.53, SU(4.06) + 0.53];

export type StartName = 'left' | 'right' | 'across';
export const STARTS: Record<StartName, [number, number, number]> = {   // rear-axle pose [x, z, heading]
  left: [-8.6, 6.45, 0], right: [SU(7.0), SV(-0.42), Math.PI], across: [SU(3.3), SV(-3.35), 125 * DEG],
};

/** What the car can touch. h is the height in metres (door mirrors only meet things taller than MIRROR_Y). */
export type ObstacleClass = 'wall' | 'low' | 'lowwall' | 'car';
interface ObstacleBase { name: string; fill: string; h: number; cls: ObstacleClass; label: string; bx0: number; bx1: number; bz0: number; bz1: number; cx: number; cz: number }
export type Obstacle = (ObstacleBase & { kind: 'poly'; pts: Pt[] }) | (ObstacleBase & { kind: 'circle'; x: number; z: number; r: number });
type Shape = { kind: 'poly'; pts: Pt[] } | { kind: 'circle'; x: number; z: number; r: number };

export function buildObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const reg = (shape: Shape, name: string, fill: string, h: number, cls: ObstacleClass, label = ''): void => {   // bounding box for quick culling, centre for labels
    let bx0, bx1, bz0, bz1;
    if (shape.kind === 'poly') { const xs = shape.pts.map(p => p[0]), zs = shape.pts.map(p => p[1]); bx0 = Math.min(...xs); bx1 = Math.max(...xs); bz0 = Math.min(...zs); bz1 = Math.max(...zs); }
    else { bx0 = shape.x - shape.r; bx1 = shape.x + shape.r; bz0 = shape.z - shape.r; bz1 = shape.z + shape.r; }
    obstacles.push({ ...shape, name, fill, h, cls, label, bx0, bx1, bz0, bz1, cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2 });
  };
  const addRect = (x0: number, x1: number, z0: number, z1: number, name: string, fill: string, h = 2.6, cls: ObstacleClass = 'wall') =>
    reg({ kind: 'poly', pts: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] }, name, fill, h, cls);
  const addCircle = (cx: number, cz: number, r: number, name: string, fill: string, h = 1, cls: ObstacleClass = 'low') =>
    reg({ kind: 'circle', x: cx, z: cz, r }, name, fill, h, cls);
  const rectS = (u0: number, u1: number, v0: number, v1: number, name: string, h?: number, cls?: ObstacleClass) =>   // in survey coordinates
    addRect(SU(Math.min(u0, u1)), SU(Math.max(u0, u1)), SV(Math.max(v0, v1)), SV(Math.min(v0, v1)), name, '', h, cls);
  const parkCar = (spec: { L: number; W: number; H: number; WB: number; label?: string }, cx: number, cz: number, heading: number, name: string) => {
    const OVR = 0.827 * (spec.L / 4.33), half = spec.L / 2 - OVR;   // parked cars keep the Atto 2's overhang ratio
    const ax = cx - Math.cos(heading) * half, az = cz + Math.sin(heading) * half;
    reg({ kind: 'poly', pts: carCorners(ax, az, heading, spec.L, spec.W, spec.WB, OVR) }, name, '', spec.H, 'car', spec.label ?? '');
  };

  addRect(SU(-0.79), SU(5.49), SV(8.15), 0, 'wall of the 561/562 room', '', 2.25);   // the technical room: its wall is the head of 561 and 562
  addRect(SU(1.38), SU(3.21), 0, SV(4.82), 'concrete bench', '', 0.5, 'low');
  // back walls: behind 559 and 560 the wall stands 0.25 m further back than the room; the alcove with the bins is left of 559
  rectS(-5.05, -0.79, 5.40, 5.62, 'back wall'); rectS(-5.27, -5.05, 5.40, 7.77, 'back wall'); rectS(-10.4, -5.05, 7.55, 7.77, 'back wall');
  rectS(-10.62, -10.4, -5.25, 7.77, 'end wall');
  rectS(-2.63, -2.35, 0.05, 2.20, 'pillar 560');   // a long wall stub between 559 and 560 from the aisle line back
  // the far side of the aisle: full wall on the left (the 208 stands against it), then a low wall over the lower level
  rectS(-10.4, -2.86, -5.25, -4.85, 'wall'); rectS(-2.86, -2.26, -5.6, -4.79, 'pillar');
  rectS(-2.26, 5.6, -5.25, -5.05, 'low wall', 1.6, 'lowwall'); rectS(5.6, 6.1, -5.65, -5.05, 'pillar');
  // right of 561: the pillar by 562 with its bike hoop, and one in the aisle, the way out between them
  rectS(5.2, 5.7, -2.1, -1.6, 'pillar'); rectS(4.6, 5.35, 0.78, 1.53, 'pillar by 562');
  addRect(SU(5.38), SU(5.86), SV(1.48), SV(1.38), 'bike hoop', '#9aa0a6', 0.65, 'low');
  // the rest of the garage to the right, and its outer walls
  for (const pu of [10.05, 15.05]) for (const pv of [-6.0, 0.7, 6.6]) rectS(pu, pu + 0.5, pv, pv + 0.6, 'pillar');
  rectS(6.1, 18.2, -9.2, -9.0, 'wall'); rectS(18.0, 18.2, -9.2, 10.2, 'wall'); rectS(5.49, 18.2, 10.0, 10.2, 'wall'); rectS(5.49, 5.69, 8.15, 10.0, 'wall');
  for (const [tu, tv] of [[8.7, 7.4], [9.45, 7.85]]) addCircle(SU(tu), SV(tv), 0.3, 'blue tank', '#2b7bd6', 1.05, 'low');
  rectS(-7.2, -6.0, 5.9, 6.65, 'green bins', 1.1, 'low'); rectS(-2.25, -1.8, 5.0, 5.38, 'grey bin', 0.5, 'low');
  // parked cars: the black Peugeot 208 at the left end, the grey Clio past the pillars on the right, and the rest of the garage
  parkCar({ L: 4.055, W: 1.745, H: 1.43, WB: 2.54, label: 'Peugeot 208' }, SU(-3.85 - 4.055 / 2), SV(-3.6), 0, 'black Peugeot 208');
  parkCar({ L: 4.03, W: 1.72, H: 1.49, WB: 2.575, label: 'Clio' }, SU(5.05 + 4.03 / 2), SV(-3.5), 0, 'grey Clio');
  parkCar({ L: 4.63, W: 1.89, H: 1.71, WB: 2.77 }, SU(12.6), SV(3.7), Math.PI / 2, 'parked SUV');
  parkCar({ L: 3.92, W: 1.65, H: 1.47, WB: 2.46 }, SU(12.6), SV(-2.6), -Math.PI / 2, 'white car');
  parkCar({ L: 4.76, W: 1.82, H: 1.43, WB: 2.82 }, SU(15.6), SV(3.7), Math.PI / 2, 'black saloon');
  parkCar({ L: 4.37, W: 1.90, H: 1.63, WB: 2.66 }, SU(15.6), SV(-2.6), -Math.PI / 2, 'white SUV');
  parkCar({ L: 4.76, W: 1.82, H: 1.43, WB: 2.82 }, SU(12.7), SV(-6.9), Math.PI / 2, 'black saloon');
  return obstacles;
}
