// What a route means: moves, clearance, difficulty, and the coach's words for it.
import { collides } from '../../../src/core/collision';
import { ATTO2 as CAR } from '../../../src/core/content';
import { DEG, clamp } from '../../../src/core/math';
import type { Field } from './field';
import { moves, sample, wrap, type Piece, type Pose } from './planner';
import type { Scene } from './templates';

export interface Measure { moves: number; length: number; minClear: number; spare: number; score: number }
export interface CoachStep { n: number; text: string; detail: string; dir: 1 | -1; lvl: number; len: number; end: Pose; pieceEnd: number }

/** Re-check a route with the game's exact collision test (and the kerbs). */
export function exactCheck(scene: Scene, field: Field, pieces: Piece[]): string | null {
  for (const q of sample(pieces, 0.05)) {
    const hit = collides(CAR, scene.obstacles, q.x, q.z, q.th);
    if (hit) return hit.obstacle.name + (hit.part ? ` (${hit.part})` : '');
    if (!field.wheelsOk(q.x, q.z, q.th)) return 'the kerb';
  }
  return null;
}

export function measure(scene: Scene, field: Field, pieces: Piece[]): Measure {
  // the tightest moment on the approach, before the car is over the space (the space's own size is scored separately)
  const pts = sample(pieces, 0.1), end = pts[pts.length - 1];
  const T = scene.areas.find(a => a.kind === 'target')!.pts, tx0 = Math.min(...T.map(p => p[0])), tx1 = Math.max(...T.map(p => p[0])), tz0 = Math.min(...T.map(p => p[1])), tz1 = Math.max(...T.map(p => p[1]));
  let minClear = Infinity;
  for (const q of pts) {
    const cx = q.x + 1.34 * Math.cos(q.th), cz = q.z - 1.34 * Math.sin(q.th);
    if (cx > tx0 && cx < tx1 && cz > tz0 && cz < tz1) continue;
    minClear = Math.min(minClear, field.clearance(q.x, q.z, q.th));
  }
  if (!isFinite(minClear)) minClear = field.clearance(end.x, end.z, end.th);
  const length = pieces.reduce((s, p) => s + p.len, 0), m = moves(pieces);
  const k = scene.knobs;
  let spare: number, tpl: number, base: number;
  if (scene.template === 'kerb') {
    spare = parseFloat(String(k.space).split('+ ')[1]);
    tpl = 5 * clamp((2.4 - spare) / 1.6, 0, 1); base = 2;
  } else {
    const Wb = parseFloat(String(k.bay)), A = parseFloat(String(k.aisle));
    spare = Wb - CAR.W;
    tpl = 2.6 * clamp((7 - A) / 2, 0, 1) + 2.6 * clamp((2.7 - Wb) / 0.4, 0, 1); base = scene.way === 'forward' ? 1 : 2;
  }
  const score = clamp(1 + 1.7 * Math.max(0, m - base) + 2.0 * clamp((0.6 - minClear) / 0.5, 0, 1) + tpl, 1, 10);
  return { moves: m, length, minClear, spare, score };
}

// parts of the car a driver can see, in the rear-axle frame (x forward, z right); s = the space's side
const parts = (s: number) => [
  { name: 'your mirror', x: 1.875, z: s * 0.97 },
  { name: 'your rear wheel', x: 0, z: s * 0.785 },
  { name: 'your rear bumper', x: -0.8, z: 0 },
  { name: 'your front bumper', x: 3.45, z: 0 },
];
const fmt = (m: number) => m < 0.95 ? `${Math.round(m * 100 / 5) * 5} cm` : `${m.toFixed(1)} m`;
const steerWords = (lvl: number, scene: Scene) => {
  if (lvl === 0) return 'wheels straight';
  const how = Math.abs(lvl) === 1 ? 'full lock' : 'half lock';
  return `${how} ${Math.sign(lvl) === scene.side ? 'towards' : 'away from'} the ${scene.sideWord}`;
};

/** The obstacle nearest the car's outline at a pose, and how far it is. */
function nearest(scene: Scene, p: Pose, dir: 1 | -1): { name: string; d: number } {
  // first what is straight ahead in the direction of travel, then the closest thing all round
  const c0 = Math.cos(p.th), s0 = Math.sin(p.th);
  for (let g = 0.05; g <= 2; g += 0.05) {
    const hit = collides(CAR, scene.obstacles, p.x + dir * g * c0, p.z - dir * g * s0, p.th);
    if (hit) return { name: hit.obstacle.name, d: g };
  }
  for (let g = 0.05; g <= 1.5; g += 0.05) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [0.7, -0.7], [-0.7, 0.7], [-0.7, -0.7]]) {
      const c = Math.cos(p.th), s = Math.sin(p.th), wx = p.x + (dx * c + dz * s) * g, wz = p.z + (-dx * s + dz * c) * g;
      const hit = collides(CAR, scene.obstacles, wx, wz, p.th);
      if (hit) return { name: hit.obstacle.name, d: g };
    }
  }
  return { name: '', d: Infinity };
}

function landmarkCue(scene: Scene, p: Pose): string {
  const c = Math.cos(p.th), s = Math.sin(p.th);
  let best: { t: string; a: number } | null = null;
  for (const P of parts(scene.side)) {
    const px = p.x + P.x * c + P.z * s, pz = p.z - P.x * s + P.z * c;
    for (const L of scene.landmarks) {
      const ahead = (L.x - px) * c - (L.z - pz) * s, side = Math.abs((L.x - px) * s + (L.z - pz) * c);
      if (side > 4.5) continue;
      if (!best || Math.abs(ahead) < best.a) {
        const t = Math.abs(ahead) < 0.1 ? `until ${P.name} is level with ${L.name}`
          : ahead < 0 ? `until ${P.name} is ${fmt(-ahead)} past ${L.name}` : `until ${P.name} is ${fmt(ahead)} short of ${L.name}`;
        best = { t, a: Math.abs(ahead) };
      }
    }
  }
  return best ? best.t : 'for a moment';
}

/** Turn a route into the coach's steps. Short steering blips are folded into the step before. */
export function coach(scene: Scene, pieces: Piece[]): CoachStep[] {
  const groups: { dir: 1 | -1; lvl: number; len: number; from: Pose; to: Pose; last: number }[] = [];
  pieces.forEach((pc, i) => {
    const g = groups[groups.length - 1];
    const sameRun = g && g.dir === pc.dir;
    if (sameRun && (pc.lvl === g.lvl || pc.len <= 0.5)) { g.len += pc.len; g.to = pc.to; g.last = i; }
    else groups.push({ dir: pc.dir, lvl: pc.lvl, len: pc.len, from: pc.from, to: pc.to, last: i });
  });
  const lane = scene.entry.th;
  return groups.map((g, i) => {
    const next = groups[i + 1], lastStep = !next;
    const verb = g.dir > 0 ? 'Drive forward' : 'Reverse';
    let cue: string;
    if (lastStep) {
      cue = scene.template === 'kerb' ? 'until the car is straight, about 25 cm from the kerb' : 'until the car is straight in the bay, about 35 cm from the back line';
    } else if (next.dir !== g.dir) {
      // stop against what is just ahead, or else against a landmark you can see
      const n = nearest(scene, g.to, g.dir);
      cue = n.name && n.d <= 1.2 ? `and stop about ${fmt(n.d)} from ${n.name}` : landmarkCue(scene, g.to).replace(/^until/, 'and stop when');
    } else {
      const turned = Math.abs(wrap(g.to.th - g.from.th)) / DEG;
      if (turned >= 12) {
        const toLane = Math.abs(wrap(g.to.th - lane)) / DEG, a = Math.min(toLane, 180 - toLane);
        cue = scene.template === 'kerb' ? `until the car is at about ${Math.round(a)}° to the kerb` : `until the car is at about ${Math.round(a)}° to the aisle`;
      } else cue = landmarkCue(scene, g.to);
    }
    const detail = `${g.len.toFixed(1)} m`;
    return { n: i + 1, text: `${verb}, ${steerWords(g.lvl, scene)}, ${cue}.`, detail, dir: g.dir, lvl: g.lvl, len: g.len, end: g.to, pieceEnd: g.last };
  });
}
