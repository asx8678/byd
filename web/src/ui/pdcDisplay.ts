// Parking-sensor display over the map, like the car's own screen: a car graphic with zone bands,
// a STOP card under 30 cm in the direction of travel, and a red glow on the screen edge facing the obstacle.
import { CAR } from '../core/car';
import { DEG, clamp } from '../core/math';
import { PDC_BANDS, SENSORS, SIDES, rangeOf, type Side } from '../core/sensors';
import type { Sim } from '../core/sim';
import { $, fitCanvas } from './dom';
import { settings } from './settings';

const pdcCv = $<HTMLCanvasElement>('pdcCv'), pdcCtx = pdcCv.getContext('2d')!;
const edgeEl = { top: $('edgeF'), bottom: $('edgeR'), left: $('edgeL'), right: $('edgeRt') };
const edgeLast = { top: -1, bottom: -1, left: -1, right: -1 };
let pdcKey = '', pdcTxtKey = '';

/** Under the readouts, clear of the plan's buttons; the STOP card level with the car. */
export function layoutPdc(band: { top: number; carY: number } | null): void {
  if (!band) return;
  $('pdcWrap').style.top = band.top + 40 + 'px';
  $('pdcStop').style.top = Math.round(band.carY) + 'px';
}

const zoneOf = (g: Side, d: number): number => d < 0.3 ? 9 : PDC_BANDS[g].reduce((n, b, i) => i && d < b ? n + 1 : n, 0);   // bands lit for one sensor, 9 = under 30 cm

function drawPdcIcon(sim: Sim, g: 'front' | 'rear', armed: boolean, blinkOn: boolean, dpr: number): void {   // top-view car with the zone bands around it
  const size = fitCanvas(pdcCv); if (!size) return;
  const { w, h } = size, c = pdcCtx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const cx = w / 2, cw = w * 0.30, cl = cw * CAR.L / CAR.W, band = w * 0.065, gap = w * 0.03, top = h / 2 - cl / 2, bot = h / 2 + cl / 2;
  const col = ['236,91,79', '240,165,58', '94,208,138'];
  const paint = (i: number, lit: boolean, listening: boolean) => `rgba(${col[Math.min(i, 2)]},${lit ? .95 : listening ? .3 : .14})`;
  const hot = `rgba(236,91,79,${blinkOn ? .95 : .3})`;
  const reading = SENSORS.map((sd, i) => ({ ...sd, d: sim.sensorReadings[i] }));
  c.lineCap = 'butt';
  // bumpers: four sectors around a centre inside the nose / tail, three bands each, lit from the outside in
  for (const [grp, sign, ccy] of [['front', -1, top + cl * 0.42], ['rear', 1, bot - cl * 0.42]] as ['front' | 'rear', number, number][]) {
    const list = reading.filter(s => s.g === grp).sort((a, b) => a.lz - b.lz), bands = PDC_BANDS[grp], r0 = cl * 0.42 + gap, listening = armed && grp === g;
    list.forEach((sd, k) => {
      const ca = [-42, -14, 14, 42][k], hw = 12.5, base = sign < 0 ? -90 + ca : 90 - ca, aA = (base - hw) * DEG, aB = (base + hw) * DEG;
      for (let i = 0; i < bands.length - 1; i++) { c.beginPath(); c.arc(cx, ccy, r0 + i * band + band / 2, aA, aB); c.lineWidth = band - 1.5; c.strokeStyle = paint(i, sd.d < bands[i + 1], listening); c.stroke(); }
      if (sd.d < 0.3) { c.beginPath(); c.arc(cx, ccy, r0 - gap / 2, aA, aB); c.lineWidth = gap; c.strokeStyle = hot; c.stroke(); }
    });
  }
  // flanks: two bars per side (front and rear sensor), two bands each
  for (const [grp, sx] of [['left', -1], ['right', 1]] as ['left' | 'right', number][]) {
    const list = reading.filter(s => s.g === grp).sort((a, b) => b.lx - a.lx), bands = PDC_BANDS[grp];
    list.forEach((sd, k) => {
      const y0 = top + cl * (k ? 0.54 : 0.22), y1 = top + cl * (k ? 0.78 : 0.46);
      for (let i = 0; i < bands.length - 1; i++) { const xx = cx + sx * (cw / 2 + gap + i * band + band / 2); c.beginPath(); c.moveTo(xx, y0); c.lineTo(xx, y1); c.lineWidth = band - 1.5; c.strokeStyle = paint(i, sd.d < bands[i + 1], false); c.stroke(); }
      if (sd.d < 0.3) { const xx = cx + sx * (cw / 2 + gap / 2); c.beginPath(); c.moveTo(xx, y0); c.lineTo(xx, y1); c.lineWidth = gap; c.strokeStyle = hot; c.stroke(); }
    });
  }
  // the car, nose up: wheels, body, glass
  c.fillStyle = 'rgba(28,28,32,.95)';
  for (const [fy, sx] of [[0.19, -1], [0.19, 1], [0.80, -1], [0.80, 1]]) c.fillRect(cx + sx * cw / 2 - (sx > 0 ? cw * 0.07 : cw * 0.05), top + cl * fy - cl * 0.055, cw * 0.12, cl * 0.11);
  c.fillStyle = armed ? 'rgba(236,233,224,.96)' : 'rgba(236,233,224,.72)'; c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1;
  c.beginPath(); c.roundRect(cx - cw / 2, top, cw, cl, cw * 0.32); c.fill(); c.stroke();
  c.fillStyle = 'rgba(38,42,54,.92)';
  c.beginPath(); c.roundRect(cx - cw * 0.37, top + cl * 0.25, cw * 0.74, cl * 0.14, cw * 0.1); c.fill();
  c.beginPath(); c.roundRect(cx - cw * 0.37, top + cl * 0.72, cw * 0.74, cl * 0.11, cw * 0.1); c.fill();
  c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(cx - cw * 0.37, top + cl * 0.41, cw * 0.74, cl * 0.29);
  if (armed) {
    c.fillStyle = '#f2c230'; const y = g === 'front' ? top - gap * 0.55 : bot + gap * 0.55, s = g === 'front' ? -1 : 1;
    c.beginPath(); c.moveTo(cx, y + s * gap * 0.8); c.lineTo(cx - gap * 0.9, y - s * gap * 0.3); c.lineTo(cx + gap * 0.9, y - s * gap * 0.3); c.closePath(); c.fill();
  }
}

export function updatePdcDisplay(sim: Sim, now: number, dpr: number): void {
  const on = settings.pdc === 'on', armed = on && sim.armed, g = sim.lastMoveDir >= 0 ? 'front' : 'rear', pdc = sim.pdc;
  const inRange = (k: Side) => pdc[k] < rangeOf(k) - 1e-6;   // a reading at the range cap means nothing seen
  const dmin = Math.min(pdc.front, pdc.rear, pdc.left, pdc.right), show = on && (armed || SIDES.some(inRange));
  $('pdcWrap').classList.toggle('show', show);
  // STOP card for the end that is moving
  const stop = armed && pdc[g] < 0.3;
  $('pdcStop').classList.toggle('show', stop); if (stop) $('pdcStopD').textContent = pdc[g].toFixed(2) + ' m ' + (g === 'front' ? 'ahead' : 'behind');
  // red glow on the screen edge facing the obstacle; the map is north up, so it follows the car's heading
  const I = { top: 0, bottom: 0, left: 0, right: 0 }, cs = Math.cos(sim.th), sn = Math.sin(sim.th);
  for (const k of SIDES) {
    const s = on && inRange(k) ? clamp((0.75 - pdc[k]) / 0.45, 0, 1) : 0; if (!s) continue;
    const [ux, uy] = k === 'front' ? [cs, sn] : k === 'rear' ? [-cs, -sn] : k === 'right' ? [sn, -cs] : [-sn, cs];
    I.top += Math.max(0, uy) * s; I.bottom += Math.max(0, -uy) * s; I.right += Math.max(0, ux) * s; I.left += Math.max(0, -ux) * s;
  }
  for (const k of ['top', 'bottom', 'left', 'right'] as const) { const o = Math.min(1, I[k]); if (Math.abs(o - edgeLast[k]) > 0.02) { edgeLast[k] = o; edgeEl[k].style.opacity = o.toFixed(2); } }
  if (!show) { pdcKey = ''; return; }
  // caption: the nearest reading of any side, or clear
  let tg: Side | null = null; for (const k of SIDES) if (inRange(k) && pdc[k] < (tg ? pdc[tg] : 9)) tg = k;
  const tk = tg ? tg + pdc[tg].toFixed(2) : 'clear';
  if (tk !== pdcTxtKey) {
    pdcTxtKey = tk; const txt = $('pdcTxt');
    if (tg) { $('pdcTg').textContent = tg; $('pdcTd').textContent = pdc[tg].toFixed(2) + ' m'; txt.className = pdc[tg] < 0.35 ? 'bad' : pdc[tg] < 0.7 ? 'warn' : 'ok'; }
    else { $('pdcTg').textContent = 'Sensors'; $('pdcTd').textContent = 'clear'; txt.className = ''; }
  }
  // redraw the graphic only when a zone changes (or while the 30 cm band blinks)
  const blinkOn = Math.floor(now * 3) % 2 === 0; let key = g + (armed ? 'A' : 'a') + (dmin < 0.3 ? (blinkOn ? 'B' : 'b') : '-');
  SENSORS.forEach((sd, i) => { key += zoneOf(sd.g, sim.sensorReadings[i]); });
  if (key !== pdcKey) { pdcKey = key; drawPdcIcon(sim, g, armed, blinkOn, dpr); }
}
