// Headless checks: bay 561 from the left with the game's own garage, then a seed matrix.
import { heroCorners } from '../../../src/core/car';
import { collides } from '../../../src/core/collision';
import { ATTO2, GARAGE_561 } from '../../../src/core/content';
import { DEG } from '../../../src/core/math';
import { Field } from './field';
import { generate } from './generate';
import { moves, sample, search } from './planner';

const out: string[] = [];
// 1. the known case
{
  const obs = GARAGE_561.obstacles, b = GARAGE_561.bays['561'];
  const field = new Field(obs, -12, 9, -1.5, 11.5);
  const { x: sx, z: sz, th: sth } = GARAGE_561.starts.left;
  const inBay = (p: { x: number; z: number; th: number }) => Math.abs(p.th - Math.PI / 2) < 6 * DEG && heroCorners(ATTO2, p.x, p.z, p.th).every(q => q[0] >= b.x0 - 0.03 && q[0] <= b.x1 + 0.03 && q[1] >= -0.05 && q[1] <= b.z1 + 0.15);
  const h = (p: { x: number; z: number; th: number }) => Math.hypot(p.x - 0, p.z - 3.6) + 1.2 * Math.abs(Math.atan2(Math.sin(p.th - Math.PI / 2), Math.cos(p.th - Math.PI / 2)));
  const plan = search(field, { x: sx, z: sz, th: sth }, inBay, h, { outward: false, maxNodes: 200000, maxMs: 20000 });
  let bad = '';
  if (plan.status === 'found') for (const q of sample(plan.pieces, 0.05)) { const hit = collides(ATTO2, obs, q.x, q.z, q.th); if (hit) { bad = hit.obstacle.name + ' ' + hit.part; break; } }
  out.push(`561 from the left: ${plan.status}, moves ${plan.status === 'found' ? moves(plan.pieces) : '-'}, ${plan.nodes} nodes, ${Math.round(plan.ms)} ms, exact check: ${bad || 'clear'}`);
  if (plan.status === 'found') out.push('  pieces: ' + plan.pieces.map(p => `${p.dir > 0 ? 'F' : 'R'}${p.lvl}:${p.len.toFixed(1)}`).join(' '));
}
// 1b. where is the tightest moment on an easy kerb level?
{
  const L = generate('kerb', 1, 1, 'reverse');
  if (L) {
    let best = { c: Infinity, x: 0, z: 0, th: 0 };
    for (const q of sample(L.plan.pieces, 0.1)) { const c = L.field.clearance(q.x, q.z, q.th); if (c < best.c) best = { c, x: q.x, z: q.z, th: q.th }; }
    out.push(`kerb L1 s1: moves ${L.measure.moves}, approach clearance ${L.measure.minClear.toFixed(2)}, overall min ${best.c.toFixed(2)} at x ${best.x.toFixed(2)} z ${best.z.toFixed(2)} th ${(best.th / DEG).toFixed(0)}°, score ${L.measure.score.toFixed(1)}`);
    out.push('  steps: ' + L.steps.map(s => s.text).join(' | '));
  }
}
// 2. the matrix
const rows: string[] = [];
for (const [tpl, way] of [['kerb', 'reverse'], ['bays', 'reverse'], ['bays', 'forward']] as const) {
  for (const level of [1, 4, 7, 10]) {
    let ok = 0, ms = 0, nodes = 0, mv: number[] = [], sc: number[] = [], sk = { none: 0, gaveUp: 0, off: 0, mismatch: 0 }, fail = 0, maxMs = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const L = generate(tpl, level, seed, way, { maxMs: 6000, maxNodes: 150000 });
      if (!L) { fail++; continue; }
      ok++; ms += L.ms; maxMs = Math.max(maxMs, L.ms); nodes += L.plan.nodes; mv.push(L.measure.moves); sc.push(+L.measure.score.toFixed(1));
      for (const k of Object.keys(sk) as (keyof typeof sk)[]) sk[k] += L.skipped[k];
    }
    rows.push(`${tpl}/${way} L${level}: ok ${ok}/8, avg ${Math.round(ms / Math.max(ok, 1))} ms (max ${Math.round(maxMs)}), nodes ${Math.round(nodes / Math.max(ok, 1))}, moves [${mv.join(',')}], score [${sc.join(',')}], skipped ${JSON.stringify(sk)}, failed ${fail}`);
    console.log(rows[rows.length - 1]);
  }
}
console.log(out.join('\n'));
