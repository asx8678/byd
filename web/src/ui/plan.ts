// The plan: a map that fills the screen, with the path the car takes at the current steering, an outline of the car
// every 0.8 m along it and, in red, where it would touch something first. North up in a car park; on the street in
// Drive mode it turns so you always drive up, and zooms out with speed so you see far enough ahead to stop. On the
// street it also draws the traffic, the lights and the lines at the junctions.
import { ackermann, footprint, rearAngles } from '../core/car';
import { roundRect, type CityLayers, type Slot } from '../core/city';
import { wheelsOf } from '../core/collision';
import { lookAhead } from '../core/dynamics';
import { bayRect, besideKerb, type Rect } from '../core/scene';
import { DEG, clamp, wrapPi, type Pt } from '../core/math';
import type { Pose, RoutePoint } from '../core/planner';
import type { Prediction } from '../core/predict';
import { SIDES, rangeOf } from '../core/sensors';
import { PDC_MAX, type Sim } from '../core/sim';
import { DRIVERS, TYPES, type Traffic } from '../core/traffic';
import { $, fitCanvas } from './dom';
import { bannerCar, bannerRoom } from './hud';
import { settings } from './settings';

const planCv = $<HTMLCanvasElement>('planCv'), ctx = planCv.getContext('2d')!;
// view centre (m), scale (px/m), size, the car's screen row (and where it sits in Park and Drive mode), the free band's
// top and height, how far the map is turned (rad: a world direction at angle a shows at a + rot on the screen)
const PV = { cx: 0, cz: 4, s: 24, w: 0, h: 0, oy: 0, oyPark: 0, oyDrive: 0, top: 0, band: 0, foot: 0, init: false, rot: 0, cr: 1, sr: 0 };
let pred: Prediction | null = null, predKey = '', predT = -1, infoTxt = '', predTxt = '', scaleW = -1, numsTxt = '';

/** Under the HUD and above the wheel and pedals: where the readouts sit and which band the car is centred in. Returns that band. */
export function layoutPlan(stage: HTMLElement): { top: number; bottom: number; carY: number } | null {
  const c = stage.getBoundingClientRect(), W = c.width, H = c.height; if (!W || !H) return null;
  let hudB = $('hud').getBoundingClientRect().bottom - c.top + 8;
  // in a lesson the coach card sits under the readouts, and the wheel readout makes way for it
  const card = $('coach');
  if (!card.hidden) { card.style.top = hudB + 'px'; hudB = card.getBoundingClientRect().bottom - c.top + 6; }
  $('planInfo').hidden = !card.hidden;
  const ctlT = Math.min(...['wheelWrap', 'midCol', 'pedals'].map(id => $(id).getBoundingClientRect().top)) - c.top - 8;   // the speed and moves can stand above the wheel on the street
  const fb = W > H ? H - 10 : ctlT;   // landscape: the wheel and pedals sit at the sides, so the car can use the full height
  $('planInfo').style.top = $('planBtns').style.top = hudB + 'px';
  const foot = $('planFoot').style;   // what the path runs into, and the scale: above the wheel and pedals (landscape: at the bottom, between their columns)
  if (W > H) { foot.left = $('midCol').getBoundingClientRect().right - c.left + 8 + 'px'; foot.right = c.right - $('pedals').getBoundingClientRect().left + 8 + 'px'; foot.bottom = '6px'; }
  else { foot.left = foot.right = ''; foot.bottom = Math.max(6, H - ctlT + 4) + 'px'; }
  bannerRoom(hudB + 4, Math.min(H - 6, ctlT - 32), H, W > H);
  PV.oyPark = clamp((hudB + 70 + fb - 30) / 2, 0, H); PV.band = Math.max(120, fb - hudB - 100); PV.foot = ctlT - 30;
  PV.top = hudB + 40; PV.oyDrive = clamp(hudB + 0.62 * (fb - hudB), 0, H);   // driving: the car low down (above the banners), the road ahead above it
  if (!PV.init) PV.oy = PV.oyPark;
  placeNums();
  return { top: hudB, bottom: ctlT, carY: PV.oy };
}

export function forgetPrediction(): void { pred = null; }
/** The numbers sit just under the wheel readout, or where it would be when the coach card has taken its place. */
function placeNums(): void {
  const pi = $('planInfo'), top = pi.hidden ? parseFloat(pi.style.top) || 0 : pi.offsetTop + pi.offsetHeight + 4;
  $('planNums').style.top = top + 'px';
}

/** Show me: a planned route drawn on the floor, and a ghost car at point `at` along it. */
export interface Guide { pts: RoutePoint[]; at: number }
let guide: Guide | null = null;
export function setGuide(g: Guide | null): void { guide = g; }
/** A lesson on the floor: the route (guided), the marks still to come (the next one where the car should really stop,
 *  which follows the car), and after a try your path over the route with the first place it drifted 30 cm. */
export interface CoachDraw { route: RoutePoint[] | null; marks: Pose[]; from: number; cur: Pose | null; track: Pt[] | null; drift: Pt | null }
let coach: CoachDraw | null = null;
export function setCoachDraw(d: CoachDraw | null): void { coach = d; }

/** Jump straight to the target view on the next frame instead of easing there (a new scene: the map zooms itself again). */
export function snapView(): void { PV.init = false; setUserZoom(null); }

/** Your own zoom, pinched or with the mouse wheel or + and -: pixels per metre, or null while the map zooms itself.
 *  A double tap (or double click, or 0) gives control back. */
let userScale: number | null = null, zoomed = false;
export function setUserZoom(s: number | null): void {
  userScale = s === null ? null : clamp(s, 0.8, 80); zoomed = true;
  $('planZoom').hidden = userScale === null;
}
function bindGestures(): void {
  const pts = new Map<number, [number, number]>();
  let pinch: { d0: number; s0: number } | null = null, down = { t: 0, x: 0, y: 0, id: -1 }, tap = { t: -1e9, x: 0, y: 0 };
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  planCv.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) pinch = { d0: Math.max(10, spread()), s0: PV.s };
    else if (pts.size === 1) down = { t: e.timeStamp, x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  planCv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pts.size >= 2) setUserZoom(pinch.s0 * spread() / pinch.d0);
  });
  const up = (e: PointerEvent) => {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size < 2) pinch = null;
    // two quick taps in the same place: the map zooms itself again
    if (e.type !== 'pointerup' || pts.size || e.pointerId !== down.id || e.timeStamp - down.t > 300 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return;
    if (e.timeStamp - tap.t < 350 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 40) { setUserZoom(null); tap.t = -1e9; }
    else tap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  };
  planCv.addEventListener('pointerup', up); planCv.addEventListener('pointercancel', up);
  planCv.addEventListener('wheel', e => { e.preventDefault(); setUserZoom((userScale ?? PV.s) * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  document.addEventListener('gesturestart', e => e.preventDefault());   // Safari's own pinch would zoom the page
  window.addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') setUserZoom((userScale ?? PV.s) * 1.25);
    else if (e.key === '-' || e.key === '_') setUserZoom((userScale ?? PV.s) / 1.25);
    else if (e.key === '0') setUserZoom(null);
  });
  $('planZoom').addEventListener('click', () => setUserZoom(null));
}
bindGestures();

/** On the street: the free spaces the car fits, the one it is parking in, and where the map stays turned in Park mode
 *  (locked to the space, so it holds still while you manoeuvre); null in a car park. */
export interface StreetDraw { slots: readonly Slot[]; target: Slot | null; lockRot: number | null }
let street: StreetDraw | null = null;
export function setStreet(d: StreetDraw | null): void { street = d; }
/** Instead of the wheel angles, what Drive mode shows at the top left (the street and its speed limit); null for the wheel. */
let driveInfo: string | null = null;
export function setDriveInfo(html: string | null): void { driveInfo = html; }
/** Whether the view was still easing towards where it should be on the last frame (keep drawing until it is there). */
let moving = false;
export const viewMoving = (): boolean => moving || zoomed;
/** The turn that puts heading th straight up the screen. */
export const upRot = (th: number): number => th - Math.PI / 2;

function follow(sim: Sim, dt: number): void {
  let tx, tz, ts, rot = 0, oy = PV.oyPark;
  const v = sim.vehicle, drive = sim.mode === 'drive', mid = v.L / 2 - v.OVR, init = PV.init;
  if (settings.planView === 'area') { const [x0, x1, z0, z1] = sim.scene.areaView; tx = (x0 + x1) / 2; tz = (z0 + z1) / 2; ts = Math.min(PV.w / (x1 - x0), PV.band / (z1 - z0)); }   // the scene's whole-area view, north up
  else {
    tx = sim.x + mid * Math.cos(sim.th); tz = sim.z - mid * Math.sin(sim.th);
    if (drive) {
      // the zoom rule: at least the distance to stop, plus the car, between the car and the top of the free band
      rot = upRot(sim.th); oy = PV.oyDrive;
      ts = Math.max(1.2, (PV.oyDrive - PV.top) / (lookAhead(Math.abs(sim.v), v.L) + v.L / 2));
    } else {
      ts = Math.min(PV.w, PV.band) / Math.max(11, 2.4 * v.L);
      if (street?.lockRot != null) rot = street.lockRot;
    }
  }
  PV.init = true;
  const ease = (tau: number) => (init ? 1 - Math.exp(-dt / tau) : 1), was = [PV.cx, PV.cz, PV.s, PV.rot, PV.oy];
  const k = ease(0.125);
  PV.cx += (tx - PV.cx) * k; PV.cz += (tz - PV.cz) * k; PV.oy += (oy - PV.oy) * ease(0.3);
  // your own zoom holds; Drive mode zooms out quickly as you speed up and back in slowly, and not at all while you wait
  // (at a junction)
  if (userScale !== null) PV.s = userScale;
  else if (drive && settings.planView !== 'area') { if (ts < PV.s) PV.s += (ts - PV.s) * ease(0.2); else if (Math.abs(sim.v) > 0.5) PV.s += (ts - PV.s) * ease(0.85); }
  else PV.s += (ts - PV.s) * k;
  PV.rot += wrapPi(rot - PV.rot) * (drive ? ease(0.18) : k);
  PV.cr = Math.cos(PV.rot); PV.sr = Math.sin(PV.rot);
  moving = Math.abs(PV.cx - was[0]) + Math.abs(PV.cz - was[1]) > 0.002 || Math.abs(PV.s - was[2]) > 0.002 * PV.s || Math.abs(PV.rot - was[3]) > 0.0005 || Math.abs(PV.oy - was[4]) > 0.2;
}
const PS = (px: number, pz: number): Pt => { const dx = px - PV.cx, dz = pz - PV.cz; return [PV.w / 2 + (dx * PV.cr - dz * PV.sr) * PV.s, PV.oy + (dx * PV.sr + dz * PV.cr) * PV.s]; };
/** The world point at screen point (sx, sy). */
const WS = (sx: number, sy: number): Pt => { const a = (sx - PV.w / 2) / PV.s, b = (sy - PV.oy) / PV.s; return [PV.cx + a * PV.cr + b * PV.sr, PV.cz - a * PV.sr + b * PV.cr]; };
const rectPts = (r: Rect): Pt[] => [[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]]];
function path(c: CanvasRenderingContext2D, pts: Pt[], close = true): void {
  c.beginPath();
  for (let i = 0; i < pts.length; i++) { const [sx, sy] = PS(pts[i][0], pts[i][1]); if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy); }
  if (close) c.closePath();
}
let hatch: CanvasPattern | null = null;
/** Buildings: dark, hatched like a printed plan (the hatching stays put on the screen), with a hairline round them. */
function hatchOf(c: CanvasRenderingContext2D): CanvasPattern | null {
  if (!hatch) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 7;
    const g = cv.getContext('2d'); if (!g) return null;
    g.strokeStyle = 'rgba(160,168,180,.22)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-1, 8); g.lineTo(8, -1); g.stroke();
    hatch = c.createPattern(cv, 'repeat');
  }
  return hatch;
}
/** The street map under everything else: pavements, the roads inside the ring, the blocks and their buildings, the car
 *  parks and their driveways, water, the kerbs, the zones painted along them and the arrows on one-way aisles. */
function drawCity(c: CanvasRenderingContext2D, L: CityLayers, s: number, inView: (x0: number, x1: number, z0: number, z1: number) => boolean, d1: number, d2: number): void {
  c.fillStyle = '#25282f'; path(c, rectPts(L.bounds)); c.fill();
  const ring = roundRect(L.ring.rect, L.ring.r, 6);
  c.fillStyle = '#1c1e24'; path(c, ring); c.fill();
  if (L.water) { c.fillStyle = '#122636'; path(c, rectPts(L.water)); c.fill(); }
  const blocks = L.blocks.map(b => roundRect(b.rect, b.r, 4));
  c.fillStyle = '#25282f'; for (const b of blocks) { path(c, b); c.fill(); }
  c.fillStyle = '#1c1e24'; for (const l of L.lots) { path(c, rectPts(l.rect)); c.fill(); }   // car parks: tarmac inside the block
  const pat = hatchOf(c);
  c.lineWidth = 1; c.strokeStyle = '#4b515b';
  for (const b of L.buildings) {
    if (!inView(Math.min(b[0][0], b[2][0]), Math.max(b[0][0], b[2][0]), Math.min(b[0][1], b[2][1]), Math.max(b[0][1], b[2][1]))) continue;
    path(c, b); c.fillStyle = '#1d2026'; c.fill(); if (pat) { c.fillStyle = pat; c.fill(); } c.stroke();
  }
  c.strokeStyle = '#8e939c'; c.lineWidth = Math.max(1, 0.15 * s); path(c, ring); c.stroke(); for (const b of blocks) { path(c, b); c.stroke(); }
  c.fillStyle = '#1c1e24'; for (const l of L.lots) { path(c, rectPts(l.gate)); c.fill(); }   // a driveway: the kerb dropped across the pavement
  // the zones along the kerbs: no parking at any time a double red line, a driveway's keep-clear white, the rest yellow
  c.globalAlpha = d1;
  if (d1 > 0) for (const z of L.zones) {
    c.lineWidth = Math.max(1, 0.08 * s);
    if (z.kind === 'none') { c.strokeStyle = '#ec5b4f'; for (const l of z.lines) { path(c, l, false); c.stroke(); } continue; }
    const drive = z.kind === 'driveway';
    c.strokeStyle = drive ? 'rgba(235,232,223,.6)' : '#f2c230'; c.setLineDash([Math.max(3, 0.5 * s), Math.max(3, 0.5 * s)]); path(c, z.pts); c.stroke(); c.setLineDash([]);
    if (d2 > 0 && !drive) { c.globalAlpha = d2; label(c, z.kind === 'bus' ? 'BUS STOP' : z.kind === 'loading' ? 'LOADING' : 'DISABLED', z.at[0], z.at[1], z.th, `700 ${clamp(0.55 * s, 9, 15).toFixed(1)}px "Barlow Condensed", sans-serif`, '#f2c230'); c.globalAlpha = d1; }
  }
  // one-way aisles: an arrow every 13 m the way they are driven
  if (d1 > 0) {
    c.fillStyle = 'rgba(235,232,223,.5)';
    for (const a of L.arrows) {
      if (!inView(a.x - 2, a.x + 2, a.z - 2, a.z + 2)) continue;
      const f = (u: number, w: number): Pt => [a.x + u * Math.cos(a.th) + w * Math.sin(a.th), a.z - u * Math.sin(a.th) + w * Math.cos(a.th)];
      path(c, [f(1.1, 0), f(0.2, -0.55), f(0.2, -0.18), f(-1.1, -0.18), f(-1.1, 0.18), f(0.2, 0.18), f(0.2, 0.55)]); c.fill();
    }
  }
  c.globalAlpha = 1;
}
/** The street names and the car parks' (zoomed out), over everything on the ground. */
function drawCityLabels(c: CanvasRenderingContext2D, L: CityLayers, s: number): void {
  if (s <= 1.2) return;
  for (const n of L.names) label(c, n.text.toUpperCase(), n.x, n.z, n.th, `600 ${clamp(0.5 * s, 10, 15).toFixed(1)}px "Barlow Condensed", sans-serif`, 'rgba(235,232,223,.7)');
  if (s < 8) for (const l of L.lots) label(c, `P · ${l.name.toUpperCase()}`, (l.rect[0] + l.rect[1]) / 2, (l.rect[2] + l.rect[3]) / 2, 0, `700 ${clamp(0.55 * s, 10, 15).toFixed(1)}px "Barlow Condensed", sans-serif`, 'rgba(143,184,255,.95)');
}
/** Text along a direction th on the map (radians, as the car's heading), turned so it never reads upside down. */
function label(c: CanvasRenderingContext2D, text: string, x: number, z: number, th: number, font: string, fill: string): void {
  let a = -th + PV.rot;   // a heading th points along (cos th, -sin th): angle -th on the map, then turned with it
  a = wrapPi(a); if (a > Math.PI / 2) a -= Math.PI; else if (a <= -Math.PI / 2) a += Math.PI;
  const [sx, sy] = PS(x, z);
  if (sx < -200 || sy < -200 || sx > PV.w + 200 || sy > PV.h + 200) return;
  c.save(); c.translate(sx, sy); c.rotate(a); c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 3; c.strokeStyle = 'rgba(13,14,18,.85)'; c.strokeText(text, 0, 0); c.fillStyle = fill; c.fillText(text, 0, 0); c.restore();
}
/** How far a detail level has faded in at s pixels per metre: none below `at`, all of it a third above. On the street,
 *  level 1 (lane lines, bays, parked cars, zones) comes in from 2.6 and level 2 (labels) from 7.8; below 2.6 the map
 *  shows only the blocks, the roads and their names. */
const fadeIn = (s: number, at: number): number => clamp((s - at) / (0.3 * at), 0, 1);
const zoneCol = (d: number): string => d < 0.3 ? '#ec5b4f' : d < 0.5 ? '#ff8a3d' : d < 1.0 ? '#f2c230' : '#5ed08a';

export function drawPlan(sim: Sim, now: number, dt: number, dpr: number): void {
  const size = fitCanvas(planCv); if (!size) return;
  const { w, h } = size, { x, z, th } = sim, v = sim.vehicle, sc = sim.scene;
  PV.w = w; PV.h = h; follow(sim, dt); zoomed = false;
  { const mid = v.L / 2 - v.OVR; bannerCar(PS(x + mid * Math.cos(th), z - mid * Math.sin(th))[1], (v.L / 2 + 0.4) * PV.s); }   // keep messages off the car
  const c = ctx, s = PV.s; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.lineJoin = 'round';
  c.fillStyle = '#0d0e12'; c.fillRect(0, 0, w, h);
  // what is on the screen, in the world: the corners of the screen turned back into the map
  const corners = [WS(0, 0), WS(w, 0), WS(0, h), WS(w, h)];
  const vx0 = Math.min(...corners.map(q => q[0])) - 1, vx1 = Math.max(...corners.map(q => q[0])) + 1, vz0 = Math.min(...corners.map(q => q[1])) - 1, vz1 = Math.max(...corners.map(q => q[1])) + 1;
  const inView = (x0: number, x1: number, z0: number, z1: number) => !(x1 < vx0 || x0 > vx1 || z1 < vz0 || z0 > vz1);
  const city = sc.city, drive = sim.mode === 'drive', fast = drive && Math.abs(sim.v) > PDC_MAX;
  const d1 = city ? fadeIn(s, 2.6) : 1, d2 = city ? fadeIn(s, 7.8) : 1;   // detail levels: only a street map is ever zoomed out that far
  if (city) drawCity(c, city, s, inView, d1, d2);
  else {
    // floors, the lower level over the low wall, pavements with their kerbs
    c.fillStyle = '#1c1e24'; for (const f of sc.floors) { path(c, rectPts(f)); c.fill(); }
    if (sc.pit) { c.fillStyle = '#121317'; path(c, rectPts(sc.pit)); c.fill(); }
    for (const o of sim.obstacles) if (o.cls === 'kerb' && o.kind === 'poly') {
      c.fillStyle = '#2a2d34'; path(c, o.pts); c.fill();
      c.strokeStyle = '#8e939c'; c.lineWidth = Math.max(1.5, 0.15 * s); c.lineCap = 'butt'; path(c, o.pts.slice(0, 2), false); c.stroke();
    }
  }
  // the target space; on the street, the free spaces this car fits (close enough to read)
  if (street && d1 > 0) {
    c.globalAlpha = d1; c.lineWidth = 1; c.setLineDash([4, 4]); c.strokeStyle = 'rgba(94,208,138,.55)';
    for (const sl of street.slots) {
      if (sl === street.target || sl.parkable === false || sim.traffic?.taken(sl.id)) continue;   // a car parked in it for now
      const q = bayRect(sl.bay, [sl.bay.x0 + 0.08, sl.bay.x1 - 0.08, sl.bay.z0 + 0.05, sl.bay.z1 - 0.05]), xs = q.map(p => p[0]), zs = q.map(p => p[1]);
      if (inView(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs))) { path(c, q); c.stroke(); }
    }
    c.setLineDash([]); c.globalAlpha = 1;
  }
  const B = sc.bays[sim.options.bay] ?? sc.bays[sc.defaultBay];
  if (B) {
    c.fillStyle = 'rgba(94,208,138,.11)'; path(c, bayRect(B, [B.x0, B.x1, B.z0, B.z1])); c.fill();
    if (B.kind === 'kerb') { c.strokeStyle = 'rgba(94,208,138,.6)'; c.lineWidth = 1; c.setLineDash([4, 4]); path(c, bayRect(B, [B.x0 + 0.08, B.x1 - 0.08, B.z0 + 0.05, B.z1 - 0.05])); c.stroke(); c.setLineDash([]); }
  }
  // lane markings: dashed white (detail level 1)
  c.globalAlpha = d1;
  if (sc.dashes.length && d1 > 0) {
    c.strokeStyle = 'rgba(235,232,223,.55)'; c.lineWidth = Math.max(1, 0.1 * s); c.setLineDash([3 * s, 3 * s]); c.beginPath();
    for (const [x0, z0, x1, z1] of sc.dashes) { const a = PS(x0, z0), b = PS(x1, z1); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
    c.stroke(); c.setLineDash([]);
  }
  if (sim.traffic) drawJunctionLines(c, sim.traffic, s, d1);
  // painted lines (bays, detail level 1), numbers, the drain cover
  if (d1 > 0) {
    c.strokeStyle = '#d9ab2b'; c.lineWidth = Math.max(1, 0.1 * s); c.lineCap = 'butt'; c.beginPath();
    for (const [x0, z0, x1, z1] of sc.lines) { if (!inView(Math.min(x0, x1), Math.max(x0, x1), Math.min(z0, z1), Math.max(z0, z1))) continue; const a = PS(x0, z0), b = PS(x1, z1); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
    c.stroke();
  }
  c.globalAlpha = 1;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `700 ${Math.max(9, 0.42 * s).toFixed(1)}px "Barlow Condensed", sans-serif`; c.fillStyle = 'rgba(214,74,58,.9)';
  for (const [t, mx, mz] of sc.marks.text) { const [sx, sy] = PS(mx, mz); c.fillText(t, sx, sy); }
  if (sc.marks.manhole) { c.fillStyle = '#2c2f35'; path(c, rectPts(sc.marks.manhole)); c.fill(); }
  // what is solid: walls and pillars light, low things amber, parked cars dark with their names
  c.lineWidth = 1;
  const carLabels = d2 * fadeIn(s, 15);   // a parked car's name needs room to be read
  for (const o of sim.obstacles) {
    if (o.cls === 'kerb' || !inView(o.bx0, o.bx1, o.bz0, o.bz1) || (city && o.name === 'building')) continue;
    if (o.cls === 'car' && o.kind === 'poly') {   // detail level 1 on the street
      if (d1 <= 0) continue;
      c.globalAlpha = d1; c.fillStyle = '#353a43'; c.strokeStyle = '#5b636e'; path(c, o.pts); c.fill(); c.stroke();
      if (carLabels > 0 && o.label) { const [sx, sy] = PS(o.cx, o.cz); c.globalAlpha = carLabels; c.fillStyle = '#a7afb9'; c.font = `600 ${clamp(0.3 * s, 9, 13).toFixed(1)}px "Barlow Condensed", sans-serif`; c.fillText(o.label, sx, sy); }
      c.globalAlpha = 1;
      continue;
    }
    if (city && o.kind === 'circle' && d1 <= 0) continue;   // lamp posts come in with detail level 1
    const low = o.cls === 'low';
    c.fillStyle = o.fill || (low ? '#b9832a' : o.cls === 'lowwall' ? '#8e9498' : '#c9ccc8'); c.strokeStyle = o.fill ? '#ebe8df' : low ? '#f2c230' : '#6d747a';
    if (o.kind === 'circle') { const [sx, sy] = PS(o.x, o.z); c.beginPath(); c.arc(sx, sy, o.r * s, 0, 6.3); c.fill(); c.stroke(); }
    else { path(c, o.pts); c.fill(); c.stroke(); }
  }
  if (city) drawCityLabels(c, city, s);
  if (sim.traffic) { drawTraffic(c, sim.traffic, s, inView, d1, d2); drawLights(c, sim.traffic, s); }
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
  // (not above 10 km/h in Drive mode: a few metres of path mean nothing at speed)
  const dir: 1 | -1 = sim.input.rev ? -1 : sim.input.fwd ? 1 : sim.lastMoveDir;
  const key = `${x.toFixed(3)},${z.toFixed(3)},${th.toFixed(4)},${sim.wheelAngle.toFixed(1)},${dir}`;
  if (!pred || (!fast && (pred.dir !== dir || (key !== predKey && now - predT > 0.05)))) { pred = sim.predict(dir); predKey = key; predT = now; }
  const p = pred, showPath = settings.layerPath !== 'off' && !fast;
  c.lineCap = 'round';
  if (settings.layerSwept === 'on' && !fast) {   // learning layer: the swept path of all four corners
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(214,160,255,.75)';
    for (const tr of [p.tracks.fl, p.tracks.fr, p.tracks.rl, p.tracks.rr]) { path(c, tr, false); c.stroke(); }
  }
  if (showPath) {
    c.strokeStyle = 'rgba(242,194,48,.26)'; c.lineWidth = 1;
    for (const g of p.ghosts) { path(c, footprint(g[0], g[1], g[2], v.body)); c.stroke(); }
    c.setLineDash([4, 4]); c.strokeStyle = 'rgba(143,184,255,.7)'; path(c, p.tracks.rearAxle, false); c.stroke(); c.setLineDash([]);
    c.lineWidth = 2; c.strokeStyle = p.hit ? '#ff6b5a' : '#f2c230';
    for (const tr of p.dir > 0 ? [p.tracks.fl, p.tracks.fr] : [p.tracks.rl, p.tracks.rr]) { path(c, tr, false); c.stroke(); }
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(94,208,216,.9)'; path(c, p.tracks.swing, false); c.stroke();
    if (p.hit) { c.strokeStyle = '#ff4f4f'; c.lineWidth = 2; c.setLineDash([5, 3]); path(c, footprint(p.end[0], p.end[1], p.end[2], v.body)); c.stroke(); c.setLineDash([]); }
  }
  // turning centre, the lines from it to the wheels (Ackermann) and the circle the outer front corner sweeps
  const dl = -sim.steerDeg * DEG, [fl, fr] = ackermann(v, dl), [rl, rr] = rearAngles(v, dl);
  const wl = footprint(x, z, th, [[v.WB, -v.TRACK / 2], [v.WB, v.TRACK / 2], [v.RA, -v.TRACK / 2], [v.RA, v.TRACK / 2]]);
  if (Math.abs(dl) > 0.004 && settings.layerPivot !== 'off' && !fast) {   // learning layer: the pivot and the turning circles
    const Rc = v.WB / Math.tan(dl);
    if (Math.abs(Rc) < 30) {
      const fc = v.planCorners[1], icr = footprint(x, z, th, [[0, -Rc]])[0], [ix, iy] = PS(icr[0], icr[1]), oc = footprint(x, z, th, [[fc[0], Rc > 0 ? fc[1] : -fc[1]]])[0];
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(200,215,225,.5)'; c.lineWidth = 1;
      for (const wp of wl) { const [sx, sy] = PS(wp[0], wp[1]); c.beginPath(); c.moveTo(ix, iy); c.lineTo(sx, sy); c.stroke(); }
      c.strokeStyle = 'rgba(255,138,61,.38)'; c.beginPath(); c.arc(ix, iy, Math.hypot(oc[0] - icr[0], oc[1] - icr[1]) * s, 0, 6.3); c.stroke();
      c.strokeStyle = 'rgba(94,208,216,.35)'; c.beginPath(); c.arc(ix, iy, Math.hypot(Math.abs(Rc) - v.TRACK / 2, v.RA) * s, 0, 6.3); c.stroke(); c.setLineDash([]);   // the inner rear wheel's circle
      c.fillStyle = '#ebe8df'; c.beginPath(); c.arc(ix, iy, 3, 0, 6.3); c.fill();
    }
  }
  // parking-sensor zones
  if (settings.pdc === 'on') {
    const Z: Record<string, Pt[]> = {
      front: [[v.WB + v.OVF + 0.16, -(v.W / 2 - 0.215)], [v.WB + v.OVF + 0.16, v.W / 2 - 0.215]], rear: [[-v.OVR - 0.16, -(v.W / 2 - 0.215)], [-v.OVR - 0.16, v.W / 2 - 0.215]],
      left: [[v.RA + 0.2, -v.W / 2 - 0.2], [v.WB - 0.02, -v.W / 2 - 0.2]], right: [[v.RA + 0.2, v.W / 2 + 0.2], [v.WB - 0.02, v.W / 2 + 0.2]],
    };
    c.lineCap = 'round';
    for (const k of SIDES) { const d = sim.pdc[k]; if (!(d < rangeOf(v, k) - 1e-6)) continue; c.strokeStyle = zoneCol(d); c.lineWidth = Math.max(3, 0.12 * s); path(c, footprint(x, z, th, Z[k]), false); c.stroke(); }
  }
  // the car: body, mirrors, glass, the nose mark, wheels (the fronts at their Ackermann angles)
  c.fillStyle = 'rgba(16,18,22,.95)'; c.strokeStyle = '#ebe8df'; c.lineWidth = 1.5; path(c, footprint(x, z, th, v.body)); c.fill(); c.stroke();
  c.fillStyle = '#8e939c'; for (const m of v.mirrors) { path(c, footprint(x, z, th, m)); c.fill(); }
  const [gx, gr] = v.glass, gw = v.W / 2 - 0.195, nose = v.WB + v.OVF - 0.143;   // glass and the nose mark, scaled to this car
  c.fillStyle = 'rgba(70,92,116,.5)'; path(c, footprint(x, z, th, [[gx, -gw], [gx, gw], [gr, gw - 0.04], [gr, -gw + 0.04]])); c.fill();
  c.fillStyle = '#f2c230'; path(c, footprint(x, z, th, [[nose, 0], [nose - 0.4, -0.27], [nose - 0.4, 0.27]])); c.fill();
  if ((sim.ind || sim.hazard) && blinkOn(sim.time)) {   // your indicators (both sides: hazards), at the corners
    c.fillStyle = '#ffb020';
    for (const sg of sim.hazard ? [-1, 1] : [sim.ind]) for (const [x0, x1] of [[-v.OVR, -v.OVR + 0.22], [v.WB + v.OVF - 0.24, v.WB + v.OVF - 0.02]]) {
      path(c, footprint(x, z, th, [[x0, sg * (v.W / 2 - 0.24)], [x1, sg * (v.W / 2 - 0.24)], [x1, sg * (v.W / 2 - 0.02)], [x0, sg * (v.W / 2 - 0.02)]])); c.fill();
    }
  }
  const WRECT: Pt[] = [[-v.WR, -v.WW / 2], [v.WR, -v.WW / 2], [v.WR, v.WW / 2], [-v.WR, v.WW / 2]];
  ([[wl[0], fl], [wl[1], fr], [wl[2], rl], [wl[3], rr]] as [Pt, number][]).forEach(([q, a]) => {
    c.fillStyle = Math.abs(a) > 0.01 ? '#f2c230' : '#ebe8df'; path(c, footprint(q[0], q[1], th + a, WRECT)); c.fill();
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
  // readouts: wheel angles and turning radius (or the street in Drive mode); what the path runs into; the scale bar
  const Rout = Math.abs(dl) > 0.004 ? Math.hypot(Math.abs(v.WB / Math.tan(dl)) + v.TRACK / 2, v.WB) : Infinity;   // the steering wheel's own turns are on its hub
  const info = drive && driveInfo !== null ? driveInfo + streetInfo(sim) : `<div><span>Wheels</span>L ${(fl / DEG).toFixed(1)}° · R ${(fr / DEG).toFixed(1)}°</div><div><span>Turn radius</span>${Rout < 60 ? Rout.toFixed(2) + ' m' : 'straight'}</div>`;
  if (info !== infoTxt) { infoTxt = info; $('planInfo').innerHTML = info; placeNums(); }
  const what = p.dir > 0 ? 'Forward' : 'Reversing';
  const ptxt = !showPath || drive ? '' : p.hit ? `${what}: ${p.part ? p.part + ' ' : ''}hits ${p.hit.name} in ${p.dist.toFixed(1)} m` : `${what}: clear for ${p.dist.toFixed(1)} m`;
  if (ptxt !== predTxt) { predTxt = ptxt; const el = $('planPred'); el.textContent = ptxt; el.className = p.hit && p.dist < 1 ? 'bad' : ''; }
  const sw = Math.round(s); if (sw !== scaleW) { scaleW = sw; $('planScale').innerHTML = `<i style="width:${sw}px"></i>1 m`; }
  // learning layers: the kerb close-up, and the numbers (angle to the space, gaps)
  const kw = nearestKerbWheel(sim);
  if (settings.layerKerb !== 'off' && kw && kw.gap < 1.0) drawKerbCloseUp(c, kw);
  const nums = settings.layerNums === 'off' ? '' : numbersHtml(sim, kw);
  if (nums !== numsTxt) { numsTxt = nums; const el = $('planNums'); el.innerHTML = nums; el.hidden = !nums; }
}

/** Lights and indicators flash: on for 0.45 s of every 0.8 s. */
const blinkOn = (t: number): boolean => t % 0.8 < 0.45;
const LIGHT_COL = { green: '#5ed08a', amber: '#f2c230', red: '#ec5b4f' } as const;
/** On the street, detail level 1: the stop lines at the lights (solid) and the give-way lines across the side roads (dashed). */
function drawJunctionLines(c: CanvasRenderingContext2D, t: Traffic, s: number, d1: number): void {
  if (d1 <= 0) return;
  c.globalAlpha = d1; c.lineCap = 'butt'; c.strokeStyle = 'rgba(235,232,223,.85)';
  for (const J of t.net.junctions) for (const ap of J.approaches) {
    if (J.control === 'giveway' && !ap.minor) continue;
    const lights = J.control === 'lights';
    c.lineWidth = Math.max(1.5, (lights ? 0.3 : 0.15) * s); c.setLineDash(lights ? [] : [0.6 * s, 0.4 * s]);
    path(c, ap.line, false); c.stroke();
    if (!lights) {   // and a triangle in the lane before the line, pointing at you
      const [a, b] = ap.line, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, ux = Math.cos(ap.th), uz = -Math.sin(ap.th), w = 0.6;
      c.lineWidth = Math.max(1, 0.1 * s); c.setLineDash([]);
      path(c, [[mx - ux * 1.2 - uz * w, mz - uz * 1.2 + ux * w], [mx - ux * 1.2 + uz * w, mz - uz * 1.2 - ux * w], [mx - ux * 3.2, mz - uz * 3.2]]); c.stroke();
    }
  }
  c.setLineDash([]); c.globalAlpha = 1;
}
/** The traffic lights: a lamp by each stop line in the colour it shows, readable zoomed right out. */
function drawLights(c: CanvasRenderingContext2D, t: Traffic, s: number): void {
  const r = Math.max(3.5, 0.45 * s);
  for (const J of t.net.junctions) {
    if (J.control !== 'lights') continue;
    for (const ap of J.approaches) {
      const [sx, sy] = PS(ap.head[0], ap.head[1]);
      if (sx < -20 || sy < -20 || sx > PV.w + 20 || sy > PV.h + 20) continue;
      c.beginPath(); c.arc(sx, sy, r + 1.5, 0, 6.3); c.fillStyle = '#0d0e12'; c.fill();
      c.beginPath(); c.arc(sx, sy, r, 0, 6.3); c.fillStyle = LIGHT_COL[t.lightFor(ap)]; c.fill();
    }
  }
}
/** The other cars: lighter than the parked ones, a windscreen to show which way they face, brake lights, indicators and
 *  hazard lights, a horn's sound drawn ahead of one that honks, and zoomed in close, the driver and the speed. A car parked
 *  at the kerb (one that will pull out, or a thief that took a space) looks like the parked cars (detail level 1). */
function drawTraffic(c: CanvasRenderingContext2D, t: Traffic, s: number, inView: (x0: number, x1: number, z0: number, z1: number) => boolean, d1: number, d2: number): void {
  const lit = blinkOn(t.t), labels = d2 * fadeIn(s, 15);
  c.lineWidth = 1;
  for (const car of t.cars) {
    if (!inView(car.x - 6, car.x + 6, car.z - 6, car.z + 6)) continue;
    const ty = TYPES[car.type], nose = ty.L - ty.OVR, hw = ty.W / 2, P = (pts: Pt[]) => footprint(car.x, car.z, car.h, pts), parked = car.state === 'parked';
    if (parked) {
      if (d1 <= 0) continue;
      c.globalAlpha = d1; c.fillStyle = '#353a43'; c.strokeStyle = '#5b636e'; path(c, car.box); c.fill(); c.stroke(); c.globalAlpha = 1;
    } else {
      c.fillStyle = '#5a6574'; c.strokeStyle = '#b4bcc6'; path(c, car.box); c.fill(); c.stroke();
      c.fillStyle = 'rgba(24,28,36,.8)'; path(c, P([[nose - 0.9, -hw + 0.16], [nose - 1.4, -hw + 0.2], [nose - 1.4, hw - 0.2], [nose - 0.9, hw - 0.16]])); c.fill();
      if (car.acc < -0.6 || (car.v < 0.05 && car.wait)) {
        c.fillStyle = '#ff3b30';
        for (const sg of [-1, 1]) { path(c, P([[-ty.OVR, sg * (hw - 0.06)], [-ty.OVR + 0.18, sg * (hw - 0.06)], [-ty.OVR + 0.18, sg * (hw - 0.42)], [-ty.OVR, sg * (hw - 0.42)]])); c.fill(); }
      }
    }
    const sides = car.haz ? [-1, 1] : car.ind ? [car.ind] : [];
    if (sides.length && lit) {
      c.fillStyle = '#ffb020';
      for (const sg of sides) for (const x0 of [-ty.OVR, nose - 0.22]) { path(c, P([[x0, sg * (hw - 0.24)], [x0 + 0.22, sg * (hw - 0.24)], [x0 + 0.22, sg * hw], [x0, sg * hw]])); c.fill(); }
    }
    if (car.honk >= 0 && t.t - car.honk < 0.6) {   // the horn: two arcs ahead of its nose
      const [sx, sy] = PS(car.x + (nose + 0.3) * Math.cos(car.h), car.z - (nose + 0.3) * Math.sin(car.h)), a = PV.rot - car.h;   // its heading on the screen (the map turns)
      c.strokeStyle = '#ffd166'; c.lineWidth = 2;
      for (const r of [Math.max(5, 0.5 * s), Math.max(9, 0.9 * s)]) { c.beginPath(); c.arc(sx, sy, r, a - 0.7, a + 0.7); c.stroke(); }
      c.lineWidth = 1;
    }
    if (labels > 0 && !parked) {
      const [sx, sy] = PS(car.x + (nose / 2) * Math.cos(car.h), car.z - (nose / 2) * Math.sin(car.h));
      c.globalAlpha = labels; c.font = `600 ${clamp(0.3 * s, 9, 13).toFixed(1)}px "Barlow Condensed", sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#ebe8df'; c.fillText(`${DRIVERS[car.drv].name}${car.imp ? ', impatient' : ''} · ${Math.round(car.v * 3.6)}`, sx, sy); c.globalAlpha = 1;
    }
  }
}
/** On the street, under the street's name: the next traffic light on your way (in your lane, 80 m at most) with how
 *  far its stop line is, the faults on this drive so far, and how long you have held up traffic. */
function streetInfo(sim: Sim): string {
  const t = sim.traffic;
  if (!t) return '';
  const v = sim.vehicle, ux = Math.cos(sim.th), uz = -Math.sin(sim.th), fx = sim.x + (v.L - v.OVR) * ux, fz = sim.z + (v.L - v.OVR) * uz;
  let best: { d: number; light: keyof typeof LIGHT_COL } | null = null;
  for (const J of t.net.junctions) {
    if (J.control !== 'lights') continue;
    for (const ap of J.approaches) {
      const ax = Math.cos(ap.th), az = -Math.sin(ap.th), [a, b] = ap.line;
      if (ux * ax + uz * az < 0.7) continue;
      const d = -((fx - a[0]) * ax + (fz - a[1]) * az), wx = b[0] - a[0], wz = b[1] - a[1], q = ((fx - a[0]) * wx + (fz - a[1]) * wz) / (wx * wx + wz * wz);
      if (d < 0 || d > 80 || q < -0.3 || q > 1.3) continue;
      if (!best || d < best.d) best = { d, light: t.lightFor(ap) };
    }
  }
  const n = sim.rules?.faults.length ?? 0, held = Math.round(sim.rules?.heldUp ?? 0);
  return (best ? `<div><span>Lights</span><i class="lt ${best.light}"></i>${Math.round(best.d)} m</div>` : '') + (n ? `<div><span>Faults</span><b class="bad">${n}</b></div>` : '')
    + (held ? `<div><span>Held up</span>${held} s</div>` : '');
}

type KerbWheel = { gap: number; wheel: Pt[]; nx: number; nz: number; c: number };
/** The wheel nearest a kerb, and its gap to it (m, from the tyre's outside edge). */
function nearestKerbWheel(sim: Sim): KerbWheel | null {
  let best: KerbWheel | null = null;
  for (const k of sim.scene.kerbs) for (const w of wheelsOf(sim.vehicle)) {
    const pts = footprint(sim.x, sim.z, sim.th, w.pts), gap = Math.min(...pts.map(q => (besideKerb(k, q[0], q[1]) ? k.c - (k.nx * q[0] + k.nz * q[1]) : Infinity)));
    if (!best || gap < best.gap) best = { gap, wheel: pts, nx: k.nx, nz: k.nz, c: k.c };
  }
  return best;
}
/** A box at the bottom left: the wheel nearest the kerb seen close up, with the kerb below it, like a mirror tilted down. */
function drawKerbCloseUp(c: CanvasRenderingContext2D, kw: KerbWheel): void {
  const W = 132, H = 84, x0 = 8, y0 = Math.max(80, PV.foot - H - 6), sc = 140;
  const cx = kw.wheel.reduce((a, q) => a + q[0], 0) / 4, cz = kw.wheel.reduce((a, q) => a + q[1], 0) / 4;
  // inset axes: along the kerb to the right, towards the kerb downwards
  const ax = -kw.nz, az = kw.nx, map = (q: Pt): Pt => [x0 + W / 2 + ((q[0] - cx) * ax + (q[1] - cz) * az) * sc, y0 + H * 0.38 + ((q[0] - cx) * kw.nx + (q[1] - cz) * kw.nz) * sc];
  c.save();
  c.fillStyle = 'rgba(12,13,17,.92)'; c.strokeStyle = 'rgba(235,232,223,.35)'; c.lineWidth = 1;
  c.beginPath(); c.roundRect(x0, y0, W, H, 8); c.fill(); c.stroke(); c.clip();
  // the kerb: its edge line and the pavement beyond it
  const k0 = cx + kw.nx * (kw.c - (kw.nx * cx + kw.nz * cz)), k1 = cz + kw.nz * (kw.c - (kw.nx * cx + kw.nz * cz));
  const e0 = map([k0 - ax * 2, k1 - az * 2]), e1 = map([k0 + ax * 2, k1 + az * 2]);
  c.fillStyle = '#2a2d34'; c.fillRect(x0, e0[1], W, H); c.strokeStyle = '#8e939c'; c.lineWidth = 3; c.beginPath(); c.moveTo(e0[0], e0[1]); c.lineTo(e1[0], e1[1]); c.stroke();
  // the car's side and the wheel
  c.fillStyle = '#ebe8df'; c.beginPath(); kw.wheel.map(map).forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.closePath(); c.fill();
  c.fillStyle = kw.gap < 0.1 ? '#ec5b4f' : kw.gap < 0.3 ? '#5ed08a' : '#f2c230'; c.font = '600 13px "Barlow Condensed", sans-serif'; c.textAlign = 'left'; c.textBaseline = 'top';
  c.fillText(`Kerb ${Math.max(0, Math.round(kw.gap * 100))} cm`, x0 + 7, y0 + 5);
  c.restore();
}
/** The numbers layer: the car's angle to the space, the gap to a kerb, and the gaps either side. */
function numbersHtml(sim: Sim, kw: KerbWheel | null): string {
  const b = sim.scene.bays[sim.options.bay] ?? sim.scene.bays[sim.scene.defaultBay], out: string[] = [];
  const a = (h: number) => Math.abs(wrapPi(sim.th - h - (b?.frame?.rot ?? 0))) / DEG;   // a turned bay's headings are in its own frame
  if (b) {   // on the street there is no space to aim for until Park mode picks one
    const ang = b.face === 'in' ? a(b.inHeading) : b.face === 'out' ? a(b.inHeading + Math.PI) : Math.min(a(b.inHeading), a(b.inHeading + Math.PI));
    out.push(`<span>${b.kind === 'kerb' || b.kind === 'exit' ? 'To kerb' : 'To bay'}</span><b>${ang.toFixed(0)}°</b>`);
  }
  if (kw && kw.gap < 2) out.push(`<span>Kerb</span><b>${Math.max(0, Math.round(kw.gap * 100))} cm</b>`);
  for (const [k, label] of [['left', 'Left'], ['right', 'Right']] as const) if (sim.gaps[k] < 3) out.push(`<span>${label}</span><b>${sim.gaps[k] < 1 ? Math.round(sim.gaps[k] * 100) + ' cm' : sim.gaps[k].toFixed(2) + ' m'}</b>`);
  return out.join('');
}

