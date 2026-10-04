// The readouts at the top and the message banner.
import { DRIVE } from '../core/car';
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
const SENSOR_IDS: [string, Side][] = [['sF', 'front'], ['sR', 'rear'], ['sL', 'left'], ['sRt', 'right']];
const cls = (d: number) => d < 0.35 ? 'bad' : d < 0.7 ? 'warn' : 'ok';

export function updateHud(sim: Sim): void {
  const wa = sim.wheelAngle, tgt = sim.targetSpeed();
  wheelSvg.style.transform = `rotate(${wa}deg)`;
  $('steerTurns').textContent = (Math.abs(wa) / 360).toFixed(1) + (wa > 1 ? ' R' : wa < -1 ? ' L' : '');
  $('spd').textContent = (Math.abs(sim.v) * 3.6).toFixed(1); $('gear').textContent = sim.gear; $('steerV').textContent = steerText(sim.steerDeg);
  for (const [id, k] of SENSOR_IDS) { const el = $(id), d = sim.pdc[k], r = rangeOf(k); el.textContent = d < r ? d.toFixed(2) + ' m' : '–'; el.className = d < r ? cls(d) : ''; }
  $('lF').classList.toggle('armed', sim.lastMoveDir >= 0); $('lR').classList.toggle('armed', sim.lastMoveDir < 0);
  $('btnFwd').style.setProperty('--lvl', sim.input.fwd ? (Math.abs(tgt) / DRIVE.VMAX_F).toFixed(2) : '0');
  $('btnRev').style.setProperty('--lvl', sim.input.rev ? (Math.abs(tgt) / DRIVE.VMAX_R).toFixed(2) : '0');
}
