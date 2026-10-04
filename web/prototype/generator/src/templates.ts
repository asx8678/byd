// Scene templates. Each turns (level, seed) into obstacles, kerbs, painted lines, the parked
// target pose and the entry region the route has to start from. World frame as in the core:
// x to the right, z down the screen, rear-axle poses, heading 0 = driving to the right.
import { ATTO2 as CAR } from '../../../src/core/content';
import type { Obstacle, ObstacleClass } from '../../../src/core/scene';
import type { Pt } from '../../../src/core/math';
import type { Kerb } from './field';
import type { Pose } from './planner';

export type TemplateId = 'bays' | 'kerb';
export type WayIn = 'reverse' | 'forward';
export interface Landmark { name: string; x: number; z: number }
export interface ParkedCar { x: number; z: number; th: number; L: number; W: number }
export interface Scene {
  template: TemplateId; level: number; seed: number; way: WayIn;
  obstacles: Obstacle[]; kerbs: Kerb[]; cars: ParkedCar[];
  lines: [number, number, number, number][];          // painted lines x0, z0, x1, z1
  areas: { kind: 'pavement' | 'target' | 'wall'; pts: Pt[] }[];
  bounds: [number, number, number, number];           // x0, x1, z0, z1
  goal: Pose;                                          // the ideal parked pose (centred)
  goals: Pose[];                                       // every parked pose that counts as well parked
  entry: { x0: number; x1: number; z0: number; z1: number; th: number };
  side: 1 | -1;                                        // which way "towards the space" is when driving along: 1 right, -1 left
  sideWord: string;                                    // 'kerb' or 'bay'
  landmarks: Landmark[];
  knobs: Record<string, number | string>;              // what the level turned into, for the stats panel
}

export function mulberry32(a: number): () => number { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// rough class sizes for the parked cars (length, width)
const CARS: [number, number, number][] = [[2.70, 1.66, 0.5], [4.06, 1.75, 5], [4.35, 1.83, 5], [4.70, 1.83, 2], [5.00, 1.90, 1.5], [5.90, 2.08, 0.4]];

function mk(): { obs: Obstacle[]; poly: (pts: Pt[], name: string, h: number, cls: ObstacleClass) => void; circle: (x: number, z: number, r: number, name: string, h: number) => void } {
  const obs: Obstacle[] = [];
  const box = (xs: number[], zs: number[]) => { const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs); return { bx0, bx1, bz0, bz1, cx: (bx0 + bx1) / 2, cz: (bz0 + bz1) / 2 }; };
  return {
    obs,
    poly: (pts, name, h, cls) => obs.push({ kind: 'poly', pts, name, fill: '', h, cls, label: '', ...box(pts.map(p => p[0]), pts.map(p => p[1])) }),
    circle: (x, z, r, name, h) => obs.push({ kind: 'circle', x, z, r, name, fill: '', h, cls: 'wall', label: '', ...box([x - r, x + r], [z - r, z + r]) }),
  };
}
/** Corners of a car-sized box centred at (cx, cz) pointing along th. */
function carBox(cx: number, cz: number, th: number, L: number, W: number): Pt[] {
  const c = Math.cos(th), s = Math.sin(th), P = (a: number, b: number): Pt => [cx + a * c + b * s, cz - a * s + b * c];
  return [P(-L / 2, -W / 2), P(L / 2, -W / 2), P(L / 2, W / 2), P(-L / 2, W / 2)];
}
const rect = (x0: number, x1: number, z0: number, z1: number): Pt[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** Parallel parking at a kerb on your right. Level 1 ≈ 1.5 car lengths of space, level 10 = car length + 0.8 m. */
export function kerb(level: number, seed: number): Scene {
  const rnd = mulberry32(seed * 7919 + level), r = (a: number, b: number) => a + (b - a) * rnd(), t = (level - 1) / 9;
  const pick = () => { let tot = 0; for (const c of CARS) tot += c[2]; let x = rnd() * tot; for (const c of CARS) { x -= c[2]; if (x <= 0) return c; } return CARS[1]; };
  const { obs, poly, circle } = mk();
  const spare = 2.4 - 1.6 * t + r(-0.08, 0.08), G = CAR.L + spare;
  const laneW = 3.4 - 0.45 * t, parkW = 2.1, K = 0;                    // kerb line at z = 0, pavement below
  const laneC = -parkW - laneW / 2, farParked = level >= 4;
  const farKerb = -parkW - 2 * laneW - (farParked ? parkW : 0);
  const cars: ParkedCar[] = [], lines: Scene['lines'] = [];
  const place = (x0: number, L: number, W: number, out: number, tilt: number, far: boolean, name = far ? 'a car opposite' : 'a parked car') => {
    const z = far ? farKerb + 0.2 + W / 2 + out : K - 0.2 - W / 2 - out, th = (far ? Math.PI : 0) + tilt;
    poly(carBox(x0 + L / 2, z, th, L, W), name, 1.5, 'car');
    cars.push({ x: x0 + L / 2, z, th, L, W });
  };
  // the gap from x = 0 to G, the car behind ends at 0, the car in front starts at G
  const [Lr, Wr] = pick(), [Lf, Wf] = pick();
  const rearOut = 0.05 + 0.35 * t * rnd(), rearTilt = -(0.5 + 2.5 * t) * rnd() * Math.PI / 180;
  place(-Lr, Lr, Wr, rearOut, rearTilt, false, 'the car behind the space');
  place(G, Lf, Wf, 0.03 * rnd(), 0, false, 'the car in front of the space');
  for (let x = -Lr - r(0.6, 1.2); x > -30;) { const [L, W] = pick(); place(x - L, L, W, 0.12 * rnd(), 0, false); x -= L + r(0.6, 1.4); }
  for (let x = G + Lf + r(0.6, 1.2); x < 24;) { const [L, W] = pick(); place(x, L, W, 0.12 * rnd(), 0, false); x += L + r(0.6, 1.4); }
  if (farParked) for (let x = -30 + r(0, 2); x < 24;) { const [L, W] = pick(); if (rnd() < 0.85) place(x, L, W, 0.1 * rnd(), 0, true); x += L + r(0.7, 2.5); }
  // pavement, buildings, a post on the pavement from level 6
  poly(rect(-34, 30, 3.2, 3.8), 'a building', 3, 'wall');
  poly(rect(-34, 30, farKerb - 3.8, farKerb - 3.2), 'a building', 3, 'wall');
  let post = '';
  if (level >= 6 && rnd() < 0.7) { const px = r(0.6, Math.max(0.7, G - 0.6)); circle(px, 0.55, 0.11, 'the lamp post', 4); post = `${px.toFixed(1)} m into the space`; }
  lines.push([-34, -parkW, 30, -parkW]);                               // edge of the parking lane
  lines.push([-34, -parkW - laneW, 30, -parkW - laneW]);               // centre line (dashed when drawn)
  if (farParked) lines.push([-34, farKerb + parkW, 30, farKerb + parkW]);
  const goalZ = K - 0.25 - CAR.W / 2;
  const goal: Pose = { x: (G - CAR.L) / 2 + CAR.OVR, z: goalZ, th: 0 };
  // anywhere along the space with at least 30 cm to the cars in front and behind
  const goals: Pose[] = []; for (let x = 0.3 + CAR.OVR; x <= G - 0.3 - (CAR.L - CAR.OVR) + 1e-9; x += 0.2) goals.push({ x, z: goalZ, th: 0 });
  if (!goals.length) goals.push(goal);
  const frontCar = cars[1], rearCar = cars[0];
  return {
    template: 'kerb', level, seed, way: 'reverse', obstacles: obs, cars, lines, goals,
    kerbs: [{ nx: 0, nz: 1, c: K, name: 'the kerb' }, { nx: 0, nz: -1, c: -farKerb, name: 'the far kerb' }],
    areas: [{ kind: 'pavement', pts: rect(-34, 30, K, 3.2) }, { kind: 'pavement', pts: rect(-34, 30, farKerb - 3.2, farKerb) }, { kind: 'target', pts: rect(0.1, G - 0.1, -parkW + 0.05, -0.05) }],
    bounds: [-30, 24, farKerb - 3.8, 3.8], goal,
    entry: { x0: -16, x1: -4, z0: laneC - 0.45, z1: laneC + 0.45, th: 0 },
    side: 1, sideWord: 'kerb',
    landmarks: [
      { name: "the front car's rear bumper", x: G, z: frontCar.z - frontCar.W / 2 },
      { name: "the rear car's front bumper", x: 0, z: rearCar.z - rearCar.W / 2 },
    ],
    knobs: { space: `${G.toFixed(2)} m (car + ${spare.toFixed(2)} m)`, lane: `${laneW.toFixed(2)} m`, opposite: farParked ? 'parked cars' : 'open lane', 'car behind': `${(rearOut + 0.2).toFixed(2)} m from the kerb`, post: post || 'none' },
  };
}

/** A row of 90° bays on your left, entered forwards or in reverse. */
export function bays(level: number, seed: number, way: WayIn): Scene {
  const rnd = mulberry32(seed * 104729 + level * 31 + (way === 'forward' ? 7 : 0)), r = (a: number, b: number) => a + (b - a) * rnd(), t = (level - 1) / 9;
  const pick = () => { let tot = 0; for (const c of CARS.slice(0, 5)) tot += c[2]; let x = rnd() * tot; for (const c of CARS.slice(0, 5)) { x -= c[2]; if (x <= 0) return c; } return CARS[1]; };
  const { obs, poly, circle } = mk();
  const Wb = 2.7 - 0.4 * t, D = 5.0, A = Math.max(5.0, 7.0 - 2.0 * t + r(-0.1, 0.1));
  const cars: ParkedCar[] = [], lines: Scene['lines'] = [];
  const nB = 6, oppo = level >= 4, pillarSide = level >= 8 ? (rnd() < 0.5 ? -1 : 1) : 0;
  const parkIn = (bx: number, top: boolean, slop: number, toward: number, name: string) => {
    const [L, W] = pick(), nose = rnd() < 0.5 ? 1 : -1;
    const th = (nose > 0 ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 2 * slop * 4 * Math.PI / 180;
    const cx = bx + toward * slop * 0.28 * rnd(), cz = top ? -D / 2 - 0.1 : A + D / 2 + 0.1;
    poly(carBox(cx, cz, th, L, W), name, 1.5, 'car');
    cars.push({ x: cx, z: cz, th, L, W });
  };
  for (let i = -nB; i <= nB; i++) {
    const bx = i * Wb;
    lines.push([bx - Wb / 2, -D, bx - Wb / 2, 0]);
    if (i === nB) lines.push([bx + Wb / 2, -D, bx + Wb / 2, 0]);
    if (i === 0) continue;
    const neighbour = Math.abs(i) === 1;
    const name = i === -1 ? 'the car in the near bay' : i === 1 ? 'the car in the far bay' : 'a parked car';
    if ((neighbour && level >= 2) || (!neighbour && rnd() < 0.55 + 0.04 * level)) parkIn(bx, true, neighbour ? (Math.sign(i) === pillarSide ? 0.15 : t) : 0.2, Math.sign(i) === pillarSide ? 0 : -Math.sign(i), name);
  }
  lines.push([-nB * Wb - Wb / 2, -D, nB * Wb + Wb / 2, -D]);
  for (let i = -nB; i <= nB; i++) {
    const bx = i * Wb;
    lines.push([bx - Wb / 2, A, bx - Wb / 2, A + D]); if (i === nB) lines.push([bx + Wb / 2, A, bx + Wb / 2, A + D]);
    if (oppo && rnd() < 0.55 + 0.04 * level) parkIn(bx, false, 0.3, 0, 'a car opposite');
  }
  lines.push([-nB * Wb - Wb / 2, A + D, nB * Wb + Wb / 2, A + D]);
  const X0 = -nB * Wb - Wb / 2 - 9, X1 = nB * Wb + Wb / 2 + 3;
  poly(rect(X0, X1, -D - 0.9, -D - 0.35), 'the wall', 2.5, 'wall');
  poly(rect(X0, X1, A + D + 0.35, A + D + 0.9), 'the wall', 2.5, 'wall');
  let pillar = '';
  if (pillarSide) { circle(pillarSide * (Wb / 2 + 0.04), -0.22, 0.17, 'the pillar', 3); pillar = pillarSide < 0 ? 'near side' : 'far side'; }
  const goal: Pose = way === 'reverse'
    ? { x: 0, z: -D + 0.35 + CAR.OVR, th: -Math.PI / 2 }
    : { x: 0, z: -D + 0.35 + (CAR.L - CAR.OVR), th: Math.PI / 2 };
  // centred, 35–65 cm from the back line
  const goals: Pose[] = [0, 0.15, 0.3].map(d => ({ ...goal, z: goal.z + d }));
  return {
    template: 'bays', level, seed, way, obstacles: obs, kerbs: [], cars, lines, goals,
    areas: [{ kind: 'target', pts: rect(-Wb / 2 + 0.06, Wb / 2 - 0.06, -D + 0.06, -0.06) }],
    bounds: [X0, X1, -D - 0.9, A + D + 0.9], goal,
    entry: { x0: X0 + 1.5, x1: -Wb * 2.2, z0: 1.4, z1: A - 1.4, th: 0 },
    side: -1, sideWord: 'bay',
    landmarks: [
      { name: 'the near bay line', x: -Wb / 2, z: 0 },
      { name: 'the far bay line', x: Wb / 2, z: 0 },
    ],
    knobs: { bay: `${Wb.toFixed(2)} m wide`, aisle: `${A.toFixed(2)} m`, neighbours: level >= 2 ? (t > 0.3 ? 'parked off-centre' : 'parked neatly') : 'none', opposite: oppo ? 'parked cars' : 'empty bays', pillar: pillar || 'none' },
  };
}

export function build(id: TemplateId, level: number, seed: number, way: WayIn): Scene { return id === 'kerb' ? kerb(level, seed) : bays(level, seed, way); }
