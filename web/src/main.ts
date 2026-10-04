// Atto 2 Garage Trainer: wires the simulation (core/) to the screen (ui/) and runs the frame loop.
// You play either your garage or a generated level; both run on the same simulation, which loads the scene.
import './style.css';
import { GARAGE_561 } from './core/content';
import { generate, parseKey, timeLimit, type Level } from './core/generator/level';
import type { TemplateId } from './core/generator/templates';
import { DEG, clamp, wrapPi } from './core/math';
import { moves, planBack, planToBay, sample, type Piece, type Plan, type Pose } from './core/planner';
import { Recorder, STEP, playback } from './core/replay';
import { starsFor } from './core/score';
import { Sim, type ParkedResult, type SimEvent } from './core/sim';
import { beep, updateBeeper } from './ui/audio';
import { bindControls } from './ui/controls';
import { $, MAX_DPR, closeSheets, screen } from './ui/dom';
import { parkedCard, touchTitle } from './ui/format';
import { setPar, showBanner, updateHud } from './ui/hud';
import { bindLevels, hideResult, renderLevels, showResult } from './ui/levels';
import { updatePdcDisplay, layoutPdc } from './ui/pdcDisplay';
import { drawPlan, forgetPrediction, layoutPlan, setGuide, snapView, type Guide } from './ui/plan';
import { TEMPLATE_NAMES, progress, recordStars, seedFor, setPlaying } from './ui/progress';
import { lockDeg, settings } from './ui/settings';

if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) { this.rect(x, y, w, h); };

const sim = new Sim(), stage = $('app');
// what is being played: a generated level, or your garage (null); and the planner's route from the start,
// which gives par and the time allowed
let level: Level | null = null, parRoute: Piece[] = [], par = 0, limit = 0;
// every attempt is recorded from its start, so it can be replayed; the replay runs on a second simulation
const recorder = new Recorder();
let replay: ReturnType<typeof playback> | null = null;
const btnReplay = $('btnReplay'), btnShow = $('btnShow');
// Show me: a planned route from where the car is into the bay, driven by a ghost
let guide: (Guide & { times: number[]; t0: number }) | null = null;
const applySettings = () => { sim.options.lockDeg = lockDeg(); sim.options.selfCentre = settings.center === 'on'; sim.options.bay = level ? sim.scene.defaultBay : settings.bay; sim.wheelAngle = clamp(sim.wheelAngle, -sim.options.lockDeg, sim.options.lockDeg); };
const garageSlot = () => `garage:${settings.bay}:${settings.start}`;
const garageName = () => `Bay ${settings.bay} · from the ${settings.start === 'across' ? 'other side of the aisle' : settings.start}`;
const levelName = (L: Level) => `${TEMPLATE_NAMES[L.template].short} · level ${L.level}`;
/** Paint a message first, then do the slow part (generating a level, planning a route) on the next frame,
 *  or after 150 ms where frames are held back (a hidden tab, some embedded views). */
function afterPaint(f: () => void): void {
  let done = false; const go = () => { if (!done) { done = true; f(); } };
  requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 150);
}

function setRoute(route: Piece[]): void { parRoute = route; par = route.length ? moves(route) : 0; limit = route.length ? timeLimit(route) : 0; setPar(par); }
function garagePar(): void {
  const s = GARAGE_561.starts[settings.start] ?? GARAGE_561.starts[GARAGE_561.defaultStart], p = planToBay(sim.vehicle, GARAGE_561, s, settings.bay);
  setRoute(p.status === 'found' ? p.pieces : []);
}

function resetCar(): void {
  stopReplay(); hideGuide(); hideResult(); applySettings();
  sim.reset(level ? 'start' : settings.start); forgetPrediction(); recorder.begin(sim);
  $('btnFwd').classList.remove('on'); $('btnRev').classList.remove('on');
  const parText = par ? ` Par: ${par} ${par === 1 ? 'move' : 'moves'}.` : '';
  if (level) { showBanner('', levelName(level), sim.scene.starts.start.label + parText, null, 7000); return; }
  const from = (sim.scene.starts[settings.start] ?? sim.scene.starts[sim.scene.defaultStart]).label;
  showBanner('', `Park in bay ${settings.bay}`, from + (settings.bay === '561' ? ' Mind pillar 560 and the bench; the plan shows where each move ends.' : ' Pillar 560 runs along its left side.') + parText, null, 8000);
}

function enterLevel(L: Level): void {
  level = L; sim.load(L.scene); setRoute(L.route); setPlaying(L.key, L.template, L.level, L.seed);
  snapView(); resetCar(); refreshLevels();
}
function playLevel(t: TemplateId, n: number, seed: number): void {
  stopReplay(); hideGuide(); closeSheets();
  showBanner('', 'Building the level…', `${TEMPLATE_NAMES[t].long}, level ${n}`, null);
  afterPaint(() => {
    const L = generate(sim.vehicle, t, n, seed);
    if (L) enterLevel(L); else showBanner('bad', 'No level from this layout', 'Try another: Levels, then New layout.', null, 4000);
  });
}
function playGarage(): void {
  level = null; sim.load(GARAGE_561); garagePar(); setPlaying('garage'); closeSheets();
  snapView(); resetCar(); refreshLevels();
}
const refreshLevels = () => renderLevels(level ? level.key : 'garage', garageName(), garageSlot());
const newSeed = () => 1 + Math.floor(Math.random() * 99999);
bindLevels({ playLevel, playGarage });

bindControls(sim, {
  reset: resetCar,
  levels: refreshLevels,
  settingChanged: key => {
    if (key === 'start' || key === 'bay') { if (level) playGarage(); else { garagePar(); resetCar(); } }
    else { applySettings(); if (!replay) recorder.begin(sim); }
  },
});

function hideGuide(): void { guide = null; setGuide(null); btnShow.textContent = 'Show me'; btnShow.classList.remove('on'); }
function startGuide(pieces: Piece[], now: number): void {
  const pts = sample(sim.vehicle, pieces, 0.05), times: number[] = [];
  let t = 0; pts.forEach((p, i) => { if (i) { t += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) / 1.4; if (p.dir !== pts[i - 1].dir) t += 0.6; } times.push(t); });
  guide = { pts, at: 0, times, t0: now }; setGuide(guide);
  btnShow.textContent = 'Hide'; btnShow.classList.add('on');
  const n = moves(pieces), runs: string[] = [];
  pieces.forEach((p, i) => { if (i === 0 || p.dir !== pieces[i - 1].dir) runs.push(p.dir > 0 ? 'forward' : 'reverse'); });
  const said = runs.map((r, i) => (i ? r : r[0].toUpperCase() + r.slice(1))).join(', then ');
  showBanner('', `Show me: ${n} ${n === 1 ? 'move' : 'moves'}`, `${said}. Watch the ghost, then follow the line yourself. Yellow is forward, dashed blue is reverse.`, null, 6000);
}
/** From the start, the route that set par; from anywhere else, a fresh plan. Parallel spaces plan outward from the space. */
function showMe(now: number): void {
  if (replay) return;
  const from: Pose = { x: sim.x, z: sim.z, th: sim.th }, s0 = parRoute[0]?.from;
  if (s0 && Math.hypot(from.x - s0.x, from.z - s0.z) < 0.05 && Math.abs(wrapPi(from.th - s0.th)) < DEG) { startGuide(parRoute, now); return; }
  showBanner('', 'Working out a route…', 'From where your car is now.', null);
  afterPaint(() => {
    const v = sim.vehicle, sc = sim.scene, bay = sim.options.bay, kerb = sc.bays[bay]?.kind === 'kerb';
    const inward = (n: number): Plan => planToBay(v, sc, from, bay, { maxNodes: n }), outward = (): Plan => planBack(v, sc, from, bay, { maxNodes: 6000 });
    let plan = kerb ? outward() : inward(level ? 1500 : 20000);
    if (plan.status === 'gave-up') plan = kerb ? inward(1500) : outward();
    if (plan.status === 'found' && !plan.pieces.length) { showBanner('good', 'You are parked already', 'Nothing to show from here.', null, 3000); return; }
    if (plan.status !== 'found') {
      showBanner('bad', 'No route from here', plan.status === 'none' ? 'The space has no room for the car.' : 'Tap Reset to watch the way in from the start, or back out a little and try again.', null, 4500);
      return;
    }
    startGuide(plan.pieces, performance.now());
  });
}
btnShow.addEventListener('click', () => { if (guide) hideGuide(); else showMe(performance.now()); });

function startReplay(): void {
  const rec = recorder.rec;
  if (!rec || rec.steps < 30) { showBanner('', 'Nothing to replay yet', 'Drive a little first. Replay shows this attempt from its start, exactly as you drove it.', null, 3500); return; }
  hideGuide(); hideResult(); replay = playback({ ...rec, events: rec.events.slice() }, sim.scene, sim.vehicle);
  forgetPrediction(); snapView(); btnReplay.textContent = 'Stop'; btnReplay.classList.add('on');
  showBanner('', 'Replay', 'Your attempt from its start. Tap Stop to go back to your car.', null, 4000);
}
function stopReplay(): void {
  if (!replay) return;
  replay = null; forgetPrediction(); snapView(); btnReplay.textContent = 'Replay'; btnReplay.classList.remove('on');
}
btnReplay.addEventListener('click', () => { if (replay) { stopReplay(); showBanner('', 'Back to your car', 'Carry on from where you were.', null, 2000); } else startReplay(); });

/** Parked: the stars, a new best if it is one, and the result card with where to go next. */
function parked(r: ParkedResult): void {
  const st = starsFor(r, par || r.moves, limit || Infinity), L = level;
  const better = recordStars(L ? `${L.template}:${L.level}` : garageSlot(), st.count) && st.count > 0;
  showBanner('good', `Parked · ${'★'.repeat(st.count)}${'☆'.repeat(3 - st.count)}`, st.count === 3 ? 'Three stars: clean, neat and efficient.' : 'The card below says what each star needs.', null, 3000);
  setTimeout(() => {
    if (!sim.parked || replay) return;   // drove off again, or started a replay
    showResult(r, st, L ? {
      title: `Parked in ${L.level === 10 ? 'the hardest level' : 'level ' + L.level}`, sub: `${TEMPLATE_NAMES[L.template].long} · layout ${L.seed} · par ${L.par}`, par: L.par, limit: L.timeLimit, better,
      retry: resetCar, newLayout: () => playLevel(L.template, L.level, newSeed()),
      next: () => (L.level === 10 ? playLevel(L.template, 10, newSeed()) : playLevel(L.template, L.level + 1, seedFor(L.template, L.level + 1))), nextLabel: L.level === 10 ? 'Another' : 'Next level',
    } : {
      title: parkedCard(r).title, sub: `${garageName()} · par ${par}`, par, limit, better,
      retry: resetCar, newLayout: null, next: null, nextLabel: 'Levels',
    });
  }, 900);
}

function handle(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'touch') {
      $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 60); beep(160, 0.2, 0.15);
      showBanner('bad', touchTitle(e.name, e.part), 'Stop, straighten up and back away. Touches: ' + e.hits, null, 2200);
    } else {
      beep(880, 0.12, 0.08); setTimeout(() => beep(1320, 0.18, 0.08), 140);
      if (replay) { const c = parkedCard(e.result); showBanner('good', c.title, c.text, c.stats); } else parked(e.result);
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
  const sig = [S.x.toFixed(4), S.z.toFixed(4), S.th.toFixed(5), S.wheelAngle.toFixed(1), S.v.toFixed(3), S.input.fwd, S.input.rev, settings.planView, !!replay, guide ? guide.at : -1, S.scene.id].join('|');
  if (sig === lastSig && now > wakeUntil && now - lastDrawT < 1000) return;
  lastSig = sig; lastDrawT = now;
  updateHud(S); drawPlan(S, now / 1000, dt, screen.dpr);
}

// boot: back into what you were playing, keeping the car where it was across a hot reload in the artifact viewer
type Saved = { x?: number; z?: number; th?: number; wheelAngle?: number; hits?: number; elapsed?: number; moves?: number; layout?: number; scene?: string; play?: string };
type Hot = { snapshot?: (f: () => Saved) => void; ready?: (f: (saved: Saved) => void) => void; data?: Saved };
const hot = (window as unknown as { claude?: { hot?: Hot } }).claude?.hot;
function start(saved: Saved = {}): void {
  const key = parseKey(saved.play ?? progress.play), L = key ? generate(sim.vehicle, key.template, key.level, key.seed) : null;
  if (L) { level = L; sim.load(L.scene); setRoute(L.route); } else garagePar();
  resetCar(); refreshLevels();
  if (typeof saved.x === 'number' && typeof saved.z === 'number' && typeof saved.th === 'number' && saved.scene === sim.scene.id && saved.layout === sim.scene.layoutVersion && !sim.touching(saved.x, saved.z, saved.th)) {
    sim.place(saved.x, saved.z, saved.th); sim.wheelAngle = saved.wheelAngle || 0; sim.hits = saved.hits || 0; sim.elapsed = saved.elapsed || 0; sim.moves = saved.moves || 0;
    recorder.begin(sim);
  }
  resize(); setTimeout(layout, 300); setTimeout(layout, 1500);
  requestAnimationFrame(t => { last = t; frame(t); });
}
try { hot?.snapshot?.(() => ({ x: sim.x, z: sim.z, th: sim.th, wheelAngle: sim.wheelAngle, hits: sim.hits, elapsed: sim.elapsed, moves: sim.moves, layout: sim.scene.layoutVersion, scene: sim.scene.id, play: level ? level.key : 'garage' })); } catch { /* not in the viewer */ }
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});

// browser checks only (`vite build --mode harness`); other builds drop this
if (import.meta.env.MODE === 'harness') Object.assign(window, { __game: { sim, level: () => level, route: () => parRoute } });

// offline and installable when served as a web app (not inside the artifact viewer)
if (import.meta.env.MODE !== 'artifact' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* no offline mode */ }); });
}
