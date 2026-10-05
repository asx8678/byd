// The readouts between the wheel and the pedals (speed and gear; your moves, or the speed limit when driving), the
// wheel's turns on its hub, and the message banner.
import type { Sim } from '../core/sim';
import { $ } from './dom';

const banner = $('banner');
let bannerT = 0;
export function showBanner(cls: '' | 'good' | 'bad', title: string, text: string, stats: [string, string][] | null, ttl?: number): void {
  clearTimeout(bannerT); if (ttl) bannerT = window.setTimeout(() => banner.classList.add('hide'), ttl);
  banner.className = cls; $('bTitle').textContent = title; $('bText').textContent = text;
  const st = $('bStats'); st.hidden = !stats;
  if (stats) st.replaceChildren(...stats.map(([k, val]) => { const d = document.createElement('div'), s = document.createElement('span'), b = document.createElement('b'); s.textContent = k; b.textContent = val; d.append(s, b); return d; }));
  room.h = banner.offsetHeight; placeBanner();
}

/** Where a message goes: at the foot of the map, just above the path's readout, unless the car (or the space it is
 *  going into) is down there; then at
 *  the top of the map. In landscape always at the top, clear of the wheel's and the pedals' columns. */
const room = { top: 0, foot: 0, H: 0, land: false, lo: 0, hi: 0, h: 0 };
let banAt: 'top' | 'bottom' = 'bottom', banKey = '';
function placeBanner(): void {
  if (!room.H || banner.classList.contains('hide')) return;
  const over = (a: number) => Math.max(0, Math.min(a + room.h, room.hi) - Math.max(a, room.lo));
  const ot = over(room.top), ob = over(room.foot - room.h);
  if (room.land) banAt = 'top'; else if (!ob) banAt = 'bottom'; else if (ot + 20 < ob) banAt = 'top'; else if (ob + 20 < ot) banAt = 'bottom';
  const key = `${banAt}|${Math.round(room.top)}|${Math.round(room.foot)}|${Math.round(room.H)}`; if (key === banKey) return; banKey = key;
  const st = banner.style;
  if (banAt === 'top') { st.top = room.top + 'px'; st.bottom = 'auto'; } else { st.top = 'auto'; st.bottom = room.H - room.foot + 'px'; }
}
/** The map's free band (screen px from the top of the stage) as the layout leaves it. */
export function bannerRoom(top: number, foot: number, H: number, land: boolean): void { Object.assign(room, { top, foot, H, land }); placeBanner(); }
/** The rows of the screen a message should keep off: the car's, and in Park mode the space it is going into. */
export function bannerCar(lo: number, hi: number): void {
  if (Math.abs(lo - room.lo) < 2 && Math.abs(hi - room.hi) < 2) return;
  room.lo = lo; room.hi = hi; placeBanner();
}

const wheelSvg = $('wheelSvg');
let par = 0, limit: number | null = null;
/** On the street in Drive mode, the speed limit where you are: shown in place of the moves (null: the moves). */
export function setLimit(l: number | null): void { limit = l; }
/** The planner's moves for this attempt, shown next to yours (0: none). */
export function setPar(n: number): void { par = n; $('parV').textContent = n ? `/ ${n}` : ''; $('movesTile').title = n ? `Par is ${n}: the planner's route from the start` : ''; }

export function updateHud(sim: Sim): void {
  const wa = sim.wheelAngle, tgt = sim.targetSpeed();
  wheelSvg.style.transform = `rotate(${wa}deg)`;
  $('steerTurns').textContent = (Math.abs(wa) / 360).toFixed(1) + (wa > 1 ? ' R' : wa < -1 ? ' L' : '');
  const kmh = Math.abs(sim.v) * 3.6, drive = sim.mode === 'drive', over = limit !== null && drive && kmh > limit + 3;
  const spd = $('spd'); spd.textContent = drive && kmh >= 10 ? kmh.toFixed(0) : kmh.toFixed(1); spd.className = over ? 'over' : ''; $('gear').textContent = sim.gear;
  const mv = $('movesV');
  if (limit !== null && drive) { $('movesK').textContent = 'Limit'; mv.textContent = String(limit); $('parV').textContent = ''; mv.className = over ? 'over' : ''; }
  else { $('movesK').textContent = 'Moves'; mv.textContent = String(sim.moves); $('parV').textContent = par ? `/ ${par}` : ''; mv.className = par && sim.moves > par + 1 ? 'over' : ''; }
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
