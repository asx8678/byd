// The simulation: one car in one scene, driven by a steering wheel and either hold-to-move pedals (Park mode, the
// exact low-speed model) or an accelerator and a brake (Drive mode on the street, see dynamics.ts). On the street the
// other cars and the lights (traffic.ts) step with it, and the rules of the road (rules.ts) watch your drive.
// Pure logic with no screen code, so it can be tested and ported as it is. The car and the scene
// come from data files or the level generator; with no arguments it is the Atto 2 in the garage around bay 561.
import { collides, type CarPart } from './collision';
import { ATTO2, GARAGE_561 } from './content';
import { blendOf, rates } from './dynamics';
import { DEG, clamp } from './math';
import { facesRight, parkedIn, placement } from './parking';
import { predictPath, type Prediction } from './predict';
import { Rules, type Fault, type RulesSnap } from './rules';
import { toBay, type Bay, type Obstacle, type Scene } from './scene';
import { edgeGaps, scanPdc, type SideValues } from './sensors';
import { Traffic, type PlayerView, type TrafficSnap } from './traffic';
import type { Vehicle } from './vehicle';

export interface SimInput {
  fwd: boolean; rev: boolean;      // pedals held (Park mode)
  kl: boolean; kr: boolean;        // keyboard steering held
  wheelHeld: boolean;              // a finger on the steering wheel (no self-centring then)
  acc: number; brk: number;        // accelerator and brake, 0 to 1 (Drive mode)
}
export type Mode = 'park' | 'drive';
/** Drive mode's parking sensors (and the gaps the numbers show) switch off above this speed, as real ones do (m/s). */
export const PDC_MAX = 10 / 3.6;

export interface ParkedResult {
  bay: string; noseIn: boolean;
  kind: 'bay' | 'kerb' | 'exit';
  offCentre: number;               // m, + to the right as you sit in the car
  angle: number;                   // degrees off straight
  gapWall: number; gapLeft: number; gapRight: number;   // m
  kerbGap: number;                 // m, the kerb-side tyres to the kerb (Infinity in a bay)
  gapFront: number; gapRear: number;   // m, body to the nearest thing ahead and behind
  hits: number; elapsed: number;   // touches on the way in, seconds
  moves: number;                   // runs in one direction, as the planner counts them
}

export type SimEvent =
  | { type: 'touch'; name: string; part: CarPart; hits: number }
  | { type: 'parked'; result: ParkedResult }
  | { type: 'fault'; fault: Fault };
/** The traffic and the rules as they were between two steps (a recording starts from it; a rewind goes back to it). */
export interface WorldSnap { traffic: TrafficSnap; rules: RulesSnap | null }

export interface SimOptions { lockDeg: number; selfCentre: boolean; bay: string }

export class Sim {
  scene: Scene;
  obstacles: readonly Obstacle[];
  // rear-axle pose (m, rad), speed (m/s, + forward), steering wheel angle (degrees, clockwise +)
  x = 0; z = 0; th = 0; v = 0;
  wheelAngle = 0;
  /** Park mode: hold to move, the exact low-speed model. Drive mode: accelerator and brake, the street model. */
  mode: Mode = 'park';
  // Drive mode's state besides the speed: side speed at the origin (m/s, left +), yaw rate (rad/s, left +), and the
  // last longitudinal acceleration (m/s², it shifts the weight between the axles)
  vy = 0; r = 0; ax = 0;
  wheelTarget: number | null = null;   // animate the wheel towards this (Straighten)
  readonly input: SimInput = { fwd: false, rev: false, kl: false, kr: false, wheelHeld: false, acc: 0, brk: 0 };
  readonly options: SimOptions;
  hits = 0; elapsed = 0; parked = false; inContact = false; started = false;
  lastMoveDir: 1 | -1 = 1;
  moves = 0;           // runs driven in one direction
  moveSign = 0;        // the direction of the current run (0 before the first)
  holdT = 0;
  time = 0;            // simulation clock, s
  lastDriveT = -9;     // when the car last moved or a pedal was held
  readonly gaps: SideValues = { front: 9, rear: 9, left: 9, right: 9 };                          // body outline to the nearest obstacle
  readonly pdc: SideValues = { front: Infinity, rear: Infinity, left: Infinity, right: Infinity };   // closest parking-sensor reading per group
  sensorReadings: number[];
  /** Your indicator (-1 left, 1 right, 0 off) and hazard lights. An indicator cancels itself once the wheel has been
   *  turned its way past a quarter turn and comes back, as a real one does. */
  ind: -1 | 0 | 1 = 0; hazard = false; indArmed = false;
  /** On the street: the other cars and the lights, and the rules your drive is held to (null elsewhere). */
  traffic: Traffic | null = null; rules: Rules | null = null;
  private poseSig = '';

  constructor(scene: Scene = GARAGE_561, public vehicle: Vehicle = ATTO2) {
    this.scene = scene; this.obstacles = scene.obstacles;
    this.options = { lockDeg: 2.7 * 180, selfCentre: true, bay: scene.defaultBay };
    this.sensorReadings = vehicle.sensors.map(() => Infinity);
  }

  /** Another car in the same scene. Call reset or resetAt next. */
  setVehicle(v: Vehicle): void {
    if (v === this.vehicle) return;
    this.vehicle = v; this.sensorReadings = v.sensors.map(() => Infinity); this.poseSig = '';
  }

  /** Single-track angle in degrees, right positive. */
  get steerDeg(): number { return this.wheelAngle / this.options.lockDeg * this.vehicle.MAXSTEER; }
  get gear(): 'D' | 'R' | 'P' { return this.mode === 'drive' || this.input.fwd || this.v > 0.05 ? 'D' : this.input.rev || this.v < -0.05 ? 'R' : 'P'; }
  /** The parking sensors are listening while the car moves and for 1.5 s after. */
  get armed(): boolean { return this.time - this.lastDriveT < 1.5; }

  /** Another scene for the same car: its default bay becomes the target. Call reset or resetAt next. */
  load(scene: Scene): void {
    this.scene = scene; this.obstacles = scene.obstacles; this.options.bay = scene.defaultBay; this.poseSig = '';
  }

  /** Back to a named start of the scene (its default if the name is unknown). */
  reset(start: string): void {
    const s = this.scene.starts[start] ?? this.scene.starts[this.scene.defaultStart];
    this.resetAt(s.x, s.z, s.th);
  }
  /** Back to the start of an attempt at a given pose. */
  resetAt(x: number, z: number, th: number): void {
    this.x = x; this.z = z; this.th = th;
    this.v = 0; this.wheelAngle = 0; this.wheelTarget = null; this.hits = 0; this.elapsed = 0;
    this.started = false; this.inContact = false; this.parked = false; this.lastMoveDir = 1; this.moves = 0; this.moveSign = 0;
    this.input.fwd = this.input.rev = false; this.input.acc = this.input.brk = 0; this.vy = this.r = this.ax = 0;
    this.ind = 0; this.hazard = false; this.indArmed = false;
  }

  /** Park mode or Drive mode, keeping the speed (Drive mode never reverses) and the turn the car is in. The pedals are
   *  left as they are: the caller decides what a pedal still held means now. */
  setMode(m: Mode): void {
    if (m === this.mode || (m === 'drive' && !this.vehicle.dyn)) return;
    this.mode = m; this.holdT = 0; this.ax = 0; this.vy = 0;
    if (m === 'drive') { this.v = Math.max(0, this.v); this.r = this.v * Math.tan(-this.steerDeg * DEG) / this.vehicle.WB; } else this.r = 0;
  }

  /** Put the car somewhere directly (tests, restoring a saved session). */
  place(x: number, z: number, th: number): void { this.x = x; this.z = z; this.th = th; }

  touching(x = this.x, z = this.z, th = this.th) { return collides(this.vehicle, this.obstacles, x, z, th); }
  /** The path at the current steering, to where it would touch: on the street, a car parked at the kerb counts too. */
  predict(dir: 1 | -1): Prediction { return predictPath(this.vehicle, this.obstacles, this.x, this.z, this.th, this.steerDeg, dir, this.traffic?.near(this.x, this.z, this.vehicle.REACH + 12, true)); }

  /** Advance by dt seconds. Returns what happened (touches, parking) for the UI to show. */
  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [], inp = this.input, lock = this.options.lockDeg, drive = this.mode === 'drive';
    this.time += dt;
    // steering: the Straighten animation, keyboard (more slowly at speed), and self-centring as the car rolls
    if (this.wheelTarget !== null) { const d = this.wheelTarget - this.wheelAngle; const stepA = 540 * dt; this.wheelAngle = Math.abs(d) <= stepA ? this.wheelTarget : this.wheelAngle + Math.sign(d) * stepA; if (this.wheelAngle === this.wheelTarget) this.wheelTarget = null; }
    const kRate = drive ? 420 / (1 + (this.v / 8) ** 2) : 420;
    if (inp.kl) this.wheelAngle = clamp(this.wheelAngle - kRate * dt, -lock, lock);
    if (inp.kr) this.wheelAngle = clamp(this.wheelAngle + kRate * dt, -lock, lock);
    if (this.options.selfCentre && !inp.wheelHeld && !inp.kl && !inp.kr && this.wheelTarget === null && Math.abs(this.v) > 0.05) {   // self-aligning torque returns the wheel
      const rate = Math.min(180, 55 * Math.abs(this.v)); this.wheelAngle = Math.abs(this.wheelAngle) <= rate * dt ? 0 : this.wheelAngle - Math.sign(this.wheelAngle) * rate * dt;
    }
    if (this.ind) { const w = this.wheelAngle * this.ind; if (w > 90) this.indArmed = true; else if (this.indArmed && w < 20) { this.ind = 0; this.indArmed = false; } }
    const delta = -this.steerDeg * DEG, dyn = this.vehicle.dyn!;
    if (drive) {
      // longitudinal, Drive mode: the accelerator and brake through the tyres; it never rolls backwards
      const R = rates(dyn, { u: this.v, vy: this.vy, r: this.r, ax: this.ax }, { delta, acc: inp.acc, brk: inp.brk }, blendOf(this.v));
      this.ax = R.ax; this.v = Math.max(0, this.v + R.du * dt); this.holdT = 0;
      this.lastMoveDir = 1; if (inp.acc > 0) this.started = true;
    } else {
      // longitudinal: hold to move, release to brake; the longer the hold, the higher the target speed
      const D = this.vehicle.drive;
      this.holdT = (inp.fwd || inp.rev) ? this.holdT + dt : 0;
      const ramp = Math.max(0, this.holdT - D.HOLD_T);
      const tgt = this.targetSpeed(ramp);
      if (tgt === 0) { this.v = Math.abs(this.v) <= D.BRAKE * dt ? 0 : this.v - Math.sign(this.v) * D.BRAKE * dt; }
      else if (tgt > this.v) this.v = Math.min(tgt, this.v + (this.v < 0 ? D.BRAKE : D.ACC) * dt);
      else this.v = Math.max(tgt, this.v - (this.v > 0 ? D.BRAKE : D.ACC) * dt);
      if (inp.fwd) this.lastMoveDir = 1; else if (inp.rev) this.lastMoveDir = -1;
    }
    if (inp.fwd || inp.rev) this.started = true;
    if (this.started && !this.parked) this.elapsed += dt;
    // kinematics with a collision check per substep; in Drive mode above 7 km/h the tyres slip: the car moves by the
    // tyre model's side speed and yaw rate, blended with the low-speed model's up to 18 km/h
    const sub = 4, h = dt / sub, lam = drive ? blendOf(this.v) : 0;
    let touched: { name: string; traffic: boolean } | null = null;
    for (let i = 0; i < sub && this.v !== 0; i++) {
      let nth: number, nx: number, nz: number;
      if (lam > 0) {
        const R = rates(dyn, { u: this.v, vy: this.vy, r: this.r, ax: this.ax }, { delta, acc: inp.acc, brk: inp.brk }, lam);
        this.vy += R.dvy * h; this.r += R.dr * h;
        const cs = Math.cos(this.th), sn = Math.sin(this.th), yaw = lam * this.r + (1 - lam) * this.v * Math.tan(delta) / this.vehicle.WB, side = lam * this.vy;
        nth = this.th + yaw * h; nx = this.x + (this.v * cs - side * sn) * h; nz = this.z + (-this.v * sn - side * cs) * h;
      } else {
        nth = this.th + this.v / this.vehicle.WB * Math.tan(delta) * h; nx = this.x + this.v * Math.cos(this.th) * h; nz = this.z - this.v * Math.sin(this.th) * h;
      }
      const hit = this.touching(nx, nz, nth), car = !hit && this.traffic ? this.traffic.touch(this.vehicle, nx, nz, nth) : null;
      if (hit || car) {
        const name = hit ? hit.obstacle.name : car!.name, part = hit ? hit.part : car!.part;
        if (!this.inContact) { this.inContact = true; this.hits++; events.push({ type: 'touch', name, part, hits: this.hits }); touched = { name, traffic: !!car && !car.parked }; }
        this.v = 0; this.vy = 0; this.r = 0; break;
      }
      this.x = nx; this.z = nz; this.th = nth; this.inContact = false;
    }
    // below 7 km/h Drive mode is the low-speed model: no side slip, the yaw rate the steering sets
    if (drive && lam === 0) { this.vy = 0; this.r = this.v * Math.tan(delta) / this.vehicle.WB; }
    if (Math.abs(this.v) > 0.05 && Math.sign(this.v) !== this.moveSign) { this.moveSign = Math.sign(this.v); this.moves++; }
    // the street: the traffic moves on (never into your car), and the rules judge this step
    if (this.traffic) this.traffic.step(dt, this.view());
    if (this.rules) for (const fault of this.rules.step({ x: this.x, z: this.z, th: this.th, v: this.v, L: this.vehicle.L, OVR: this.vehicle.OVR, drive }, this.traffic, this.time, dt, touched)) events.push({ type: 'fault', fault });
    // sensors only when the car (or a car in traffic near it: the sensors hear those too) has moved; in Drive mode only
    // below 10 km/h
    if (!drive || Math.abs(this.v) < PDC_MAX) {
      const near = this.traffic ? this.traffic.near(this.x, this.z, this.vehicle.REACH + 10) : undefined;
      const ps = this.x.toFixed(4) + ',' + this.z.toFixed(4) + ',' + this.th.toFixed(5) + (near ? near.map(o => `|${o.cx.toFixed(3)},${o.cz.toFixed(3)}`).join('') : '');
      if (ps !== this.poseSig) { this.poseSig = ps; edgeGaps(this.vehicle, this.obstacles, this.x, this.z, this.th, this.gaps, near); scanPdc(this.vehicle, this.obstacles, this.x, this.z, this.th, this.sensorReadings, this.pdc, near); }
    } else if (this.poseSig !== 'off') {
      this.poseSig = 'off'; this.sensorReadings.fill(Infinity);
      for (const k of ['front', 'rear', 'left', 'right'] as const) { this.gaps[k] = 9; this.pdc[k] = Infinity; }
    }
    const parked = this.checkParked(); if (parked) events.push({ type: 'parked', result: parked });
    if (inp.fwd || inp.rev || (drive && inp.acc > 0) || Math.abs(this.v) > 0.05) this.lastDriveT = this.time;
    return events;
  }

  /** Your car as the traffic sees it. */
  view(): PlayerView {
    const v = this.vehicle;
    return { x: this.x, z: this.z, th: this.th, v: this.v, L: v.L, W: v.W, OVR: v.OVR, ind: this.ind, hazard: this.hazard, park: this.mode === 'park' };
  }
  /** The traffic and the rules as they are now (null off the street). */
  world(): WorldSnap | null { return this.traffic ? { traffic: this.traffic.snapshot(), rules: this.rules?.snapshot() ?? null } : null; }
  /** Put the traffic and the rules back as a snapshot had them, making them for the scene's road network if need be. */
  restoreWorld(w: WorldSnap): void {
    const net = this.traffic?.net ?? this.scene.net;
    if (!net) return;
    (this.traffic ??= new Traffic(net)).restore(w.traffic);
    if (w.rules) (this.rules ??= new Rules(net)).restore(w.rules);
  }

  /** Speed the pedals ask for, m/s (0 when none is held). */
  targetSpeed(ramp = Math.max(0, this.holdT - this.vehicle.drive.HOLD_T)): number {
    const D = this.vehicle.drive, inp = this.input;
    return inp.fwd ? Math.min(D.VMAX_F, D.V_CREEP_F + ramp * D.RAMP_F) : inp.rev ? -Math.min(D.VMAX_R, D.V_CREEP_R + ramp * D.RAMP_R) : 0;
  }

  /** All four corners inside the target bay, stopped, within 6° of straight, the way round the bay asks for. */
  private checkParked(): ParkedResult | null {
    if (Math.abs(this.v) > 0.02) return null;
    const b = this.targetBay(), at = b && parkedIn(this.vehicle, b, this.x, this.z, this.th);
    if (!at) { this.parked = false; return null; }
    if (!facesRight(b, at) || this.parked) return null;
    this.parked = true;
    return this.resultAt(b, at);
  }

  /** How the car sits in the target bay right now, or null when it is not in it the right way round. The parked
   *  event reports the first stop; this is for reading the result later, once the car has settled. */
  parkedResult(): ParkedResult | null {
    const b = this.targetBay(), at = b && parkedIn(this.vehicle, b, this.x, this.z, this.th);
    return at && facesRight(b, at) ? this.resultAt(b, at) : null;
  }

  /** The space the car should park in (none on a street before Park mode picks one). */
  private targetBay(): Bay | undefined { return this.scene.bays[this.options.bay] ?? this.scene.bays[this.scene.defaultBay]; }
  private resultAt(b: Bay, at: NonNullable<ReturnType<typeof parkedIn>>): ParkedResult {
    const v = this.vehicle, { noseIn } = at, p = placement(v, b, this.scene.kerbs, this.x, this.z, this.th, at);
    const [bx, , bth] = toBay(b, this.x, this.z, this.th), cx = bx + (v.WB / 2) * Math.cos(bth), gl = cx - v.W / 2 - b.x0, gr = b.x1 - cx - v.W / 2;
    return {
      bay: this.options.bay, noseIn, kind: b.kind ?? 'bay',
      offCentre: p.offCentre, angle: p.angle,
      gapWall: noseIn ? this.gaps.front : this.gaps.rear,
      gapLeft: Math.max(0, noseIn ? gl : gr), gapRight: Math.max(0, noseIn ? gr : gl),
      kerbGap: p.kerbGap, gapFront: this.gaps.front, gapRear: this.gaps.rear,
      hits: this.hits, elapsed: this.elapsed, moves: this.moves,
    };
  }
}
