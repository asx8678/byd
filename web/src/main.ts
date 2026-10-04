// Atto 2 Garage Trainer: wires the simulation (core/) to the screen (ui/) and runs the frame loop.
import './style.css';
import { LAYOUT_V } from './core/garage';
import { clamp } from './core/math';
import { Sim } from './core/sim';
import { beep, updateBeeper } from './ui/audio';
import { bindControls } from './ui/controls';
import { $, MAX_DPR, screen } from './ui/dom';
import { parkedCard, touchTitle } from './ui/format';
import { showBanner, updateHud } from './ui/hud';
import { updatePdcDisplay, layoutPdc } from './ui/pdcDisplay';
import { drawPlan, forgetPrediction, layoutPlan, snapView } from './ui/plan';
import { lockDeg, settings } from './ui/settings';

if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) { this.rect(x, y, w, h); };

const sim = new Sim(), stage = $('app');
const applySettings = () => { sim.options.lockDeg = lockDeg(); sim.options.selfCentre = settings.center === 'on'; sim.options.bay = settings.bay; sim.wheelAngle = clamp(sim.wheelAngle, -sim.options.lockDeg, sim.options.lockDeg); };

function resetCar(): void {
  applySettings(); sim.reset(settings.start); forgetPrediction();
  $('btnFwd').classList.remove('on'); $('btnRev').classList.remove('on');
  const from = settings.start === 'right' ? 'Coming from the right, between the pillars.' : settings.start === 'across' ? 'Starting across the aisle, angled at the bays.' : 'Coming from the left, as you usually do.';
  showBanner('', `Park in bay ${settings.bay}`, from + (settings.bay === '561' ? ' Mind pillar 560 and the bench; the plan shows where each move ends.' : ' Pillar 560 runs along its left side.'), null, 8000);
}

bindControls(sim, {
  reset: resetCar,
  settingChanged: key => { if (key === 'start' || key === 'bay') resetCar(); else applySettings(); },
});

function layout(): void { layoutPdc(layoutPlan(stage)); }
function resize(): void { screen.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR); layout(); snapView(); }
window.addEventListener('resize', resize); window.addEventListener('orientationchange', () => setTimeout(resize, 200));

// frame loop: 30 fps is plenty at parking speeds, and nothing is redrawn while nothing changes
let last = 0, lastSig = '', lastDrawT = 0, wakeUntil = 0;
const wake = () => { wakeUntil = performance.now() + 1500; };   // keep drawing for a moment after any touch, so panels settle
(['pointerdown', 'pointerup', 'keydown', 'resize'] as const).forEach(ev => window.addEventListener(ev, wake, { passive: true }));
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (now - last < 31) return;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const e of sim.step(dt)) {
    if (e.type === 'touch') {
      $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 60); beep(160, 0.2, 0.15);
      showBanner('bad', touchTitle(e.name, e.part), 'Stop, straighten up and back away. Touches: ' + e.hits, null, 2200);
    } else {
      const c = parkedCard(e.result); showBanner('good', c.title, c.text, c.stats);
      beep(880, 0.12, 0.08); setTimeout(() => beep(1320, 0.18, 0.08), 140);
    }
  }
  updateBeeper(sim, now / 1000); updatePdcDisplay(sim, now / 1000, screen.dpr);
  const sig = [sim.x.toFixed(4), sim.z.toFixed(4), sim.th.toFixed(5), sim.wheelAngle.toFixed(1), sim.v.toFixed(3), sim.input.fwd, sim.input.rev, settings.planView].join('|');
  if (sig === lastSig && now > wakeUntil && now - lastDrawT < 1000) return;
  lastSig = sig; lastDrawT = now;
  updateHud(sim); drawPlan(sim, now / 1000, dt, screen.dpr);
}

// boot, keeping the car where it was across a hot reload in the artifact viewer
type Saved = { x?: number; z?: number; th?: number; wheelAngle?: number; hits?: number; elapsed?: number; layout?: number };
type Hot = { snapshot?: (f: () => Saved) => void; ready?: (f: (saved: Saved) => void) => void; data?: Saved };
const hot = (window as unknown as { claude?: { hot?: Hot } }).claude?.hot;
function start(saved: Saved = {}): void {
  resetCar();
  if (typeof saved.x === 'number' && typeof saved.z === 'number' && typeof saved.th === 'number' && saved.layout === LAYOUT_V && !sim.touching(saved.x, saved.z, saved.th)) {
    sim.place(saved.x, saved.z, saved.th); sim.wheelAngle = saved.wheelAngle || 0; sim.hits = saved.hits || 0; sim.elapsed = saved.elapsed || 0;
  }
  resize(); setTimeout(layout, 300); setTimeout(layout, 1500);
  requestAnimationFrame(t => { last = t; frame(t); });
}
try { hot?.snapshot?.(() => ({ x: sim.x, z: sim.z, th: sim.th, wheelAngle: sim.wheelAngle, hits: sim.hits, elapsed: sim.elapsed, layout: LAYOUT_V })); } catch { /* not in the viewer */ }
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});

// offline and installable when served as a web app (not inside the artifact viewer)
if (import.meta.env.MODE !== 'artifact' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* no offline mode */ }); });
}
