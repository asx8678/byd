// A car from its data file (content/vehicles/*.json): dimensions, outline, mirrors, steering
// lock, driveline and parking sensors. Rear-axle bicycle model; local frame: rear axle at the
// origin, x forward, z to the right.
import { DEG, type Pt } from './math';

export type Side = 'front' | 'rear' | 'left' | 'right';
export interface SensorMount { g: Side; lx: number; lz: number; a: number }

/** The file format. */
export interface VehicleSpec {
  format: 1; id: string; name: string; basedOn?: string; sources?: string[]; notes?: string;
  dims: { length: number; width: number; height: number; wheelbase: number; track: number; overhangFront: number; overhangRear: number; wheelRadius: number; wheelWidth: number; mass: number };
  turning: { kerbRadius: number };
  outline: { half: number[][] };                                  // one side, front to back; mirrored for the other
  mirrors: { height: number; box: number[] } | null;               // [x0, z0, x1, z1] of the right mirror; the left is mirrored
  planCorners: number[][];                                         // FL, FR, RL, RR on the rounded corners, for drawn tracks
  drive: { creepForward: number; maxForward: number; rampForward: number; creepReverse: number; maxReverse: number; rampReverse: number; holdTime: number; accel: number; brake: number };
  parkingSensors: { layout: string; ranges: { front: number; rear: number; side: number }; coneDeg: number; bands: Record<Side, number[]> } | null;
}

/** Hold to move, release to brake. A short press creeps; keep holding and the target speed ramps up. */
export interface Drive { V_CREEP_F: number; VMAX_F: number; RAMP_F: number; V_CREEP_R: number; VMAX_R: number; RAMP_R: number; HOLD_T: number; ACC: number; BRAKE: number }

export interface Vehicle {
  readonly id: string; readonly name: string;
  readonly L: number; readonly W: number; readonly H: number; readonly WB: number; readonly TRACK: number;
  readonly OVF: number; readonly OVR: number; readonly WR: number; readonly WW: number; readonly R_CC: number; readonly MASS: number;
  /** Circle of the rear-axle centre at full lock. */
  readonly R_REAR: number;
  /** Single-track steering angle at full lock, degrees. */
  readonly MAXSTEER: number;
  /** Circle swept by the outer front corner at full lock. */
  readonly R_WALL: number;
  readonly body: Pt[]; readonly mirrors: Pt[][]; readonly mirrorY: number; readonly planCorners: Pt[];
  readonly drive: Drive;
  readonly sensors: readonly SensorMount[];
  readonly pdc: { front: number; rear: number; side: number; half: number; bands: Record<Side, readonly number[]> };
}

export function makeVehicle(s: VehicleSpec): Vehicle {
  const d = s.dims, L = d.length, W = d.width, WB = d.wheelbase, TRACK = d.track, R_CC = s.turning.kerbRadius;
  // full-lock geometry from the kerb-to-kerb turning radius (outer front wheel)
  const R_REAR = Math.sqrt(R_CC * R_CC - WB * WB) - TRACK / 2;
  const half = s.outline.half.map(([a, b]): Pt => [a, b]);
  const body: Pt[] = [...half, ...half.slice().reverse().map(([a, b]): Pt => [a, -b])];
  const mirrors: Pt[][] = s.mirrors ? [-1, 1].map(sg => { const [x0, z0, x1, z1] = s.mirrors!.box; return [[x0, sg * z0], [x1, sg * z0], [x1, sg * z1], [x0, sg * z1]] as Pt[]; }) : [];
  const v: Omit<Vehicle, 'sensors'> = {
    id: s.id, name: s.name, L, W, H: d.height, WB, TRACK, OVF: d.overhangFront, OVR: d.overhangRear, WR: d.wheelRadius, WW: d.wheelWidth, R_CC, MASS: d.mass,
    R_REAR,
    MAXSTEER: Math.atan(WB / R_REAR) / DEG,
    R_WALL: Math.hypot(R_REAR + W / 2, WB + d.overhangFront),
    body, mirrors, mirrorY: s.mirrors ? s.mirrors.height : Infinity,
    planCorners: s.planCorners.map(([a, b]): Pt => [a, b]),
    drive: { V_CREEP_F: s.drive.creepForward, VMAX_F: s.drive.maxForward, RAMP_F: s.drive.rampForward, V_CREEP_R: s.drive.creepReverse, VMAX_R: s.drive.maxReverse, RAMP_R: s.drive.rampReverse, HOLD_T: s.drive.holdTime, ACC: s.drive.accel, BRAKE: s.drive.brake },
    pdc: s.parkingSensors
      ? { ...s.parkingSensors.ranges, half: (s.parkingSensors.coneDeg / 2) * DEG, bands: s.parkingSensors.bands }
      : { front: 0, rear: 0, side: 0, half: 0, bands: { front: [], rear: [], left: [], right: [] } },
  };
  return { ...v, sensors: s.parkingSensors ? standardSensors(v) : [] };
}

/** Four sensors in each bumper (two centre, two corner angled 35° out) and two per side, each a cone. */
function standardSensors(v: Pick<Vehicle, 'WB' | 'OVF' | 'OVR'>): SensorMount[] {
  const fx = v.WB + v.OVF - 0.03, rx = -v.OVR + 0.02;
  return [
    { g: 'front', lx: fx, lz: -0.26, a: 0 }, { g: 'front', lx: fx, lz: 0.26, a: 0 },
    { g: 'front', lx: fx - 0.08, lz: -0.68, a: -35 * DEG }, { g: 'front', lx: fx - 0.08, lz: 0.68, a: 35 * DEG },
    { g: 'rear', lx: rx, lz: -0.26, a: Math.PI }, { g: 'rear', lx: rx, lz: 0.26, a: Math.PI },
    { g: 'rear', lx: rx + 0.06, lz: -0.68, a: Math.PI + 35 * DEG }, { g: 'rear', lx: rx + 0.06, lz: 0.68, a: Math.PI - 35 * DEG },
    { g: 'left', lx: v.WB + 0.3, lz: -0.9, a: -Math.PI / 2 }, { g: 'left', lx: -0.3, lz: -0.9, a: -Math.PI / 2 },
    { g: 'right', lx: v.WB + 0.3, lz: 0.9, a: Math.PI / 2 }, { g: 'right', lx: -0.3, lz: 0.9, a: Math.PI / 2 },
  ];
}
