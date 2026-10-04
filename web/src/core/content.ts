// The cars and scenes that ship with the game, loaded from content/. Add a file there and list it here.
import atto2 from '../../content/vehicles/byd-atto2.json';
import garage561 from '../../content/scenes/garage-561.json';
import { makeScene, type Scene, type SceneSpec } from './scene';
import { makeVehicle, type Vehicle, type VehicleSpec } from './vehicle';

export const ATTO2: Vehicle = makeVehicle(atto2 as unknown as VehicleSpec);
export const GARAGE_561: Scene = makeScene(garage561 as unknown as SceneSpec);

export const VEHICLES: Readonly<Record<string, Vehicle>> = { [ATTO2.id]: ATTO2 };
export const SCENES: Readonly<Record<string, Scene>> = { [GARAGE_561.id]: GARAGE_561 };
