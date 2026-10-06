// Reversing a trailer: the pilot that steers the car so the trailer follows a path (as a trailer-reversing assist
// does), the coach built on it (a target on the wheel, a crawl, pulling forward to straighten when the trailer gets
// away), the trailer yards and their paths, and the three towing lessons: every driver backs the trailer into the
// space, touching nothing, and passes.
import { describe, expect, it } from 'vitest';
import { BOX_TRAILER, TOW_CAR, VEHICLES, vehicleFor } from '../src/core/content';
import { parseKey } from '../src/core/generator/level';
import { generateTow, towKnobs } from '../src/core/generator/towLevels';
import { towScene, type TowSceneId } from '../src/core/generator/towScenes';
import { starsFor } from '../src/core/score';
import { COURSE, checkPass, lessonFor, loadLesson, routeFor } from '../src/core/lesson';
import { DEG } from '../src/core/math';
import { Recorder, STEP, playback, stateOf } from '../src/core/replay';
import { TOW_DRIVERS, towDrive } from '../src/core/robot';
import { makeScene } from '../src/core/scene';
import { Sim } from '../src/core/sim';
import { TowCoach, TowPath, TowPilot, axleAt, type PathSeg } from '../src/core/towing';
import { hitchAngle, jackknifeAngle } from '../src/core/trailer';

const V = vehicleFor(TOW_CAR), T = BOX_TRAILER;
const open = makeScene({ format: 1, id: 'open', name: 'Open', layoutVersion: 1, areaView: [-300, 300, -300, 300], defaultBay: 'x', bays: {}, defaultStart: 'o', starts: { o: { x: 0, z: 0, th: 0 } }, lines: [], obstacles: [] } as never);
const TOWS = COURSE.lessons.filter(l => l.tow);

/** The pilot reversing the rig along the path in the open from a hitch angle of phi degrees, the hand following its
 *  target at `hands` degrees a second: how far off the path and how folded it got, and where it stopped. */
function pilotRun(segs: PathSeg[], phi: number, hands = 360) {
  const s = new Sim(open, V); s.setTrailer(T); s.resetAt(0, 0, 0, -phi * DEG); s.options.selfCentre = false; s.input.wheelHeld = true;
  const [ax, az] = axleAt(V, T, 0, 0, 0, 0), path = TowPath.build({ x: ax, z: az, th: 0 }, segs), pilot = new TowPilot(V, T, path);
  let maxOff = 0, maxPhi = 0, hits = 0;
  for (let n = 0; n < 60 * 200; n++) {
    const want = pilot.steer(s.x, s.z, s.th, s.tth, s.options.lockDeg, STEP), d = want - s.wheelAngle;
    s.wheelAngle += Math.sign(d) * Math.min(Math.abs(d), hands * STEP);
    const pr = pilot.progress(s.x, s.z, s.th, s.tth);
    if (pr.s > 2) maxOff = Math.max(maxOff, pr.off);
    maxPhi = Math.max(maxPhi, Math.abs(hitchAngle(s.th, s.tth)));
    s.input.rev = pr.left > 0.05 + s.v * s.v / 7 && Math.abs(s.v) < 0.55;
    if (!s.input.rev && pr.left < 0.1 && Math.abs(s.v) < 0.01) break;
    for (const e of s.step(STEP)) if (e.type === 'touch') hits++;
  }
  const e = path.pts[path.pts.length - 1], [x, z] = axleAt(V, T, s.x, s.z, s.th, s.tth);
  return { maxOff, maxPhi: maxPhi / DEG, end: Math.hypot(x - e.x, z - e.z), endTh: Math.abs(s.tth - e.th) / DEG, hits, pilot };
}

describe('the pilot', () => {
  it.each([[3], [-4], [6]])('keeps a trailer straight from %s° off, reversing', phi => {
    const r = pilotRun([{ line: 15 }], phi);
    expect(r.hits).toBe(0); expect(r.end).toBeLessThan(0.1); expect(r.endTh).toBeLessThan(1);
    expect(r.maxPhi).toBeLessThan(Math.abs(phi) + 6);
  });
  it.each([[8, 1], [8, -1], [7, 1], [7, -1]])('takes it round a corner of %s m, either way (%s)', (R, side) => {
    const r = pilotRun([{ line: 4 }, { r: R, turn: side * Math.PI / 2 }, { line: 8 }], 0);
    expect(r.hits).toBe(0); expect(r.maxOff).toBeLessThan(0.5); expect(r.end).toBeLessThan(0.15); expect(r.endTh).toBeLessThan(2);
    // never further than it lets itself go, well short of the jackknife
    expect(r.maxPhi).toBeLessThan(r.pilot.maxPhi / DEG + 1);
    expect(r.pilot.maxPhi).toBeLessThan(jackknifeAngle(V, T) - 25 * DEG + 1e-9);
  });
  it('can be followed by a hand slower than its own', () => {
    const r = pilotRun([{ line: 4 }, { r: 8, turn: -Math.PI / 2 }, { line: 8 }], 2, 150);
    expect(r.hits).toBe(0); expect(r.end).toBeLessThan(0.2);
  });
});

describe('the coach', () => {
  it('pulls you forward to straighten a trailer that has got away, then has you reverse again', () => {
    // in the open, the trailer folded 45° to the car's right
    const sim = new Sim(open, V), [ax, az] = axleAt(V, T, 0, 0, 0, 0), path = TowPath.build({ x: ax, z: az, th: 0 }, [{ line: 15 }]);
    sim.setTrailer(T); sim.resetAt(0, 0, 0, 45 * DEG);
    const coach = new TowCoach(V, T, path, () => sim.options.lockDeg);
    expect(coach.observe(sim, STEP)).toEqual([{ type: 'lost' }]);
    expect(coach.phase).toBe('forward'); expect(coach.wheelWant).toBe(0);
    expect(coach.gate({ fwd: false, rev: true }, sim)).toEqual({ fwd: false, rev: false });
    expect(coach.hint).toMatch(/forward/);
    // pull forward with the wheels straight until the trailer has come back into line
    let lined = false;
    for (let n = 0; n < 60 * 60 && !lined; n++) {
      sim.input.wheelHeld = true; sim.wheelAngle = 0;
      const g = coach.gate({ fwd: Math.abs(coach.phi) >= 3 * DEG, rev: false }, sim); sim.input.fwd = g.fwd; sim.input.rev = g.rev;
      sim.step(STEP);
      lined = coach.observe(sim, STEP).some(e => e.type === 'lined');
    }
    expect(lined).toBe(true); expect(coach.phase).toBe('reverse');
    expect(Math.abs(hitchAngle(sim.th, sim.tth))).toBeLessThan(3 * DEG);
  });
  it('keeps the trailer to a crawl and only lets you reverse', () => {
    const S = towScene(V, T, 'tow-straight'), sim = new Sim(makeScene(S.spec), V);
    sim.setTrailer(T); sim.resetAt(S.start.x, S.start.z, S.start.th, S.start.tth);
    const coach = new TowCoach(V, T, S.path, () => sim.options.lockDeg);
    coach.observe(sim, STEP);
    expect(coach.gate({ fwd: true, rev: false }, sim)).toEqual({ fwd: false, rev: false });
    expect(coach.gate({ fwd: false, rev: true }, sim)).toEqual({ fwd: false, rev: true });
    sim.v = -0.6; expect(coach.gate({ fwd: false, rev: true }, sim).rev).toBe(false);
  });
});

describe.each(['tow-straight', 'tow-corner', 'tow-bay'] as TowSceneId[])('the %s yard', id => {
  it('ends its path where the trailer sits in the space, straight, and starts clear', () => {
    const S = towScene(V, T, id), scene = makeScene(S.spec), b = scene.bays[S.bay], e = S.path.pts[S.path.pts.length - 1];
    expect(e.x).toBeCloseTo((b.x0 + b.x1) / 2, 6); expect(Math.abs(e.th + Math.PI / 2)).toBeLessThan(1e-9);
    const sim = new Sim(scene, V); sim.setTrailer(T); sim.options.bay = S.bay; sim.resetAt(S.start.x, S.start.z, S.start.th, S.start.tth);
    expect(sim.touching()).toBeNull(); expect(sim.trailerTouch(sim.x, sim.z, sim.th, sim.tth)).toBeNull();
    // the trailer's axle starts on the path
    const [ax, az] = axleAt(V, T, S.start.x, S.start.z, S.start.th, S.start.tth);
    expect(Math.hypot(ax - S.path.pts[0].x, az - S.path.pts[0].z)).toBeLessThan(1e-9);
    expect(JSON.stringify(towScene(V, T, id).spec)).toBe(JSON.stringify(S.spec));
  });
});

describe.each(TOWS.map(d => [d.n, d.title, d] as const))('lesson %s, %s', (_n, _t, def) => {
  it('is for every car, in the Octavia with the box trailer, with no stored route', () => {
    for (const v of Object.values(VEHICLES)) expect(lessonFor(v, def), v.id).toBe(true);
    const L = loadLesson(VEHICLES['byd-atto2'], def);
    expect(L.tow!.car.id).toBe(TOW_CAR); expect(L.tow!.trailer).toBe(T); expect(L.route).toEqual([]); expect(routeFor(V, def)).toBeUndefined();
    expect(L.par).toBe(1); expect(L.scene.bays[L.bay].towed).toBe(true);
  });
  it.each(TOW_DRIVERS.map(([name, o]) => [name, o] as const))('%s: backs the trailer in, touching nothing, and passes', (_name, o) => {
    const L = loadLesson(V, def), { r, touches, lost, secs } = towDrive(V, T, L.scene, L.bay, L.tow!.start, L.tow!.path, o);
    expect(touches).toBe(0); expect(lost).toBe(0);
    expect(r, 'parked').not.toBeNull();
    const chk = checkPass(r!, def.pass ?? {}, L.par);
    expect(chk.pass, JSON.stringify(chk.lines)).toBe(true);
    expect(secs).toBeLessThan(L.limit);
  }, 120000);
  it('a guided try replays exactly', () => {
    const L = loadLesson(V, def), sim = new Sim(L.scene, V), rec = new Recorder();
    sim.setTrailer(T); sim.options.bay = L.bay; sim.resetAt(L.tow!.start.x, L.tow!.start.z, L.tow!.start.th, L.tow!.start.tth);
    const coach = new TowCoach(V, T, L.tow!.path, () => sim.options.lockDeg);
    rec.begin(sim);
    for (let n = 0; n < 60 * 90 && coach.phase !== 'done'; n++) {
      sim.input.wheelHeld = true; sim.wheelAngle += Math.max(-6, Math.min(6, coach.wheelWant - sim.wheelAngle));
      const g = coach.gate({ fwd: false, rev: true }, sim); sim.input.fwd = g.fwd; sim.input.rev = g.rev;
      rec.before(sim); sim.step(STEP); rec.after(sim); coach.observe(sim, STEP);
    }
    expect(coach.phase).toBe('done');
    const p = playback(rec.rec!, L.scene, V); while (p.step());
    expect(stateOf(p.sim)).toEqual(stateOf(sim));
  }, 120000);
});

describe('trailer levels', () => {
  it.each([1, 3, 6, 10])('level %s builds as asked, the same every time, and the coach backs the trailer in for three stars', level => {
    for (const seed of [1, 7]) {
      const L = generateTow(level, seed)!;
      expect(L.knobLevel).toBe(level); expect(L.template).toBe('tow'); expect(L.key).toBe(`tow:${level}:${seed}`); expect(parseKey(L.key)).toEqual({ template: 'tow', level, seed });
      expect(JSON.stringify(generateTow(level, seed)!.scene)).toBe(JSON.stringify(L.scene));
      const { r, touches, secs } = towDrive(V, T, L.scene, L.scene.defaultBay, L.tow!.start, L.tow!.path);
      expect(touches).toBe(0); expect(r).not.toBeNull();
      expect(starsFor(r!, L.par, L.timeLimit).count, `${secs.toFixed(0)} s`).toBe(3);
    }
  }, 120000);
  it('gets harder: a narrower space, a tighter corner, cars beside it, cones, the passenger side', () => {
    const k1 = towKnobs(1, 3), k10 = towKnobs(10, 3);
    expect(k1.space).toBeGreaterThan(3.3); expect(k10.space).toBeLessThan(2.5);
    expect(k1.approach).toBe('straight'); expect(k10.approach).toBe('corner'); expect(k10.radius).toBeLessThan(7.5);
    expect(k1.neighbours).toBeNull(); expect(k10.neighbours).not.toBeNull(); expect(k10.cones).toBe(true);
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(s => towKnobs(8, s).side))).toEqual(new Set(['left', 'right']));
  });
});
