// The simulation: one car in one scene, driven by hold-to-move pedals and a steering wheel.
// Pure logic with no screen code, so it can be tested and ported as it is. The car and the scene
// come from data files; with no arguments it is the Atto 2 in the garage around bay 561.
import { collides, type CarPart } from './collision';
import { ATTO2, GARAGE_561 } from './content';
import { DEG, clamp } from './math';
import { parkedIn } from './parking';
import { predictPath, type Prediction } from './predict';
import type { Obstacle, Scene } from './scene';
import { edgeGaps, scanPdc, type SideValues } from './sensors';
import type { Vehicle } from './vehicle';

export interface SimInput {
  fwd: boolean; rev: boolean;      // pedals held
  kl: boolean; kr: boolean;        // keyboard steering held
  wheelHeld: boolean;              // a finger on the steering wheel (no self-centring then)
}

export interface ParkedResult {
  bay: string; noseIn: boolean;
  offCentre: number;               // m, + to the right as you sit in the car
  angle: number;                   // degrees off straight
  gapWall: number; gapLeft: number; gapRight: number;   // m
  hits: number; elapsed: number;   // touches on the way in, seconds
}

export type SimEvent =
  | { type: 'touch'; name: string; part: CarPart; hits: number }
  | { type: 'parked'; result: ParkedResult };

export interface SimOptions { lockDeg: number; selfCentre: boolean; bay: string }

export class Sim {
  readonly obstacles: readonly Obstacle[];
  // rear-axle pose (m, rad), speed (m/s, + forward), steering wheel angle (degrees, clockwise +)
  x = 0; z = 0; th = 0; v = 0;
  wheelAngle = 0;
  wheelTarget: number | null = null;   // animate the wheel towards this (Straighten)
  readonly input: SimInput = { fwd: false, rev: false, kl: false, kr: false, wheelHeld: false };
  readonly options: SimOptions;
  hits = 0; elapsed = 0; parked = false; inContact = false; started = false;
  lastMoveDir: 1 | -1 = 1;
  holdT = 0;
  time = 0;            // simulation clock, s
  lastDriveT = -9;     // when the car last moved or a pedal was held
  readonly gaps: SideValues = { front: 9, rear: 9, left: 9, right: 9 };                          // body outline to the nearest obstacle
  readonly pdc: SideValues = { front: Infinity, rear: Infinity, left: Infinity, right: Infinity };   // closest parking-sensor reading per group
  readonly sensorReadings: number[];
  private poseSig = '';

  constructor(readonly scene: Scene = GARAGE_561, readonly vehicle: Vehicle = ATTO2) {
    this.obstacles = scene.obstacles;
    this.options = { lockDeg: 2.7 * 180, selfCentre: true, bay: scene.defaultBay };
    this.sensorReadings = vehicle.sensors.map(() => Infinity);
  }

  /** Single-track angle in degrees, right positive. */
  get steerDeg(): number { return this.wheelAngle / this.options.lockDeg * this.vehicle.MAXSTEER; }
  get gear(): 'D' | 'R' | 'P' { return this.input.fwd || this.v > 0.05 ? 'D' : this.input.rev || this.v < -0.05 ? 'R' : 'P'; }
  /** The parking sensors are listening while the car moves and for 1.5 s after. */
  get armed(): boolean { return this.time - this.lastDriveT < 1.5; }

  /** Back to a named start of the scene (its default if the name is unknown). */
  reset(start: string): void {
    const s = this.scene.starts[start] ?? this.scene.starts[this.scene.defaultStart];
    this.resetAt(s.x, s.z, s.th);
  }
  /** Back to the start of an attempt at a given pose. */
  resetAt(x: number, z: number, th: number): void {
    this.x = x; this.z = z; this.th = th;
    this.v = 0; this.wheelAngle = 0; this.wheelTarget = null; this.hits = 0; this.elapsed = 0;
    this.started = false; this.inContact = false; this.parked = false; this.lastMoveDir = 1;
    this.input.fwd = this.input.rev = false;
  }

  /** Put the car somewhere directly (tests, restoring a saved session). */
  place(x: number, z: number, th: number): void { this.x = x; this.z = z; this.th = th; }

  touching(x = this.x, z = this.z, th = this.th) { return collides(this.vehicle, this.obstacles, x, z, th); }
  predict(dir: 1 | -1): Prediction { return predictPath(this.vehicle, this.obstacles, this.x, this.z, this.th, this.steerDeg, dir); }

  /** Advance by dt seconds. Returns what happened (touches, parking) for the UI to show. */
  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [], inp = this.input, lock = this.options.lockDeg;
    this.time += dt;
    // steering: the Straighten animation, keyboard, and self-centring as the car rolls
    if (this.wheelTarget !== null) { const d = this.wheelTarget - this.wheelAngle; const stepA = 540 * dt; this.wheelAngle = Math.abs(d) <= stepA ? this.wheelTarget : this.wheelAngle + Math.sign(d) * stepA; if (this.wheelAngle === this.wheelTarget) this.wheelTarget = null; }
    if (inp.kl) this.wheelAngle = clamp(this.wheelAngle - 420 * dt, -lock, lock);
    if (inp.kr) this.wheelAngle = clamp(this.wheelAngle + 420 * dt, -lock, lock);
    if (this.options.selfCentre && !inp.wheelHeld && !inp.kl && !inp.kr && this.wheelTarget === null && Math.abs(this.v) > 0.05) {   // self-aligning torque returns the wheel
      const rate = Math.min(180, 55 * Math.abs(this.v)); this.wheelAngle = Math.abs(this.wheelAngle) <= rate * dt ? 0 : this.wheelAngle - Math.sign(this.wheelAngle) * rate * dt;
    }
    // longitudinal: hold to move, release to brake; the longer the hold, the higher the target speed
    const D = this.vehicle.drive;
    this.holdT = (inp.fwd || inp.rev) ? this.holdT + dt : 0;
    const ramp = Math.max(0, this.holdT - D.HOLD_T);
    const tgt = this.targetSpeed(ramp);
    if (tgt === 0) { this.v = Math.abs(this.v) <= D.BRAKE * dt ? 0 : this.v - Math.sign(this.v) * D.BRAKE * dt; }
    else if (tgt > this.v) this.v = Math.min(tgt, this.v + (this.v < 0 ? D.BRAKE : D.ACC) * dt);
    else this.v = Math.max(tgt, this.v - (this.v > 0 ? D.BRAKE : D.ACC) * dt);
    if (inp.fwd) this.lastMoveDir = 1; else if (inp.rev) this.lastMoveDir = -1;
    if (inp.fwd || inp.rev) this.started = true;
    if (this.started && !this.parked) this.elapsed += dt;
    // kinematics with a collision check per substep
    const sub = 4, h = dt / sub, delta = -this.steerDeg * DEG;
    for (let i = 0; i < sub && this.v !== 0; i++) {
      const nth = this.th + this.v / this.vehicle.WB * Math.tan(delta) * h, nx = this.x + this.v * Math.cos(this.th) * h, nz = this.z - this.v * Math.sin(this.th) * h;
      const hit = this.touching(nx, nz, nth);
      if (hit) {
        if (!this.inContact) { this.inContact = true; this.hits++; events.push({ type: 'touch', name: hit.obstacle.name, part: hit.part, hits: this.hits }); }
        this.v = 0; break;
      }
      this.x = nx; this.z = nz; this.th = nth; this.inContact = false;
    }
    // sensors only when the car has moved
    const ps = this.x.toFixed(4) + ',' + this.z.toFixed(4) + ',' + this.th.toFixed(5);
    if (ps !== this.poseSig) { this.poseSig = ps; edgeGaps(this.vehicle, this.obstacles, this.x, this.z, this.th, this.gaps); scanPdc(this.vehicle, this.obstacles, this.x, this.z, this.th, this.sensorReadings, this.pdc); }
    const parked = this.checkParked(); if (parked) events.push({ type: 'parked', result: parked });
    if (inp.fwd || inp.rev || Math.abs(this.v) > 0.05) this.lastDriveT = this.time;
    return events;
  }

  /** Speed the pedals ask for, m/s (0 when none is held). */
  targetSpeed(ramp = Math.max(0, this.holdT - this.vehicle.drive.HOLD_T)): number {
    const D = this.vehicle.drive, inp = this.input;
    return inp.fwd ? Math.min(D.VMAX_F, D.V_CREEP_F + ramp * D.RAMP_F) : inp.rev ? -Math.min(D.VMAX_R, D.V_CREEP_R + ramp * D.RAMP_R) : 0;
  }

  /** All four corners inside the target bay, stopped, within 6° of straight: nose-in or reversed in. */
  private checkParked(): ParkedResult | null {
    if (Math.abs(this.v) > 0.02) return null;
    const v = this.vehicle, b = this.scene.bays[this.options.bay] ?? this.scene.bays[this.scene.defaultBay];
    const at = parkedIn(v, b, this.x, this.z, this.th);
    if (!at) { this.parked = false; return null; }
    const { errIn, errOut, noseIn, noseOut } = at;
    if (!(noseIn || noseOut) || this.parked) return null;
    this.parked = true;
    const cs = Math.cos(this.th), cx = this.x + (v.WB / 2) * cs, gl = cx - v.W / 2 - b.x0, gr = b.x1 - cx - v.W / 2;
    return {
      bay: this.options.bay, noseIn,
      offCentre: (noseIn ? 1 : -1) * (cx - (b.x0 + b.x1) / 2), angle: (noseIn ? errIn : errOut) / DEG,
      gapWall: noseIn ? this.gaps.front : this.gaps.rear,
      gapLeft: Math.max(0, noseIn ? gl : gr), gapRight: Math.max(0, noseIn ? gr : gl),
      hits: this.hits, elapsed: this.elapsed,
    };
  }
}
