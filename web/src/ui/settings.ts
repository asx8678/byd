// Setup choices, kept in this browser between visits.
import { BAYS, LAYOUT_V, type StartName } from '../core/garage';

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

if (settings.layout !== LAYOUT_V) {   // new garage layout: start from the left, as you usually arrive
  settings.layout = LAYOUT_V; settings.start = 'left'; if (!BAYS[settings.bay]) settings.bay = '561'; saveSettings();
}

/** Steering-wheel degrees at full lock (turns lock to lock × 180). */
export const lockDeg = (): number => (parseFloat(settings.steer) || 2.7) * 180;
