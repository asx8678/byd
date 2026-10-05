// What you have played: the best stars per level, the layout (seed) you last had on each, and what you
// were playing, kept in this browser. Storage can be missing or blocked; then nothing is remembered.
import type { TemplateId } from '../core/generator/templates';

export const TEMPLATE_NAMES: Record<TemplateId, { long: string; short: string }> = {
  'bays-in': { long: 'Bays, nose first', short: 'Bay, nose first' },
  'bays-back': { long: 'Bays, reversing in', short: 'Bay, reversing in' },
  kerb: { long: 'Parallel parking', short: 'Parallel' },
};

interface Progress { best: Record<string, number>; seeds: Record<string, number>; play: string }
const KEY = 'atto2-levels';
export const progress: Progress = { best: {}, seeds: {}, play: 'garage' };
try { Object.assign(progress, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode or blocked storage */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(progress)); } catch { /* not saved */ } };

/** Stars are kept per car: the Atto 2's under the plain slot names (as before there were other cars), the others'
 *  with the car's id in front. */
let carSlot = '';
export function setStarsCar(id: string): void { carSlot = id === 'byd-atto2' ? '' : id + '|'; }
/** Best stars so far for the car being driven; slot is "bays-in:4" for a level or "garage:561:left" for the garage. */
export const bestStars = (slot: string): number => progress.best[carSlot + slot] ?? -1;
export function recordStars(slot: string, n: number): boolean {
  const key = carSlot + slot, better = n > (progress.best[key] ?? -1);
  if (better) { progress.best[key] = n; save(); }
  return better;
}
export const seedFor = (t: TemplateId, level: number): number => progress.seeds[`${t}:${level}`] ?? 1;
/** The layout you last had on a street map, and remembering a new one. */
export const citySeed = (id: string): number => progress.seeds[`city:${id}`] ?? 1;
export function setCitySeed(id: string, seed: number): void { progress.seeds[`city:${id}`] = seed; save(); }
export function setPlaying(play: string, t?: TemplateId, level?: number, seed?: number): void {
  progress.play = play;
  if (t && level && seed) progress.seeds[`${t}:${level}`] = seed;
  save();
}

/** Today's level: the template, a middling difficulty and the seed all come from the date (UTC). */
export function daily(now = Date.now()): { template: TemplateId; level: number; seed: number } {
  const day = Math.floor(now / 86400000), order: TemplateId[] = ['kerb', 'bays-back', 'bays-in'];
  return { template: order[day % 3], level: 4 + (day % 5), seed: day };
}
