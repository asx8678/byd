// The trailer against what can be checked: its file, the tractrix it follows (exact for a straight move, and undone
// exactly by the move back), the angle the rig settles at on a steady circle, the way a small angle grows as you reverse
// and dies away as you pull forward, the jackknife where it folds into the car, what it touches, the sensors it switches
// off, a space judged on the trailer, and recordings with a trailer replaying exactly.
import { describe, expect, it } from 'vitest';
import { BOX_TRAILER, TOW_CAR, VEHICLES, vehicleFor } from '../src/core/content';
import { DEG, wrapPi, type Pt } from '../src/core/math';
import { Recorder, STEP, playback, replayTo, stateOf } from '../src/core/replay';
import { makeScene, type SceneObstacleSpec } from '../src/core/scene';
import { Sim } from '../src/core/sim';
import { angleForTrailerCurve, ballAt, ballBehind, hitchAngle, hitchRate, jackknifeAngle, settledAngle, towStep } from '../src/core/trailer';

const V = vehicleFor(TOW_CAR), T = BOX_TRAILER;
const sceneWith = (obstacles: SceneObstacleSpec[] = [], kerbs: { name: string; a: number[]; b: number[] }[] = [], bays = {}) =>
  makeScene({ format: 1, id: 'yard', name: 'Yard', layoutVersion: 1, areaView: [-200, 200, -200, 200], defaultBay: 'b', bays, defaultStart: 'o', starts: { o: { x: 0, z: 0, th: 0 } }, lines: [], obstacles, kerbs } as never);
const open = sceneWith();

/** The Octavia with the trailer on, at the origin pointing along +x, the trailer at `phi` degrees (hitch angle). */
function rig(scene = open, phiDeg = 0): Sim {
  const s = new Sim(scene, V); s.setTrailer(T); s.resetAt(0, 0, 0, -phiDeg * DEG); s.options.selfCentre = false;
  return s;
}
/** Hold the wheel at `wheel` degrees and drive `dir` until `m` metres have gone by (or the rig stops on a touch). */
function drive(s: Sim, dir: 1 | -1, m: number, wheel = s.wheelAngle): string[] {
  const touches: string[] = [];
  s.input.wheelHeld = true; s.wheelAngle = wheel; s.input.fwd = dir > 0; s.input.rev = dir < 0;
  let gone = 0;
  for (let n = 0; n < 60 * 600 && gone < m; n++) {
    const x = s.x, z = s.z;
    for (const e of s.step(STEP)) if (e.type === 'touch') touches.push(`${e.name}|${e.part}`);
    gone += Math.hypot(s.x - x, s.z - z);
    if (touches.length) break;
  }
  s.input.fwd = s.input.rev = false;
  for (let n = 0; n < 120 && Math.abs(s.v) > 0; n++) s.step(STEP);
  return touches;
}
const phiOf = (s: Sim) => hitchAngle(s.th, s.tth) / DEG;

describe('the trailer and the tow car', () => {
  it('comes from its file: 3.63 × 1.76 m, the axle 2.26 m behind the ball (an estimate, and said so)', () => {
    expect(T.length).toBe(3.63); expect(T.width).toBe(1.76); expect(T.L1).toBe(2.26);
    expect(T.spec.estimates!.some(e => e.includes('axle'))).toBe(true);
    expect(T.reach).toBeCloseTo(Math.hypot(3.63, 0.88), 6);
  });
  it('hitches only to a car with a tow bar: the Octavia, its ball 10 cm behind the bumper', () => {
    expect(V.tow!.x).toBeCloseTo(-1.194, 9); expect(ballBehind(V) - V.OVR).toBeCloseTo(0.10, 9);
    expect(V.tow!.unbraked).toBe(670); expect(V.tow!.braked).toBe(1500);
    for (const v of Object.values(VEHICLES)) if (v.id !== TOW_CAR) expect(v.tow, v.id).toBeUndefined();
    expect(() => new Sim(open, VEHICLES['byd-atto2']).setTrailer(T)).toThrow();
    const s = rig(); s.setVehicle(VEHICLES['byd-atto2']); expect(s.trailer).toBeNull();
  });
});

describe('how the trailer follows the ball', () => {
  it('a straight move: the tractrix, undone exactly by the move back', () => {
    for (const phi of [0, 3, 30, 89, 135, 179.5, -60]) {
      const t0 = 0.3 + phi * DEG, a: Pt = [1, 2], b: Pt = [1 + 0.4 * Math.cos(0.3), 2 - 0.4 * Math.sin(0.3)];
      const t1 = towStep(T.L1, a, b, t0), back = towStep(T.L1, b, a, t1);
      expect(Math.abs(back - t0)).toBeLessThan(1e-12);
      // tan(φ/2) shrinks by e^(−d/L1) towing (and 0 stays 0)
      if (phi) expect(Math.tan(wrapPi(t1 - 0.3) / 2) / Math.tan(phi * DEG / 2)).toBeCloseTo(Math.exp(-0.4 / T.L1), 9);
      else expect(t1).toBe(t0);
    }
  });
  it('a whole arc driven out and back in small straight steps comes back exactly', () => {
    const k = 0.15, pts: Pt[] = [];
    for (let i = 0; i <= 400; i++) { const s = i * 0.02; pts.push([Math.sin(k * s) / k, -(1 - Math.cos(k * s)) / k]); }
    let th = 0.2; const t0 = th;
    for (let i = 1; i < pts.length; i++) th = towStep(T.L1, pts[i - 1], pts[i], th);
    for (let i = pts.length - 1; i > 0; i--) th = towStep(T.L1, pts[i], pts[i - 1], th);
    expect(Math.abs(th - t0)).toBeLessThan(1e-9);
  });
  it('the rate the sim gives the hitch angle matches the formula', () => {
    for (const [phi, wheel] of [[10, -200], [-25, 300], [0, 486]] as const) {
      const s = rig(open, phi); s.wheelAngle = wheel;
      const k = Math.tan(-s.steerDeg * DEG) / V.WB, before = hitchAngle(s.th, s.tth);
      drive(s, 1, 0.05, wheel);
      const gone = Math.hypot(s.x, s.z);
      expect((hitchAngle(s.th, s.tth) - before) / gone).toBeCloseTo(hitchRate(V, T, before, k), 1);
    }
  });
});

describe('steady turns', () => {
  it.each([-486, -300, -150, 150, 300, 486])('pulled round on a steady wheel (%s°), the rig settles where sin φ = k (L1 + M cos φ)', wheel => {
    const s = rig(); s.wheelAngle = wheel;
    const k = Math.tan(-s.steerDeg * DEG) / V.WB, want = settledAngle(V, T, k)!;
    drive(s, 1, 45, wheel);
    expect(Math.abs(hitchAngle(s.th, s.tth) - want) / DEG).toBeLessThan(0.1);
    // and that is the hitch angle that keeps the trailer on its own circle, sin φ − L1 kt cos φ = M kt
    const kt = Math.sin(want) / (T.L1 * Math.cos(want) + ballBehind(V));
    expect(angleForTrailerCurve(V, T, kt)).toBeCloseTo(want, 9);
  });
});

describe('reversing and pulling forward', () => {
  it('reversing straight, 4° grows: tan(φ/2) by e^(d/L1)', () => {
    const s = rig(open, 4);
    drive(s, -1, 2, 0);
    const d = Math.hypot(s.x, s.z), want = 2 * Math.atan(Math.tan(2 * DEG) * Math.exp(d / T.L1)) / DEG;
    expect(Math.abs(phiOf(s))).toBeGreaterThan(9);
    expect(Math.abs(Math.abs(phiOf(s)) - want)).toBeLessThan(0.5);   // the ball moves a little off straight as the angle grows
  });
  it('pulling forward straight, 30° dies away', () => {
    const s = rig(open, 30);
    drive(s, 1, 10, 0);
    expect(Math.abs(phiOf(s))).toBeLessThan(1);
  });
  it('the jackknife: the A-frame meets the bumper at about 70°, the same either way', () => {
    const a = jackknifeAngle(V, T) / DEG;
    expect(a).toBeGreaterThan(55); expect(a).toBeLessThan(90);
  });
  it.each([-1, 1])('reversing on a steady half lock (side %s), the rig folds until the trailer touches the car', side => {
    const s = rig(); const touches = drive(s, -1, 40, side * 243);
    expect(touches).toEqual(['your car|jackknife']);
    expect(Math.abs(Math.abs(phiOf(s)) - jackknifeAngle(V, T) / DEG)).toBeLessThan(1);
    expect(s.hits).toBe(1);
  });
});

describe('getting out of a jackknife', () => {
  it.each([0, 486, -486])('folded up, the rig pulls forward and straightens with the wheel at %s°', wheel => {
    const s = rig();
    expect(drive(s, -1, 40, 243)).toEqual(['your car|jackknife']);
    const phi0 = Math.abs(phiOf(s)), x0 = s.x, z0 = s.z;
    expect(drive(s, 1, 3, wheel)).toEqual([]);
    expect(Math.hypot(s.x - x0, s.z - z0)).toBeGreaterThan(2.9);
    expect(Math.abs(phiOf(s))).toBeLessThan(phi0 - 10);
  });
});

describe('what the trailer touches', () => {
  it('reversing towards a wall, the trailer touches it first', () => {
    const s = rig(sceneWith([{ kind: 'poly', pts: [[-8, -5], [-7.6, -5], [-7.6, 5], [-8, 5]], name: 'wall', h: 2.5, cls: 'wall' }]));
    expect(drive(s, -1, 10, 0)).toEqual(['wall|trailer']);
    expect(ballAt(V, s.x, s.z, s.th)[0] - T.length).toBeLessThan(-7.55);
  });
  it('a low post under the drawbar, beside the car: the A-frame', () => {
    const s = rig(sceneWith([{ kind: 'circle', x: -1.9, z: 0.6, r: 0.1, name: 'post', h: 0.6, cls: 'low' }]), 0);
    // turn so the A-frame swings across the post as the rig backs up
    const t = drive(s, -1, 6, 486);
    expect(t.length).toBe(1); expect(t[0].startsWith('post|')).toBe(true);
  });
  it('its tyres meet a kerb; the box hangs over it', () => {
    // the trailer 20° off to the car's left, a kerb 2 m out on that side: reversing straight, the trailer swings on
    // towards it until a tyre meets it, with the box already over it
    const s = rig(sceneWith([], [{ name: 'kerb', a: [20, -2.0], b: [-20, -2.0] }]), 20);
    expect(drive(s, -1, 8, 0)).toEqual(['kerb|trailer wheel']);
    const [bx, bz] = ballAt(V, s.x, s.z, s.th), box = [[-T.drawbar, -T.width / 2], [-T.length, -T.width / 2]].map(([a, b]) => bz - a * Math.sin(s.tth) + b * Math.cos(s.tth));
    expect(Math.min(...box)).toBeLessThan(-2.0); expect(bx).toBeLessThan(0);
  });
});

describe('sensors, spaces and replays with a trailer on', () => {
  it('the rear parking sensors are off; the gaps round the trailer are measured', () => {
    const s = rig(sceneWith([{ kind: 'poly', pts: [[-6, -5], [-5.5, -5], [-5.5, 5], [-6, 5]], name: 'wall', h: 2.5, cls: 'wall' }]));
    drive(s, -1, 0.3, 0);
    expect(s.pdc.rear).toBe(Infinity);
    V.sensors.forEach((m, i) => { if (m.g === 'rear') expect(s.sensorReadings[i]).toBe(Infinity); });
    const back = ballAt(V, s.x, s.z, s.th)[0] - T.length;
    expect(s.trailerGaps.rear).toBeCloseTo(back - -5.5, 2);
  });
  it('a towed space is judged on the trailer, reversed in', () => {
    const bay = { x0: -1.3, x1: 1.3, z0: 6, z1: 12, headZ: 6, sideTol: 0, mouthTol: 0, inHeading: Math.PI / 2, face: 'out', towed: true };
    const s = new Sim(sceneWith([], [], { b: bay }), V); s.setTrailer(T); s.options.bay = 'b';
    // the trailer's box from z = 6.5 to 9.13, pointing down the plan (out of the space), the car beyond the mouth
    const ball: Pt = [0, 6.5 + T.length], th = -Math.PI / 2;
    s.resetAt(ball[0], ball[1] - V.tow!.x, th, th);
    s.step(STEP);
    const r = s.parkedResult();
    expect(r).not.toBeNull(); expect(r!.noseIn).toBe(false); expect(Math.abs(r!.offCentre)).toBeLessThan(1e-9); expect(Math.abs(r!.angle)).toBeLessThan(1e-9);
    // the car alone in the space would not count: move the trailer out
    s.resetAt(ball[0], ball[1] - V.tow!.x - 3, th, th); s.step(STEP);
    expect(s.parkedResult()).toBeNull();
  });
  it('a recording with a trailer replays exactly, from the start and from a checkpoint', () => {
    const s = rig(sceneWith([{ kind: 'poly', pts: [[-30, -9], [30, -9], [30, -8.6], [-30, -8.6]], name: 'wall', h: 2.5, cls: 'wall' }]), 3), rec = new Recorder();
    rec.begin(s);
    expect(rec.rec!.trailer).toBe(T.id); expect(rec.rec!.start.tth).toBe(s.tth);
    const run = (n: number, f: (i: number) => void) => { for (let i = 0; i < n; i++) { f(i); rec.before(s); s.step(STEP); rec.after(s); } };
    s.input.wheelHeld = true;
    run(300, i => { s.input.rev = true; s.wheelAngle = Math.sin(i / 40) * 200; });
    run(500, i => { s.input.rev = false; s.input.fwd = i < 400; s.wheelAngle = -100; });
    run(500, i => { s.input.fwd = false; s.input.rev = i < 450; s.wheelAngle = 150; });
    const p = playback(rec.rec!, s.scene, V); while (p.step());
    expect(stateOf(p.sim)).toEqual(stateOf(s));
    expect(stateOf(replayTo(rec.rec!, s.scene, V, 1300))).toEqual(stateOf(s));
    expect(stateOf(replayTo(rec.rec!, s.scene, V, 1250)).tth).toBe(stateOf(replayTo(rec.rec!, s.scene, V, 1250, () => {})).tth);
  });
  it('without a trailer nothing about it is recorded', () => {
    const s = new Sim(open, V), rec = new Recorder(); rec.begin(s);
    expect('trailer' in rec.rec!).toBe(false); expect('tth' in rec.rec!.start).toBe(false);
  });
});
