// Level templates. Each turns (level, seed) into a scene file, the parked poses that count, and the
// region the way in starts from. World frame as everywhere: x to the right, z down the plan, rear-axle
// poses, heading 0 drives to the right. The same template, level and seed always give the same scene.
import type { Pose } from '../planner';
import type { SceneObstacleSpec, SceneSpec } from '../scene';
import type { Vehicle } from '../vehicle';

export type TemplateId = 'bays-in' | 'bays-back' | 'kerb';
export const TEMPLATES: readonly TemplateId[] = ['bays-in', 'bays-back', 'kerb'];

/** Where a route into the level may start: a box for the rear axle and the heading to start at. */
export interface Region { x0: number; x1: number; z0: number; z1: number; th: number }
/** What a level number turned into, for measuring and for the level card. */
export type Knobs =
  | { kind: 'bays'; bay: number; aisle: number; neighbours: 'none' | 'neat' | 'off-centre'; opposite: boolean; pillar: '' | 'near side' | 'far side' }
  | { kind: 'kerb'; space: number; spare: number; lane: number; opposite: boolean; rearOut: number; post: number | null };
export interface Draft { spec: SceneSpec; goals: Pose[]; entry: Region; knobs: Knobs }

export function mulberry32(a: number): () => number { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// parked cars by size: length, width, how common, what the plan calls them
const CARS: [number, number, number, string][] = [
  [2.70, 1.66, 0.5, 'city car'], [4.06, 1.75, 5, 'hatchback'], [4.35, 1.83, 5, 'crossover'],
  [4.70, 1.83, 2, 'estate'], [5.00, 1.90, 1.5, 'saloon'], [5.90, 2.08, 0.4, 'pickup'],
];
const pickFrom = (rnd: () => number, list: typeof CARS) => {
  let tot = 0; for (const c of list) tot += c[2];
  let x = rnd() * tot; for (const c of list) { x -= c[2]; if (x <= 0) return c; }
  return list[1];
};

/** Corners of a car-sized box centred at (cx, cz) pointing along th. */
function carBox(cx: number, cz: number, th: number, L: number, W: number): number[][] {
  const c = Math.cos(th), s = Math.sin(th), P = (a: number, b: number) => [cx + a * c + b * s, cz - a * s + b * c];
  return [P(-L / 2, -W / 2), P(L / 2, -W / 2), P(L / 2, W / 2), P(-L / 2, W / 2)];
}
const rect = (x0: number, x1: number, z0: number, z1: number): number[][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function shell(id: string, name: string, lot: number[]): SceneSpec {
  return {
    format: 1, id, name, layoutVersion: 1, lot, areaView: lot,
    defaultBay: 'target', bays: {}, defaultStart: 'start', starts: {},
    lines: [], dashes: [], kerbs: [], floors: [lot], obstacles: [],
  };
}

/** Parallel parking at a kerb on your right. Level 1 ≈ 1.5 car lengths of space, level 10 = car length + 0.8 m. */
export function kerb(v: Vehicle, level: number, seed: number): Draft {
  const rnd = mulberry32(seed * 7919 + level), r = (a: number, b: number) => a + (b - a) * rnd(), t = (level - 1) / 9;
  const spare = 2.4 - 1.6 * t + r(-0.08, 0.08), G = v.L + spare;    // the space between the bumpers
  const laneW = 3.4 - 0.45 * t, parkW = 2.1, K = 0;                  // kerb line at z = 0, pavement below it
  const laneC = -parkW - laneW / 2, opposite = level >= 4;
  const farKerb = -parkW - 2 * laneW - (opposite ? parkW : 0);
  const X0 = -34, X1 = 30, lot = [X0, X1, farKerb - 3.8, 3.8];
  const spec = shell(`kerb-${level}-${seed}`, 'Parallel parking', lot), obs: SceneObstacleSpec[] = spec.obstacles;
  const cars: { x: number; z: number; L: number; W: number }[] = [];
  const place = (x0: number, c: (typeof CARS)[number], out: number, tilt: number, far: boolean, name = far ? 'car opposite' : 'parked car') => {
    const [L, W, , label] = c, z = far ? farKerb + 0.2 + W / 2 + out : K - 0.2 - W / 2 - out, th = (far ? Math.PI : 0) + tilt;
    obs.push({ kind: 'poly', pts: carBox(x0 + L / 2, z, th, L, W).map(p => p.map(r3)), name, h: 1.5, cls: 'car', label });
    cars.push({ x: x0 + L / 2, z, L, W });
  };
  // the gap runs from x = 0 to G: the car behind ends at 0, the car in front starts at G
  const rear = pickFrom(rnd, CARS), front = pickFrom(rnd, CARS);
  const rearOut = 0.05 + 0.35 * t * rnd(), rearTilt = -(0.5 + 2.5 * t) * rnd() * Math.PI / 180;
  place(-rear[0], rear, rearOut, rearTilt, false, 'car behind the space');
  place(G, front, 0.03 * rnd(), 0, false, 'car in front of the space');
  for (let x = -rear[0] - r(0.6, 1.2); x > -30;) { const c = pickFrom(rnd, CARS); place(x - c[0], c, 0.12 * rnd(), 0, false); x -= c[0] + r(0.6, 1.4); }
  for (let x = G + front[0] + r(0.6, 1.2); x < 24;) { const c = pickFrom(rnd, CARS); place(x, c, 0.12 * rnd(), 0, false); x += c[0] + r(0.6, 1.4); }
  if (opposite) for (let x = -30 + r(0, 2); x < 24;) { const c = pickFrom(rnd, CARS); if (rnd() < 0.85) place(x, c, 0.1 * rnd(), 0, true); x += c[0] + r(0.7, 2.5); }
  // buildings behind both pavements, a lamp post on the pavement from level 6
  obs.push({ kind: 'poly', pts: rect(X0, X1, 3.2, 3.8), name: 'building', h: 3, cls: 'wall' });
  obs.push({ kind: 'poly', pts: rect(X0, X1, farKerb - 3.8, farKerb - 3.2), name: 'building', h: 3, cls: 'wall' });
  let post: number | null = null;
  if (level >= 6 && rnd() < 0.7) { post = r(0.6, Math.max(0.7, G - 0.6)); obs.push({ kind: 'circle', x: r3(post), z: 0.55, r: 0.11, name: 'lamp post', h: 4, cls: 'wall' }); }
  spec.kerbs = [{ name: 'kerb', a: [X0, K], b: [X1, K], depth: 3.2 }, { name: 'far kerb', a: [X1, farKerb], b: [X0, farKerb], depth: 3.2 }];
  spec.dashes = [[X0, -parkW, X1, -parkW], [X0, -parkW - laneW, X1, -parkW - laneW]];
  if (opposite) spec.dashes.push([X0, farKerb + parkW, X1, farKerb + parkW]);
  // parked: between the cars with the tyres close to the kerb; the planner aims for the body 15–20 cm out
  const goals: Pose[] = [];
  for (const out of [0.15, 0.2]) for (let x = 0.3 + v.OVR; x <= G - 0.3 - (v.L - v.OVR) + 1e-9; x += 0.2) goals.push({ x: r3(x), z: r3(K - out - v.W / 2), th: 0 });
  if (!goals.length) goals.push({ x: r3((G - v.L) / 2 + v.OVR), z: r3(K - 0.15 - v.W / 2), th: 0 });
  spec.bays.target = {
    x0: 0, x1: r3(G), z0: -parkW, z1: K, headZ: -parkW, sideTol: 0, mouthTol: 0, inHeading: 0,
    face: 'in', kind: 'kerb', box: [-0.05, r3(G + 0.05), r3(K - 0.5 - v.W - 0.05), K + 0.1], goals,
  };
  return {
    spec, goals,
    entry: { x0: -16, x1: -4, z0: laneC - 0.45, z1: laneC - 0.1, th: 0 },   // a little out from the lane's middle, clear of the parked cars' mirrors
    knobs: { kind: 'kerb', space: G, spare, lane: laneW, opposite, rearOut: rearOut + 0.2, post },
  };
}

/** A row of 90° bays on your left, entered nose first or in reverse. */
export function bays(v: Vehicle, level: number, seed: number, back: boolean): Draft {
  const rnd = mulberry32(seed * 104729 + level * 31 + (back ? 0 : 7)), r = (a: number, b: number) => a + (b - a) * rnd(), t = (level - 1) / 9;
  const list = CARS.slice(0, 5);
  const Wb = 2.7 - 0.4 * t, D = 5.0, A = Math.max(5.0, 7.0 - 2.0 * t + r(-0.1, 0.1));
  const nB = 6, opposite = level >= 4, pillarSide = level >= 8 ? (rnd() < 0.5 ? -1 : 1) : 0;
  const X0 = -nB * Wb - Wb / 2 - 9, X1 = nB * Wb + Wb / 2 + 3, lot = [r3(X0), r3(X1), -D - 0.9, r3(A + D + 0.9)];
  const spec = shell(`${back ? 'bays-back' : 'bays-in'}-${level}-${seed}`, back ? 'Reverse into a bay' : 'Into a bay, nose first', lot), obs = spec.obstacles, lines = spec.lines;
  const parkIn = (bx: number, top: boolean, slop: number, toward: number, name: string) => {
    const [L, W, , label] = pickFrom(rnd, list), nose = rnd() < 0.5 ? 1 : -1;
    const th = (nose > 0 ? Math.PI / 2 : -Math.PI / 2) + (rnd() - 0.5) * 2 * slop * 4 * Math.PI / 180;
    const cx = bx + toward * slop * 0.28 * rnd(), cz = top ? -D / 2 - 0.1 : A + D / 2 + 0.1;
    obs.push({ kind: 'poly', pts: carBox(cx, cz, th, L, W).map(p => p.map(r3)), name, h: 1.5, cls: 'car', label });
  };
  for (let i = -nB; i <= nB; i++) {
    const bx = i * Wb;
    lines.push([bx - Wb / 2, -D, bx - Wb / 2, 0].map(r3));
    if (i === nB) lines.push([bx + Wb / 2, -D, bx + Wb / 2, 0].map(r3));
    if (i === 0) continue;
    const neighbour = Math.abs(i) === 1;
    const name = i === -1 ? 'car in the near bay' : i === 1 ? 'car in the far bay' : 'parked car';
    if ((neighbour && level >= 2) || (!neighbour && rnd() < 0.55 + 0.04 * level)) parkIn(bx, true, neighbour ? (Math.sign(i) === pillarSide ? 0.15 : t) : 0.2, Math.sign(i) === pillarSide ? 0 : -Math.sign(i), name);
  }
  lines.push([-nB * Wb - Wb / 2, -D, nB * Wb + Wb / 2, -D].map(r3));
  for (let i = -nB; i <= nB; i++) {
    const bx = i * Wb;
    lines.push([bx - Wb / 2, A, bx - Wb / 2, A + D].map(r3)); if (i === nB) lines.push([bx + Wb / 2, A, bx + Wb / 2, A + D].map(r3));
    if (opposite && rnd() < 0.55 + 0.04 * level) parkIn(bx, false, 0.3, 0, 'car opposite');
  }
  lines.push([-nB * Wb - Wb / 2, A + D, nB * Wb + Wb / 2, A + D].map(r3));
  obs.push({ kind: 'poly', pts: rect(X0, X1, -D - 0.9, -D - 0.35).map(p => p.map(r3)), name: 'wall', h: 2.5, cls: 'wall' });
  obs.push({ kind: 'poly', pts: rect(X0, X1, A + D + 0.35, A + D + 0.9).map(p => p.map(r3)), name: 'wall', h: 2.5, cls: 'wall' });
  if (pillarSide) obs.push({ kind: 'circle', x: r3(pillarSide * (Wb / 2 + 0.04)), z: -0.22, r: 0.17, name: 'pillar', h: 3, cls: 'wall' });
  // parked: centred, 35–65 cm from the back line, nose in or reversed in
  const z = back ? -D + 0.35 + v.OVR : -D + 0.35 + (v.L - v.OVR), th = back ? -Math.PI / 2 : Math.PI / 2;
  const goals: Pose[] = [0, 0.15, 0.3].map(d => ({ x: 0, z: r3(z + d), th }));
  spec.bays.target = { x0: r3(-Wb / 2), x1: r3(Wb / 2), z0: -D, z1: 0, headZ: -D - 0.25, sideTol: 0.05, mouthTol: 0.1, inHeading: Math.PI / 2, face: back ? 'out' : 'in', goals };
  return {
    spec, goals,
    entry: { x0: X0 + 1.5, x1: -Wb * 2.2, z0: 1.4, z1: A - 1.4, th: 0 },
    knobs: { kind: 'bays', bay: Wb, aisle: A, neighbours: level >= 2 ? (t > 0.3 ? 'off-centre' : 'neat') : 'none', opposite, pillar: pillarSide < 0 ? 'near side' : pillarSide > 0 ? 'far side' : '' },
  };
}

export function draft(v: Vehicle, id: TemplateId, level: number, seed: number): Draft {
  return id === 'kerb' ? kerb(v, level, seed) : bays(v, level, seed, id === 'bays-back');
}
