// Atto 2 Garage Trainer: wires the simulation (core/) to the screen (ui/) and runs the frame loop.
// You play your garage, a generated level or a lesson; all run on the same simulation, which loads the scene.
import './style.css';
import { CoachRun, Tracker, feedback, stepsFor, timingCause, type CoachEvent, type CoachSnap, type Feedback, type Step } from './core/coach';
import { ATTO2, GARAGE_561, VEHICLES, vehicleFor } from './core/content';
import { generate, parseKey, timeLimit, type Level } from './core/generator/level';
import type { TemplateId } from './core/generator/templates';
import type { Vehicle } from './core/vehicle';
import { COURSE, HELP, afterTry, checkPass, endHint, lessonById, loadLesson, type Lesson, type LessonDef, type LessonState } from './core/lesson';
import { DEG, clamp, wrapPi, type Pt } from './core/math';
import { clearStart, fitsBay, moves, planBack, planToBay, sample, type Piece, type Plan, type Pose, type RoutePoint } from './core/planner';
import { Recorder, STEP, playback, replayTo, restoreState, stateOf as simState } from './core/replay';
import { starsFor } from './core/score';
import { Sim, type ParkedResult, type SimEvent } from './core/sim';
import { beep, updateBeeper } from './ui/audio';
import { renderCarFacts, renderCarPicker, syncCarPicker } from './ui/cars';
import { bindCard, renderCard } from './ui/coachCard';
import { bindControls, pedals } from './ui/controls';
import { bindCourse, courseTab, renderCourse, setState, showLesson, showLessonResult, stateOf } from './ui/course';
import { $, MAX_DPR, closeSheets, openSheet, screen } from './ui/dom';
import { parkedCard, touchTitle } from './ui/format';
import { setPar, showBanner, updateHud } from './ui/hud';
import { bindLevels, hideResult, renderLevels, showResult } from './ui/levels';
import { updatePdcDisplay, layoutPdc } from './ui/pdcDisplay';
import { drawPlan, forgetPrediction, layoutPlan, setCoachDraw, setGuide, snapView, type Guide } from './ui/plan';
import { TEMPLATE_NAMES, progress, recordStars, seedFor, setPlaying, setStarsCar } from './ui/progress';
import { lockDeg, settings } from './ui/settings';

if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) { this.rect(x, y, w, h); };

const sim = new Sim(), stage = $('app');
// what is being played: a generated level, a lesson, or your garage (both null); and the route from the start,
// which gives par and the time allowed
let level: Level | null = null, parRoute: Piece[] = [], par = 0, limit = 0;
// every attempt is recorded from its start, so it can be replayed; the replay runs on a second simulation
const recorder = new Recorder();
let replay: ReturnType<typeof playback> | null = null;
const btnReplay = $('btnReplay'), btnShow = $('btnShow');
// Show me (and a lesson's Watch): a planned route driven by a ghost; watching pauses at each mark
let guide: (Guide & { times: number[]; t0: number; watch: boolean }) | null = null;
// a try ends once the car has sat parked, still, for a moment: then its result is read from where it settled
const SETTLE = 1.0;
let settledT = 0, tryOver = false;
// Rewind: back 5 s by replaying this try's recording to then. A try with a rewind is practice (no stars saved, a lesson
// try counts neither way).
const REWIND = 300;
let tryRewound = false;
// the game's clock (ms); browser checks run the frame loop by hand and move it on (pump, harness builds only)
let clockOffset = 0;
const clock = () => performance.now() + clockOffset;

/** A lesson being played: its route as steps, where you are in it, and this try. */
interface LessonPlay {
  L: Lesson; steps: Step[]; routePts: RoutePoint[]; st: LessonState;
  run: CoachRun | null;    // the coach following this try: guided, or keeping up with the cue marks; null with less help
  tracker: Tracker;        // your path, for the feedback
  fault: string;           // what spoilt this try already ('touch', 'missed'), '' if nothing
  fb: Feedback | null;     // what went wrong, worked out when it went wrong (a miss)
  summoned: boolean;       // help on request: the coach was asked for in this try
  watching: boolean;       // the ghost is showing the route
  over: boolean;           // this try has its result
  track: Pt[] | null; drift: Pt | null;   // after a try: your path, and where it first drifted 30 cm
  rewound: boolean;        // this try went back in time: practice
  mark0: { coach: CoachSnap | null; track: number };   // the coach and the path when the recording last began, for rewinding
}
let lesson: LessonPlay | null = null;

/** The car chosen in Setup. Lessons are taught in the Atto 2 for now; the garage and the levels use this one. */
const chosenCar = (): Vehicle => vehicleFor(settings.car, parseFloat(settings.ras));
/** Drive v from the next reset on, with its facts in Info. Stars are the chosen car's: only the garage and levels keep them. */
function useCar(v: Vehicle): void {
  setStarsCar(chosenCar().id); renderCarFacts(v); syncCarPicker(chosenCar());
  if (sim.vehicle === v) return;
  sim.setVehicle(v); forgetPrediction(); hideGuide();
}
const carNote = (v: Vehicle) => `${v.short}: ${(v.L + 1e-9).toFixed(2)} × ${(v.W + 1e-9).toFixed(2)} m, turning circle ${(2 * v.R_CC).toFixed(2)} m kerb to kerb${v.REAR_DEG ? `, ${v.REAR_DEG}° rear-axle steering` : ''}.`;

const applySettings = () => {
  sim.options.lockDeg = lockDeg(); sim.options.selfCentre = settings.center === 'on';
  sim.options.bay = lesson ? lesson.L.bay : level ? sim.scene.defaultBay : settings.bay;
  sim.wheelAngle = clamp(sim.wheelAngle, -sim.options.lockDeg, sim.options.lockDeg);
};
const garageSlot = () => `garage:${settings.bay}:${settings.start}`;
const garageName = () => `Bay ${settings.bay} · from the ${settings.start === 'across' ? 'other side of the aisle' : settings.start}`;
const levelName = (L: Level) => `${TEMPLATE_NAMES[L.template].short} · level ${L.level}`;
const clearPedals = () => { pedals.fwd = pedals.rev = false; sim.input.fwd = sim.input.rev = false; $('btnFwd').classList.remove('on'); $('btnRev').classList.remove('on'); };
/** Paint a message first, then do the slow part (generating a level, planning a route) on the next frame,
 *  or after 150 ms where frames are held back (a hidden tab, some embedded views). */
function afterPaint(f: () => void): void {
  let done = false; const go = () => { if (!done) { done = true; f(); } };
  requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 150);
}

/** Start recording from the car as it is; in a lesson, remember the coach and the path too, for a rewind. */
function beginRecording(): void {
  recorder.begin(sim);
  if (lesson) lesson.mark0 = { coach: lesson.run?.snapshot() ?? null, track: lesson.tracker.pts.length };
}
function setRoute(route: Piece[]): void { parRoute = route; par = route.length ? moves(route) : 0; limit = route.length ? timeLimit(route) : 0; setPar(par); }
/** Where the garage try starts: the chosen start, moved back for a car too long to stand there. */
const garageStart = (): Pose => clearStart(sim.vehicle, GARAGE_561, GARAGE_561.starts[settings.start] ?? GARAGE_561.starts[GARAGE_561.defaultStart]);
function garagePar(): void {
  const p = planToBay(sim.vehicle, GARAGE_561, garageStart(), settings.bay);
  setRoute(p.status === 'found' ? p.pieces : []);
}

function resetCar(): void {
  if (lesson) { startTry(); return; }
  stopReplay(); hideGuide(); hideResult(); applySettings();
  if (level) sim.reset('start'); else { const s = garageStart(); sim.resetAt(s.x, s.z, s.th); }
  forgetPrediction(); beginRecording(); clearPedals();
  settledT = 0; tryOver = false; tryRewound = false;
  const parText = par ? ` Par: ${par} ${par === 1 ? 'move' : 'moves'}.` : '';
  if (level) { showBanner('', levelName(level), sim.scene.starts.start.label + parText, null, 7000); return; }
  const v = sim.vehicle, bay = GARAGE_561.bays[settings.bay];
  if (!fitsBay(v, GARAGE_561, settings.bay)) {
    const room = bay.headZ < bay.z1 ? bay.z1 + bay.mouthTol - bay.headZ : 0, wide = bay.x1 - bay.x0;
    const why = v.L > room - 0.35 ? `it is ${v.L.toFixed(2)} m long and the bay has room for about ${(room - 0.35).toFixed(2)} m, wall gap included` : `it is ${v.W.toFixed(2)} m wide and the bay ${wide.toFixed(2)} m`;
    showBanner('bad', `The ${v.short} won't fit bay ${settings.bay}`, `${why[0].toUpperCase() + why.slice(1)}. Drive round the garage, or play a level: the bays there grow for a bigger car.`, null, 9000);
    return;
  }
  const from = (sim.scene.starts[settings.start] ?? sim.scene.starts[sim.scene.defaultStart]).label;
  showBanner('', `Park in bay ${settings.bay}${v === ATTO2 ? '' : ` · ${v.short}`}`, from + (settings.bay === '561' ? ' Mind pillar 560 and the bench; the plan shows where each move ends.' : ' Pillar 560 runs along its left side.') + parText, null, 8000);
}

function leaveLesson(): void { lesson = null; setCoachDraw(null); renderCard(null); useCar(chosenCar()); layout(); }
function enterLevel(L: Level): void {
  leaveLesson(); level = L; sim.load(L.scene); setRoute(L.route); setPlaying(L.key, L.template, L.level, L.seed);
  snapView(); resetCar(); refreshLevels();
}
function playLevel(t: TemplateId, n: number, seed: number): void {
  stopReplay(); hideGuide(); closeSheets();
  showBanner('', 'Building the level…', `${TEMPLATE_NAMES[t].long}, level ${n}`, null);
  afterPaint(() => {
    const L = generate(chosenCar(), t, n, seed);
    if (L) enterLevel(L); else showBanner('bad', 'No level from this layout', 'Try another: Play, then New layout.', null, 4000);
  });
}
function playGarage(): void {
  leaveLesson(); level = null; sim.load(GARAGE_561); garagePar(); setPlaying('garage'); closeSheets();
  snapView(); resetCar(); refreshLevels();
}
const refreshLevels = () => {
  const v = chosenCar();
  renderLevels(level ? level.key : lesson ? '' : 'garage', garageName(), garageSlot()); renderCourse(lesson ? lesson.L.def.id : null);
  $('lvCar').textContent = v === ATTO2 ? '' : `Built for the ${v.short}: the bays grow for a car bigger than the Atto 2, the aisles and kerb spaces stay as they are.`; $('lvCar').hidden = v === ATTO2;
  $('crsCar').textContent = `The lessons' routes and marks are worked out for the Atto 2, so they use it for now; the ${v.short} stays yours in the garage and the levels.`; $('crsCar').hidden = v === ATTO2;
};
const newSeed = () => 1 + Math.floor(Math.random() * 99999);
bindLevels({ playLevel, playGarage });

// ---- lessons ----

const picksOf = (def: LessonDef) => Object.fromEntries(Object.entries(def.tips ?? {}).map(([k, t]) => [k, t.cue]));
/** Into a lesson: its scene, its route, where you are in it; then the lesson card, or straight into a try. */
function enterLesson(id: string, then: 'card' | 'drive' = 'card'): void {
  const def = lessonById(id); if (!def) return;
  stopReplay(); hideGuide(); closeSheets();
  useCar(ATTO2);   // the lessons' routes and marks are worked out for the Atto 2; lessons in each car come next
  const L = loadLesson(sim.vehicle, def);
  level = null;
  lesson = { L, steps: stepsFor(sim.vehicle, L.scene, L.bay, L.route, picksOf(def)), routePts: sample(sim.vehicle, L.route, 0.1), st: stateOf(id), run: null, tracker: new Tracker(), fault: '', fb: null, summoned: false, watching: false, over: false, track: null, drift: null, rewound: false, mark0: { coach: null, track: 0 } };
  sim.load(L.scene); setRoute(L.route); setPlaying(`lesson:${id}`);
  snapView(); startTry(); refreshLevels();
  if (then === 'card') lessonCard();
}
function lessonCard(): void {
  const ls = lesson; if (!ls) return;
  showLesson(ls.L.def, ls.st, {
    watch: () => { closeSheets(); startWatch(); },
    drive: () => { closeSheets(); startTry(); },
    test: () => { ls.st = { ...ls.st, help: 3, passes: 0, fails: 0, slow: false }; setState(ls.L.def.id, ls.st); closeSheets(); startTry(); },
  });
}
/** A new try from the lesson's start, with as much help as you are at. */
function startTry(): void {
  const ls = lesson!; stopReplay(); hideGuide(); hideResult(); applySettings();
  const s = ls.L.route[0].from; sim.resetAt(s.x, s.z, s.th); forgetPrediction(); clearPedals();
  settledT = 0; tryOver = false; tryRewound = false;
  Object.assign(ls, { fault: '', fb: null, summoned: false, watching: false, over: false, track: null, drift: null, rewound: false });
  ls.tracker.reset(); ls.tracker.add(sim);
  ls.run = ls.st.help <= 1 ? new CoachRun(sim.vehicle, ls.steps, () => sim.options.lockDeg, ls.st.help === 1) : null;
  beginRecording();
  const h = ls.st.help, def = ls.L.def;
  const how = h === 0 ? 'Set the wheel as the card says, then hold the pedal: the coach keeps you at walking pace and stops you on each mark.'
    : h === 1 ? 'Only the marks now: stop on each one yourself, then set the wheel for the next.'
    : h === 2 ? 'No marks now. Show me and the coach are there if you need them.' : 'The test: no help, and the stars count.';
  showBanner('', `Lesson ${def.n} · ${HELP[h].name}`, how + (ls.st.slow ? ' Slow motion is on.' : ''), null, 6000);
}
/** Watch: the ghost drives the route from the start, pausing on each mark while the card says what happens there. */
function startWatch(): void {
  const ls = lesson!; startTry(); ls.watching = true;
  const pts = sample(sim.vehicle, ls.L.route, 0.05), times: number[] = [];
  let t = 0.8;
  pts.forEach((p, i) => { if (i) { t += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) / 1.4; if (p.i !== pts[i - 1].i) t += 1.8; } times.push(t); });
  guide = { pts, at: 0, times, t0: clock(), watch: true }; setGuide(guide);
  btnShow.textContent = 'Stop'; btnShow.classList.add('on');
  showBanner('', `Watch: ${ls.steps.length} steps`, 'The ghost drives the route and stops on each mark. The card says what to do there.', null, 4000);
}
function endWatch(): void {
  hideGuide(); if (!lesson) return;
  lesson.watching = false;
  showBanner('', 'Your turn', 'Drive it the same way. The card shows each step.', null, 3500);
}
function backToMark(): void {
  const ls = lesson, run = ls?.run; if (!ls || !run) return;
  const { pose, wheel } = run.backToMark();
  sim.place(pose.x, pose.z, pose.th); sim.v = 0; sim.wheelAngle = wheel; sim.wheelTarget = null; sim.inContact = false;
  clearPedals(); forgetPrediction(); ls.tracker.reset(); ls.tracker.add(sim); beginRecording();
  showBanner('', 'Back on the mark', 'This try no longer counts as a pass. Carry on for practice, or start again.', null, 3500);
}
bindCard({
  back: backToMark,
  restart: () => startTry(),
  summon: () => { const ls = lesson; if (!ls) return; ls.summoned = true; ls.run = new CoachRun(sim.vehicle, ls.steps, () => sim.options.lockDeg, true); ls.run.jumpTo(sim); beginRecording(); },
  slow: () => { const ls = lesson; if (!ls) return; ls.st = { ...ls.st, slow: false }; setState(ls.L.def.id, ls.st); },
});
bindCourse({ open: id => enterLesson(id, 'card'), tab: () => refreshLevels() });

function coachEvents(evs: CoachEvent[]): void {
  const ls = lesson; if (!ls) return;
  for (const e of evs) {
    if (e.type === 'mark') beep(660, 0.06, 0.05);
    else if (e.type === 'missed' && ls.run && !ls.run.passive) {
      ls.fault ||= 'missed'; ls.fb ??= feedback(sim.vehicle, ls.L.route, ls.steps, ls.tracker.pts);
      beep(220, 0.25, 0.1);
    } else if (e.type === 'done' && ls.run && !ls.run.passive) finishTry(sim.parkedResult());
  }
}

/** A try in a lesson is over: pass or not, what to work on, and whether the help steps back or comes back. */
function finishTry(r: ParkedResult | null): void {
  const ls = lesson; if (!ls || ls.over) return;
  ls.over = true; tryOver = true;
  const def = ls.L.def, rule = def.pass ?? {}, triedAt = ls.st.help, test = triedAt === 3;
  const chk = r ? checkPass(r, rule, ls.L.par) : { pass: false, lines: [{ ok: false, text: 'Not in the space' }] };
  if (ls.fault === 'missed') chk.lines.push({ ok: false, text: 'The coach had to stop you at a mark' });
  const pass = chk.pass && !ls.fault, practice = ls.rewound;
  // what to work on: the first place the try left the route by 30 cm and why; failing without that (or with no clear
  // why), the switch whose timing moved the finish most; failing that, what the result missed
  let fb = pass ? null : (ls.fb ?? feedback(sim.vehicle, ls.L.route, ls.steps, ls.tracker.pts));
  if (fb && (!fb.at || fb.text.startsWith('You drifted'))) fb = timingCause(sim.vehicle, ls.L.route, ls.steps, ls.tracker.pts) ?? (fb.at ? fb : { ...fb, text: (r && endHint(r, rule, ls.L.par)) ?? fb.text });
  const stars = test && r ? starsFor(r, ls.L.par, ls.L.limit) : null;
  const { state, change } = practice ? { state: { ...ls.st }, change: null } : afterTry(ls.st, pass);
  const better = !!stars && pass && stars.count > state.best;
  if (better) state.best = stars!.count;
  state.focus = fb?.step ?? 0;
  ls.st = state; setState(def.id, state);
  ls.track = ls.tracker.pts.map((p): Pt => [p.x, p.z]); ls.drift = fb?.at ?? null;
  const next = COURSE.lessons.find(l => !l.soon && l.n > def.n);
  const changeText = change === 'less' ? (state.help === 3 ? 'Two passes: next is the test, with no help.' : `Two passes: next try with ${HELP[state.help].name.toLowerCase()}: ${HELP[state.help].what}.`)
    : change === 'more' ? `Two misses: back to ${HELP[state.help].name.toLowerCase()}, in slow motion.` : change === 'slow' ? 'Two misses: slow motion is on.'
    : change === 'done' ? 'Lesson complete.' : null;
  showBanner(pass ? 'good' : 'bad', pass ? (test ? `Passed the test · ${'★'.repeat(stars?.count ?? 0)}${'☆'.repeat(3 - (stars?.count ?? 0))}` : 'Pass') : 'Not yet', fb?.text ?? (pass ? 'Clean and within the rules.' : ''), null, 3000);
  setTimeout(() => {
    if (lesson !== ls || !ls.over) return;
    showLessonResult(r, {
      title: practice ? 'Practice try (rewound)' : change === 'done' ? `Lesson ${def.n} complete` : pass ? 'Pass' : 'Not a pass yet', sub: `Lesson ${def.n} · ${def.title} · ${HELP[triedAt].name}`,
      pass, test, stars, better, lines: chk.lines, feedback: fb?.text ?? null, change: practice ? 'A try with a rewind is practice: it counts neither way.' : changeText,
      retry: () => startTry(), watch: () => { hideResult(); startWatch(); }, course: () => { courseTab(); refreshLevels(); openSheet('sheetLevels'); },
      next: state.done && next ? () => enterLesson(next.id, 'card') : null,
    });
  }, 700);
}

renderCarPicker();   // the car buttons, before the Setup rows are bound
bindControls(sim, {
  reset: resetCar,
  levels: refreshLevels,
  settingChanged: key => {
    if (key === 'car' || key === 'ras') {
      const v = chosenCar(); syncCarPicker(v);
      if (lesson) { showBanner('', `Lessons use the Atto 2 for now`, `The ${v.short} is yours in the garage and the levels. ${carNote(v)}`, null, 5000); return; }
      useCar(v);
      if (level) playLevel(level.template, level.level, level.seed);
      else { garagePar(); resetCar(); if (fitsBay(v, GARAGE_561, settings.bay)) showBanner('', `Now driving the ${v.short}`, carNote(v) + (par ? ` Par in bay ${settings.bay}: ${par} ${par === 1 ? 'move' : 'moves'}.` : ''), null, 6000); }
      return;
    }
    if (key === 'start' || key === 'bay') { if (level || lesson) playGarage(); else { garagePar(); resetCar(); } }
    else { applySettings(); if (!replay && (key === 'steer' || key === 'center')) beginRecording(); }   // only these change how the car steps
  },
});

function hideGuide(): void { guide = null; setGuide(null); btnShow.textContent = 'Show me'; btnShow.classList.remove('on'); }
function startGuide(pieces: Piece[], now: number): void {
  const pts = sample(sim.vehicle, pieces, 0.05), times: number[] = [];
  let t = 0; pts.forEach((p, i) => { if (i) { t += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) / 1.4; if (p.dir !== pts[i - 1].dir) t += 0.6; } times.push(t); });
  guide = { pts, at: 0, times, t0: now, watch: false }; setGuide(guide);
  btnShow.textContent = 'Hide'; btnShow.classList.add('on');
  const n = moves(pieces), runs: string[] = [];
  pieces.forEach((p, i) => { if (i === 0 || p.dir !== pieces[i - 1].dir) runs.push(p.dir > 0 ? 'forward' : 'reverse'); });
  const said = runs.map((r, i) => (i ? r : r[0].toUpperCase() + r.slice(1))).join(', then ');
  showBanner('', `Show me: ${n} ${n === 1 ? 'move' : 'moves'}`, `${said}. Watch the ghost, then follow the line yourself. Yellow is forward, dashed blue is reverse.`, null, 6000);
}
/** From the start, the route that set par; from anywhere else, a fresh plan. Parallel spaces plan outward from the space.
 *  In a lesson the plan keeps to full lock or straight, as the coach does; the test has no help. */
function showMe(now: number): void {
  if (replay) return;
  if (lesson?.st.help === 3) { showBanner('', 'No help in the test', 'Two misses bring the help back. Tap Reset to start the try again.', null, 3500); return; }
  const from: Pose = { x: sim.x, z: sim.z, th: sim.th }, s0 = parRoute[0]?.from;
  if (s0 && Math.hypot(from.x - s0.x, from.z - s0.z) < 0.05 && Math.abs(wrapPi(from.th - s0.th)) < DEG) { if (lesson) startWatch(); else startGuide(parRoute, now); return; }
  showBanner('', 'Working out a route…', 'From where your car is now.', null);
  afterPaint(() => {
    const v = sim.vehicle, sc = sim.scene, bay = sim.options.bay, kerb = sc.bays[bay]?.kind === 'kerb', lvls = lesson ? [-1, 0, 1] : undefined;
    const inward = (n: number): Plan => planToBay(v, sc, from, bay, { maxNodes: n, lvls }), outward = (): Plan => planBack(v, sc, from, bay, { maxNodes: 6000, lvls });
    let plan = kerb ? outward() : inward(level || lesson ? 1500 : 20000);
    if (plan.status === 'gave-up') plan = kerb ? inward(1500) : outward();
    if (plan.status === 'found' && !plan.pieces.length) { showBanner('good', 'You are parked already', 'Nothing to show from here.', null, 3000); return; }
    if (plan.status !== 'found') {
      showBanner('bad', 'No route from here', plan.status === 'none' ? 'The space has no room for the car.' : 'Tap Reset to watch the way in from the start, or back out a little and try again.', null, 4500);
      return;
    }
    startGuide(plan.pieces, clock());
  });
}
btnShow.addEventListener('click', () => { if (guide) { if (guide.watch) endWatch(); else hideGuide(); } else showMe(clock()); });

function startReplay(): void {
  const rec = recorder.rec;
  if (!rec || rec.steps < 30) { showBanner('', 'Nothing to replay yet', 'Drive a little first. Replay shows this attempt from its start, exactly as you drove it.', null, 3500); return; }
  hideGuide(); hideResult(); replay = playback({ ...rec, events: rec.events.slice() }, sim.scene, VEHICLES[rec.vehicle] ?? sim.vehicle);
  forgetPrediction(); snapView(); btnReplay.textContent = 'Stop'; btnReplay.classList.add('on');
  showBanner('', 'Replay', 'Your attempt from its start. Tap Stop to go back to your car.', null, 4000);
}
function stopReplay(): void {
  if (!replay) return;
  replay = null; forgetPrediction(); snapView(); btnReplay.textContent = 'Replay'; btnReplay.classList.remove('on');
}
btnReplay.addEventListener('click', () => { if (replay) { stopReplay(); showBanner('', 'Back to your car', 'Carry on from where you were.', null, 2000); } else startReplay(); });

/** Parked and settled: the stars, a new best if it is one, and the result card with where to go next. */
function parked(r: ParkedResult): void {
  const st = starsFor(r, par || r.moves, limit || Infinity), L = level;
  const better = !tryRewound && recordStars(L ? `${L.template}:${L.level}` : garageSlot(), st.count) && st.count > 0;
  showBanner('good', `Parked · ${'★'.repeat(st.count)}${'☆'.repeat(3 - st.count)}`, tryRewound ? 'After a rewind: stars shown, not saved.' : st.count === 3 ? 'Three stars: clean, neat and efficient.' : 'The card below says what each star needs.', null, 3000);
  setTimeout(() => {
    if (!sim.parked || replay) return;   // drove off again, or started a replay
    showResult(r, st, L ? {
      title: `Parked in ${L.level === 10 ? 'the hardest level' : 'level ' + L.level}`, sub: `${TEMPLATE_NAMES[L.template].long} · layout ${L.seed} · par ${L.par}`, par: L.par, limit: L.timeLimit, better,
      retry: resetCar, newLayout: () => playLevel(L.template, L.level, newSeed()),
      next: () => (L.level === 10 ? playLevel(L.template, 10, newSeed()) : playLevel(L.template, L.level + 1, seedFor(L.template, L.level + 1))), nextLabel: L.level === 10 ? 'Another' : 'Next level',
    } : {
      title: parkedCard(r).title, sub: `${garageName()} · par ${par}`, par, limit, better,
      retry: resetCar, newLayout: null, next: null, nextLabel: 'Play',
    });
  }, 500);
}

const canRewind = (): boolean => {
  const rec = recorder.rec;
  return !!rec && rec.steps >= 30 && !replay && !tryOver && !(lesson && (lesson.over || lesson.watching || lesson.st.help === 3));
};
/** Back 5 s: replay this try's recording to then on a second simulation, rebuilding the coach and your path as it
 *  goes (exactly as they were), and carry on from there. */
function rewind(): void {
  if (!canRewind()) return;
  const rec = recorder.rec!, n = Math.max(0, rec.steps - REWIND), ls = lesson;
  let run: CoachRun | null = null;
  if (ls) {
    run = ls.run ? new CoachRun(sim.vehicle, ls.steps, () => sim.options.lockDeg, ls.run.passive) : null;
    if (run && ls.mark0.coach) run.restore(ls.mark0.coach);
    ls.tracker.pts.length = Math.min(ls.tracker.pts.length, ls.mark0.track);
  }
  const p = replayTo(rec, sim.scene, VEHICLES[rec.vehicle] ?? sim.vehicle, n, s => run?.sync(s), s => { ls?.tracker.add(s); run?.observe(s); });
  restoreState(sim, simState(p)); clearPedals(); recorder.truncate(n, sim); forgetPrediction();
  if (ls) { ls.run = run; ls.rewound = true; }
  tryRewound = true; settledT = 0;
  showBanner('', 'Back 5 seconds', ls ? 'Try that bit again. A try with a rewind is practice: it counts neither way.' : 'Try that bit again. Stars after a rewind are shown but not saved.', null, 3500);
}
$('btnRewind').addEventListener('click', rewind);

function handle(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'touch') {
      $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 60); beep(160, 0.2, 0.15);
      showBanner('bad', touchTitle(e.name, e.part), 'Stop, straighten up and back away. Touches: ' + e.hits, null, 2200);
      if (lesson && !replay && !lesson.over) lesson.fault ||= 'touch';
    } else {
      beep(880, 0.12, 0.08); setTimeout(() => beep(1320, 0.18, 0.08), 140);
      if (replay) { const c = parkedCard(e.result); showBanner('good', c.title, c.text, c.stats); }
    }
  }
}

/** Once the car has sat parked, still, with no pedal held, for SETTLE seconds: the try's result, from where it settled.
 *  Guided lessons end when the coach says the last step is done instead. Driving out of the space starts it over. */
function settle(dt: number): void {
  if (replay) return;
  if (!sim.parked) { tryOver = false; settledT = 0; return; }
  const still = Math.abs(sim.v) < 0.02 && !sim.input.fwd && !sim.input.rev;
  settledT = still ? settledT + dt : 0;
  if (settledT < SETTLE || tryOver) return;
  if (lesson && (lesson.watching || (lesson.run && !lesson.run.passive))) return;
  tryOver = true;
  const r = sim.parkedResult(); if (!r) return;
  if (lesson) finishTry(r); else parked(r);
}

let cardH = -1;
function layout(): void { layoutPdc(layoutPlan(stage)); }
function resize(): void { screen.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR); layout(); snapView(); }
window.addEventListener('resize', resize); window.addEventListener('orientationchange', () => setTimeout(resize, 200));

/** The lesson on the screen: the card, and the route, marks and your path on the plan. Outside lessons, the ideal
 *  path layer: the route that set par and where each of its moves ends. */
let ghostOf: Piece[] | null = null;
function drawLesson(): string {
  const ls = lesson;
  if (!ls) {
    const want = settings.layerGhost === 'on' && parRoute.length ? parRoute : null;
    if (want !== ghostOf) { ghostOf = want; setCoachDraw(want ? { route: sample(sim.vehicle, want, 0.1), marks: want.map(p => p.to), from: 0, cur: null, track: null, drift: null } : null); }
    return want ? 'ghost' : '';
  }
  ghostOf = null;
  const run = ls.run, h = ls.st.help, coachOn = !!run && (!run.passive || ls.summoned), marksOn = !!run && run.phase !== 'missed' && run.phase !== 'done' && !ls.over;
  const watchK = ls.watching && guide ? guide.pts[Math.min(guide.at, guide.pts.length - 1)].i : -1;
  setCoachDraw({
    route: ls.watching ? null : (h === 0 || ls.summoned || ls.over) ? ls.routePts : null,
    marks: ls.steps.map(s => s.to), from: ls.watching ? Math.max(0, watchK) : marksOn && (h <= 1 || ls.summoned) ? run!.k : ls.steps.length,
    cur: marksOn && run && !ls.watching ? run.markPose(sim) : null, track: ls.over ? ls.track : null, drift: ls.over ? ls.drift : null,
  });
  renderCard({ def: ls.L.def, help: ls.st.help, steps: ls.steps, run: ls.over ? null : run, summoned: ls.summoned && coachOn, watching: watchK, over: ls.over, slow: ls.st.slow, lockDeg: sim.options.lockDeg, wheel: sim.wheelAngle, v: sim.v });
  const ch = $('coach').hidden ? 0 : $('coach').offsetHeight;
  if (ch !== cardH) { cardH = ch; layout(); }
  return [run?.k, run?.phase, run?.left.toFixed(2), run?.hint, run?.note, ls.over, watchK, h, ls.summoned].join(',');
}

// frame loop: the simulation steps at a fixed 60 Hz (so attempts replay exactly); drawing at 30 fps is plenty
// at parking speeds, and nothing is redrawn while nothing changes
let last = 0, lastSig = '', lastDrawT = 0, wakeUntil = 0, acc = 0;
const wake = () => { wakeUntil = clock() + 1500; };   // keep drawing for a moment after any touch, so panels settle
(['pointerdown', 'pointerup', 'keydown', 'resize'] as const).forEach(ev => window.addEventListener(ev, wake, { passive: true }));
function frame(now: number): void { requestAnimationFrame(frame); tick(now + clockOffset); }
function tick(now: number): void {
  if (now - last < 31) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  acc += dt * (lesson?.st.slow && !replay ? 0.5 : 1);   // slow motion: the same fixed steps, half as many a second
  for (let n = 0; acc >= STEP - 1e-9; n++) {
    if (n === 6) { acc = 0; break; }   // far behind (a stalled tab): drop the backlog rather than race to catch up
    acc -= STEP;
    if (replay) { const evs = replay.step(); if (!evs) { stopReplay(); showBanner('', 'Replay finished', 'Back to your car, where you left it.', null, 2500); break; } handle(evs); continue; }
    // the pedals as held, passed on to the car unless the coach is holding one back; then recorded as the car saw them
    let fwd = pedals.fwd, rev = pedals.rev;
    const run = lesson && !lesson.over ? lesson.run : null;
    if (lesson?.watching || lesson?.over) fwd = rev = false;   // watching, or the try is over: the car waits for Try again
    else if (run && !run.passive) ({ fwd, rev } = run.gate({ fwd, rev }, sim));
    else if (run) run.sync(sim);
    sim.input.fwd = fwd; sim.input.rev = rev;
    recorder.before(sim); const evs = sim.step(STEP); recorder.after(sim);
    if (lesson && !lesson.over && !lesson.watching) { lesson.tracker.add(sim); if (run) coachEvents(run.observe(sim)); }
    handle(evs);
    settle(STEP);
  }
  const S = replay ? replay.sim : sim;
  if (guide) {
    const el = (now - guide.t0) / 1000; let i = guide.times.findIndex(x => x >= el); if (i < 0) i = guide.pts.length - 1; guide.at = i;
    if (guide.watch && el > guide.times[guide.times.length - 1] + 1.2) endWatch();
  }
  updateBeeper(S, now / 1000); updatePdcDisplay(S, now / 1000, screen.dpr);
  const lsSig = replay ? '' : drawLesson();
  const rw = $('btnRewind'), canRw = canRewind(); if (rw.hidden === canRw) rw.hidden = !canRw;
  const layers = settings.layerPath + settings.layerPivot + settings.layerSwept + settings.layerKerb + settings.layerNums;
  const sig = [S.x.toFixed(4), S.z.toFixed(4), S.th.toFixed(5), S.wheelAngle.toFixed(1), S.v.toFixed(3), S.input.fwd, S.input.rev, settings.planView, !!replay, guide ? guide.at : -1, S.scene.id, lsSig, layers].join('|');
  if (sig === lastSig && now > wakeUntil && now - lastDrawT < 1000) return;
  lastSig = sig; lastDrawT = now;
  updateHud(S); drawPlan(S, now / 1000, dt, screen.dpr);
}

// boot: back into what you were playing, keeping the car where it was across a hot reload in the artifact viewer
type Saved = { x?: number; z?: number; th?: number; wheelAngle?: number; hits?: number; elapsed?: number; moves?: number; layout?: number; scene?: string; play?: string; car?: string };
type Hot = { snapshot?: (f: () => Saved) => void; ready?: (f: (saved: Saved) => void) => void; data?: Saved };
const hot = (window as unknown as { claude?: { hot?: Hot } }).claude?.hot;
function start(saved: Saved = {}): void {
  const play = saved.play ?? progress.play;
  useCar(chosenCar());
  if (play.startsWith('lesson:') && lessonById(play.slice(7))) enterLesson(play.slice(7), 'drive');   // a lesson starts its try over
  else {
    const key = parseKey(play), L = key ? generate(sim.vehicle, key.template, key.level, key.seed) : null;
    if (L) { level = L; sim.load(L.scene); setRoute(L.route); } else garagePar();
    resetCar(); refreshLevels();
    if (typeof saved.x === 'number' && typeof saved.z === 'number' && typeof saved.th === 'number' && saved.scene === sim.scene.id && saved.layout === sim.scene.layoutVersion && (saved.car ?? ATTO2.id) === sim.vehicle.id && !sim.touching(saved.x, saved.z, saved.th)) {
      sim.place(saved.x, saved.z, saved.th); sim.wheelAngle = saved.wheelAngle || 0; sim.hits = saved.hits || 0; sim.elapsed = saved.elapsed || 0; sim.moves = saved.moves || 0;
      beginRecording();
    }
  }
  resize(); setTimeout(layout, 300); setTimeout(layout, 1500);
  requestAnimationFrame(t => { last = t; frame(t); });
}
try { hot?.snapshot?.(() => ({ x: sim.x, z: sim.z, th: sim.th, wheelAngle: sim.wheelAngle, hits: sim.hits, elapsed: sim.elapsed, moves: sim.moves, layout: sim.scene.layoutVersion, scene: sim.scene.id, play: lesson ? `lesson:${lesson.L.def.id}` : level ? level.key : 'garage', car: sim.vehicle.id })); } catch { /* not in the viewer */ }
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});

// browser checks only (`vite build --mode harness`); other builds drop this
if (import.meta.env.MODE === 'harness') Object.assign(window, { __game: {
  sim, level: () => level, route: () => parRoute, lesson: () => lesson, pedals, enterLesson,
  /** Run the frame loop for ms of game time at 30 frames a second (automation tabs get no animation frames). */
  pump: (ms: number) => { const t0 = Math.max(last, clock()); for (let k = 33.4; k <= ms + 1e-9; k += 33.4) tick(t0 + k); clockOffset += Math.max(0, t0 + ms - clock()); },
} });

// offline and installable when served as a web app (not inside the artifact viewer)
if (import.meta.env.MODE !== 'artifact' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* no offline mode */ }); });
}
