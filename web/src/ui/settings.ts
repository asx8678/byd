// Setup choices, kept in this browser between visits.
import { GARAGE_561 } from '../core/content';
import type { StartName } from '../core/garage';

export interface Settings {
  start: StartName;
  bay: string;
  steer: string;          // steering-wheel turns lock to lock
  pdc: 'on' | 'off';      // parking sensors: beeps and display
  center: 'on' | 'off';   // steering self-centres when rolling
  planView: 'car' | 'area';
  layout: number;         // garage layout version these settings were made for
}

const KEY = 'atto2-garage';
export const settings: Settings = { start: 'left', bay: '561', steer: '2.7', pdc: 'on', center: 'on', planView: 'car', layout: 0 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode or blocked storage: defaults */ }
if ((settings.steer as string) === 'real') settings.steer = '2.7';
if ((settings.steer as string) === 'quick') settings.steer = '1';

export function saveSettings(): void { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* not saved */ } }

if (settings.layout !== GARAGE_561.layoutVersion) {   // new garage layout: start from the left, as you usually arrive
  settings.layout = GARAGE_561.layoutVersion; settings.start = GARAGE_561.defaultStart; if (!GARAGE_561.bays[settings.bay]) settings.bay = GARAGE_561.defaultBay; saveSettings();
}

/** Steering-wheel degrees at full lock (turns lock to lock × 180). */
export const lockDeg = (): number => (parseFloat(settings.steer) || 2.7) * 180;
