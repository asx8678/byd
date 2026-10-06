// The cars and scenes that ship with the game, loaded from content/. Add a file there and list it here.
import atto2 from '../../content/vehicles/byd-atto2.json';
import sclass from '../../content/vehicles/mercedes-s-class-w223.json';
import ram from '../../content/vehicles/ram-1500-dt.json';
import smart from '../../content/vehicles/smart-fortwo-c453.json';
import p208 from '../../content/vehicles/peugeot-208-p21.json';
import octavia from '../../content/vehicles/skoda-octavia-combi-nx.json';
import boxTrailer from '../../content/trailers/boeckmann-tl-al-2513-75.json';
import garage561 from '../../content/scenes/garage-561.json';
import agadir from '../../content/maps/agadir.json';
import harbour from '../../content/maps/harbour.json';
import type { AnyMapSpec, MapSpec } from './city';
import { makeScene, type Scene, type SceneSpec } from './scene';
import { makeTrailer, type Trailer, type TrailerSpec } from './trailer';
import { makeVehicle, variantId, type Vehicle, type VehicleSpec } from './vehicle';

/** The car files in the order the app lists them; the Atto 2 first. */
export const CAR_SPECS: readonly VehicleSpec[] = [atto2, smart, p208, octavia, ram, sclass] as unknown as VehicleSpec[];

export const ATTO2: Vehicle = makeVehicle(atto2 as unknown as VehicleSpec);
export const GARAGE_561: Scene = makeScene(garage561 as unknown as SceneSpec);

/** Every car by id. A car with rear-axle steering has one per setting, `<file id>@<degrees>`. */
export const VEHICLES: Readonly<Record<string, Vehicle>> = Object.fromEntries(CAR_SPECS.flatMap(s =>
  s.id === ATTO2.id ? [[ATTO2.id, ATTO2]] : (s.rearSteer?.options ?? [0]).map(deg => [variantId(s, deg), makeVehicle(s, deg)])));
export const SCENES: Readonly<Record<string, Scene>> = { [GARAGE_561.id]: GARAGE_561 };
/** The street maps, by id (see core/city.ts). */
export const MAPS: Readonly<Record<string, AnyMapSpec> & { harbour: MapSpec }> = { harbour: harbour as unknown as MapSpec, agadir: agadir as unknown as AnyMapSpec };

/** The trailers, by id; and the box trailer the towing lessons and levels use, on the Octavia (the one car with a
 *  published towing limit). */
export const TRAILERS: Readonly<Record<string, Trailer>> = Object.fromEntries(([boxTrailer] as unknown as TrailerSpec[]).map(s => [s.id, makeTrailer(s)]));
export const BOX_TRAILER: Trailer = TRAILERS['boeckmann-tl-al-2513-75'];
export const TOW_CAR = 'skoda-octavia-combi-nx';

/** A car file's Vehicle with its rear-axle steering at rearDeg (its default when that is not one of its settings). */
export function vehicleFor(carId: string, rearDeg?: number): Vehicle {
  const s = CAR_SPECS.find(c => c.id === carId) ?? CAR_SPECS[0];
  const deg = s.rearSteer ? (rearDeg !== undefined && s.rearSteer.options.includes(rearDeg) ? rearDeg : s.rearSteer.default) : 0;
  return VEHICLES[variantId(s, deg)];
}
