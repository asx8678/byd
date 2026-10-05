// The rules your drive on the street is held to. Everywhere: no going through a red light, no more than 3 km/h over the
// limit for more than a second, no driving into anything, signalling before you turn at a junction, pull in to park and
// pull out again, not stopping in a junction you are not waiting to turn in, and not parking where it is not allowed (a
// bus stop, a loading bay, a disabled bay, a driveway, a no-parking zone, or too close to a junction). Hazard lights
// only as the country allows (country.ts). Each fault is noted when it happens (the game shows it then) and listed on the
// card once you have parked; how long you held up traffic is counted too.
//
// A red light is judged where your front bumper crosses the stop line of the lane you are in: on amber you may go on
// through. A turn is a heading change of 60° or more between your front entering a junction and your rear axle being
// 12 m clear of it (a turn has ended by then), signalled if that indicator was on as your front entered, or in the 3 s
// before. Pulling in is judged as you first
// reverse into a space on the street, pulling out as you drive a metre from where you parked at the kerb: signalled if
// the indicator towards the kerb (or away from it) was on then, or in the 10 s before. A stop of 3 s in a junction is
// blocking it, unless the lights are with you or you are waiting to turn across the oncoming lane, signalling; a stop of
// 10 s with the middle of your car where parking is not allowed is parking there.
import { clearOf, lotAt, streetAt, type KerbSlot } from './city';
import { COUNTRIES, type Country, type CountryId } from './country';
import { wrapPi, type Pt } from './math';
import type { Rect } from './scene';
import { lightAt, type Network, type Traffic } from './traffic';

export type FaultKind = 'red' | 'speed' | 'crash' | 'touch' | 'signal' | 'block' | 'zone' | 'hazard';
/** A fault: what it is, when (the simulation's clock), a banner's title and line, and a few words for the card. */
export interface Fault { kind: FaultKind; t: number; title: string; text: string; brief: string }
/** Your way through a junction: which, your heading and the street's way as your front entered it, whether you had
 *  signalled left or right by then, and whether you have blocked it. */
interface Visit { j: number; th: number; axis: 'x' | 'z' | null; left: boolean; right: boolean; blocked: boolean }
export interface RulesSnap {
  faults: Fault[]; over: number; under: number; open: number; peak: number; limit: number; front: Pt | null; heldUp?: number; heldCars?: number[];
  country?: CountryId; indT?: [number, number]; axis?: 'x' | 'z' | null; visit?: Visit | null; blockT?: number; zoneAt?: number; zoneT?: number; zonesHit?: number[];
  tryBay?: string; pulledIn?: boolean; anchor?: Pt | null; hazT?: number; hazOpen?: boolean;
}
/** Over the limit by more than this (km/h; the speed readout turns red there too), for longer than SPEED_HOLD s, is
 *  speeding; back under it for SPEED_CLEAR s ends that spell. */
export const SPEED_SLACK = 3, SPEED_HOLD = 1, SPEED_CLEAR = 2;

/** Your car as the rules see it after a step: its pose, speed (m/s), size (the length ahead of and behind its rear axle,
 *  its width), whether it is in Drive mode, its signals, the space Park mode is for ('' for none), and whether it is
 *  parked in it. */
export interface Driven { x: number; z: number; th: number; v: number; L: number; W: number; OVR: number; drive: boolean; ind: -1 | 0 | 1; hazard: boolean; bay: string; parked: boolean }
/** Where parking is not allowed: a zone painted on a kerb, or the kerb by a junction; what it is, and its street. */
interface NoParking { rect: Rect; what: string; street: string }

const inRect = (r: Rect, p: Pt) => p[0] >= r[0] && p[0] <= r[1] && p[1] >= r[2] && p[1] <= r[3];
const ZONE_WHAT = { bus: 'a bus stop', loading: 'a loading bay', none: 'a no-parking zone', disabled: 'a disabled bay', driveway: 'a driveway' } as const;

export class Rules {
  faults: Fault[] = [];
  private over = 0;       // s over the limit in this spell
  private under = 0;      // s back under it
  private open = -1;      // the speeding fault still going on (its top speed grows), or -1
  private peak = 0;       // that spell's top speed, km/h
  private limit = 0;      // the last speed limit you were under (in a junction you keep the one you came with)
  private front: Pt | null = null;   // your front bumper's middle after the last step
  /** How long you have held up traffic on this drive (s: while a car waited behind you and you were not waiting
   *  yourself), and the cars you held up. */
  heldUp = 0; heldCars = new Set<number>();
  private indT: [number, number] = [-99, -99];   // when your left and right indicators were last on
  private axis: 'x' | 'z' | null = null;         // the way the street you were last on runs
  private visit: Visit | null = null;            // the junction you are in
  private blockT = 0;                            // how long you have been stopped in it, not waiting to turn
  private zoneAt = -1; private zoneT = 0;        // where parking is not allowed that you are stopped in, and for how long
  private zonesHit: number[] = [];               // the ones you have parked in on this drive
  private tryBay = ''; private pulledIn = false; // the space Park mode is for, and whether you have begun to reverse into it
  private anchor: Pt | null = null;              // where you parked at the kerb, until you pull out
  private hazT = 0; private hazOpen = false;     // how long your hazard lights have been on where they should not, and whether that is noted
  private readonly kerbSlots: Map<string, KerbSlot>;
  private readonly noParking: NoParking[] = [];

  constructor(readonly net: Network, public country: Country = COUNTRIES.ma) {
    const m = net.map;
    this.kerbSlots = new Map(m.slots.filter((s): s is KerbSlot => s.kind === 'kerb').map(s => [s.id, s]));
    // the zones painted on the kerbs (their boxes run along the kerb, out over the parking lane), and the kerb by each
    // junction where the parking stops
    const box = (pts: Pt[]): Rect => [Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[1]))];
    for (const z of m.scene.city?.zones ?? []) this.noParking.push({ rect: box(z.pts), what: ZONE_WHAT[z.kind], street: streetAt(m, z.at[0], z.at[1], z.th)?.name ?? '' });
    const R = m.spec.corner ?? 6, gap = clearOf(R);
    for (const st of m.streets) for (const side of [1, -1] as const) {
      const sd = st.side[side];
      if (!sd.park) continue;
      const t0 = st.c + side * (sd.hw - sd.park), t1 = st.c + side * sd.hw, [lo, hi] = [Math.min(t0, t1), Math.max(t0, t1)];
      for (const J of m.junctions) {
        const [a0, a1, b0, b1] = st.along === 'x' ? [J[0], J[1], J[2], J[3]] : [J[2], J[3], J[0], J[1]];
        if (st.c < b0 || st.c > b1) continue;   // not a junction on this street
        for (const [s0, s1] of [[a0 - gap, a0], [a1, a1 + gap]]) {
          if (s1 < st.s0 || s0 > st.s1) continue;
          this.noParking.push({ rect: st.along === 'x' ? [s0, s1, lo, hi] : [lo, hi, s0, s1], what: 'the kerb by a junction', street: st.name });
        }
      }
    }
  }

  /** A fresh drive: no faults yet (where you parked stays: pulling out of it belongs to the new drive). */
  clear(): void {
    this.faults = []; this.over = this.under = 0; this.open = -1; this.peak = 0; this.heldUp = 0; this.heldCars = new Set();
    this.zonesHit = []; this.hazOpen = false; this.hazT = 0;
  }
  snapshot(): RulesSnap {
    return {
      faults: this.faults.map(f => ({ ...f })), over: this.over, under: this.under, open: this.open, peak: this.peak, limit: this.limit, front: this.front ? [this.front[0], this.front[1]] : null,
      heldUp: this.heldUp, heldCars: [...this.heldCars], country: this.country.id, indT: [this.indT[0], this.indT[1]], axis: this.axis, visit: this.visit ? { ...this.visit } : null,
      blockT: this.blockT, zoneAt: this.zoneAt, zoneT: this.zoneT, zonesHit: this.zonesHit.slice(), tryBay: this.tryBay, pulledIn: this.pulledIn,
      anchor: this.anchor ? [this.anchor[0], this.anchor[1]] : null, hazT: this.hazT, hazOpen: this.hazOpen,
    };
  }
  restore(s: RulesSnap): void {
    this.faults = s.faults.map(f => ({ ...f })); this.over = s.over; this.under = s.under; this.open = s.open; this.peak = s.peak; this.limit = s.limit;
    this.front = s.front ? [s.front[0], s.front[1]] : null; this.heldUp = s.heldUp ?? 0; this.heldCars = new Set(s.heldCars ?? []);
    this.country = COUNTRIES[s.country ?? this.country.id]; this.indT = s.indT ? [s.indT[0], s.indT[1]] : [-99, -99]; this.axis = s.axis ?? null;
    this.visit = s.visit ? { ...s.visit } : null; this.blockT = s.blockT ?? 0; this.zoneAt = s.zoneAt ?? -1; this.zoneT = s.zoneT ?? 0; this.zonesHit = (s.zonesHit ?? []).slice();
    this.tryBay = s.tryBay ?? ''; this.pulledIn = s.pulledIn ?? false; this.anchor = s.anchor ? [s.anchor[0], s.anchor[1]] : null; this.hazT = s.hazT ?? 0; this.hazOpen = s.hazOpen ?? false;
  }

  /** The speed limit at a point (a street's, or a car park's), or null off the roads. */
  limitAt(x: number, z: number, th: number): { limit: number; place: string } | null {
    const m = this.net.map, st = streetAt(m, x, z, th), lot = st ? null : lotAt(m, x, z);
    return st ? { limit: st.limit, place: st.name } : lot ? { limit: lot.limit, place: lot.name } : null;
  }
  /** Whether your indicator that way (-1 left, 1 right) has been on in the last `within` seconds (now included). */
  private signalled(dir: -1 | 1, t: number, within: number): boolean { return this.indT[dir < 0 ? 0 : 1] >= t - within - 1e-9; }

  /** After a step: the faults your car made in it. `hit` is what it touched in the step (a car in traffic always counts;
   *  anything else only in Drive mode: in Park mode a touch is the parking's own business). */
  step(p: Driven, traffic: Traffic | null, t: number, dt: number, hit: { name: string; traffic: boolean } | null): Fault[] {
    const out: Fault[] = [], add = (kind: FaultKind, title: string, text: string, brief: string) => { const f = { kind, t, title, text, brief }; this.faults.push(f); out.push(f); return f; };
    const net = this.net, kerb = net.drive === 'right' ? 1 : -1, clock = traffic?.t ?? t;
    // a touch (pressing on against the same thing makes more; one fault for each thing in 3 s)
    if (hit && (hit.traffic || p.drive)) {
      const kind: FaultKind = hit.traffic ? 'crash' : 'touch', text = `The ${hit.name}.`;
      if (!this.faults.some(f => f.kind === kind && f.text === text && t - f.t < 3)) add(kind, hit.traffic ? 'You hit a car' : 'Touched', text, `${hit.traffic ? 'hit' : 'touched'} the ${hit.name}`);
    }
    // holding up traffic
    if (traffic?.held.length) { this.heldUp += dt; for (const id of traffic.held) this.heldCars.add(id); }
    // speeding
    const here = this.limitAt(p.x, p.z, p.th);
    if (here) this.limit = here.limit;
    const kmh = Math.abs(p.v) * 3.6;
    if (this.limit && kmh > this.limit + SPEED_SLACK) {
      this.over += dt; this.under = 0;
      if (this.open >= 0) { if (kmh > this.peak) { const f = this.faults[this.open]; this.peak = kmh; f.text = speedText(kmh, this.limit, here?.place); f.brief = f.text.slice(0, -1); } }
      else if (this.over >= SPEED_HOLD) { this.peak = kmh; const text = speedText(kmh, this.limit, here?.place); add('speed', 'Speeding', text, text.slice(0, -1)); this.open = this.faults.length - 1; }
    } else {
      this.over = 0; this.under += dt;
      if (this.under >= SPEED_CLEAR) this.open = -1;
    }
    // a stop line crossed on red: your front bumper's middle going over the line of the lane it is in, facing along it
    const ux = Math.cos(p.th), uz = -Math.sin(p.th), f: Pt = [p.x + (p.L - p.OVR) * ux, p.z + (p.L - p.OVR) * uz], was = this.front, back: Pt = [p.x - p.OVR * ux, p.z - p.OVR * uz];
    this.front = f;
    if (was && traffic) for (const J of net.junctions) {
      if (J.control !== 'lights') continue;
      for (const ap of J.approaches) {
        const [a, b] = ap.line, ax = Math.cos(ap.th), az = -Math.sin(ap.th);
        const d0 = (was[0] - a[0]) * ax + (was[1] - a[1]) * az, d1 = (f[0] - a[0]) * ax + (f[1] - a[1]) * az;
        if (!(d0 < 0 && d1 >= 0) || ux * ax + uz * az < 0.5) continue;
        const wx = b[0] - a[0], wz = b[1] - a[1], q = ((f[0] - a[0]) * wx + (f[1] - a[1]) * wz) / (wx * wx + wz * wz);
        if (q < -0.1 || q > 1.1) continue;
        if (lightAt(J, net.els[ap.el].axis, clock) === 'red') add('red', 'Red light', `You went through on red at ${J.name}.`, `a red light at ${J.name}`);
      }
    }
    // your indicators (your hazard lights are not a signal)
    if (p.ind) this.indT[p.ind < 0 ? 0 : 1] = t;
    // through a junction (one you could turn at): signalled before a turn, and not stopped in it for nothing
    if (this.visit) {
      const v = this.visit, J = net.junctions[v.j], [x0, x1, z0, z1] = J.rect, mid: Pt = [p.x + (p.L / 2 - p.OVR) * ux, p.z + (p.L / 2 - p.OVR) * uz];
      if (!inRect([x0 - 12, x1 + 12, z0 - 12, z1 + 12], [p.x, p.z])) {   // through it: was it a turn?
        const dh = wrapPi(p.th - v.th), way = dh > 0 ? 'left' : 'right';
        if (Math.abs(dh) >= Math.PI / 3 && !(dh > 0 ? v.left : v.right)) add('signal', 'No signal', `You turned ${way} at ${J.name} without signalling.`, `turned ${way} at ${J.name} without signalling`);
        this.visit = null; this.blockT = 0;
      } else if (Math.abs(p.v) < 0.3 && !v.blocked && (inRect(J.rect, f) || inRect(J.rect, mid) || inRect(J.rect, back))) {
        const waiting = p.ind === -kerb && Math.abs(wrapPi(p.th - v.th)) < 0.5, go = J.control === 'lights' && v.axis !== null && lightAt(J, v.axis, clock) !== 'red';
        this.blockT = waiting || go ? 0 : this.blockT + dt;
        if (this.blockT >= 3) { v.blocked = true; add('block', 'Blocking the junction', `You stopped in the junction at ${J.name}.`, `stopped in the junction at ${J.name}`); }
      } else this.blockT = 0;
    } else {
      const j = net.junctions.findIndex(J => J.arms >= 3 && inRect(J.rect, f));
      if (j >= 0) this.visit = { j, th: p.th, axis: this.axis, left: this.signalled(-1, t, 3), right: this.signalled(1, t, 3), blocked: false };
      else { const st = streetAt(net.map, p.x, p.z, p.th); if (st) this.axis = st.along; }
    }
    // pulling in to park in a space on the street, and out again
    const sl = p.bay ? this.kerbSlots.get(p.bay) : undefined;
    if (p.bay !== this.tryBay) { this.tryBay = p.bay; this.pulledIn = false; }
    if (sl && !this.pulledIn && p.v < -0.05) {
      this.pulledIn = true;
      if (!this.signalled(kerb as -1 | 1, t, 10)) add('signal', 'No signal', `You pulled in to park on ${sl.street.name} without signalling ${kerb > 0 ? 'right' : 'left'}.`, `pulled in on ${sl.street.name} without signalling`);
    }
    if (sl && p.parked) this.anchor = [p.x, p.z];
    else if (this.anchor && !p.bay && p.v > 0 && Math.hypot(p.x - this.anchor[0], p.z - this.anchor[1]) > 1) {
      this.anchor = null;
      if (!this.signalled(-kerb as -1 | 1, t, 10)) add('signal', 'No signal', `You pulled out without signalling ${kerb > 0 ? 'left' : 'right'}.`, 'pulled out without signalling');
    }
    // parking where it is not allowed: stopped for 10 s with the middle of your car there
    const mid: Pt = [p.x + (p.L / 2 - p.OVR) * ux, p.z + (p.L / 2 - p.OVR) * uz], at = Math.abs(p.v) < 0.05 ? this.noParking.findIndex(n => inRect(n.rect, mid)) : -1;
    this.zoneT = at >= 0 && at === this.zoneAt ? this.zoneT + dt : at >= 0 ? dt : 0; this.zoneAt = at;
    if (at >= 0 && this.zoneT >= 10 && !this.zonesHit.includes(at)) {
      const n = this.noParking[at];
      this.zonesHit.push(at);
      add('zone', 'No parking here', `You parked in ${n.what}${n.street ? ` on ${n.street}` : ''}.`, `parked in ${n.what}${n.street ? ` on ${n.street}` : ''}`);
    }
    // hazard lights where the country does not allow them
    const rule = this.country.hazards;
    if (rule && p.hazard && (rule === 'danger' || Math.abs(p.v) > 0.3)) {
      this.hazT += dt;
      if (!this.hazOpen && this.hazT >= (rule === 'danger' ? 3 : 1)) {
        this.hazOpen = true;
        if (rule === 'danger') add('hazard', 'Hazard lights', 'In Germany hazard lights are for danger only (StVO §16): not for waiting, stopping in the lane or parking.', 'hazard lights with no danger');
        else add('hazard', 'Hazard lights', 'Hazard lights while moving: in the UK they are only to warn others while you are stopped (Highway Code rule 116).', 'hazard lights while moving');
      }
    } else { this.hazT = 0; if (!p.hazard) this.hazOpen = false; }
    return out;
  }
}

const speedText = (kmh: number, limit: number, place?: string): string => `${Math.round(kmh)} km/h in a ${limit}${place ? ` on ${place}` : ''}.`;
