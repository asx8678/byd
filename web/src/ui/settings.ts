// Setup choices, kept in this browser between visits.
import { GARAGE_561 } from '../core/content';
import type { StartName } from '../core/garage';

export interface Settings {
  car: string;            // the car you drive in the garage and the levels (its file id); lessons use the Atto 2 for now
  ras: string;            // rear-axle steering at full lock, degrees ('0' = off), for a car that has it
  start: StartName;
  bay: string;
  steer: string;          // steering-wheel turns lock to lock
  pdc: 'on' | 'off';      // parking sensors: beeps and display
  center: 'on' | 'off';   // steering self-centres when rolling
  planView: 'car' | 'area';
  drive: 'right' | 'left';  // on the street, the side traffic keeps to (and you park on)
  district: '2' | '5' | '9';  // how hard the made-up districts are: roomy, average, tight
  layout: number;         // garage layout version these settings were made for
  // learning layers drawn on the plan
  layerPath: 'on' | 'off';    // the path at the current steering, with where it would touch first
  layerPivot: 'on' | 'off';   // the turning centre and circles
  layerSwept: 'on' | 'off';   // the swept path of all four corners
  layerGhost: 'on' | 'off';   // the ideal path and its marks, in the garage and levels (lessons follow their help)
  layerKerb: 'on' | 'off';    // a close-up of the wheel nearest a kerb
  layerNums: 'on' | 'off';    // angle to the space, gap to the kerb and either side
}

const KEY = 'atto2-garage';
export const settings: Settings = {
  car: 'byd-atto2', ras: '10', start: 'left', bay: '561', steer: '2.7', pdc: 'on', center: 'on', planView: 'car', drive: 'right', district: '5', layout: 0,
  layerPath: 'on', layerPivot: 'on', layerSwept: 'off', layerGhost: 'off', layerKerb: 'on', layerNums: 'on',
};
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode or blocked storage: defaults */ }
if ((settings.steer as string) === 'real') settings.steer = '2.7';
if ((settings.steer as string) === 'quick') settings.steer = '1';

export function saveSettings(): void { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* not saved */ } }

if (settings.layout !== GARAGE_561.layoutVersion) {   // new garage layout: start from the left, as you usually arrive
  settings.layout = GARAGE_561.layoutVersion; settings.start = GARAGE_561.defaultStart; if (!GARAGE_561.bays[settings.bay]) settings.bay = GARAGE_561.defaultBay; saveSettings();
}

/** Steering-wheel degrees at full lock (turns lock to lock × 180). */
export const lockDeg = (): number => (parseFloat(settings.steer) || 2.7) * 180;
