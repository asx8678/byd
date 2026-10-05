// A car from its data file (content/vehicles/*.json): dimensions, outline, mirrors, steering lock,
// driveline and parking sensors. Bicycle model; local frame: x forward, z to the right, with the origin on the
// centre line at the point the car turns about. That is the rear axle, unless the rear wheels steer as well:
// then the origin sits a little ahead of the rear axle (see makeVehicle) and the rest of the game is unchanged.
import { DEG, type Pt } from './math';

export type Side = 'front' | 'rear' | 'left' | 'right';
export interface SensorMount { g: Side; lx: number; lz: number; a: number }

/** A published turning circle (diameters, m): kerb to kerb is the track of the outer front wheel, wall to wall the
 *  track of the body's outermost point; rearSteer is the rear wheels' angle at full lock it was measured with. */
export interface Circle { kerbDiameter?: number; wallDiameter?: number; rearSteer?: number }

/** The file format. Lengths in metres in the rear-axle frame: x forward from the rear axle, z to the right. */
export interface VehicleSpec {
  format: 1; id: string; name: string; short?: string; basedOn?: string; sources?: string[]; notes?: string;
  estimates?: string[];                                            // figures no source gave: the app says they are estimates
  dims: { length: number; width: number; widthMirrors?: number; height: number; wheelbase: number; track: number; overhangFront: number; overhangRear: number; wheelRadius: number; wheelWidth: number; mass: number };
  /** The steering lock is worked out from the turning circle: the Atto 2's kerb radius, or the published circles. */
  turning: { by?: string; kerbRadius?: number; circles?: Circle[]; turnsLockToLock?: number };   // by: who published them
  /** Rear-axle steering: the rear wheels' angle at full lock for each setting (degrees, 0 = switched off). */
  rearSteer?: { options: number[]; default: number };
  outline: { half: number[][] };                                  // one side, front to back; mirrored for the other
  mirrors: { height: number; box: number[] } | null;               // [x0, z0, x1, z1] of the right mirror; the left is mirrored
  planCorners: number[][];                                         // FL, FR, RL, RR on the rounded corners, for drawn tracks
  glass?: number[];                                                // where the windows run on the plan, front and back (x)
  seats?: number;                                                  // 2 for a two-seater: no back seat for the coach to name
  drive: { creepForward: number; maxForward: number; rampForward: number; creepReverse: number; maxReverse: number; rampReverse: number; holdTime: number; accel: number; brake: number };
  parkingSensors: { layout: string; ranges: { front: number; rear: number; side: number }; coneDeg: number; bands: Record<Side, number[]>; cornerZ?: number; sideZ?: number } | null;
}

/** Hold to move, release to brake. A short press creeps; keep holding and the target speed ramps up. */
export interface Drive { V_CREEP_F: number; VMAX_F: number; RAMP_F: number; V_CREEP_R: number; VMAX_R: number; RAMP_R: number; HOLD_T: number; ACC: number; BRAKE: number }

export interface Vehicle {
  readonly id: string; readonly name: string;
  /** The car file this comes from (a car with rear-axle steering makes one Vehicle per setting), and its short name. */
  readonly family: string; readonly short: string;
  readonly L: number; readonly W: number; readonly H: number; readonly TRACK: number;
  /** From the origin to the front axle: the wheelbase, or less when the rear wheels steer. */
  readonly WB: number;
  /** Where the rear axle is: 0, or behind the origin when the rear wheels steer. The wheelbase is WB - RA. */
  readonly RA: number;
  /** Rear-axle steering: tan(rear angle) = RS * tan(front angle), counter-phase (0 without); the angle at full lock. */
  readonly RS: number; readonly REAR_DEG: number;
  /** Front overhang past the front axle, and how far the body reaches behind the origin. */
  readonly OVF: number; readonly OVR: number;
  readonly WR: number; readonly WW: number; readonly R_CC: number; readonly MASS: number;
  /** Circle of the origin (the rear-axle centre) at full lock. */
  readonly R_REAR: number;
  /** Single-track steering angle of the front wheels at full lock, degrees. */
  readonly MAXSTEER: number;
  /** Circle swept by the corner of the car's bounding box at full lock. */
  readonly R_WALL: number;
  /** The furthest any part of the car (body, mirrors, tyres) is from the origin. */
  readonly REACH: number;
  readonly body: Pt[]; readonly mirrors: Pt[][]; readonly mirrorY: number; readonly planCorners: Pt[];
  /** The windows on the plan, from the windscreen's foot back to the rear window (x). */
  readonly glass: readonly [number, number];
  readonly drive: Drive;
  readonly sensors: readonly SensorMount[];
  readonly pdc: { front: number; rear: number; side: number; half: number; bands: Record<Side, readonly number[]> };
  /** The data file, for the facts and sources shown in the app. */
  readonly spec: VehicleSpec;
}

/**
 * Full lock with the rear wheels at rearDeg (counter-phase), for front-lock tangent tf: the turning centre's distance
 * from the centre line (R), how far ahead of the rear axle the car turns about (x0), and the radii the outer front
 * wheel (kerb) and the body (wall) sweep. The rear wheels follow tan(rear) = k tan(front) with a fixed k, so that
 * point stays put at any steering: the car moves exactly like an ordinary one whose rear axle is there.
 */
export function fullLock(s: VehicleSpec, tf: number, rearDeg: number): { R: number; x0: number; kerb: number; wall: number } {
  const d = s.dims, tr = Math.tan(rearDeg * DEG), R = d.wheelbase / (tf + tr), x0 = R * tr;
  let wall = 0;
  for (const [x, z] of s.outline.half) wall = Math.max(wall, Math.hypot(R + Math.abs(z), x - x0));
  return { R, x0, kerb: Math.hypot(R + d.track / 2, d.wheelbase - x0), wall };
}

/** The tangent of the front wheels' single-track angle at full lock, from the published turning circles: exactly from a
 *  kerb-to-kerb figure measured without rear steering, else the angle that best fits all the figures. */
export function lockOf(s: VehicleSpec): number {
  const d = s.dims, cs = s.turning.circles ?? [];
  const kerb = s.turning.kerbRadius ?? cs.filter(c => c.kerbDiameter && !c.rearSteer).map(c => c.kerbDiameter! / 2)[0];
  if (kerb) return d.wheelbase / (Math.sqrt(kerb * kerb - d.wheelbase * d.wheelbase) - d.track / 2);
  const err = (tf: number) => cs.reduce((e, c) => {
    const g = fullLock(s, tf, c.rearSteer ?? 0);
    return e + (c.kerbDiameter ? (2 * g.kerb - c.kerbDiameter) ** 2 : 0) + (c.wallDiameter ? (2 * g.wall - c.wallDiameter) ** 2 : 0);
  }, 0);
  if (!cs.length) throw new Error(`${s.id}: no turning circle`);
  // golden-section search between 15° and 70°: a fixed number of steps, so every device gets the same car
  let a = Math.tan(15 * DEG), b = Math.tan(70 * DEG);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), e = a + g * (b - a), fc = err(c), fe = err(e);
  for (let i = 0; i < 80; i++) {
    if (fc < fe) { b = e; e = c; fe = fc; c = b - g * (b - a); fc = err(c); }
    else { a = c; c = e; fc = fe; e = a + g * (b - a); fe = err(e); }
  }
  return (a + b) / 2;
}

/** The car's own turning circles at full lock (diameters, m): its outer front wheel's (kerb to kerb) and its body's
 *  (wall to wall). The car turns about a point on the y axis through the origin, R_REAR to the side. */
export function circlesOf(v: Vehicle): { kerb: number; wall: number } {
  let wall = 0;
  for (const [x, z] of v.body) wall = Math.max(wall, Math.hypot(x, v.R_REAR + Math.abs(z)));
  return { kerb: 2 * v.R_CC, wall: 2 * wall };
}

/** The id of a car with its rear-axle steering set to rearDeg (the file's own id without rear steering). */
export const variantId = (s: VehicleSpec, rearDeg: number): string => (s.rearSteer ? `${s.id}@${rearDeg}` : s.id);

export function makeVehicle(s: VehicleSpec, rearDeg = s.rearSteer?.default ?? 0): Vehicle {
  const d = s.dims, L = d.length, W = d.width, TRACK = d.track;
  let WB = d.wheelbase, R_CC: number, R_REAR: number, x0 = 0;
  if (s.turning.kerbRadius !== undefined && !rearDeg) {
    // full-lock geometry from the kerb-to-kerb turning radius (outer front wheel)
    R_CC = s.turning.kerbRadius;
    R_REAR = Math.sqrt(R_CC * R_CC - WB * WB) - TRACK / 2;
  } else {
    const g = fullLock(s, lockOf(s), rearDeg);
    x0 = g.x0; WB = d.wheelbase - x0; R_REAR = g.R; R_CC = g.kerb;
  }
  const shift = ([a, b]: number[]): Pt => [a - x0, b];
  const half = s.outline.half.map(shift);
  const body: Pt[] = [...half, ...half.slice().reverse().map(([a, b]): Pt => [a, -b])];
  const mirrors: Pt[][] = s.mirrors ? [-1, 1].map(sg => { const [mx0, z0, mx1, z1] = s.mirrors!.box; return [[mx0 - x0, sg * z0], [mx1 - x0, sg * z0], [mx1 - x0, sg * z1], [mx0 - x0, sg * z1]] as Pt[]; }) : [];
  const RA = x0 ? -x0 : 0, OVR = d.overhangRear + x0;
  const tyres = [WB, RA].flatMap(ax => [[ax + d.wheelRadius, TRACK / 2 + d.wheelWidth / 2], [ax - d.wheelRadius, TRACK / 2 + d.wheelWidth / 2]]);
  const REACH = Math.max(...[...body, ...mirrors.flat(), ...tyres].map(([a, b]) => Math.hypot(a, b)));
  const v: Omit<Vehicle, 'sensors'> = {
    id: variantId(s, rearDeg), name: s.name, family: s.id, short: s.short ?? s.name,
    L, W, H: d.height, WB, RA, RS: rearDeg ? Math.tan(rearDeg * DEG) / (WB / R_REAR) : 0, REAR_DEG: rearDeg, TRACK,
    OVF: d.overhangFront, OVR, WR: d.wheelRadius, WW: d.wheelWidth, R_CC, MASS: d.mass,
    R_REAR,
    MAXSTEER: Math.atan(WB / R_REAR) / DEG,
    R_WALL: Math.hypot(R_REAR + W / 2, WB + d.overhangFront),
    REACH,
    body, mirrors, mirrorY: s.mirrors ? s.mirrors.height : Infinity,
    planCorners: s.planCorners.map(shift),
    glass: s.glass ? [s.glass[0] - x0, s.glass[1] - x0] : [WB - 0.32, -0.45],
    drive: { V_CREEP_F: s.drive.creepForward, VMAX_F: s.drive.maxForward, RAMP_F: s.drive.rampForward, V_CREEP_R: s.drive.creepReverse, VMAX_R: s.drive.maxReverse, RAMP_R: s.drive.rampReverse, HOLD_T: s.drive.holdTime, ACC: s.drive.accel, BRAKE: s.drive.brake },
    pdc: s.parkingSensors
      ? { ...s.parkingSensors.ranges, half: (s.parkingSensors.coneDeg / 2) * DEG, bands: s.parkingSensors.bands }
      : { front: 0, rear: 0, side: 0, half: 0, bands: { front: [], rear: [], left: [], right: [] } },
    spec: s,
  };
  return { ...v, sensors: s.parkingSensors ? standardSensors(v, s.parkingSensors) : [] };
}

/** Each layout's groups: four sensors in a bumper (two centre, two corner angled 35° out), two per side, each a cone. */
function standardSensors(v: Pick<Vehicle, 'WB' | 'OVF' | 'OVR' | 'RA'>, p: NonNullable<VehicleSpec['parkingSensors']>): SensorMount[] {
  const fx = v.WB + v.OVF - 0.03, rx = -v.OVR + 0.02, cz = p.cornerZ ?? 0.68, sz = p.sideZ ?? 0.9;
  const front: SensorMount[] = [
    { g: 'front', lx: fx, lz: -0.26, a: 0 }, { g: 'front', lx: fx, lz: 0.26, a: 0 },
    { g: 'front', lx: fx - 0.08, lz: -cz, a: -35 * DEG }, { g: 'front', lx: fx - 0.08, lz: cz, a: 35 * DEG },
  ];
  const rear: SensorMount[] = [
    { g: 'rear', lx: rx, lz: -0.26, a: Math.PI }, { g: 'rear', lx: rx, lz: 0.26, a: Math.PI },
    { g: 'rear', lx: rx + 0.06, lz: -cz, a: Math.PI + 35 * DEG }, { g: 'rear', lx: rx + 0.06, lz: cz, a: Math.PI - 35 * DEG },
  ];
  const sides: SensorMount[] = [
    { g: 'left', lx: v.WB + 0.3, lz: -sz, a: -Math.PI / 2 }, { g: 'left', lx: v.RA - 0.3, lz: -sz, a: -Math.PI / 2 },
    { g: 'right', lx: v.WB + 0.3, lz: sz, a: Math.PI / 2 }, { g: 'right', lx: v.RA - 0.3, lz: sz, a: Math.PI / 2 },
  ];
  if (p.layout === '4-rear') return rear;
  if (p.layout === '4-front-4-rear') return [...front, ...rear];
  return [...front, ...rear, ...sides];
}
