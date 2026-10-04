// Make a level: build the scene, solve it outward from the parked pose, check, measure, describe.
import { ATTO2 as CAR } from '../../../src/core/content';
import { DEG } from '../../../src/core/math';
import { Field } from './field';
import { search, type Plan } from './planner';
import { coach, exactCheck, measure, type CoachStep, type Measure } from './route';
import { build, type Scene, type TemplateId, type WayIn } from './templates';

export interface Skipped { none: number; gaveUp: number; off: number; mismatch: number }
export interface Level { scene: Scene; field: Field; plan: Plan; measure: Measure; steps: CoachStep[]; usedSeed: number; knobLevel: number; skipped: Skipped; ms: number }

const R_REAR = Math.sqrt(CAR.R_CC * CAR.R_CC - CAR.WB * CAR.WB) - CAR.TRACK / 2;

export function solve(scene: Scene, opts: { maxNodes?: number; maxMs?: number } = {}): { field: Field; plan: Plan } {
  const [x0, x1, z0, z1] = scene.bounds, e = scene.entry;
  const field = new Field(scene.obstacles, x0, x1, z0, z1, scene.kerbs);
  const done = (p: { x: number; z: number; th: number }) => p.x >= e.x0 && p.x <= e.x1 && p.z >= e.z0 && p.z <= e.z1 && Math.abs(Math.atan2(Math.sin(p.th - e.th), Math.cos(p.th - e.th))) < 8 * DEG;
  const heur = (p: { x: number; z: number; th: number }) => {
    const dx = Math.max(e.x0 - p.x, 0, p.x - e.x1), dz = Math.max(e.z0 - p.z, 0, p.z - e.z1);
    return Math.hypot(dx, dz) + 0.5 * R_REAR * Math.abs(Math.atan2(Math.sin(p.th - e.th), Math.cos(p.th - e.th)));
  };
  return { field, plan: search(field, scene.goals, done, heur, { outward: true, shotHeading: e.th, ...opts }) };
}

/** Deterministic: the same template, level, seed and way in always give the same level. */
export function generate(tpl: TemplateId, level: number, seed: number, way: WayIn, opts: { tries?: number; maxNodes?: number; maxMs?: number } = {}): Level | null {
  const t0 = performance.now(), skipped: Skipped = { none: 0, gaveUp: 0, off: 0, mismatch: 0 };
  const tries = opts.tries ?? 6;
  let fallback: Level | null = null, knob = level;
  for (let k = 0; k < tries; k++) {
    const s = seed + k * 100003;
    const scene = build(tpl, knob, s, way);
    const { field, plan } = solve(scene, opts);
    if (plan.status === 'none') { skipped.none++; continue; }
    if (plan.status === 'gave-up') { skipped.gaveUp++; continue; }
    if (exactCheck(scene, field, plan.pieces)) { skipped.mismatch++; continue; }
    const m = measure(scene, field, plan.pieces);
    const lvl: Level = { scene, field, plan, measure: m, steps: coach(scene, plan.pieces), usedSeed: s, knobLevel: knob, skipped: { ...skipped }, ms: 0 };
    const off = m.score - level;
    if (Math.abs(off) > 2.5) {
      // measured far from what was asked: keep the seed's spirit but ease or tighten the settings
      skipped.off++;
      if (!fallback || Math.abs(m.score - level) < Math.abs(fallback.measure.score - level)) fallback = lvl;
      knob = Math.max(1, Math.min(10, knob - Math.sign(off)));
      continue;
    }
    lvl.skipped = skipped; lvl.ms = performance.now() - t0; return lvl;
  }
  if (fallback) { fallback.skipped = skipped; fallback.ms = performance.now() - t0; }
  return fallback;
}
