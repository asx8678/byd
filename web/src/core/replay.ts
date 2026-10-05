// Recording and replaying an attempt. The simulation steps at a fixed rate, so an attempt is its
// starting pose and settings plus the inputs that changed, step by step. Replaying them on the same
// device gives the same drive exactly; shared ghosts should also store poses, because tiny floating-
// point differences between devices can add up.
import { Sim, type SimEvent, type SimOptions } from './sim';
import type { Scene } from './scene';
import type { Vehicle } from './vehicle';

/** The steady rate the game steps at, in seconds per step. */
export const STEP = 1 / 60;

type Key = 'fwd' | 'rev' | 'kl' | 'kr' | 'held' | 'wheel' | 'target';
/** [step index, what changed, its new value] */
export type RecEvent = [number, Key, number | boolean | null];
/** Everything about the car at the moment a recording starts, so playback begins in exactly the same state. */
export interface StartState {
  x: number; z: number; th: number; v: number; wheelAngle: number; wheelTarget: number | null; holdT: number; time: number; lastDriveT: number;
  hits: number; elapsed: number; started: boolean; parked: boolean; inContact: boolean; lastMoveDir: 1 | -1; moves: number; moveSign: number;
  input: { fwd: boolean; rev: boolean; kl: boolean; kr: boolean; wheelHeld: boolean };
}
export interface Recording {
  format: 1; scene: string; vehicle: string; dt: number;
  start: StartState; options: SimOptions; steps: number; events: RecEvent[];
}
export const stateOf = (s: Sim): StartState => ({
  x: s.x, z: s.z, th: s.th, v: s.v, wheelAngle: s.wheelAngle, wheelTarget: s.wheelTarget, holdT: s.holdT, time: s.time, lastDriveT: s.lastDriveT,
  hits: s.hits, elapsed: s.elapsed, started: s.started, parked: s.parked, inContact: s.inContact, lastMoveDir: s.lastMoveDir, moves: s.moves, moveSign: s.moveSign, input: { ...s.input },
});

type Snap = Record<Key, number | boolean | null>;
const snap = (s: Sim): Snap => ({ fwd: s.input.fwd, rev: s.input.rev, kl: s.input.kl, kr: s.input.kr, held: s.input.wheelHeld, wheel: s.wheelAngle, target: s.wheelTarget });

/** Watches a simulation between steps and writes down what the player changed. */
export class Recorder {
  rec: Recording | null = null;
  private last: Snap | null = null;
  /** Start a new recording from the car's current state. */
  begin(sim: Sim, dt = STEP): void {
    this.rec = { format: 1, scene: sim.scene.id, vehicle: sim.vehicle.id, dt, start: stateOf(sim), options: { ...sim.options }, steps: 0, events: [] };
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
  }
  /** Rewind: keep only the first n steps, and carry on recording from the car as it now is (put back to step n). */
  truncate(n: number, sim: Sim): void {
    if (!this.rec) return;
    this.rec.steps = n; this.rec.events = this.rec.events.filter(e => e[0] < n); this.last = snap(sim);
  }
}

/** Put a simulation into a recorded state (the car, its timers and counters, and what is held). */
export function restoreState(sim: Sim, st: StartState): void {
  const { input, ...rest } = st;
  Object.assign(sim, rest); Object.assign(sim.input, input);
}

/**
 * Play a recording's first n steps on a fresh simulation, calling before(sim) once each step's inputs are applied
 * and after(sim) once it has stepped: what a coach or a path tracker needs to be rebuilt along with the car.
 */
export function replayTo(rec: Recording, scene: Scene, vehicle: Vehicle, n: number, before?: (sim: Sim) => void, after?: (sim: Sim) => void): Sim {
  const sim = new Sim(scene, vehicle);
  Object.assign(sim.options, rec.options); restoreState(sim, rec.start);
  for (let i = 0, e = 0; i < Math.min(n, rec.steps); i++) {
    for (; e < rec.events.length && rec.events[e][0] === i; e++) {
      const [, k, val] = rec.events[e];
      if (k === 'wheel') sim.wheelAngle = val as number;
      else if (k === 'target') sim.wheelTarget = val as number | null;
      else if (k === 'held') sim.input.wheelHeld = val as boolean;
      else sim.input[k] = val as boolean;
    }
    before?.(sim); sim.step(rec.dt); after?.(sim);
  }
  return sim;
}

/** A fresh simulation set up at the recording's start, and a function that plays it one step at a time. */
export function playback(rec: Recording, scene: Scene, vehicle: Vehicle): { sim: Sim; step: () => SimEvent[] | null } {
  const sim = new Sim(scene, vehicle);
  Object.assign(sim.options, rec.options);
  const { input, ...st } = rec.start;
  Object.assign(sim, st); Object.assign(sim.input, input);
  let i = 0, e = 0;
  const step = (): SimEvent[] | null => {
    if (i >= rec.steps) return null;
    for (; e < rec.events.length && rec.events[e][0] === i; e++) {
      const [, k, val] = rec.events[e];
      if (k === 'wheel') sim.wheelAngle = val as number;
      else if (k === 'target') sim.wheelTarget = val as number | null;
      else if (k === 'held') sim.input.wheelHeld = val as boolean;
      else sim.input[k] = val as boolean;
    }
    i++;
    return sim.step(rec.dt);
  };
  return { sim, step };
}
