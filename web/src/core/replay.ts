// Recording and replaying an attempt. The simulation steps at a fixed rate, so an attempt is its
// starting pose and settings plus the inputs that changed, step by step. Replaying them on the same
// device gives the same drive exactly; shared ghosts should also store poses, because tiny floating-
// point differences between devices can add up.
import { TRAILERS } from './content';
import { Sim, type Mode, type SimEvent, type SimOptions, type WorldSnap } from './sim';
import type { Scene } from './scene';
import type { Vehicle } from './vehicle';

/** The steady rate the game steps at, in seconds per step. */
export const STEP = 1 / 60;

type Key = 'fwd' | 'rev' | 'kl' | 'kr' | 'held' | 'wheel' | 'target' | 'acc' | 'brk' | 'drive' | 'ind' | 'haz';
/** [step index, what changed, its new value] */
export type RecEvent = [number, Key, number | boolean | null];
/** Everything about the car at the moment a recording starts, so playback begins in exactly the same state. */
export interface StartState {
  x: number; z: number; th: number; v: number; wheelAngle: number; wheelTarget: number | null; holdT: number; time: number; lastDriveT: number;
  hits: number; elapsed: number; started: boolean; parked: boolean; inContact: boolean; lastMoveDir: 1 | -1; moves: number; moveSign: number;
  input: { fwd: boolean; rev: boolean; kl: boolean; kr: boolean; wheelHeld: boolean; acc?: number; brk?: number };
  // Drive mode (recordings made before it have none of these: Park mode, at rest)
  mode?: Mode; vy?: number; r?: number; ax?: number;
  // on the street: your signals, and the traffic and the rules as they were (recordings made before them have none)
  ind?: -1 | 0 | 1; hazard?: boolean; indArmed?: boolean; world?: WorldSnap;
  // with a trailer on: its heading
  tth?: number;
}
export interface Recording {
  format: 1; scene: string; vehicle: string; dt: number;
  /** The trailer on the tow ball, by id (none: no trailer). */
  trailer?: string;
  start: StartState; options: SimOptions; steps: number; events: RecEvent[];
  /** The whole state every MARK steps, so a rewind need not replay from the start (on the street that is the traffic too). */
  marks?: { step: number; state: StartState }[];
}
/** Steps between a recording's checkpoints: 10 s. */
export const MARK = 600;
export const stateOf = (s: Sim): StartState => ({
  x: s.x, z: s.z, th: s.th, v: s.v, wheelAngle: s.wheelAngle, wheelTarget: s.wheelTarget, holdT: s.holdT, time: s.time, lastDriveT: s.lastDriveT,
  hits: s.hits, elapsed: s.elapsed, started: s.started, parked: s.parked, inContact: s.inContact, lastMoveDir: s.lastMoveDir, moves: s.moves, moveSign: s.moveSign, input: { ...s.input },
  mode: s.mode, vy: s.vy, r: s.r, ax: s.ax,
  ind: s.ind, hazard: s.hazard, indArmed: s.indArmed, ...(s.traffic ? { world: s.world()! } : {}), ...(s.trailer ? { tth: s.tth } : {}),
});

type Snap = Record<Key, number | boolean | null>;
const snap = (s: Sim): Snap => ({ fwd: s.input.fwd, rev: s.input.rev, kl: s.input.kl, kr: s.input.kr, held: s.input.wheelHeld, wheel: s.wheelAngle, target: s.wheelTarget, acc: s.input.acc, brk: s.input.brk, drive: s.mode === 'drive', ind: s.ind, haz: s.hazard });

/** Watches a simulation between steps and writes down what the player changed. */
export class Recorder {
  rec: Recording | null = null;
  private last: Snap | null = null;
  /** Start a new recording from the car's current state. */
  begin(sim: Sim, dt = STEP): void {
    this.rec = { format: 1, scene: sim.scene.id, vehicle: sim.vehicle.id, ...(sim.trailer ? { trailer: sim.trailer.id } : {}), dt, start: stateOf(sim), options: { ...sim.options }, steps: 0, events: [] };
    this.last = snap(sim);
  }
  /** Call just before sim.step: anything that differs from how the last step left it was the player. */
  before(sim: Sim): void {
    if (!this.rec || !this.last) return;
    const now = snap(sim);
    for (const k of Object.keys(now) as Key[]) if (now[k] !== this.last[k]) this.rec.events.push([this.rec.steps, k, now[k]]);
  }
  /** Call just after sim.step. */
  after(sim: Sim): void {
    if (!this.rec) return;
    this.rec.steps++; this.last = snap(sim);
    if (this.rec.steps % MARK === 0) (this.rec.marks ??= []).push({ step: this.rec.steps, state: stateOf(sim) });
  }
  /** Rewind: keep only the first n steps, and carry on recording from the car as it now is (put back to step n). */
  truncate(n: number, sim: Sim): void {
    if (!this.rec) return;
    this.rec.steps = n; this.rec.events = this.rec.events.filter(e => e[0] < n); this.last = snap(sim);
    if (this.rec.marks) this.rec.marks = this.rec.marks.filter(m => m.step <= n);
  }
}

/** One recorded change, applied to a simulation. */
function apply(sim: Sim, k: Key, val: number | boolean | null): void {
  if (k === 'wheel') sim.wheelAngle = val as number;
  else if (k === 'target') sim.wheelTarget = val as number | null;
  else if (k === 'held') sim.input.wheelHeld = val as boolean;
  else if (k === 'acc' || k === 'brk') sim.input[k] = val as number;
  else if (k === 'drive') sim.setMode(val ? 'drive' : 'park');
  else if (k === 'ind') sim.ind = val as -1 | 0 | 1;
  else if (k === 'haz') sim.hazard = val as boolean;
  else sim.input[k] = val as boolean;
}

/** Put a simulation into a recorded state (the car, its timers and counters, what is held, and on the street the
 *  traffic and the rules, copied in: the state can be used again). */
export function restoreState(sim: Sim, st: StartState): void {
  const { input, world, ...rest } = st;
  Object.assign(sim, rest); Object.assign(sim.input, input);
  if (world) sim.restoreWorld(world);
}

/** A fresh simulation for a recording: its scene and car, with its trailer hitched. */
function simFor(rec: Recording, scene: Scene, vehicle: Vehicle): Sim {
  const sim = new Sim(scene, vehicle);
  if (rec.trailer) sim.setTrailer(TRAILERS[rec.trailer]);
  return sim;
}

/**
 * Play a recording's first n steps on a fresh simulation, calling before(sim) once each step's inputs are applied
 * and after(sim) once it has stepped: what a coach or a path tracker needs to be rebuilt along with the car. With
 * neither, it starts from the last checkpoint at or before step n.
 */
export function replayTo(rec: Recording, scene: Scene, vehicle: Vehicle, n: number, before?: (sim: Sim) => void, after?: (sim: Sim) => void): Sim {
  const sim = simFor(rec, scene, vehicle), mark = before || after ? undefined : (rec.marks ?? []).filter(m => m.step <= n).pop();
  Object.assign(sim.options, rec.options); restoreState(sim, mark ? mark.state : rec.start);
  const i0 = mark ? mark.step : 0;
  for (let i = i0, e = rec.events.filter(ev => ev[0] < i0).length; i < Math.min(n, rec.steps); i++) {
    for (; e < rec.events.length && rec.events[e][0] === i; e++) apply(sim, rec.events[e][1], rec.events[e][2]);
    before?.(sim); sim.step(rec.dt); after?.(sim);
  }
  return sim;
}

/** A fresh simulation set up at the recording's start, and a function that plays it one step at a time. */
export function playback(rec: Recording, scene: Scene, vehicle: Vehicle): { sim: Sim; step: () => SimEvent[] | null } {
  const sim = simFor(rec, scene, vehicle);
  Object.assign(sim.options, rec.options); restoreState(sim, rec.start);
  let i = 0, e = 0;
  const step = (): SimEvent[] | null => {
    if (i >= rec.steps) return null;
    for (; e < rec.events.length && rec.events[e][0] === i; e++) apply(sim, rec.events[e][1], rec.events[e][2]);
    i++;
    return sim.step(rec.dt);
  };
  return { sim, step };
}
