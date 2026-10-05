// Replays recorded drives through the core and compares every checkpoint with the original single-file game
// (fixtures/golden.json was recorded from it, frame by frame at 33.4 ms, with the same key presses: fixtures/ops.json).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Sim, type SimEvent } from '../src/core/sim';
import type { StartName } from '../src/core/garage';
import { parkedCard, steerText, touchTitle } from '../src/ui/format';

type Op = [string, ...(string | number)[]];
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const ops: Op[] = load('ops.json'), golden: any[] = load('golden.json');
const num = (v: number | null) => (v === null ? Infinity : v);

function replay() {
  const sim = new Sim(), out: any[] = [];
  let start: StartName = 'left', title = 'Park in bay 561', stats: string | null = null;
  const apply = (evs: SimEvent[]) => {
    for (const e of evs) {
      if (e.type === 'touch') { title = touchTitle(e.name, e.part); stats = null; }
      else if (e.type === 'parked') { const c = parkedCard(e.result); title = c.title; stats = c.stats.map(([k, v]) => `${k} ${v}`).join(' '); }
    }
  };
  const keys: Record<string, (down: boolean) => void> = {
    ArrowUp: d => { sim.input.fwd = d; }, ArrowDown: d => { sim.input.rev = d; },
    ArrowLeft: d => { sim.input.kl = d; if (d) sim.wheelTarget = null; }, ArrowRight: d => { sim.input.kr = d; if (d) sim.wheelTarget = null; },
    ' ': d => { if (d) sim.wheelTarget = 0; },
  };
  for (const [op, a, b, c] of ops) {
    if (op === 'down' || op === 'up') keys[a as string](op === 'down');
    else if (op === 'step') for (let i = 0; i < (a as number); i++) apply(sim.step(0.0334));
    else if (op === 'reset') { sim.reset(start); title = `Park in bay ${sim.options.bay}`; stats = null; }
    else if (op === 'set') sim.place(a as number, b as number, c as number);
    else if (op === 'start') start = a as StartName;
    else if (op === 'bay') sim.options.bay = a as string;
    else if (op === 'probe') {
      const P = (d: 1 | -1) => { const p = sim.predict(d); return { hit: p.hit ? p.hit.name : null, part: p.part, dist: p.dist, end: p.end, ghosts: p.ghosts.length, n: p.tracks.fl.length, fl: p.tracks.fl.at(-1), sw: p.tracks.swing.at(-1) }; };
      out.push({ x: sim.x, z: sim.z, th: sim.th, v: sim.v, wheelAngle: sim.wheelAngle, hits: sim.hits, elapsed: sim.elapsed, lastMoveDir: sim.lastMoveDir, inContact: sim.inContact, parkedShown: sim.parked,
        pdc: { ...sim.pdc }, sensors: { ...sim.gaps }, sd: [...sim.sensorReadings], fwd: P(1), rev: P(-1), banner: title, stats, gear: sim.gear, steer: steerText(sim.steerDeg) });
    }
  }
  return out;
}

const close = (a: number, b: number, what: string) => {
  if (a === b) return;
  expect(Math.abs(a - b), what).toBeLessThan(1e-9);
};

describe('core matches the original game', () => {
  const got = replay();
  it('records the same number of checkpoints', () => expect(got.length).toBe(golden.length));
  golden.forEach((g, i) => it(`checkpoint ${i}: ${g.banner}`, () => {
    const r = got[i];
    for (const k of ['x', 'z', 'th', 'v', 'wheelAngle', 'elapsed']) close(r[k], g[k], k);
    expect([r.hits, r.lastMoveDir, r.inContact, r.parkedShown, r.gear, r.steer, r.banner]).toEqual([g.hits, g.lastMoveDir, g.inContact, g.parkedShown, g.gear, g.steer, g.banner]);
    for (const s of ['front', 'rear', 'left', 'right']) { close(r.pdc[s], num(g.pdc[s]), 'pdc ' + s); close(r.sensors[s], g.sensors[s], 'gap ' + s); }
    g.sd.forEach((d: number | null, j: number) => close(r.sd[j], num(d), 'sensor ' + j));
    for (const d of ['fwd', 'rev']) {
      const a = r[d], b = g[d];
      expect([a.hit, a.part, a.ghosts, a.n], d).toEqual([b.hit, b.part, b.ghosts, b.n]);
      close(a.dist, b.dist, d + ' dist'); a.end.forEach((v: number, j: number) => close(v, b.end[j], d + ' end')); close(a.fl[0], b.fl[0], d + ' fl'); close(a.sw[1], b.sw[1], d + ' swing');
    }
    const norm = (s: string | null) => s && s.replace(/\s+/g, ' ').trim().toUpperCase();
    expect(norm(r.stats)).toBe(norm(g.stats));
  }));
});
