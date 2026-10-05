// Street physics for Drive mode. A single-track ("bicycle") model: tyres that slip and run out of grip, weight that
// shifts forward under braking and back under power, the drive train's power and the grip of the driven wheels,
// brakes with ABS, regenerative or engine braking when you lift off, drag and rolling resistance. Tyre-slip models
// break down as a car stops, so between 7 and 18 km/h this one is blended into the exact low-speed model the parking
// game uses; below 7 km/h the car moves exactly as in Park mode. The blend mixes how the two models move the car:
// the tyre model keeps its own side speed and yaw rate, started from the low-speed model's as the car comes into the
// band. Pure logic, no screen code.
import { clamp } from './math';
import type { VehicleSpec } from './vehicle';

export const G = 9.81, RHO = 1.2;
/** The blend: the low-speed model up to V_KIN, the tyre model from V_DYN, both in between (m/s). */
export const V_KIN = 7 / 3.6, V_DYN = 18 / 3.6;
/** How much of the tyre model is used at speed u (0 below 7 km/h, 1 above 18 km/h). */
export const blendOf = (u: number): number => clamp((u - V_KIN) / (V_DYN - V_KIN), 0, 1);

/** The car file's driving figures. */
export interface DynamicsSpec {
  power: number;                     // kW, the most the drive train gives
  driven: 'front' | 'rear' | 'all';
  frontShare: number;                // share of the car's weight on the front axle
  cgHeight: number;                  // m, height of the centre of gravity
  cdA: number;                       // m², drag coefficient times frontal area
  grip: number;                      // friction coefficient of the front tyres on dry asphalt (the rears get 5% more)
  launch: number;                    // m/s², the most the drive train pulls from rest (torque, gearing, traction control)
  coast: number;                     // m/s², slowing with no pedal pressed: regenerative or engine braking
  powerShare: number;                // the share of the peak power the model gets on average through a run
  topSpeed: number;                  // km/h
  zeroTo100?: number;                // s, 0–100 km/h as published
  zeroTo60mph?: number;              // s, 0–60 mph as published (where that is the figure given)
}

/** The figures the model runs on, worked out once per car. Lengths along the car from its origin (see vehicle.ts). */
export interface Dyn {
  m: number; Iz: number;
  xg: number; xf: number; xr: number; h: number;   // centre of gravity, front axle, rear axle; CG height
  P: number; Fl: number;                            // effective power (W), most drive force from rest (N)
  driveFront: number;                               // share of the drive force on the front axle
  cdA: number; muF: number; muR: number; cF: number; cR: number;   // cornering stiffness per newton of axle load, per radian
  coast: number; vmax: number;
  rearRatio: number;                                // rear-axle steering: tan(rear) = -rearRatio * tan(front) at low speed
}

/** The model's figures for a car, given where its axles sit (front axle at WB, rear axle at RA from the origin) and
 *  its rear-axle steering ratio. */
export function makeDyn(s: VehicleSpec, WB: number, RA: number, RS: number): Dyn {
  const d = s.dynamics!, m = s.dims.mass, Lg = WB - RA;
  const xg = RA + d.frontShare * Lg;   // the front axle carries frontShare of the weight: the CG is that far from the rear axle
  const a = WB - xg, b = xg - RA;
  return {
    m, Iz: m * a * b,                  // yaw inertia: the usual estimate, a car's mass times the two axle distances
    xg, xf: WB, xr: RA, h: d.cgHeight,
    P: d.power * 1000 * d.powerShare, Fl: m * d.launch,
    driveFront: d.driven === 'front' ? 1 : d.driven === 'rear' ? 0 : 0.4,
    cdA: d.cdA, muF: d.grip, muR: d.grip * 1.05,
    // the front tyres are a little softer in cornering than the rears, as on most road cars: the car understeers
    cF: 12, cR: 16,
    coast: d.coast, vmax: d.topSpeed / 3.6,
    rearRatio: RS,
  };
}

export interface DynState { u: number; vy: number; r: number; ax: number }
export interface DynInput { delta: number; acc: number; brk: number }
/** The forward speed's rate of change (the two models blended), and the tyre model's side-speed and yaw-rate rates. */
export interface Rates { du: number; dvy: number; dr: number; ax: number }

/** Lateral force of an axle (N) at slip angle alpha, with fx of its grip already used along the road. */
function lateral(alpha: number, Fz: number, mu: number, c: number): number {
  return mu * Fz * Math.sin(1.3 * Math.atan(c / (1.3 * mu) * alpha));
}

/**
 * The rates of change of the forward speed u at blend lam, and of the tyre model's side speed vy (at the origin, left
 * positive) and yaw rate r (left positive), with the front wheels at delta (radians, left positive) and the pedals at
 * acc and brk (0 to 1). Below the band (lam 0) only the speed changes: the low-speed model has no slip.
 */
export function rates(d: Dyn, st: DynState, inp: DynInput, lam: number): Rates {
  const { u, vy, r } = st, { delta, acc, brk } = inp, m = d.m;
  // axle loads, with the weight shifted by the last step's longitudinal acceleration
  const a = d.xf - d.xg, b = d.xg - d.xr, Lg = a + b;
  const Fzf = Math.max(0.1 * m * G, m * (G * b - st.ax * d.h) / Lg), Fzr = Math.max(0.1 * m * G, m * (G * a + st.ax * d.h) / Lg);
  const Df = d.muF * Fzf, Dr = d.muR * Fzr;
  // rear-axle steering turns the rear wheels against the front ones up to 20 km/h, fading out by 60 km/h
  const kRear = d.rearRatio ? d.rearRatio * clamp((60 / 3.6 - u) / (40 / 3.6), 0, 1) : 0;
  const dRear = kRear ? -Math.atan(kRear * Math.tan(delta)) : 0;
  // the tyres' sideways grip as they slip (none in the low-speed model)
  let Fyf = 0, Fyr = 0;
  if (lam > 0 && u > 0.1) {
    Fyf = lateral(delta - Math.atan2(vy + d.xf * r, u), Fzf, d.muF, d.cF);
    Fyr = lateral(dRear - Math.atan2(vy + d.xr * r, u), Fzr, d.muR, d.cR);
  }
  // what the pedals ask for along the road: drive force (power-limited), brakes shared by axle load (EBD), and the
  // slowing with no pedal on the driven wheels
  const moving = u > 0;
  const Fd = acc > 0 && u < d.vmax ? acc * Math.min(d.Fl, d.P / Math.max(u, 0.1)) : 0;
  const Fb = moving ? brk * 1.1 * G * d.muF * m : 0, Fc = moving && acc === 0 ? d.coast * m : 0;
  const shareF = Fzf / (Fzf + Fzr);
  let Fxf = (Fd - Fc) * d.driveFront - Fb * shareF, Fxr = (Fd - Fc) * (1 - d.driveFront) - Fb * (1 - shareF);
  // traction control and ABS keep what the tyres need for cornering, but always allow 30% of their grip along the road;
  // what is used along the road leaves less for cornering (the friction ellipse)
  const capF = Math.max(Math.sqrt(Math.max(0, Df * Df - Fyf * Fyf)), 0.3 * Df), capR = Math.max(Math.sqrt(Math.max(0, Dr * Dr - Fyr * Fyr)), 0.3 * Dr);
  Fxf = clamp(Fxf, -capF, capF); Fxr = clamp(Fxr, -capR, capR);
  const yF = Math.sqrt(Math.max(0, Df * Df - Fxf * Fxf)), yR = Math.sqrt(Math.max(0, Dr * Dr - Fxr * Fxr));
  Fyf = clamp(Fyf, -yF, yF); Fyr = clamp(Fyr, -yR, yR);
  const drag = moving ? 0.5 * RHO * d.cdA * u * u + 0.012 * m * G : 0;
  // the low-speed model: no slip
  const duK = (Fxf + Fxr - drag) / m;
  if (lam <= 0) return { du: duK, dvy: 0, dr: 0, ax: duK };
  // the tyre model, in the car's frame at the centre of gravity
  const cf = Math.cos(delta), sf = Math.sin(delta), cr = Math.cos(dRear), sr = Math.sin(dRear);
  const X = Fxf * cf - Fyf * sf + Fxr * cr - Fyr * sr - drag, Yf = Fxf * sf + Fyf * cf, Yr = Fxr * sr + Fyr * cr;
  const vyc = vy + d.xg * r;
  const duD = X / m + vyc * r, drD = ((d.xf - d.xg) * Yf + (d.xr - d.xg) * Yr) / d.Iz, dvyD = (Yf + Yr) / m - u * r - d.xg * drD;
  return { du: lam * duD + (1 - lam) * duK, dvy: dvyD, dr: drD, ax: lam * X / m + (1 - lam) * duK };
}

/** How far ahead Drive mode's map shows: your car, 1.5 s of travel and the distance to stop at 4 m/s², at least 14 m. */
export const lookAhead = (u: number, L: number): number => Math.max(14, L + 1.5 * u + (u * u) / 8);
