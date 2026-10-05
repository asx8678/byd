// The readouts at the top and the message banner.
import { rangeOf, type Side } from '../core/sensors';
import type { Sim } from '../core/sim';
import { $ } from './dom';
import { steerText } from './format';

const banner = $('banner');
let bannerT = 0;
export function showBanner(cls: '' | 'good' | 'bad', title: string, text: string, stats: [string, string][] | null, ttl?: number): void {
  clearTimeout(bannerT); if (ttl) bannerT = window.setTimeout(() => banner.classList.add('hide'), ttl);
  banner.className = cls; $('bTitle').textContent = title; $('bText').textContent = text;
  const st = $('bStats'); st.hidden = !stats;
  if (stats) st.replaceChildren(...stats.map(([k, val]) => { const d = document.createElement('div'), s = document.createElement('span'), b = document.createElement('b'); s.textContent = k; b.textContent = val; d.append(s, b); return d; }));
}

const wheelSvg = $('wheelSvg');
let par = 0, limit: number | null = null;
/** On the street in Drive mode, the speed limit where you are: the Moves tile shows it instead (null: the moves). */
export function setLimit(l: number | null): void { limit = l; }
/** The planner's moves for this attempt, shown next to yours (0: none). */
export function setPar(n: number): void { par = n; $('parV').textContent = n ? `/ ${n}` : ''; $('movesTile').title = n ? `Par is ${n}: the planner's route from the start` : ''; }
const SENSOR_IDS: [string, Side][] = [['sF', 'front'], ['sR', 'rear'], ['sL', 'left'], ['sRt', 'right']];
const cls = (d: number) => d < 0.35 ? 'bad' : d < 0.7 ? 'warn' : 'ok';

export function updateHud(sim: Sim): void {
  const wa = sim.wheelAngle, tgt = sim.targetSpeed();
  wheelSvg.style.transform = `rotate(${wa}deg)`;
  $('steerTurns').textContent = (Math.abs(wa) / 360).toFixed(1) + (wa > 1 ? ' R' : wa < -1 ? ' L' : '');
  const kmh = Math.abs(sim.v) * 3.6, drive = sim.mode === 'drive';
  $('spd').textContent = drive && kmh >= 10 ? kmh.toFixed(0) : kmh.toFixed(1); $('gear').textContent = sim.gear; $('steerV').textContent = steerText(sim.steerDeg);
  const mv = $('movesV');
  if (limit !== null && drive) { $('movesK').textContent = 'Limit'; mv.textContent = String(limit); $('parV').textContent = 'km/h'; mv.className = kmh > limit + 3 ? 'over' : ''; }
  else { $('movesK').textContent = 'Moves'; mv.textContent = String(sim.moves); $('parV').textContent = par ? `/ ${par}` : ''; mv.className = par && sim.moves > par + 1 ? 'over' : ''; }
  for (const [id, k] of SENSOR_IDS) { const el = $(id), d = sim.pdc[k], r = rangeOf(sim.vehicle, k); el.textContent = d < r ? d.toFixed(2) + ' m' : '–'; el.className = d < r ? cls(d) : ''; }
  $('lF').classList.toggle('armed', sim.lastMoveDir >= 0); $('lR').classList.toggle('armed', sim.lastMoveDir < 0);
  if (sim.traffic) {   // on the street: the indicator and hazard buttons light up and flash with the lights they work
    const lit = sim.time % 0.8 < 0.45;
    for (const [id, on, pressed] of [['btnIndL', sim.ind === -1 || sim.hazard, sim.ind === -1], ['btnIndR', sim.ind === 1 || sim.hazard, sim.ind === 1], ['btnHaz', sim.hazard, sim.hazard]] as const) {
      const b = $(id); b.classList.toggle('on', on); b.classList.toggle('lit', on && lit); b.setAttribute('aria-pressed', String(pressed));
    }
  }
  // the buttons fill as the speed stage rises (Park mode) or as hard as the pedal is pressed (Drive mode)
  $('btnFwd').style.setProperty('--lvl', drive ? sim.input.acc.toFixed(2) : sim.input.fwd ? (Math.abs(tgt) / sim.vehicle.drive.VMAX_F).toFixed(2) : '0');
  $('btnRev').style.setProperty('--lvl', drive ? sim.input.brk.toFixed(2) : sim.input.rev ? (Math.abs(tgt) / sim.vehicle.drive.VMAX_R).toFixed(2) : '0');
}
