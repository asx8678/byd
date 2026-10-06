// What is free and what comes with Pro in the store edition (the personal edition has everything): free to learn, Pro
// for the special cars, the hard levels and the busy street, as the blueprint has it. Pure rules, no screen code.
import type { TemplateId } from './generator/templates';

/** The everyday cars, by file id; the others come with Pro. */
export const FREE_CARS: readonly string[] = ['byd-atto2', 'smart-fortwo-c453', 'peugeot-208-p21', 'skoda-octavia-combi-nx'];
/** Levels 1 to FREE_LEVELS of each car template are free, layouts 1 to FREE_LAYOUTS of each: ninety maps, with the
 *  lessons, the garage, Harbour, the roomy and average districts and today's level about a hundred. */
export const FREE_LEVELS = 6, FREE_LAYOUTS = 5;

export const carIsPro = (fileId: string): boolean => !FREE_CARS.includes(fileId);
/** A level from the Levels tab: every trailer level, levels past FREE_LEVELS and layouts past FREE_LAYOUTS are Pro;
 *  today's level is free whatever it turns out to be. */
export const levelIsPro = (t: TemplateId, level: number, seed: number, daily = false): boolean =>
  !daily && (t === 'tow' || level > FREE_LEVELS || seed > FREE_LAYOUTS);
/** Busy traffic (rush hour) is Pro; so are the spot thieves, whatever the traffic. */
export const trafficIsPro = (setting: string): boolean => setting === 'busy';
/** The tight made-up districts are Pro (the hard generator settings); roomy and average are free. */
export const districtIsPro = (level: number): boolean => level >= 8;
/** A free player's next layout of a level: round the first FREE_LAYOUTS. */
export const nextFreeLayout = (seed: number): number => (Math.max(1, seed) % FREE_LAYOUTS) + 1;
