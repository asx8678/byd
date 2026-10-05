// Drive mode's street physics against what can be checked: the published 0–100 km/h times and top speeds, braking
// distances in the normal range, the turning circle at walking pace (Park mode's, exactly), steady cornering (the car
// runs wide as it goes faster, and grip runs out at the tyres' limit without a spin), a smooth handover between the
// low-speed model and the tyre model, and Drive-mode runs replaying exactly.
import { describe, expect, it } from 'vitest';
import { footprint } from '../src/core/car';
import { VEHICLES } from '../src/core/content';
import { V_DYN, V_KIN, lookAhead } from '../src/core/dynamics';
import { DEG, clamp } from '../src/core/math';
import { Recorder, STEP, replayTo } from '../src/core/replay';
import { makeScene } from '../src/core/scene';
import { Sim } from '../src/core/sim';
import type { Vehicle } from '../src/core/vehicle';

const open = makeScene({ format: 1, id: 'open', name: 'Open', layoutVersion: 1, areaView: [-3000, 3000, -3000, 3000], defaultBay: 'x', bays: {}, defaultStart: 'o', starts: { o: { x: 0, z: 0, th: 0 } }, lines: [], obstacles: [] });
const CARS = ['byd-atto2', 'smart-fortwo-c453', 'ram-1500-dt', 'mercedes-s-class-w223@10', 'mercedes-s-class-w223@0'];
const G = 9.81;

/** The car in Drive mode on an open square, rolling at speed m/s, the wheel held where it is put. */
function driving(v: Vehicle, speed = 0): Sim {
  const s = new Sim(open, v); s.reset('o'); s.setMode('drive'); s.v = speed; s.options.selfCentre = false;
  return s;
}
/** Seconds from rest to kmh with the accelerator down. */
function timeTo(v: Vehicle, kmh: number): number {
  const s = driving(v); s.input.acc = 1; let t = 0;
  while (s.v * 3.6 < kmh && t < 60) { s.step(STEP); t += STEP; }
  return t;
}
/** Metres to a stop from kmh with the brake down. */
function stopping(v: Vehicle, kmh: number): number {
  const s = driving(v, kmh / 3.6); s.input.brk = 1;
  for (let n = 0; s.v > 0 && n < 6000; n++) s.step(STEP);
  return s.x;
}
/** Held at kmh by a cruise control with the steering wheel at wheel degrees: the radius it settles on and how hard it corners. */
function cornering(v: Vehicle, kmh: number, wheel: number): { R: number; Rk: number; ay: number; yaw: number; speed: number } {
  const s = driving(v, kmh / 3.6); s.wheelAngle = wheel;
  let yaw = 0;
  for (let n = 0; n < 60 * 15; n++) {
    const e = kmh / 3.6 - s.v; s.input.acc = clamp(2 * e, 0, 1); s.input.brk = clamp(-2 * e, 0, 1);
    const th0 = s.th; s.step(STEP); yaw = (s.th - th0) / STEP;
  }
  return { R: Math.abs(s.v / yaw), Rk: v.WB / Math.tan(Math.abs(s.steerDeg) * DEG), ay: Math.abs(s.v * yaw) / G, yaw: Math.abs(yaw), speed: s.v };
}

describe('Drive mode against the published figures', () => {
  it.each([['byd-atto2', 100, 7.5], ['smart-fortwo-c453', 100, 14.4], ['mercedes-s-class-w223@10', 96.56, 3.9]] as const)('%s: 0 to %s km/h in the published %s s', (id, kmh, t) => {
    expect(Math.abs(timeTo(VEHICLES[id], kmh) / t - 1)).toBeLessThan(0.03);
  });
  it.each(CARS)('%s: tops out at its published top speed', id => {
    const v = VEHICLES[id], s = driving(v); s.input.acc = 1;
    for (let n = 0; n < 60 * 120; n++) s.step(STEP);
    const top = v.spec.dynamics!.topSpeed;
    expect(s.v * 3.6).toBeLessThanOrEqual(top + 0.5); expect(s.v * 3.6).toBeGreaterThan(top * 0.97);
  });
  it.each(CARS)('%s: stops from 100 km/h in a normal distance, and from 50 km/h', id => {
    const d100 = stopping(VEHICLES[id], 100), d50 = stopping(VEHICLES[id], 50);
    expect(d100).toBeGreaterThan(33); expect(d100).toBeLessThan(46);
    expect(d50).toBeGreaterThan(8); expect(d50).toBeLessThan(12.5);
  });
});

describe('the handover to the parking model', () => {
  it.each(CARS)('%s: below 7 km/h a Drive-mode step moves the car along exactly the arc a Park-mode step would', id => {
    const v = VEHICLES[id], s = driving(v, 1.2); s.wheelAngle = 300; s.options.selfCentre = true;
    for (let n = 0; n < 120; n++) {
      s.input.acc = s.v < 1.5 ? 0.08 : 0;
      const x0 = s.x, z0 = s.z, th0 = s.th;
      s.step(STEP);
      expect(s.v).toBeLessThan(V_KIN);
      // Park mode's four substeps at the speed and steering this step ran with
      const h = STEP / 4, delta = -s.steerDeg * DEG;
      let x = x0, z = z0, th = th0;
      for (let i = 0; i < 4; i++) { const nth = th + s.v / v.WB * Math.tan(delta) * h, nx = x + s.v * Math.cos(th) * h, nz = z - s.v * Math.sin(th) * h; x = nx; z = nz; th = nth; }
      expect([s.x, s.z, s.th]).toEqual([x, z, th]);
    }
  });
  it.each(CARS)('%s: at walking pace in Drive mode the turning circle is the spec sheet\'s, as in Park mode', id => {
    const v = VEHICLES[id], s = driving(v); s.wheelAngle = s.options.lockDeg;
    const wheel: [number, number][] = [];
    while (s.th > -2 * Math.PI - 0.3) {
      s.input.acc = s.v < 1.3 ? 0.1 : 0; s.step(STEP);
      expect(s.v).toBeLessThan(V_KIN);
      wheel.push(footprint(s.x, s.z, s.th, [[v.WB, -v.TRACK / 2]])[0]);
    }
    const span = Math.max(Math.max(...wheel.map(q => q[0])) - Math.min(...wheel.map(q => q[0])), Math.max(...wheel.map(q => q[1])) - Math.min(...wheel.map(q => q[1])));
    expect(Math.abs(span - 2 * v.R_CC)).toBeLessThan(0.02);
  });
  it.each(CARS)('%s: speeding up through 7–18 km/h and slowing down again, the turn rate never jolts', id => {
    const v = VEHICLES[id], s = driving(v); s.wheelAngle = 120;
    let last = 0, lastU = 0, inBand = 0, outside = 0;
    for (let n = 0; n < 60 * 40; n++) {
      if (s.v * 3.6 < 30 && n < 60 * 20) { s.input.acc = 0.25; s.input.brk = 0; } else { s.input.acc = 0; s.input.brk = 0.15; }
      const th0 = s.th; s.step(STEP);
      const yaw = (s.th - th0) / STEP, jolt = Math.abs(yaw - last), band = (u: number) => u > V_KIN - 0.2 && u < V_DYN + 0.2;
      if (n) { if (band(s.v) || band(lastU)) inBand = Math.max(inBand, jolt); else outside = Math.max(outside, jolt); }
      last = yaw; lastU = s.v;
    }
    expect(s.v).toBe(0);
    expect(inBand).toBeLessThan(0.006);
    expect(inBand).toBeLessThanOrEqual(outside * 1.5);
  });
});

describe('steady cornering', () => {
  it.each(CARS)('%s: at a fixed steering wheel the circle widens with speed (understeer)', id => {
    const v = VEHICLES[id], r = [15, 30, 50, 80].map(kmh => cornering(v, kmh, 30));
    expect(Math.abs(r[0].R / r[0].Rk - 1)).toBeLessThan(0.02);   // at 15 km/h close to the low-speed model's circle
    for (let i = 1; i < r.length; i++) expect(r[i].R).toBeGreaterThan(r[i - 1].R);
    expect(r[3].R / r[3].Rk).toBeGreaterThan(1.15);
  });
  it.each(CARS)('%s: turned too hard at 50 km/h it runs wide at the tyres\' limit, and does not spin', id => {
    const v = VEHICLES[id], mu = v.dyn!.muF, r = cornering(v, 50, 180);
    expect(r.ay).toBeGreaterThan(0.85 * mu); expect(r.ay).toBeLessThan(1.05 * mu);
    expect(r.R).toBeGreaterThan(1.3 * r.Rk);
    expect(r.yaw).toBeLessThan(1.1 * mu * G / r.speed);
  });
});

describe('recording a drive', () => {
  it('a drive with the pedals, the wheel and a switch into Park mode and back replays exactly', () => {
    const v = VEHICLES['byd-atto2'], s = driving(v), rec = new Recorder();
    s.options.selfCentre = true; rec.begin(s);
    for (let n = 0; n < 60 * 30; n++) {
      const t = n / 60;
      s.input.acc = t < 6 ? 0.6 : t < 9 ? 0 : t > 20 && t < 24 ? 0.3 : 0; s.input.brk = t >= 9 && t < 13 ? 0.5 : 0;
      if (n % 30 === 0) s.input.wheelHeld = !s.input.wheelHeld;
      if (s.input.wheelHeld) s.wheelAngle = clamp(s.wheelAngle + 7, -200, 200);
      if (n === 60 * 15) { s.setMode('park'); s.input.acc = 0; }
      if (n > 60 * 15 && n < 60 * 17) s.input.rev = true; else s.input.rev = false;
      if (n === 60 * 19) s.setMode('drive');
      rec.before(s); s.step(STEP); rec.after(s);
    }
    const p = replayTo(rec.rec!, open, v, rec.rec!.steps);
    expect([p.x, p.z, p.th, p.v, p.mode]).toEqual([s.x, s.z, s.th, s.v, s.mode]);
  });
});

describe('the zoom rule', () => {
  it('shows the Atto 2 the blueprint\'s look-ahead at each speed', () => {
    const L = VEHICLES['byd-atto2'].L;
    for (const [kmh, m] of [[0, 14], [10, 14], [20, 16.5], [30, 25.5], [40, 36.4], [50, 49.3], [60, 64.0]]) expect(Math.abs(lookAhead(kmh / 3.6, L) - m)).toBeLessThan(0.1);
  });
});
