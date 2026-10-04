// Atto 2 Garage Trainer: wires the simulation (core/) to the screen (ui/) and runs the frame loop.
import './style.css';
import { clamp } from './core/math';
import { moves, planToBay, sample } from './core/planner';
import { Recorder, STEP, playback } from './core/replay';
import { Sim, type SimEvent } from './core/sim';
import { beep, updateBeeper } from './ui/audio';
import { bindControls } from './ui/controls';
import { $, MAX_DPR, screen } from './ui/dom';
import { parkedCard, touchTitle } from './ui/format';
import { showBanner, updateHud } from './ui/hud';
import { updatePdcDisplay, layoutPdc } from './ui/pdcDisplay';
import { drawPlan, forgetPrediction, layoutPlan, setGuide, snapView, type Guide } from './ui/plan';
import { lockDeg, settings } from './ui/settings';

if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) { this.rect(x, y, w, h); };

const sim = new Sim(), stage = $('app');
// every attempt is recorded from its start, so it can be replayed; the replay runs on a second simulation
const recorder = new Recorder();
let replay: ReturnType<typeof playback> | null = null;
const btnReplay = $('btnReplay'), btnShow = $('btnShow');
// Show me: the planner's route from where the car is into the bay, driven by a ghost
let guide: (Guide & { times: number[]; t0: number }) | null = null;
const applySettings = () => { sim.options.lockDeg = lockDeg(); sim.options.selfCentre = settings.center === 'on'; sim.options.bay = settings.bay; sim.wheelAngle = clamp(sim.wheelAngle, -sim.options.lockDeg, sim.options.lockDeg); };

function resetCar(): void {
  stopReplay(); hideGuide(); applySettings(); sim.reset(settings.start); forgetPrediction(); recorder.begin(sim);
  $('btnFwd').classList.remove('on'); $('btnRev').classList.remove('on');
  const from = (sim.scene.starts[settings.start] ?? sim.scene.starts[sim.scene.defaultStart]).label;
  showBanner('', `Park in bay ${settings.bay}`, from + (settings.bay === '561' ? ' Mind pillar 560 and the bench; the plan shows where each move ends.' : ' Pillar 560 runs along its left side.'), null, 8000);
}

bindControls(sim, {
  reset: resetCar,
  settingChanged: key => { if (key === 'start' || key === 'bay') resetCar(); else { applySettings(); if (!replay) recorder.begin(sim); } },
});

function hideGuide(): void { guide = null; setGuide(null); btnShow.textContent = 'Show me'; btnShow.classList.remove('on'); }
function showMe(now: number): void {
  if (replay) return;
  const from = { x: sim.x, z: sim.z, th: sim.th }, plan = planToBay(sim.vehicle, sim.scene, from, settings.bay);
  if (plan.status !== 'found') {
    showBanner('bad', 'No route from here', plan.status === 'none' ? `Bay ${settings.bay} has no free space for the car.` : 'Back out into the aisle a little and try again.', null, 3500);
    return;
  }
  const pts = sample(sim.vehicle, plan.pieces, 0.05), times: number[] = [];
  let t = 0; pts.forEach((p, i) => { if (i) { t += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) / 1.4; if (p.dir !== pts[i - 1].dir) t += 0.6; } times.push(t); });
  guide = { pts, at: 0, times, t0: now }; setGuide(guide);
  btnShow.textContent = 'Hide'; btnShow.classList.add('on');
  const n = moves(plan.pieces), runs: string[] = [];
  plan.pieces.forEach((p, i) => { if (i === 0 || p.dir !== plan.pieces[i - 1].dir) runs.push(p.dir > 0 ? 'forward' : 'reverse'); });
  const said = runs.map((r, i) => (i ? r : r[0].toUpperCase() + r.slice(1))).join(', then ');
  showBanner('', `Show me: ${n} ${n === 1 ? 'move' : 'moves'}`, `${said}. Watch the ghost, then follow the line yourself. Yellow is forward, dashed blue is reverse.`, null, 6000);
}
btnShow.addEventListener('click', () => { if (guide) hideGuide(); else showMe(performance.now()); });

function startReplay(): void {
  const rec = recorder.rec;
  if (!rec || rec.steps < 30) { showBanner('', 'Nothing to replay yet', 'Drive a little first. Replay shows this attempt from its start, exactly as you drove it.', null, 3500); return; }
  hideGuide(); replay = playback({ ...rec, events: rec.events.slice() }, sim.scene, sim.vehicle);
  forgetPrediction(); snapView(); btnReplay.textContent = 'Stop'; btnReplay.classList.add('on');
  showBanner('', 'Replay', 'Your attempt from its start. Tap Stop to go back to your car.', null, 4000);
}
function stopReplay(): void {
  if (!replay) return;
  replay = null; forgetPrediction(); snapView(); btnReplay.textContent = 'Replay'; btnReplay.classList.remove('on');
}
btnReplay.addEventListener('click', () => { if (replay) { stopReplay(); showBanner('', 'Back to your car', 'Carry on from where you were.', null, 2000); } else startReplay(); });

function handle(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'touch') {
      $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 60); beep(160, 0.2, 0.15);
      showBanner('bad', touchTitle(e.name, e.part), 'Stop, straighten up and back away. Touches: ' + e.hits, null, 2200);
    } else {
      const c = parkedCard(e.result); showBanner('good', c.title, c.text, c.stats);
      beep(880, 0.12, 0.08); setTimeout(() => beep(1320, 0.18, 0.08), 140);
    }
  }
}

function layout(): void { layoutPdc(layoutPlan(stage)); }
function resize(): void { screen.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR); layout(); snapView(); }
window.addEventListener('resize', resize); window.addEventListener('orientationchange', () => setTimeout(resize, 200));

// frame loop: the simulation steps at a fixed 60 Hz (so attempts replay exactly); drawing at 30 fps is plenty
// at parking speeds, and nothing is redrawn while nothing changes
let last = 0, lastSig = '', lastDrawT = 0, wakeUntil = 0, acc = 0;
const wake = () => { wakeUntil = performance.now() + 1500; };   // keep drawing for a moment after any touch, so panels settle
(['pointerdown', 'pointerup', 'keydown', 'resize'] as const).forEach(ev => window.addEventListener(ev, wake, { passive: true }));
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (now - last < 31) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  acc += dt;
  for (let n = 0; acc >= STEP - 1e-9; n++) {
    if (n === 6) { acc = 0; break; }   // far behind (a stalled tab): drop the backlog rather than race to catch up
    acc -= STEP;
    if (replay) { const evs = replay.step(); if (!evs) { stopReplay(); showBanner('', 'Replay finished', 'Back to your car, where you left it.', null, 2500); break; } handle(evs); }
    else { recorder.before(sim); const evs = sim.step(STEP); recorder.after(sim); handle(evs); }
  }
  const S = replay ? replay.sim : sim;
  if (guide) { const el = (now - guide.t0) / 1000; let i = guide.times.findIndex(x => x >= el); if (i < 0) i = guide.pts.length - 1; guide.at = i; }
  updateBeeper(S, now / 1000); updatePdcDisplay(S, now / 1000, screen.dpr);
  const sig = [S.x.toFixed(4), S.z.toFixed(4), S.th.toFixed(5), S.wheelAngle.toFixed(1), S.v.toFixed(3), S.input.fwd, S.input.rev, settings.planView, !!replay, guide ? guide.at : -1].join('|');
  if (sig === lastSig && now > wakeUntil && now - lastDrawT < 1000) return;
  lastSig = sig; lastDrawT = now;
  updateHud(S); drawPlan(S, now / 1000, dt, screen.dpr);
}

// boot, keeping the car where it was across a hot reload in the artifact viewer
type Saved = { x?: number; z?: number; th?: number; wheelAngle?: number; hits?: number; elapsed?: number; layout?: number };
type Hot = { snapshot?: (f: () => Saved) => void; ready?: (f: (saved: Saved) => void) => void; data?: Saved };
const hot = (window as unknown as { claude?: { hot?: Hot } }).claude?.hot;
function start(saved: Saved = {}): void {
  resetCar();
  if (typeof saved.x === 'number' && typeof saved.z === 'number' && typeof saved.th === 'number' && saved.layout === sim.scene.layoutVersion && !sim.touching(saved.x, saved.z, saved.th)) {
    sim.place(saved.x, saved.z, saved.th); sim.wheelAngle = saved.wheelAngle || 0; sim.hits = saved.hits || 0; sim.elapsed = saved.elapsed || 0;
    recorder.begin(sim);
  }
  resize(); setTimeout(layout, 300); setTimeout(layout, 1500);
  requestAnimationFrame(t => { last = t; frame(t); });
}
try { hot?.snapshot?.(() => ({ x: sim.x, z: sim.z, th: sim.th, wheelAngle: sim.wheelAngle, hits: sim.hits, elapsed: sim.elapsed, layout: sim.scene.layoutVersion })); } catch { /* not in the viewer */ }
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});

// offline and installable when served as a web app (not inside the artifact viewer)
if (import.meta.env.MODE !== 'artifact' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* no offline mode */ }); });
}
