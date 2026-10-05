// The rules your drive on the street is held to: no going through a red light, no more than 3 km/h over the limit for
// more than a second, and no driving into anything. Each fault is noted when it happens (the game shows it then) and
// listed on the card once you have parked. A red light is judged where your front bumper crosses the stop line of the
// lane you are in: on amber you may go on through.
import { lotAt, streetAt } from './city';
import type { Pt } from './math';
import { lightAt, type Network, type Traffic } from './traffic';

export type FaultKind = 'red' | 'speed' | 'crash' | 'touch';
export interface Fault { kind: FaultKind; t: number; title: string; text: string }
export interface RulesSnap { faults: Fault[]; over: number; under: number; open: number; peak: number; limit: number; front: Pt | null }
/** Over the limit by more than this (km/h; the speed readout turns red there too), for longer than SPEED_HOLD s, is
 *  speeding; back under it for SPEED_CLEAR s ends that spell. */
export const SPEED_SLACK = 3, SPEED_HOLD = 1, SPEED_CLEAR = 2;

/** Your car as the rules see it after a step: its pose, speed (m/s), the length ahead of and behind its rear axle, and
 *  whether it is in Drive mode. */
export interface Driven { x: number; z: number; th: number; v: number; L: number; OVR: number; drive: boolean }

export class Rules {
  faults: Fault[] = [];
  private over = 0;       // s over the limit in this spell
  private under = 0;      // s back under it
  private open = -1;      // the speeding fault still going on (its top speed grows), or -1
  private peak = 0;       // that spell's top speed, km/h
  private limit = 0;      // the last speed limit you were under (in a junction you keep the one you came with)
  private front: Pt | null = null;   // your front bumper's middle after the last step

  constructor(readonly net: Network) {}

  /** A fresh drive: no faults yet. */
  clear(): void { this.faults = []; this.over = this.under = 0; this.open = -1; this.peak = 0; }
  snapshot(): RulesSnap {
    return { faults: this.faults.map(f => ({ ...f })), over: this.over, under: this.under, open: this.open, peak: this.peak, limit: this.limit, front: this.front ? [this.front[0], this.front[1]] : null };
  }
  restore(s: RulesSnap): void {
    this.faults = s.faults.map(f => ({ ...f })); this.over = s.over; this.under = s.under; this.open = s.open; this.peak = s.peak; this.limit = s.limit;
    this.front = s.front ? [s.front[0], s.front[1]] : null;
  }

  /** The speed limit at a point (a street's, or a car park's), or null off the roads. */
  limitAt(x: number, z: number, th: number): { limit: number; place: string } | null {
    const m = this.net.map, st = streetAt(m, x, z, th), lot = st ? null : lotAt(m, x, z);
    return st ? { limit: st.limit, place: st.name } : lot ? { limit: lot.limit, place: lot.name } : null;
  }

  /** After a step: the faults your car made in it. `hit` is what it touched in the step (a car in traffic always counts;
   *  anything else only in Drive mode: in Park mode a touch is the parking's own business). */
  step(p: Driven, traffic: Traffic | null, t: number, dt: number, hit: { name: string; traffic: boolean } | null): Fault[] {
    const out: Fault[] = [], add = (kind: FaultKind, title: string, text: string) => { const f = { kind, t, title, text }; this.faults.push(f); out.push(f); return f; };
    // a touch (pressing on against the same thing makes more; one fault for each thing in 3 s)
    if (hit && (hit.traffic || p.drive)) {
      const kind: FaultKind = hit.traffic ? 'crash' : 'touch', text = `The ${hit.name}.`;
      if (!this.faults.some(f => f.kind === kind && f.text === text && t - f.t < 3)) add(kind, hit.traffic ? 'You hit a car' : 'Touched', text);
    }
    // speeding
    const here = this.limitAt(p.x, p.z, p.th);
    if (here) this.limit = here.limit;
    const kmh = Math.abs(p.v) * 3.6;
    if (this.limit && kmh > this.limit + SPEED_SLACK) {
      this.over += dt; this.under = 0;
      if (this.open >= 0) { if (kmh > this.peak) { this.peak = kmh; this.faults[this.open].text = speedText(this.peak, this.limit, here?.place); } }
      else if (this.over >= SPEED_HOLD) { this.peak = kmh; add('speed', 'Speeding', speedText(kmh, this.limit, here?.place)); this.open = this.faults.length - 1; }
    } else {
      this.over = 0; this.under += dt;
      if (this.under >= SPEED_CLEAR) this.open = -1;
    }
    // a stop line crossed on red: your front bumper's middle going over the line of the lane it is in, facing along it
    const ux = Math.cos(p.th), uz = -Math.sin(p.th), f: Pt = [p.x + (p.L - p.OVR) * ux, p.z + (p.L - p.OVR) * uz], was = this.front;
    this.front = f;
    if (was && traffic) for (const J of this.net.junctions) {
      if (J.control !== 'lights') continue;
      for (const ap of J.approaches) {
        const [a, b] = ap.line, ax = Math.cos(ap.th), az = -Math.sin(ap.th);
        const d0 = (was[0] - a[0]) * ax + (was[1] - a[1]) * az, d1 = (f[0] - a[0]) * ax + (f[1] - a[1]) * az;
        if (!(d0 < 0 && d1 >= 0) || ux * ax + uz * az < 0.5) continue;
        const wx = b[0] - a[0], wz = b[1] - a[1], q = ((f[0] - a[0]) * wx + (f[1] - a[1]) * wz) / (wx * wx + wz * wz);
        if (q < -0.1 || q > 1.1) continue;
        if (lightAt(J, this.net.els[ap.el].axis, traffic.t) === 'red') add('red', 'Red light', `You went through on red at ${J.name}.`);
      }
    }
    return out;
  }
}

const speedText = (kmh: number, limit: number, place?: string): string => `${Math.round(kmh)} km/h in a ${limit}${place ? ` on ${place}` : ''}.`;
