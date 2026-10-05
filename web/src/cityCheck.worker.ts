// Checking a street district's free spaces off the main thread, so driving never stutters: the district is built again
// here from the same spec, car, layout number and side of the road (the same four always give the same district), and the route planner
// tries to park the car in each space in the order asked (nearest your start first), reporting each as it goes.
import { buildCity, checkSlot, type Drive, type MapSpec } from './core/city';
import { makeVehicle, type VehicleSpec } from './core/vehicle';

export interface CheckJob { spec: MapSpec; car: VehicleSpec; rearDeg: number; seed: number; drive: Drive; order: string[] }
export interface CheckDone { seed: number; id: string; parkable: boolean }

self.onmessage = (e: MessageEvent<CheckJob>) => {
  const { spec, car, rearDeg, seed, drive, order } = e.data, v = makeVehicle(car, rearDeg), m = buildCity(spec, v, seed, drive);
  for (const id of order) {
    const s = m.slots.find(q => q.id === id);
    if (s) self.postMessage({ seed, id, parkable: checkSlot(m, v, s) } satisfies CheckDone);
  }
};
