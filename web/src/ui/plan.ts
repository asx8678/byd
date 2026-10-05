// The plan: a north-up map of the bays that fills the screen, with the path the car takes at the current steering,
// an outline of the car every 0.8 m along it and, in red, where it would touch something first.
import { ackermann, footprint } from '../core/car';
import type { Rect } from '../core/scene';
import { DEG, clamp, type Pt } from '../core/math';
import type { Pose, RoutePoint } from '../core/planner';
import type { Prediction } from '../core/predict';
import { SIDES, rangeOf } from '../core/sensors';
import type { Sim } from '../core/sim';
import { $, fitCanvas } from './dom';
import { settings } from './settings';

const planCv = $<HTMLCanvasElement>('planCv'), ctx = planCv.getContext('2d')!;
const PV = { cx: 0, cz: 4, s: 24, w: 0, h: 0, oy: 0, band: 0, init: false };   // view centre (m), scale (px/m), size, the car's screen row, the free band's height
let pred: Prediction | null = null, predKey = '', predT = -1, infoTxt = '', predTxt = '', scaleW = -1;

/** Under the HUD and above the wheel and pedals: where the readouts sit and which band the car is centred in. Returns that band. */
export function layoutPlan(stage: HTMLElement): { top: number; bottom: number; carY: number } | null {
  const c = stage.getBoundingClientRect(), W = c.width, H = c.height; if (!W || !H) return null;
  let hudB = $('hud').getBoundingClientRect().bottom - c.top + 8;
  // in a lesson the coach card sits under the readouts, and the wheel readout makes way for it
  const card = $('coach');
  if (!card.hidden) { card.style.top = hudB + 'px'; hudB = card.getBoundingClientRect().bottom - c.top + 6; }
  $('planInfo').hidden = !card.hidden;
  const ctlT = Math.min($('wheelWrap').getBoundingClientRect().top, $('pedals').getBoundingClientRect().top) - c.top - 8;
  const fb = W > H ? H - 10 : ctlT;   // landscape: the wheel and pedals sit at the sides, so the car can use the full height
  $('planInfo').style.top = $('planBtns').style.top = hudB + 'px'; $('planFoot').style.bottom = Math.max(6, H - ctlT + 4) + 'px';
  PV.oy = clamp((hudB + 70 + fb - 30) / 2, 0, H); PV.band = Math.max(120, fb - hudB - 100);
  return { top: hudB, bottom: ctlT, carY: PV.oy };
}

export function forgetPrediction(): void { pred = null; }

/** Show me: a planned route drawn on the floor, and a ghost car at point `at` along it. */
export interface Guide { pts: RoutePoint[]; at: number }
let guide: Guide | null = null;
export function setGuide(g: Guide | null): void { guide = g; }
/** A lesson on the floor: the route (guided), the marks still to come (the next one where the car should really stop,
 *  which follows the car), and after a try your path over the route with the first place it drifted 30 cm. */
export interface CoachDraw { route: RoutePoint[] | null; marks: Pose[]; from: number; cur: Pose | null; track: Pt[] | null; drift: Pt | null }
let coach: CoachDraw | null = null;
export function setCoachDraw(d: CoachDraw | null): void { coach = d; }

/** Jump straight to the target view on the next frame instead of easing there. */
export function snapView(): void { PV.init = false; }

function follow(sim: Sim, dt: number): void {
  let tx, tz, ts;
  if (settings.planView === 'area') { const [x0, x1, z0, z1] = sim.scene.areaView; tx = (x0 + x1) / 2; tz = (z0 + z1) / 2; ts = Math.min(PV.w / (x1 - x0), PV.band / (z1 - z0)); }   // the scene's whole-area view
  else { tx = sim.x + 1.34 * Math.cos(sim.th); tz = sim.z - 1.34 * Math.sin(sim.th); ts = Math.min(PV.w, PV.band) / 11; }
  const k = PV.init ? 1 - Math.exp(-8 * dt) : 1; PV.init = true;
  PV.cx += (tx - PV.cx) * k; PV.cz += (tz - PV.cz) * k; PV.s += (ts - PV.s) * k;
}
const PS = (px: number, pz: number): Pt => [PV.w / 2 + (px - PV.cx) * PV.s, PV.oy + (pz - PV.cz) * PV.s];
const rectPts = (r: Rect): Pt[] => [[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]]];
function path(c: CanvasRenderingContext2D, pts: Pt[], close = true): void {
  c.beginPath();
  for (let i = 0; i < pts.length; i++) { const [sx, sy] = PS(pts[i][0], pts[i][1]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); }
  if (close) c.closePath();
}
const zoneCol = (d: number): string => d < 0.3 ? '#ec5b4f' : d < 0.5 ? '#ff8a3d' : d < 1.0 ? '#f2c230' : '#5ed08a';

export function drawPlan(sim: Sim, now: number, dt: number, dpr: number): void {
  const size = fitCanvas(planCv); if (!size) return;
  const { w, h } = size, { x, z, th } = sim, v = sim.vehicle, sc = sim.scene;
  PV.w = w; PV.h = h; follow(sim, dt);
  const c = ctx, s = PV.s; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.lineJoin = 'round';
  c.fillStyle = '#0d0e12'; c.fillRect(0, 0, w, h);
  // floors, the lower level over the low wall, pavements with their kerbs, the target bay
  c.fillStyle = '#1c1e24'; for (const f of sc.floors) { path(c, rectPts(f)); c.fill(); }
  if (sc.pit) { c.fillStyle = '#121317'; path(c, rectPts(sc.pit)); c.fill(); }
  for (const o of sim.obstacles) if (o.cls === 'kerb' && o.kind === 'poly') {
    c.fillStyle = '#2a2d34'; path(c, o.pts); c.fill();
    c.strokeStyle = '#8e939c'; c.lineWidth = Math.max(1.5, 0.15 * s); c.lineCap = 'butt'; path(c, o.pts.slice(0, 2), false); c.stroke();
  }
  const B = sc.bays[sim.options.bay] ?? sc.bays[sc.defaultBay]; c.fillStyle = 'rgba(94,208,138,.11)'; path(c, rectPts([B.x0, B.x1, B.z0, B.z1])); c.fill();
  if (B.kind === 'kerb') { c.strokeStyle = 'rgba(94,208,138,.6)'; c.lineWidth = 1; c.setLineDash([4, 4]); path(c, rectPts([B.x0 + 0.08, B.x1 - 0.08, B.z0 + 0.05, B.z1 - 0.05])); c.stroke(); c.setLineDash([]); }
  // lane markings: dashed white
  if (sc.dashes.length) {
    c.strokeStyle = 'rgba(235,232,223,.55)'; c.lineWidth = Math.max(1, 0.1 * s); c.setLineDash([3 * s, 3 * s]); c.beginPath();
    for (const [x0, z0, x1, z1] of sc.dashes) { const a = PS(x0, z0), b = PS(x1, z1); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
    c.stroke(); c.setLineDash([]);
  }
  // painted lines, numbers, the drain cover
  c.strokeStyle = '#d9ab2b'; c.lineWidth = Math.max(1, 0.1 * s); c.lineCap = 'butt'; c.beginPath();
  for (const [x0, z0, x1, z1] of sc.lines) { const a = PS(x0, z0), b = PS(x1, z1); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
  c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `700 ${Math.max(9, 0.42 * s).toFixed(1)}px "Barlow Condensed", sans-serif`; c.fillStyle = 'rgba(214,74,58,.9)';
  for (const [t, mx, mz] of sc.marks.text) { const [sx, sy] = PS(mx, mz); c.fillText(t, sx, sy); }
  if (sc.marks.manhole) { c.fillStyle = '#2c2f35'; path(c, rectPts(sc.marks.manhole)); c.fill(); }
  // what is solid: walls and pillars light, low things amber, parked cars dark with their names
  const oy = PV.oy, vx0 = PV.cx - w / 2 / s - 1, vx1 = PV.cx + w / 2 / s + 1, vz0 = PV.cz - oy / s - 1, vz1 = PV.cz + (h - oy) / s + 1;
  c.lineWidth = 1;
  for (const o of sim.obstacles) {
    if (o.cls === 'kerb' || o.bx1 < vx0 || o.bx0 > vx1 || o.bz1 < vz0 || o.bz0 > vz1) continue;
    if (o.cls === 'car' && o.kind === 'poly') {
      c.fillStyle = '#353a43'; c.strokeStyle = '#5b636e'; path(c, o.pts); c.fill(); c.stroke();
      if (s > 15 && o.label) { const [sx, sy] = PS(o.cx, o.cz); c.fillStyle = '#a7afb9'; c.font = `600 ${clamp(0.3 * s, 9, 13).toFixed(1)}px "Barlow Condensed", sans-serif`; c.fillText(o.label, sx, sy); }
      continue;
    }
    const low = o.cls === 'low';
    c.fillStyle = low ? '#b9832a' : o.cls === 'lowwall' ? '#8e9498' : '#c9ccc8'; c.strokeStyle = low ? '#f2c230' : '#6d747a';
    if (o.kind === 'circle') { const [sx, sy] = PS(o.x, o.z); c.beginPath(); c.arc(sx, sy, o.r * s, 0, 6.3); c.fill(); c.stroke(); }
    else { path(c, o.pts); c.fill(); c.stroke(); }
  }
  if (sc.door) { c.strokeStyle = '#59636b'; c.lineWidth = Math.max(1.5, 0.07 * s); const a = PS(sc.door[0], 0.03), b = PS(sc.door[1], 0.03); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
  // a lesson: the route, the marks, your path and where it first drifted
  if (coach) {
    const C = coach;
    if (C.route) {
      const G = C.route; c.lineCap = 'round'; c.lineWidth = Math.max(1.5, 0.05 * s);
      for (let i = 1; i < G.length; i++) {
        const a = PS(G[i - 1].x, G[i - 1].z), b = PS(G[i].x, G[i].z);
        c.strokeStyle = G[i].dir > 0 ? 'rgba(242,194,48,.55)' : 'rgba(94,208,216,.6)'; c.setLineDash(G[i].dir > 0 ? [] : [6, 5]);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      }
      c.setLineDash([]);
    }
    if (C.track && C.track.length > 1) { c.strokeStyle = 'rgba(235,232,223,.85)'; c.lineWidth = Math.max(1.5, 0.05 * s); c.lineCap = 'round'; path(c, C.track, false); c.stroke(); }
    c.font = `700 ${clamp(0.5 * s, 11, 16).toFixed(1)}px "Barlow Condensed", sans-serif`;
    C.marks.forEach((m, k) => {
      if (k < C.from) return;
      const on = k === C.from, p = on && C.cur ? C.cur : m;
      c.strokeStyle = on ? 'rgba(242,194,48,.95)' : 'rgba(235,232,223,.4)'; c.lineWidth = on ? 2 : 1; c.setLineDash(on ? [] : [4, 4]);
      path(c, footprint(p.x, p.z, p.th, v.body)); c.stroke(); c.setLineDash([]);
      const q = footprint(p.x, p.z, p.th, [[v.WB / 2, 0]])[0], [sx, sy] = PS(q[0], q[1]);
      c.fillStyle = on ? '#f2c230' : 'rgba(235,232,223,.55)'; c.fillText(String(k + 1), sx, sy);
    });
    if (C.drift) { const [sx, sy] = PS(C.drift[0], C.drift[1]); c.strokeStyle = '#ff6b5a'; c.lineWidth = 2.5; c.beginPath(); c.arc(sx, sy, Math.max(10, 0.45 * s), 0, 6.3); c.stroke(); }
  }
  // Show me: the planned route (forward yellow, reverse dashed cyan), where each move ends, and the ghost car
  if (guide) {
    const G = guide.pts;
    c.lineCap = 'round'; c.lineWidth = Math.max(2, 0.07 * s);
    for (let i = 1; i < G.length; i++) {
      const a = PS(G[i - 1].x, G[i - 1].z), b = PS(G[i].x, G[i].z);
      c.strokeStyle = G[i].dir > 0 ? 'rgba(242,194,48,.9)' : 'rgba(94,208,216,.95)'; c.setLineDash(G[i].dir > 0 ? [] : [6, 5]);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    }
    c.setLineDash([]);
    for (let i = 1; i < G.length - 1; i++) if (G[i + 1].dir !== G[i].dir) { c.strokeStyle = 'rgba(235,232,223,.35)'; c.lineWidth = 1; c.setLineDash([4, 4]); path(c, footprint(G[i].x, G[i].z, G[i].th, v.body)); c.stroke(); c.setLineDash([]); }
    const g = G[Math.min(guide.at, G.length - 1)];
    c.fillStyle = 'rgba(242,194,48,.10)'; c.strokeStyle = 'rgba(242,194,48,.95)'; c.lineWidth = 1.5; c.setLineDash([5, 4]);
    path(c, footprint(g.x, g.z, g.th, v.body)); c.fill(); c.stroke(); c.setLineDash([]);
    c.fillStyle = 'rgba(242,194,48,.85)'; path(c, footprint(g.x, g.z, g.th, [[v.WB + v.OVF - 0.143, 0], [v.WB + v.OVF - 0.543, -0.27], [v.WB + v.OVF - 0.543, 0.27]])); c.fill();
  }
  // the path at the current steering: an outline every 0.8 m, the leading corners, the end that swings, and in red where it would touch first
  const dir: 1 | -1 = sim.input.rev ? -1 : sim.input.fwd ? 1 : sim.lastMoveDir;
  const key = `${x.toFixed(3)},${z.toFixed(3)},${th.toFixed(4)},${sim.wheelAngle.toFixed(1)},${dir}`;
  if (!pred || pred.dir !== dir || (key !== predKey && now - predT > 0.05)) { pred = sim.predict(dir); predKey = key; predT = now; }
  const p = pred;
  c.lineCap = 'round'; c.strokeStyle = 'rgba(242,194,48,.26)'; c.lineWidth = 1;
  for (const g of p.ghosts) { path(c, footprint(g[0], g[1], g[2], v.body)); c.stroke(); }
  c.setLineDash([4, 4]); c.strokeStyle = 'rgba(143,184,255,.7)'; path(c, p.tracks.rearAxle, false); c.stroke(); c.setLineDash([]);
  c.lineWidth = 2; c.strokeStyle = p.hit ? '#ff6b5a' : '#f2c230';
  for (const t of p.dir > 0 ? [p.tracks.fl, p.tracks.fr] : [p.tracks.rl, p.tracks.rr]) { path(c, t, false); c.stroke(); }
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(94,208,216,.9)'; path(c, p.tracks.swing, false); c.stroke();
  if (p.hit) { c.strokeStyle = '#ff4f4f'; c.lineWidth = 2; c.setLineDash([5, 3]); path(c, footprint(p.end[0], p.end[1], p.end[2], v.body)); c.stroke(); c.setLineDash([]); }
  // turning centre, the lines from it to the wheels (Ackermann) and the circle the outer front corner sweeps
  const dl = -sim.steerDeg * DEG, [fl, fr] = ackermann(v, dl);
  const wl = footprint(x, z, th, [[v.WB, -v.TRACK / 2], [v.WB, v.TRACK / 2], [0, -v.TRACK / 2], [0, v.TRACK / 2]]);
  if (Math.abs(dl) > 0.004) {
    const Rc = v.WB / Math.tan(dl);
    if (Math.abs(Rc) < 30) {
      const icr = footprint(x, z, th, [[0, -Rc]])[0], [ix, iy] = PS(icr[0], icr[1]), oc = footprint(x, z, th, [[3.40, Rc > 0 ? 0.76 : -0.76]])[0];
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(200,215,225,.5)'; c.lineWidth = 1;
      for (const wp of wl) { const [sx, sy] = PS(wp[0], wp[1]); c.beginPath(); c.moveTo(ix, iy); c.lineTo(sx, sy); c.stroke(); }
      c.strokeStyle = 'rgba(255,138,61,.38)'; c.beginPath(); c.arc(ix, iy, Math.hypot(oc[0] - icr[0], oc[1] - icr[1]) * s, 0, 6.3); c.stroke(); c.setLineDash([]);
      c.fillStyle = '#ebe8df'; c.beginPath(); c.arc(ix, iy, 3, 0, 6.3); c.fill();
    }
  }
  // parking-sensor zones
  if (settings.pdc === 'on') {
    const Z: Record<string, Pt[]> = {
      front: [[v.WB + v.OVF + 0.16, -0.7], [v.WB + v.OVF + 0.16, 0.7]], rear: [[-v.OVR - 0.16, -0.7], [-v.OVR - 0.16, 0.7]],
      left: [[0.2, -v.W / 2 - 0.2], [2.6, -v.W / 2 - 0.2]], right: [[0.2, v.W / 2 + 0.2], [2.6, v.W / 2 + 0.2]],
    };
    c.lineCap = 'round';
    for (const k of SIDES) { const d = sim.pdc[k]; if (!(d < rangeOf(v, k) - 1e-6)) continue; c.strokeStyle = zoneCol(d); c.lineWidth = Math.max(3, 0.12 * s); path(c, footprint(x, z, th, Z[k]), false); c.stroke(); }
  }
  // the car: body, mirrors, glass, the nose mark, wheels (the fronts at their Ackermann angles)
  c.fillStyle = 'rgba(16,18,22,.95)'; c.strokeStyle = '#ebe8df'; c.lineWidth = 1.5; path(c, footprint(x, z, th, v.body)); c.fill(); c.stroke();
  c.fillStyle = '#8e939c'; for (const m of v.mirrors) { path(c, footprint(x, z, th, m)); c.fill(); }
  const gx = v.WB - 0.32, gw = v.W / 2 - 0.195, nose = v.WB + v.OVF - 0.143;   // glass and the nose mark, scaled to this car
  c.fillStyle = 'rgba(70,92,116,.5)'; path(c, footprint(x, z, th, [[gx, -gw], [gx, gw], [-0.45, gw - 0.04], [-0.45, -gw + 0.04]])); c.fill();
  c.fillStyle = '#f2c230'; path(c, footprint(x, z, th, [[nose, 0], [nose - 0.4, -0.27], [nose - 0.4, 0.27]])); c.fill();
  const WRECT: Pt[] = [[-v.WR, -v.WW / 2], [v.WR, -v.WW / 2], [v.WR, v.WW / 2], [-v.WR, v.WW / 2]];
  ([[wl[0], fl, true], [wl[1], fr, true], [wl[2], 0, false], [wl[3], 0, false]] as [Pt, number, boolean][]).forEach(([q, a, front]) => {
    c.fillStyle = front && Math.abs(a) > 0.01 ? '#f2c230' : '#ebe8df'; path(c, footprint(q[0], q[1], th + a, WRECT)); c.fill();
  });
  if (s > 19) {   // wheel angles and the car's length, when zoomed in enough to read
    c.font = `600 ${Math.min(14, 0.42 * s).toFixed(1)}px "Barlow Condensed", sans-serif`; c.fillStyle = '#f2c230';
    if (Math.abs(dl) > 0.004) {
      const lab = footprint(x, z, th, [[v.WB + 0.3, -v.TRACK / 2 - 0.5], [v.WB + 0.3, v.TRACK / 2 + 0.5]]);
      c.fillText(`${Math.abs(fl / DEG).toFixed(0)}°`, ...PS(lab[0][0], lab[0][1])); c.fillText(`${Math.abs(fr / DEG).toFixed(0)}°`, ...PS(lab[1][0], lab[1][1]));
    }
    const dm = footprint(x, z, th, [[-v.OVR, v.W / 2 + 0.9], [v.WB + v.OVF, v.W / 2 + 0.9]]), a = PS(dm[0][0], dm[0][1]), b = PS(dm[1][0], dm[1][1]);
    c.strokeStyle = 'rgba(235,232,223,.45)'; c.lineWidth = 1; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    c.fillStyle = 'rgba(235,232,223,.6)'; for (const e of [a, b]) { c.beginPath(); c.arc(e[0], e[1], 2, 0, 6.3); c.fill(); }
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; c.fillStyle = 'rgba(13,14,18,.85)'; c.fillRect(mx - 22, my - 8, 44, 16); c.fillStyle = '#d6d3ca'; c.fillText(`${v.L.toFixed(2)} m`, mx, my + 1);
  }
  // readouts: wheel angles, turning radius, steering wheel; what the path runs into; the scale bar
  const Rout = Math.abs(dl) > 0.004 ? Math.hypot(Math.abs(v.WB / Math.tan(dl)) + v.TRACK / 2, v.WB) : Infinity, wa = sim.wheelAngle;
  const info = `<div><span>Wheels</span>L ${(fl / DEG).toFixed(1)}° · R ${(fr / DEG).toFixed(1)}°</div><div><span>Turn radius</span>${Rout < 60 ? Rout.toFixed(2) + ' m' : 'straight'}</div><div><span>Steering</span>${Math.abs(wa) < 1 ? 'centred' : Math.abs(wa).toFixed(0) + '° ' + (wa < 0 ? 'left' : 'right')}</div>`;
  if (info !== infoTxt) { infoTxt = info; $('planInfo').innerHTML = info; }
  const what = p.dir > 0 ? 'Forward' : 'Reversing';
  const ptxt = p.hit ? `${what}: ${p.part ? p.part + ' ' : ''}hits ${p.hit.name} in ${p.dist.toFixed(1)} m` : `${what}: clear for ${p.dist.toFixed(1)} m`;
  if (ptxt !== predTxt) { predTxt = ptxt; const el = $('planPred'); el.textContent = ptxt; el.className = p.hit && p.dist < 1 ? 'bad' : ''; }
  const sw = Math.round(s); if (sw !== scaleW) { scaleW = sw; $('planScale').innerHTML = `<i style="width:${sw}px"></i>1 m`; }
}

