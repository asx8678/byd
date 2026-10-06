// Off the main thread, so driving never stutters: checking a street district's free spaces, and working out par for a
// try. The district is built again here from the same spec, car, layout number and side of the road (the same four
// always give the same district) and kept for the next job. A check job has the route planner try to park the car in
// each space in the order asked (nearest your start first), reporting each as it goes; a par job plans the route into
// one space from where the try began. The game runs one worker for each kind, so par never waits behind the checks.
import { buildCity, checkSlot, localScene, type AnyMapSpec, type CityMap, type Drive } from './core/city';
import { planBack, type Piece, type Pose } from './core/planner';
import { makeVehicle, type Vehicle, type VehicleSpec } from './core/vehicle';

interface Job { spec: AnyMapSpec; car: VehicleSpec; rearDeg: number; seed: number; drive: Drive }
export interface CheckJob extends Job { kind: 'check'; order: string[] }
export interface CheckDone { kind: 'check'; seed: number; id: string; parkable: boolean }
export interface ParJob extends Job { kind: 'par'; slot: string; from: Pose; ticket: number }
export interface ParDone { kind: 'par'; ticket: number; pieces: Piece[] | null }

let kept: { key: string; m: CityMap; v: Vehicle } | null = null;
self.onmessage = (e: MessageEvent<CheckJob | ParJob>) => {
  const j = e.data, key = `${j.spec.id}:${j.seed}:${j.drive}:${j.car.id}:${j.rearDeg}`;
  if (kept?.key !== key) { const v = makeVehicle(j.car, j.rearDeg); kept = { key, v, m: buildCity(j.spec, v, j.seed, j.drive) }; }
  const { m, v } = kept;
  if (j.kind === 'par') {
    const s = m.slots.find(q => q.id === j.slot), plan = s ? planBack(v, localScene(m, s), j.from, s.id, { maxNodes: 6000 }) : null;
    self.postMessage({ kind: 'par', ticket: j.ticket, pieces: plan?.status === 'found' ? plan.pieces : null } satisfies ParDone);
    return;
  }
  for (const id of j.order) {
    const s = m.slots.find(q => q.id === id);
    if (s) self.postMessage({ kind: 'check', seed: j.seed, id, parkable: checkSlot(m, v, s) } satisfies CheckDone);
  }
};
