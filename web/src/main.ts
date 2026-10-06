// Atto 2 Garage Trainer: wires the simulation (core/) to the screen (ui/) and runs the frame loop.
// You play your garage, a generated level, a lesson or a district's streets; all run on the same simulation, which
// loads the scene. On the street you drive in Drive mode and park in Park mode.
import './style.css';
import { CoachRun, Tracker, feedback, timingCause, type CoachEvent, type CoachSnap, type Feedback, type Step } from './core/coach';
import { TowCoach, axleAt, towFeedback, type TowEvent, type TowSnap } from './core/towing';
import { towDrive } from './core/robot';
import type { CheckDone, CheckJob, ParDone, ParJob } from './cityCheck.worker';
import CheckWorker from './cityCheck.worker?worker&inline';
import { buildCity, checkSlot, localScene, lotAt, parkStart, slotMid, slotNear, slotPlace, streetAt, type CityMap, type MapSpec, type Slot } from './core/city';
import { districtId, districtLevel, generateDistrict } from './core/district';
import { alongHeading, lotFit } from './core/lot';
import { facesRight, parkedIn } from './core/parking';
import { ATTO2, GARAGE_561, MAPS, TOW_CAR, VEHICLES, vehicleFor } from './core/content';
import { V_KIN } from './core/dynamics';
import { generate, parseKey, timeLimit, type Level } from './core/generator/level';
import { generateTow } from './core/generator/towLevels';
import type { Scene } from './core/scene';
import type { TemplateId } from './core/generator/templates';
import type { Vehicle } from './core/vehicle';
import { COURSE, HELP, afterTry, checkPass, endHint, lessonById, lessonFor, loadLesson, type Lesson, type LessonState, type Para, type TowLesson } from './core/lesson';
import { lessonSteps, routeNote, tipsFor } from './core/lessonRoutes';
import { DEG, clamp, wrapPi, type Pt } from './core/math';
import { clearStart, fitsBay, moves, planBack, planToBay, sample, type Piece, type Plan, type Pose, type RoutePoint } from './core/planner';
import { Recorder, STEP, playback, replayTo, restoreState, stateOf as simState } from './core/replay';
import { starsFor } from './core/score';
import { Rules } from './core/rules';
import { PDC_MAX, Sim, type Mode, type ParkedResult, type SimEvent } from './core/sim';
import { COUNTRIES, theftNote } from './core/country';
import { DENSITY, TYPES, Traffic, diveFor, networkOf } from './core/traffic';
import { beep, horn, toot, updateBeeper } from './ui/audio';
import { renderCarFacts, renderCarPicker, syncCarPicker } from './ui/cars';
import { bindCard, renderCard, renderTowCard } from './ui/coachCard';
import { bindControls, pedals, releasePedals, setPedalMode, tickPedals } from './ui/controls';
import { bindCourse, courseTab, notFor, renderCourse, setCourseCar, setState, showLesson, showLessonResult, stateOf } from './ui/course';
import { $, MAX_DPR, closeSheets, openSheet, screen } from './ui/dom';
import { parkedCard, touchTitle } from './ui/format';
import { setLimit, setPar, setWheelTarget, showBanner, updateHud } from './ui/hud';
import { bindLevels, hideResult, renderLevels, showResult } from './ui/levels';
import { updatePdcDisplay, layoutPdc } from './ui/pdcDisplay';
import { drawPlan, forgetPrediction, layoutPlan, setCoachDraw, setDriveInfo, setGuide, setStreet, setTowDraw, snapView, upRot, viewMoving, type Guide } from './ui/plan';
import { TEMPLATE_NAMES, bestStars, citySeed, progress, recordStars, seedFor, setCitySeed, setPlaying, setStarsCar } from './ui/progress';
import { lockDeg, saveSettings, settings } from './ui/settings';

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
  tips: Record<string, Para>;   // the lesson's tips on this car's steps
  run: CoachRun | null;    // the coach following this try: guided, or keeping up with the cue marks; null with less help
  tracker: Tracker;        // your path, for the feedback
  fault: string;           // what spoilt this try already ('touch', 'missed'), '' if nothing
  fb: Feedback | null;     // what went wrong, worked out when it went wrong (a miss)
  summoned: boolean;       // help on request: the coach was asked for in this try
  watching: boolean;       // the ghost is showing the route
  over: boolean;           // this try has its result
  track: Pt[] | null; drift: Pt | null;   // after a try: your path, and where it first drifted 30 cm
  rewound: boolean;        // this try went back in time: practice
  mark0: { coach: CoachSnap | null; tow: TowSnap | null; track: number };   // the coaches and the path when the recording last began, for rewinding
  /** A towing lesson: the trailer's coach for this try (null with less help), the trailer's line and where it should end
   *  up (drawn on the floor), and whether the rig has folded up in this try. */
  tow: TowCoach | null; towPath: Pt[]; towGoal: [number, number, number] | null; jack: boolean;
  /** A towing lesson: where the trailer's axle went in this try (every 5 cm), drawn over its line afterwards. */
  towTrack: Pt[];
}
let lesson: LessonPlay | null = null;

/** On the street: the district; in Park mode, the space being parked in, where that try began and how the map stays
 *  turned; the last space you drove on from (stopping beside it again does not start Park mode), the last one a
 *  banner pointed out, the street or car park you are on (for the speed limit) and the car park last introduced. */
interface CityPlay { map: CityMap; slot: Slot | null; from: Pose | null; lockRot: number | null; declined: string; hinted: string; streetId: string; lotHint: string; told: Set<string> }
let city: CityPlay | null = null;
const cityKey = (m: CityMap) => `city:${m.spec.id}:${m.seed}`;
/** The side you park on in the street: the side traffic keeps to. */
const kerbSide = (): string => (city?.map.drive ?? settings.drive);

/** The car chosen in Setup: the garage, the levels and the lessons all use it. */
const chosenCar = (): Vehicle => vehicleFor(settings.car, parseFloat(settings.ras));
/** Drive v from the next reset on, with its facts in Info. Stars are the chosen car's: only the garage and levels keep them. */
function useCar(v: Vehicle): void {
  setStarsCar(chosenCar().id); setCourseCar(chosenCar().id); renderCarFacts(v); syncCarPicker(chosenCar());
  if (sim.vehicle === v) return;
  sim.setVehicle(v); forgetPrediction(); hideGuide();
}
const carNote = (v: Vehicle) => `${v.short}: ${(v.L + 1e-9).toFixed(2)} × ${(v.W + 1e-9).toFixed(2)} m, turning circle ${(2 * v.R_CC).toFixed(2)} m kerb to kerb${v.REAR_DEG ? `, ${v.REAR_DEG}° rear-axle steering` : ''}.`;

const applySettings = () => {
  sim.options.lockDeg = lockDeg(); sim.options.selfCentre = settings.center === 'on';
  sim.options.bay = lesson ? lesson.L.bay : level ? sim.scene.defaultBay : city ? (city.slot?.id ?? '') : settings.bay;
  sim.wheelAngle = clamp(sim.wheelAngle, -sim.options.lockDeg, sim.options.lockDeg);
};
const garageSlot = () => `garage:${settings.bay}:${settings.start}`;
const garageName = () => `Bay ${settings.bay} · from the ${settings.start === 'across' ? 'other side of the aisle' : settings.start}`;
const levelName = (L: Level) => `${TEMPLATE_NAMES[L.template].short} · level ${L.level}`;
const clearPedals = () => { releasePedals(); sim.input.fwd = sim.input.rev = false; sim.input.acc = sim.input.brk = 0; };
/** Park mode or Drive mode: the car, the pedals' meaning and the button that switches (only on the street). */
function setMode(m: Mode): void {
  sim.setMode(m); setPedalMode(sim.mode === 'drive');
  const b = $('btnMode'); b.hidden = !city; b.textContent = sim.mode === 'drive' ? 'Park' : 'Drive'; b.classList.toggle('drive', sim.mode === 'park');
  $('driveBtns').hidden = !city;
  layout();   // the buttons between the wheel and the pedals change the map's free band
}
/** Off the street: Park mode, north up, no speed limit. */
function leaveCity(): void {
  if (!city) return;
  city = null; sim.traffic = null; sim.rules = null; horn(false);
  setStreet(null); setDriveInfo(null); setLimit(null); setMode('park'); checker?.terminate(); checker = null; parWorker?.terminate(); parWorker = null;
}
/** The district's traffic from its layout number (the same every time), as many cars as Setup asks for (none: just the
 *  lights), clear of where you are, with parked cars that will pull out and couriers (more of each in busy traffic) and a
 *  spot thief (two in a tight district, where they wait 3 s for you to claim a space; 8 s in a roomy one, 5 s elsewhere);
 *  and a fresh drive for the rules. */
function spawnTraffic(c: CityPlay, at: { x: number; z: number } = c.map.start): void {
  const net = networkOf(c.map), busy = settings.traffic === 'busy', level = districtLevel(c.map.spec.id) ?? 5;
  c.map.scene.net = net;
  sim.traffic = settings.traffic === 'off' ? Traffic.spawn(net, c.map.seed, 0, at)
    : Traffic.spawn(net, c.map.seed, DENSITY[settings.traffic], at, { leavers: busy ? 5 : 3, couriers: busy ? 2 : 1, thieves: level >= 8 ? 2 : 1, patience: level <= 3 ? 8 : level >= 8 ? 3 : 5 });
  sim.rules = new Rules(net, COUNTRIES[settings.country]);
}
/** Whether a space is free now: none parked in it for the moment. */
const freeNow = (s: Slot): boolean => !sim.traffic?.taken(s.id);
/** The district's free spaces checked in the background, nearest the start first: can the planner park this car there?
 *  Without a worker (or before its answer comes) a space is checked the moment you slow down beside it. A second worker
 *  works out par for each try, so the map never stops while the planner thinks (a car park's bay can take a second or
 *  more on a phone). */
let checker: Worker | null = null, parWorker: Worker | null = null, parTicket = 0;
function checkSpaces(c: CityPlay): void {
  checker?.terminate(); checker = null; parWorker?.terminate(); parWorker = null;
  try { parWorker = new CheckWorker(); } catch { parWorker = null; }
  if (parWorker) {
    parWorker.onmessage = (e: MessageEvent<ParDone>) => { if (e.data.ticket === parTicket && city === c) setRoute(e.data.pieces ?? []); };
    parWorker.onerror = () => { parWorker?.terminate(); parWorker = null; };
  }
  try { checker = new CheckWorker(); } catch { return; }
  const v = sim.vehicle, s0 = c.map.start, mid = slotMid;
  const order = c.map.slots.slice().sort((a, b) => Math.hypot(mid(a)[0] - s0.x, mid(a)[1] - s0.z) - Math.hypot(mid(b)[0] - s0.x, mid(b)[1] - s0.z)).map(s => s.id);
  checker.onmessage = (e: MessageEvent<CheckDone>) => {
    if (city !== c || e.data.seed !== c.map.seed) return;
    const s = c.map.slots.find(q => q.id === e.data.id);
    if (s && s.parkable === undefined) { s.parkable = e.data.parkable; syncStreet(); }
  };
  checker.onerror = () => { checker?.terminate(); checker = null; };
  checker.postMessage({ kind: 'check', spec: c.map.spec, car: v.spec, rearDeg: v.REAR_DEG, seed: c.map.seed, drive: c.map.drive, order } satisfies CheckJob);
}
const syncStreet = () => setStreet(city ? { slots: city.map.slots, target: city.slot, lockRot: city.lockRot } : null);
/** Paint a message first, then do the slow part (generating a level, planning a route) on the next frame,
 *  or after 150 ms where frames are held back (a hidden tab, some embedded views). */
function afterPaint(f: () => void): void {
  let done = false; const go = () => { if (!done) { done = true; f(); } };
  requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 150);
}

/** Start recording from the car as it is; in a lesson, remember the coach and the path too, for a rewind. */
function beginRecording(): void {
  recorder.begin(sim);
  if (lesson) lesson.mark0 = { coach: lesson.run?.snapshot() ?? null, tow: lesson.tow?.snapshot() ?? null, track: lesson.tracker.pts.length };
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
  if (city) { resetCity(); return; }
  stopReplay(); hideGuide(); hideResult(); applySettings();
  if (level?.tow) { const s = level.tow.start; sim.resetAt(s.x, s.z, s.th, s.tth); }
  else if (level) sim.reset('start'); else { const s = garageStart(); sim.resetAt(s.x, s.z, s.th); }
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

function leaveLesson(): void { lesson = null; setCoachDraw(null); setTowDraw(null); setWheelTarget(null); renderCard(null); sim.setTrailer(null); useCar(chosenCar()); layout(); }
function enterLevel(L: Level): void {
  leaveLesson(); leaveCity(); level = L;
  if (L.tow) { useCar(L.tow.car); sim.setTrailer(L.tow.trailer); renderCarFacts(L.tow.car, L.tow.trailer); }   // a trailer level brings its rig
  sim.load(L.scene);
  if (L.tow) { parRoute = []; par = L.par; limit = L.timeLimit; setPar(par); } else setRoute(L.route);
  setPlaying(L.key, L.template, L.level, L.seed);
  snapView(); resetCar(); refreshLevels();
}
function playLevel(t: TemplateId, n: number, seed: number): void {
  stopReplay(); hideGuide(); closeSheets();
  showBanner('', 'Building the level…', `${TEMPLATE_NAMES[t].long}, level ${n}`, null);
  afterPaint(() => {
    const L = t === 'tow' ? generateTow(n, seed) : generate(chosenCar(), t, n, seed);
    if (L) enterLevel(L); else showBanner('bad', 'No level from this layout', 'Try another: Play, then New layout.', null, 4000);
  });
}
function playGarage(): void {
  leaveLesson(); leaveCity(); level = null; sim.load(GARAGE_561); garagePar(); setPlaying('garage'); closeSheets();
  snapView(); resetCar(); refreshLevels();
}
const refreshLevels = () => {
  const v = chosenCar(), map = MAPS.harbour, made = city && districtLevel(city.map.spec.id) !== null;
  // the made-up district at the chosen level: the one you are in, or the one its last layout makes
  const gl = +settings.district, gid = districtId(gl), gSeed = made && city!.map.spec.id === gid ? city!.map.seed : citySeed(gid), gen = generateDistrict(gSeed, gl);
  const word = gl <= 3 ? 'roomy' : gl >= 8 ? 'tight' : 'average';
  renderLevels(level ? level.key : lesson ? '' : city ? (made ? 'district' : 'city') : 'garage', garageName(), garageSlot(),
    { name: map.name, sub: `Drive around, then park on the street${map.lots?.length ? ' or in a car park' : ''} · layout ${city && !made ? city.map.seed : citySeed(map.id)}`, stars: bestStars(`city:${map.id}`) },
    { name: gen.name, sub: `Made up for you, ${word} · ${gen.roads.length} streets${gen.lots?.length ? `, ${gen.lots.length === 1 ? 'a car park' : `${gen.lots.length} car parks`}` : ''} · layout ${gSeed}`, stars: bestStars(`city:${gid}`) });
  renderCourse(lesson ? lesson.L.def.id : null, v);
  $('lvCar').textContent = v === ATTO2 ? '' : `Built for the ${v.short}: the bays grow for a car bigger than the Atto 2, the aisles and kerb spaces stay as they are.`; $('lvCar').hidden = v === ATTO2;
  $('crsCar').textContent = `Worked out for the ${v.short}: its own routes, marks and numbers, and its own progress. A lesson it cannot do here is greyed out.`; $('crsCar').hidden = v === ATTO2;
};
const newSeed = () => 1 + Math.floor(Math.random() * 99999);

// ---- the street ----

/** A street map by its id: a hand-made one, or a made-up district (gen5: level 5) from its layout number. */
const mapFor = (id: string, seed: number): MapSpec | null => MAPS[id] ?? (districtLevel(id) !== null ? generateDistrict(seed, districtLevel(id)!) : null);
/** A district for the chosen car (its free spaces are worked out for it): its last layout, or a new one. */
function playCity(fresh: boolean, id = 'harbour', seed = fresh ? newSeed() : citySeed(id)): void {
  stopReplay(); hideGuide(); closeSheets();
  const map = mapFor(id, seed) ?? MAPS.harbour;
  showBanner('', 'Building the district…', `${map.name}, layout ${seed}`, null);
  afterPaint(() => enterCity(buildCity(map, chosenCar(), seed, settings.drive)));
}
function enterCity(map: CityMap): void {
  leaveLesson(); level = null; useCar(chosenCar());
  city = { map, slot: null, from: null, lockRot: null, declined: '', hinted: '', streetId: '', lotHint: '', told: new Set() };
  sim.load(map.scene); setRoute([]); setCitySeed(map.spec.id, map.seed); setPlaying(cityKey(map));
  snapView(); resetCar(); refreshLevels(); checkSpaces(city);
}
/** Reset on the street: in Park mode, back to where this try at the space began; else back to the district's start. */
function resetCity(): void {
  const c = city!;
  stopReplay(); hideGuide(); hideResult();
  if (c.slot && c.from) {
    const world = recorder.rec?.start.world;   // the traffic as it was when this try began
    sim.resetAt(c.from.x, c.from.z, c.from.th); if (world) sim.restoreWorld(world); setMode('park'); applySettings(); forgetPrediction(); clearPedals();
    settledT = 0; tryOver = false; tryRewound = false; beginRecording();
    showBanner('', `Park ${c.slot.kind === 'lot' ? 'in' : 'on'} ${slotPlace(c.slot)} · again`, `${c.slot.kind === 'lot' ? `Bay ${c.slot.at.n}, or any free bay.` : `The ${fmtLen(c.slot.length)} space on your ${kerbSide()}.`}${par ? ` Par: ${par} ${par === 1 ? 'move' : 'moves'}.` : ''}`, null, 5000);
    return;
  }
  const s = c.map.start;
  sim.resetAt(s.x, s.z, s.th); c.slot = null; c.from = null; c.lockRot = null; c.hinted = ''; c.lotHint = '';
  spawnTraffic(c);
  c.declined = slotNear(c.map, sim.vehicle, s.x, s.z, s.th, freeNow)?.id ?? '';   // a space beside the start waits until you have driven on
  setMode('drive'); applySettings(); setRoute([]); syncStreet(); forgetPrediction(); clearPedals(); snapView();
  settledT = 0; tryOver = false; tryRewound = false; beginRecording();
  showBanner('', c.map.spec.name, `Drive along the streets and park in a free space on your ${kerbSide()}, between the cars${c.map.lots.length ? ', or in a car park' : ''}. Stop beside one and Park mode takes over. Accelerator and brake: higher up on the button for more.`, null, 9000);
}
const fmtLen = (m: number) => `${(m + 1e-9).toFixed(1)} m`;
/** Into Park mode beside a space (or anywhere, with no space to aim for): Forward and Reverse, the map holds still, and
 *  a new try begins, with par from the route planner. */
function enterPark(slot: Slot | null): void {
  const c = city!, v = sim.vehicle;
  setMode('park'); clearPedals();
  c.slot = slot; c.from = { x: sim.x, z: sim.z, th: sim.th }; c.lockRot = upRot(slot?.kind === 'lot' ? aisleHeading(slot) : slot ? slot.th : sim.th); applySettings();
  Object.assign(sim, { hits: 0, elapsed: 0, moves: 0, moveSign: 0, started: false, parked: false });
  settledT = 0; tryOver = false; tryRewound = false; setRoute([]); syncStreet(); hideGuide(); forgetPrediction(); beginRecording();
  if (!slot) {
    const lot = lotAt(c.map, sim.x, sim.z), why = lot ? lotFit(lot, v) : '';
    showBanner('', 'Park mode', why ? `${why} Tap Drive and find a space on the street.` : 'Forward and Reverse, as in the garage. There is no free space here that your car fits: tap Drive to drive on.', null, 5000);
    return;
  }
  if (slot.kind === 'lot') {
    const [W, D] = slot.lot.size, way = slot.lot.angle === 90 ? 'Nose first or reversed in: either counts.' : 'Nose first: the bays lean the way the aisle runs.';
    showBanner('', `Park mode · bay ${slot.at.n}`, `On your ${bayOnRight(slot) ? 'right' : 'left'}, ${W.toFixed(1)} × ${D.toFixed(1)} m, or any free bay. ${way} Show me has the route.`, null, 6000);
  } else showBanner('', `Park mode · ${fmtLen(slot.length)} space`, `On your ${kerbSide()}, ${fmtLen(slot.length - v.L)} longer than your car. Forward and Reverse, as in the garage; Show me has the route.`, null, 6000);
  planPar(c, slot);
}
/** Par for a try: the planner's route from where the try began into the space, worked out by the par worker (or,
 *  without one, after the next paint). */
function planPar(c: CityPlay, slot: Slot): void {
  const from = c.from, v = sim.vehicle, ticket = ++parTicket;
  if (!from) return;
  if (parWorker) { parWorker.postMessage({ kind: 'par', spec: c.map.spec, car: v.spec, rearDeg: v.REAR_DEG, seed: c.map.seed, drive: c.map.drive, slot: slot.id, from, ticket } satisfies ParJob); return; }
  afterPaint(() => {
    if (city !== c || c.slot !== slot || c.from !== from || ticket !== parTicket) return;
    const plan = planBack(v, localScene(c.map, slot), from, slot.id, { maxNodes: 6000 });
    setRoute(plan.status === 'found' ? plan.pieces : []);
  });
}
/** A car park's aisle as you face along it: the map turns so it runs up the screen. */
function aisleHeading(slot: Slot & { kind: 'lot' }): number {
  const a = alongHeading(slot.lot.along, 1);
  return Math.cos(sim.th - a) >= 0 ? a : alongHeading(slot.lot.along, -1);
}
/** Whether a bay's mouth is on the car's right. */
function bayOnRight(slot: Slot & { kind: 'lot' }): boolean {
  const [mx, mz] = slot.at.mouth;
  return (mx - sim.x) * Math.sin(sim.th) + (mz - sim.z) * Math.cos(sim.th) > 0;
}
/** In Park mode in a car park any free bay counts: stopped and parked in another one, it becomes the space (par stays
 *  the planner's from where you stopped, into the bay you stopped beside). Only once you have stopped in it, so a bay
 *  you pass on the way never takes over. */
function retarget(c: CityPlay): void {
  const cur = c.slot; if (cur?.kind !== 'lot' || Math.abs(sim.v) > 0.02) return;
  for (const s of c.map.slots) {
    if (s === cur || s.kind !== 'lot' || s.lot !== cur.lot || s.parkable === false) continue;
    const at = parkedIn(sim.vehicle, s.bay, sim.x, sim.z, sim.th);
    if (!at || !facesRight(s.bay, at)) continue;
    c.slot = s; applySettings(); syncStreet();
    showBanner('', `Bay ${s.at.n} then`, 'Any free bay counts.', null, 2500);
    return;
  }
}
/** Back into Drive mode: the accelerator and brake, the map turning with you. */
function enterDrive(): void {
  const c = city!;
  const near = slotNear(c.map, sim.vehicle, sim.x, sim.z, sim.th, freeNow);
  c.declined = near?.id ?? ''; c.slot = null; c.from = null; c.lockRot = null;
  setMode('drive'); applySettings(); setRoute([]); syncStreet(); hideGuide(); hideResult(); forgetPrediction(); beginRecording();
}
/** The Park / Drive button (and P on a keyboard). */
function switchMode(): void {
  if (!city || replay) return;
  if (sim.mode === 'drive') {
    if (sim.v > V_KIN) { showBanner('', 'Slow down to park', 'Park mode takes over below 7 km/h.', null, 2500); return; }
    enterPark(slotNear(city.map, sim.vehicle, sim.x, sim.z, sim.th, freeNow));
  } else {
    if (sim.v < -0.1) { showBanner('', 'Stop first', 'Drive mode only goes forwards.', null, 2500); return; }
    enterDrive(); showBanner('', 'Drive mode', 'Accelerator and brake: higher up on the button for more. Stop beside a free space and Park mode takes over.', null, 4000);
  }
}
/** Each frame on the street: Park mode beside a space you stopped at (a hint as you slow down next to one), Drive mode
 *  again once you pull away above 10 km/h, and the street you are on with its speed limit. */
function cityFrame(): void {
  const c = city; if (!c || replay) return;
  const v = sim.vehicle;
  const lot = lotAt(c.map, sim.x, sim.z);
  if (sim.mode === 'drive') {
    // into a car park: its speed limit and how it works, once each time (or why your car will not fit its bays)
    if (lot && c.lotHint !== lot.id) {
      c.lotHint = lot.id; const why = lotFit(lot, v);
      showBanner(why ? 'bad' : '', lot.name, why ? `${why} Look for a space on the street.` : `${lot.limit} km/h. Stop in an aisle beside a free bay and Park mode takes over: ${lot.angle === 90 ? 'nose first or reversed in' : 'nose first, the way the bays lean'}.`, null, 5000);
    }
    if (!lot) c.lotHint = '';
    let near = sim.v < 15 / 3.6 ? slotNear(c.map, v, sim.x, sim.z, sim.th, freeNow) : null;
    // a space the planner cannot park your car in drops off the map (checked in the background; without a worker, the
    // first time you slow down beside it)
    if (near && near.parkable === undefined && !checker) checkSlot(c.map, v, near);
    if (near && near.parkable === false) {
      if (c.hinted !== near.id) { c.hinted = near.id; showBanner('', `Too tight for the ${v.short}`, `This ${near.kind === 'lot' ? 'bay' : `${fmtLen(near.length)} space`} has room for your car, but no way in that the planner could find. Look for ${near.kind === 'lot' ? 'another' : 'a longer one'}.`, null, 4000); }
      syncStreet(); near = null;
    }
    if (!near) c.declined = '';
    else if (near.id !== c.declined) {
      if (sim.v < 0.1 && pedals.acc === 0) enterPark(near);
      else if (c.hinted !== near.id && near.kind === 'kerb') { c.hinted = near.id; showBanner('', `A ${fmtLen(near.length)} space on your ${kerbSide()}`, 'Stop beside it, level with the car in front of it, and Park mode takes over.', null, 3500); }
    }
  } else {
    // a thief dived into the space you were after: you lose it, not points (and once you have stopped, you drive on)
    const thief = c.slot?.kind === 'kerb' ? sim.traffic?.thiefIn(c.slot.id) : null;
    if (thief) {
      if (!c.told.has(`took:${c.slot!.id}`)) {
        c.told.add(`took:${c.slot!.id}`);
        showBanner('bad', 'A thief took the space', `The ${TYPES[thief.type].name} dived in nose first while you waited. ${theftNote(sim.rules?.country ?? COUNTRIES[settings.country])} You lose the space, not points: find another. Next time signal and start reversing sooner.`, null, 8000);
      }
      if (Math.abs(sim.v) < 0.05 && !pedals.fwd && !pedals.rev) enterDrive();
      return;
    }
    retarget(c);
    if (sim.v > PDC_MAX && pedals.fwd) { enterDrive(); showBanner('', 'Drive mode', 'Your finger on Forward is now the accelerator.', null, 3000); }
  }
  cityHints(c);
  const st = sim.mode === 'drive' ? streetAt(c.map, sim.x, sim.z, sim.th) : null, inLot = sim.mode === 'drive' && !st ? lot : null, id = st?.id ?? inLot?.id ?? '';
  if (id !== c.streetId) {
    c.streetId = id;
    setDriveInfo(st ? `<div><span>Street</span>${st.name}</div>` : inLot ? `<div><span>Car park</span>${inLot.name}</div>` : '');
    setLimit(st ? st.limit : inLot ? inLot.limit : null);
  }
}
/** What the traffic round you is up to, once each: a parked car ahead of you signalling to pull out (how to wait for its
 *  space), a thief waiting for the space you are after (how to claim it in time), and one giving up on it. */
function cityHints(c: CityPlay): void {
  const t = sim.traffic; if (!t) return;
  const v = sim.vehicle, ux = Math.cos(sim.th), uz = -Math.sin(sim.th), fx = sim.x + (v.L - v.OVR) * ux, fz = sim.z + (v.L - v.OVR) * uz, side = kerbSide();
  for (const car of t.cars) {
    const dx = car.x - fx, dz = car.z - fz, along = dx * ux + dz * uz, across = Math.abs(dx * uz - dz * ux);
    if (car.state === 'parked' && car.ind && sim.mode === 'drive' && along > 0 && along < 45 && across < 5 && Math.cos(car.h - sim.th) > 0.8 && !c.told.has(`leaver:${car.id}`)) {
      c.told.add(`leaver:${car.id}`);
      showBanner('', 'A parked car is pulling out', `Its indicator is on. Stop a little behind it, leaving it room, and signal ${side}: once it has gone, the space is yours.`, null, 6000);
    }
    if (car.aim && car.aimT >= 0 && Math.hypot(dx, dz) < 40 && !c.told.has(`thief:${car.id}:${car.aim}`)) {
      c.told.add(`thief:${car.id}:${car.aim}`);
      showBanner('bad', 'A thief wants the space', `The ${TYPES[car.type].name} behind is waiting to dive in. Signal ${side} and start reversing into the space within ${t.patience} s, or it is gone.`, null, Math.max(4000, t.patience * 1000));
    }
    const mine = c.slot?.kind === 'kerb' ? c.slot.id : '';
    if (mine && c.told.has(`thief:${car.id}:${mine}`) && !car.aim && car.state === 'drive' && !t.thiefIn(mine) && !c.told.has(`mine:${mine}`)) {
      c.told.add(`mine:${mine}`);
      showBanner('good', 'The space is yours', 'You signalled and began to reverse in time: the thief drives on.', null, 3500);
    }
  }
}
/** The other cars' horns, as each honk starts: louder the nearer it is (80 m at most). */
const heard = new Map<number, number>();
function streetSounds(): void {
  const S = replay ? replay.sim : sim, t = S.traffic;
  if (!t) { heard.clear(); return; }
  for (const c of t.cars) {
    if (c.honk < 0 || heard.get(c.id) === c.honk) continue;
    heard.set(c.id, c.honk);
    const d = Math.hypot(c.x - S.x, c.z - S.z);
    if (t.t - c.honk < 0.3 && d < 80) toot(1 / (1 + d / 15), c.imp);
  }
}
bindLevels({ playLevel, playGarage, playCity, playDistrict: fresh => playCity(fresh, districtId(+settings.district)) });

// ---- lessons ----

/** Into a lesson in the chosen car: its scene, its route, where you are in it; then the lesson card, or straight into a
 *  try. False when the lesson is not for this car. */
function enterLesson(id: string, then: 'card' | 'drive' = 'card'): boolean {
  const def = lessonById(id); if (!def) return false;
  const v = def.tow ? vehicleFor(TOW_CAR) : chosenCar();   // a towing lesson brings the car with the tow bar
  if (!lessonFor(v, def)) { showBanner('bad', `Lesson ${def.n} is not for the ${v.short}`, notFor(def, v, true), null, 5000); return false; }
  stopReplay(); hideGuide(); closeSheets(); leaveCity();
  useCar(v);
  const L = loadLesson(v, def), T = L.tow;
  sim.setTrailer(T ? T.trailer : null); renderCarFacts(v, sim.trailer);
  level = null;
  const end = T?.path.pts[T.path.pts.length - 1];
  lesson = {
    L, steps: T ? [] : lessonSteps(v, L), tips: T ? {} : tipsFor(def, L.route), routePts: T ? [] : sample(v, L.route, 0.1), st: stateOf(id), run: null, tracker: new Tracker(), fault: '', fb: null, summoned: false, watching: false, over: false, track: null, drift: null, rewound: false, mark0: { coach: null, tow: null, track: 0 },
    tow: null, towPath: T ? T.path.pts.map((p): Pt => [p.x, p.z]) : [], towGoal: T && end ? [end.x + T.trailer.L1 * Math.cos(end.th), end.z - T.trailer.L1 * Math.sin(end.th), end.th] : null, jack: false, towTrack: [],
  };
  sim.load(L.scene); if (T) { parRoute = []; par = L.par; limit = L.limit; setPar(par); } else setRoute(L.route); setPlaying(`lesson:${id}`);
  snapView(); startTry(); refreshLevels();
  if (then === 'card') lessonCard();
  return true;
}
function lessonCard(): void {
  const ls = lesson; if (!ls) return;
  showLesson(ls.L.def, ls.st, {
    watch: () => { closeSheets(); startWatch(); },
    drive: () => { closeSheets(); startTry(); },
    test: () => { ls.st = { ...ls.st, help: 3, passes: 0, fails: 0, slow: false }; setState(ls.L.def.id, ls.st); closeSheets(); startTry(); },
  }, sim.vehicle, ls.L, routeNote(ls.L.def, sim.vehicle, ls.L.route));
}
/** A new try from the lesson's start, with as much help as you are at. */
/** Where the trailer's axle has gone in a towing lesson, a point every 5 cm. */
function trackTrailer(ls: LessonPlay): void {
  const T = ls.L.tow; if (!T || !sim.trailer) return;
  const a = axleAt(sim.vehicle, sim.trailer, sim.x, sim.z, sim.th, sim.tth), l = ls.towTrack[ls.towTrack.length - 1];
  if (!l || Math.hypot(a[0] - l[0], a[1] - l[1]) >= 0.05) ls.towTrack.push(a);
}
/** A towing lesson's coach for this try, its hand starting from the wheel as it is. */
function towCoach(ls: LessonPlay, passive: boolean): TowCoach {
  const T = ls.L.tow!, c = new TowCoach(sim.vehicle, T.trailer, T.path, () => sim.options.lockDeg, passive);
  c.pilot.hold(sim.wheelAngle);
  return c;
}
function startTry(): void {
  const ls = lesson!; stopReplay(); hideGuide(); hideResult(); applySettings();
  const T = ls.L.tow;
  if (T) sim.resetAt(T.start.x, T.start.z, T.start.th, T.start.tth); else { const s = ls.L.route[0].from; sim.resetAt(s.x, s.z, s.th); }
  forgetPrediction(); clearPedals();
  settledT = 0; tryOver = false; tryRewound = false;
  Object.assign(ls, { fault: '', fb: null, summoned: false, watching: false, over: false, track: null, drift: null, rewound: false, jack: false, towTrack: [] });
  ls.tracker.reset(); ls.tracker.add(sim); trackTrailer(ls);
  ls.run = !T && ls.st.help <= 1 ? new CoachRun(sim.vehicle, ls.steps, () => sim.options.lockDeg, ls.st.help === 1) : null;
  ls.tow = T && ls.st.help <= 1 ? towCoach(ls, ls.st.help === 1) : null;
  beginRecording();
  const h = ls.st.help, def = ls.L.def;
  const how = T ? (h === 0 ? 'Hold Reverse and keep your hand on the wheel: turn it to the blue mark on its rim. The coach keeps the trailer to a crawl and stops it in the space.'
    : h === 1 ? 'The trailer\u2019s line is on the plan: keep the trailer on it yourself, with small corrections, early.'
    : h === 2 ? 'No line now. Show me and the coach are there if you need them.' : 'The test: no help, and the stars count.')
    : h === 0 ? 'Set the wheel as the card says, then hold the pedal: the coach keeps you at walking pace and stops you on each mark.'
    : h === 1 ? 'Only the marks now: stop on each one yourself, then set the wheel for the next.'
    : h === 2 ? 'No marks now. Show me and the coach are there if you need them.' : 'The test: no help, and the stars count.';
  showBanner('', `Lesson ${def.n} · ${HELP[h].name}`, how + (ls.st.slow ? ' Slow motion is on.' : ''), null, 6000);
}
/** Watch: the ghost drives the route from the start, pausing on each mark while the card says what happens there. */
function startWatch(): void {
  const ls = lesson!; startTry(); ls.watching = true;
  if (ls.L.tow) { towGhost(clock(), true, ls.L.scene, ls.L.bay, ls.L.tow); return; }
  const pts = sample(sim.vehicle, ls.L.route, 0.05), times: number[] = [];
  let t = 0.8;
  pts.forEach((p, i) => { if (i) { t += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) / 1.4; if (p.i !== pts[i - 1].i) t += 1.8; } times.push(t); });
  guide = { pts, at: 0, times, t0: clock(), watch: true }; setGuide(guide);
  btnShow.textContent = 'Stop'; btnShow.classList.add('on');
  showBanner('', `Watch: ${ls.steps.length} steps`, 'The ghost drives the route and stops on each mark. The card says what to do there.', null, 4000);
}
/** Show me in a towing lesson (and its Watch): the coach's guided driver backs the trailer in from where the rig is now,
 *  and a ghost rig plays that drive at three times the speed. */
function towGhost(now: number, watch: boolean, scene: Scene, bay: string, T: TowLesson): void {
  const pts: Guide['pts'] = [], times: number[] = [];
  const from = { x: sim.x, z: sim.z, th: sim.th, tth: sim.tth };
  let t = 0.8;
  const res = towDrive(sim.vehicle, T.trailer, scene, bay, from, T.path, {}, s => {
    const l = pts[pts.length - 1];
    if (l && Math.hypot(s.x - l.x, s.z - l.z) < 0.05) return;
    if (l) t += Math.hypot(s.x - l.x, s.z - l.z) / 1.5;
    pts.push({ x: s.x, z: s.z, th: s.th, tth: s.tth, dir: s.v < 0 ? -1 : 1, i: 0 }); times.push(t);
  });
  if (!res.r || pts.length < 2) { showBanner('bad', 'No way in from here', 'Pull forward to straighten the trailer, or tap Reset to start again.', null, 4000); if (watch && lesson) lesson.watching = false; return; }
  guide = { pts, at: 0, times, t0: now, watch, follow: true }; setGuide(guide);
  btnShow.textContent = watch ? 'Stop' : 'Hide'; btnShow.classList.add('on');
  showBanner('', watch ? 'Watch' : 'Show me', `The ghost backs the trailer into the space${res.lost ? ', pulling forward to straighten it first' : ''}, three times as fast as you will. Watch how little the wheel moves once the trailer is on its line.`, null, 5000);
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
  summon: () => {
    const ls = lesson; if (!ls) return; ls.summoned = true;
    if (ls.L.tow) { ls.tow = towCoach(ls, true); beginRecording(); return; }
    ls.run = new CoachRun(sim.vehicle, ls.steps, () => sim.options.lockDeg, true); ls.run.jumpTo(sim); beginRecording();
  },
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

function towEvents(evs: TowEvent[]): void {
  const ls = lesson; if (!ls) return;
  for (const e of evs) {
    if (e.type === 'lost') { beep(220, 0.25, 0.1); showBanner('bad', 'The trailer got away', 'Stop, then pull forward with the wheels straight until it is back in line behind the car.', null, 4000); }
    else if (e.type === 'lined') { beep(660, 0.06, 0.05); showBanner('', 'Back in line', 'Reverse again, your hand at the bottom of the wheel.', null, 2500); }
    else if (e.type === 'done' && ls.tow && !ls.tow.passive) finishTry(sim.parkedResult());
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
  let fb = pass ? null : ls.L.tow ? { text: towFeedback(r, rule, ls.L.par, ls.jack), step: 0, at: null, off: 0 } : (ls.fb ?? feedback(sim.vehicle, ls.L.route, ls.steps, ls.tracker.pts));
  if (fb && !ls.L.tow && (!fb.at || fb.text.startsWith('You drifted'))) fb = timingCause(sim.vehicle, ls.L.route, ls.steps, ls.tracker.pts) ?? (fb.at ? fb : { ...fb, text: (r && endHint(r, rule, ls.L.par)) ?? fb.text });
  const stars = test && r ? starsFor(r, ls.L.par, ls.L.limit) : null;
  const { state, change } = practice ? { state: { ...ls.st }, change: null } : afterTry(ls.st, pass);
  const better = !!stars && pass && stars.count > state.best;
  if (better) state.best = stars!.count;
  state.focus = fb?.step ?? 0;
  ls.st = state; setState(def.id, state);
  ls.track = ls.tracker.pts.map((p): Pt => [p.x, p.z]); ls.drift = fb?.at ?? null;
  const next = COURSE.lessons.find(l => l.n > def.n && lessonFor(sim.vehicle, l));
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
  mode: switchMode,
  indicator: dir => { if (city && !replay) { sim.ind = sim.ind === dir ? 0 : dir; sim.indArmed = false; } },
  hazard: () => { if (city && !replay) sim.hazard = !sim.hazard; },
  horn: on => horn(on && !!city),
  settingChanged: key => {
    if (key === 'car' || key === 'ras') {
      const v = chosenCar(); syncCarPicker(v);
      if (lesson) {   // the same lesson in the new car, or back to the garage when it is not for this car
        const id = lesson.L.def.id;
        if (!enterLesson(id, 'card')) playGarage();
        return;
      }
      useCar(v);
      if (city) { playCity(false, city.map.spec.id, city.map.seed); return; }
      if (level) playLevel(level.template, level.level, level.seed);
      else { garagePar(); resetCar(); if (fitsBay(v, GARAGE_561, settings.bay)) showBanner('', `Now driving the ${v.short}`, carNote(v) + (par ? ` Par in bay ${settings.bay}: ${par} ${par === 1 ? 'move' : 'moves'}.` : ''), null, 6000); }
      return;
    }
    if (key === 'country') {   // the same layout under the other country's rules (and on its side of the road)
      settings.drive = COUNTRIES[settings.country].drive; saveSettings();
      if (city) playCity(false, city.map.spec.id, city.map.seed);
      return;
    }
    if (key === 'district') { refreshLevels(); return; }
    if (key === 'traffic') { if (city && !replay) { spawnTraffic(city, sim); beginRecording(); } return; }   // the new traffic round where you are
    if (key === 'start' || key === 'bay') { if (level || lesson || city) playGarage(); else { garagePar(); resetCar(); } }
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
  if (city && !city.slot) { showBanner('', 'Show me parks you', sim.mode === 'drive' ? `Stop beside a free space on your ${kerbSide()}: Park mode takes over, and Show me has the route in.` : 'There is no space here to show the way into: tap Drive and find one.', null, 4000); return; }
  if (lesson?.L.tow) { if (lesson.over) return; towGhost(now, false, lesson.L.scene, lesson.L.bay, lesson.L.tow); return; }
  if (level?.tow) { towGhost(now, false, level.scene, level.scene.defaultBay, level.tow); return; }
  const from: Pose = { x: sim.x, z: sim.z, th: sim.th }, s0 = parRoute[0]?.from;
  if (s0 && Math.hypot(from.x - s0.x, from.z - s0.z) < 0.05 && Math.abs(wrapPi(from.th - s0.th)) < DEG) { if (lesson) startWatch(); else startGuide(parRoute, now); return; }
  showBanner('', 'Working out a route…', 'From where your car is now.', null);
  afterPaint(() => {
    const v = sim.vehicle, sc = city?.slot ? localScene(city.map, city.slot) : sim.scene, bay = sim.options.bay, kerb = sc.bays[bay]?.kind === 'kerb', lvls = lesson ? [-1, 0, 1] : undefined;
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
  if (city?.slot) { parkedOnStreet(r, city, city.slot); return; }
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

/** Parked on the street: the stars for this space (best per district), and the card: try again, a new layout, or drive on. */
function parkedOnStreet(r: ParkedResult, c: CityPlay, slot: Slot): void {
  const st = starsFor(r, par || r.moves, limit || Infinity), id = c.map.spec.id;
  const better = !tryRewound && recordStars(`city:${id}`, st.count) && st.count > 0;
  showBanner('good', `Parked · ${'★'.repeat(st.count)}${'☆'.repeat(3 - st.count)}`, tryRewound ? 'After a rewind: stars shown, not saved.' : st.count === 3 ? 'Three stars: clean, neat and efficient.' : 'The card below says what each star needs.', null, 3000);
  setTimeout(() => {
    if (!sim.parked || replay || city !== c || c.slot !== slot) return;
    showResult(r, st, {
      drive: sim.rules ? sim.rules.faults.slice() : null, held: sim.rules ? { secs: sim.rules.heldUp, cars: sim.rules.heldCars.size } : null,
      title: `Parked ${slot.kind === 'lot' ? 'in' : 'on'} ${slotPlace(slot)}`, sub: `${c.map.spec.name} · layout ${c.map.seed} · ${slot.kind === 'lot' ? `bay ${slot.at.n}` : `${fmtLen(slot.length)} space`}${par ? ` · par ${par}` : ''}`, par: par || r.moves, limit: limit || r.elapsed, better,
      retry: resetCar, newLayout: () => playCity(true, id),
      next: () => { hideResult(); c.declined = slot.id; c.slot = null; c.from = null; sim.rules?.clear(); applySettings(); syncStreet(); beginRecording(); showBanner('', 'Drive on', `Signal ${kerbSide() === 'right' ? 'left' : 'right'}, then pull out with Forward and Reverse. Above 10 km/h Drive mode takes over, or tap Drive.`, null, 5000); },   // a new recording: no space to park in from here
      nextLabel: 'Drive on',
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
  let run: CoachRun | null = null, trun: TowCoach | null = null;
  if (ls) {
    run = ls.run ? new CoachRun(sim.vehicle, ls.steps, () => sim.options.lockDeg, ls.run.passive) : null;
    if (run && ls.mark0.coach) run.restore(ls.mark0.coach);
    trun = ls.tow ? towCoach(ls, ls.tow.passive) : null;
    if (trun && ls.mark0.tow) trun.restore(ls.mark0.tow);
    ls.tracker.pts.length = Math.min(ls.tracker.pts.length, ls.mark0.track);
  }
  const p = ls ? replayTo(rec, sim.scene, VEHICLES[rec.vehicle] ?? sim.vehicle, n, s => run?.sync(s), s => { ls.tracker.add(s); run?.observe(s); trun?.observe(s, STEP); }) : replayTo(rec, sim.scene, VEHICLES[rec.vehicle] ?? sim.vehicle, n);
  restoreState(sim, simState(p)); clearPedals(); setPedalMode(sim.mode === 'drive'); recorder.truncate(n, sim); forgetPrediction();
  if (ls) { ls.run = run; ls.tow = trun; ls.rewound = true; }
  tryRewound = true; settledT = 0;
  showBanner('', 'Back 5 seconds', ls ? 'Try that bit again. A try with a rewind is practice: it counts neither way.' : 'Try that bit again. Stars after a rewind are shown but not saved.', null, 3500);
}
$('btnRewind').addEventListener('click', rewind);

function handle(events: SimEvent[]): void {
  for (const e of events) {
    if (e.type === 'touch') {
      $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 60); beep(160, 0.2, 0.15);
      showBanner('bad', touchTitle(e.name, e.part), e.part === 'jackknife' ? 'The rig has folded up. Pull forward with the wheels straight to straighten it, then reverse again.' : 'Stop, straighten up and back away. Touches: ' + e.hits, null, e.part === 'jackknife' ? 4000 : 2200);
      if (lesson && !replay && !lesson.over) { lesson.fault ||= 'touch'; if (e.part === 'jackknife') lesson.jack = true; }
    } else if (e.type === 'parked') {
      beep(880, 0.12, 0.08); setTimeout(() => beep(1320, 0.18, 0.08), 140);
      if (replay) { const c = parkedCard(e.result); showBanner('good', c.title, c.text, c.stats); }
    } else if (e.fault.kind !== 'crash' && e.fault.kind !== 'touch') {   // a touch has its own banner already
      $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 60); beep(320, 0.25, 0.12);
      showBanner('bad', e.fault.title, e.fault.text + ' It counts against this drive.', null, 3500);
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
  if (lesson && (lesson.watching || (lesson.run && !lesson.run.passive) || (lesson.tow && !lesson.tow.passive))) return;
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
let ghostOf: Piece[] | null = null, towLine: Level | null = null;
function drawLesson(): string {
  const ls = lesson;
  if (!ls && level?.tow) {   // a trailer level: the ideal path layer is the trailer's line
    const on = settings.layerGhost === 'on';
    if (on !== (towLine === level)) { towLine = on ? level : null; setTowDraw(on ? { path: level.tow.path.pts.map((p): Pt => [p.x, p.z]), goal: null } : null); }
    return on ? 'towline' : '';
  }
  if (towLine) { towLine = null; setTowDraw(null); }
  if (!ls) {
    const want = settings.layerGhost === 'on' && parRoute.length ? parRoute : null;
    if (want !== ghostOf) { ghostOf = want; setCoachDraw(want ? { route: sample(sim.vehicle, want, 0.1), marks: want.map(p => p.to), from: 0, cur: null, track: null, drift: null } : null); }
    return want ? 'ghost' : '';
  }
  ghostOf = null;
  if (ls.L.tow) return drawTowLesson(ls);
  const run = ls.run, h = ls.st.help, coachOn = !!run && (!run.passive || ls.summoned), marksOn = !!run && run.phase !== 'missed' && run.phase !== 'done' && !ls.over;
  const watchK = ls.watching && guide ? guide.pts[Math.min(guide.at, guide.pts.length - 1)].i : -1;
  setCoachDraw({
    route: ls.watching ? null : (h === 0 || ls.summoned || ls.over) ? ls.routePts : null,
    marks: ls.steps.map(s => s.to), from: ls.watching ? Math.max(0, watchK) : marksOn && (h <= 1 || ls.summoned) ? run!.k : ls.steps.length,
    cur: marksOn && run && !ls.watching ? run.markPose(sim) : null, track: ls.over ? ls.track : null, drift: ls.over ? ls.drift : null,
  });
  renderCard({ def: ls.L.def, help: ls.st.help, steps: ls.steps, tips: ls.tips, run: ls.over ? null : run, summoned: ls.summoned && coachOn, watching: watchK, over: ls.over, slow: ls.st.slow, lockDeg: sim.options.lockDeg, wheel: sim.wheelAngle, v: sim.v });
  const ch = $('coach').hidden ? 0 : $('coach').offsetHeight;
  if (ch !== cardH) { cardH = ch; layout(); }
  return [run?.k, run?.phase, run?.left.toFixed(2), run?.hint, run?.note, ls.over, watchK, h, ls.summoned].join(',');
}

/** A towing lesson on the screen: the trailer's line and the space (with the full coach or the line only, and after a
 *  try), the coach's target on the wheel's rim, and the card. */
function drawTowLesson(ls: LessonPlay): string {
  const trun = ls.over ? null : ls.tow, h = ls.st.help, lineOn = h <= 1 || ls.summoned || ls.watching || ls.over;
  setCoachDraw(ls.over && ls.towTrack.length > 1 ? { route: null, marks: [], from: 0, cur: null, track: ls.towTrack, drift: null } : null);
  setTowDraw({ path: lineOn ? ls.towPath : null, goal: lineOn ? ls.towGoal : null });
  const guiding = !!trun && (!trun.passive || ls.summoned) && !ls.watching && trun.phase !== 'done';
  setWheelTarget(guiding ? trun!.wheelWant : null);
  renderTowCard({ def: ls.L.def, help: h, run: trun, summoned: ls.summoned, watching: ls.watching, over: ls.over, slow: ls.st.slow, wheel: sim.wheelAngle, v: sim.v, pathLen: ls.L.tow!.path.len });
  const ch = $('coach').hidden ? 0 : $('coach').offsetHeight;
  if (ch !== cardH) { cardH = ch; layout(); }
  return [trun?.phase, trun?.left.toFixed(2), trun?.wheelWant.toFixed(0), trun?.hint, trun?.note, ls.over, ls.watching, h, ls.summoned].join(',');
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
  tickPedals(dt);
  for (let n = 0; acc >= STEP - 1e-9; n++) {
    if (n === 6) { acc = 0; break; }   // far behind (a stalled tab): drop the backlog rather than race to catch up
    acc -= STEP;
    if (replay) { const evs = replay.step(); if (!evs) { stopReplay(); showBanner('', 'Replay finished', 'Back to your car, where you left it.', null, 2500); break; } handle(evs); continue; }
    // the pedals as held, passed on to the car unless the coach is holding one back; then recorded as the car saw them
    let fwd = pedals.fwd, rev = pedals.rev;
    const run = lesson && !lesson.over ? lesson.run : null, trun = lesson && !lesson.over ? lesson.tow : null;
    if (lesson?.watching || lesson?.over) fwd = rev = false;   // watching, or the try is over: the car waits for Try again
    else if (run && !run.passive) ({ fwd, rev } = run.gate({ fwd, rev }, sim));
    else if (run) run.sync(sim);
    else if (trun) ({ fwd, rev } = trun.gate({ fwd, rev }, sim));
    sim.input.fwd = fwd; sim.input.rev = rev; sim.input.acc = pedals.acc; sim.input.brk = pedals.brk;
    recorder.before(sim); const evs = sim.step(STEP); recorder.after(sim);
    if (lesson && !lesson.over && !lesson.watching) { lesson.tracker.add(sim); trackTrailer(lesson); if (run) coachEvents(run.observe(sim)); if (trun) towEvents(trun.observe(sim, STEP)); }
    handle(evs);
    settle(STEP);
  }
  cityFrame();
  streetSounds();
  const S = replay ? replay.sim : sim;
  if (guide) {
    const el = (now - guide.t0) / 1000; let i = guide.times.findIndex(x => x >= el); if (i < 0) i = guide.pts.length - 1; guide.at = i;
    if (guide.watch && el > guide.times[guide.times.length - 1] + 1.2) endWatch();
  }
  updateBeeper(S, now / 1000); updatePdcDisplay(S, now / 1000, screen.dpr);
  const lsSig = replay ? '' : drawLesson();
  const rw = $('btnRewind'), canRw = canRewind(); if (rw.hidden === canRw) { rw.hidden = !canRw; layout(); }
  const layers = settings.layerPath + settings.layerPivot + settings.layerSwept + settings.layerKerb + settings.layerNums;
  const sig = [S.x.toFixed(4), S.z.toFixed(4), S.th.toFixed(5), S.wheelAngle.toFixed(1), S.v.toFixed(3), S.input.fwd, S.input.rev, S.input.acc, S.input.brk, S.mode, settings.planView, !!replay, guide ? guide.at : -1, S.scene.id, lsSig, layers, city?.slot?.id, S.traffic?.t.toFixed(2), S.ind, S.hazard].join('|');   // on the street the traffic and the lights move on
  if (sig === lastSig && now > wakeUntil && now - lastDrawT < 1000 && !viewMoving()) return;
  lastSig = sig; lastDrawT = now;
  updateHud(S); drawPlan(S, now / 1000, dt, screen.dpr);
}

// boot: back into what you were playing, keeping the car where it was across a hot reload in the artifact viewer
type Saved = { x?: number; z?: number; th?: number; wheelAngle?: number; hits?: number; elapsed?: number; moves?: number; layout?: number; scene?: string; play?: string; car?: string; mode?: Mode };
type Hot = { snapshot?: (f: () => Saved) => void; ready?: (f: (saved: Saved) => void) => void; data?: Saved };
const hot = (window as unknown as { claude?: { hot?: Hot } }).claude?.hot;
function start(saved: Saved = {}): void {
  const play = saved.play ?? progress.play;
  useCar(chosenCar());
  const cityPlay = /^city:([a-z0-9-]+):(\d+)$/.exec(play);
  const cityMap = cityPlay ? mapFor(cityPlay[1], +cityPlay[2]) : null;
  if (cityPlay && cityMap) {   // back on the street, in Drive mode, where you were if the layout is the same
    enterCity(buildCity(cityMap, chosenCar(), +cityPlay[2], settings.drive));
    if (typeof saved.x === 'number' && typeof saved.z === 'number' && typeof saved.th === 'number' && saved.scene === sim.scene.id && (saved.car ?? ATTO2.id) === sim.vehicle.id && !sim.touching(saved.x, saved.z, saved.th)) {
      sim.place(saved.x, saved.z, saved.th); sim.wheelAngle = saved.wheelAngle || 0; city!.declined = slotNear(city!.map, sim.vehicle, saved.x, saved.z, saved.th, freeNow)?.id ?? '';
      spawnTraffic(city!, { x: saved.x, z: saved.z }); beginRecording();   // the traffic clear of where you are now, not of the start
    }
  } else if (play.startsWith('lesson:') && lessonById(play.slice(7)) && lessonFor(chosenCar(), lessonById(play.slice(7))!)) enterLesson(play.slice(7), 'drive');   // a lesson starts its try over
  else {
    const key = parseKey(play), L = key ? (key.template === 'tow' ? generateTow(key.level, key.seed) : generate(sim.vehicle, key.template, key.level, key.seed)) : null;
    if (L?.tow) { enterLevel(L); resize(); setTimeout(layout, 300); requestAnimationFrame(t => { last = t; frame(t); }); return; }
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
try { hot?.snapshot?.(() => ({ x: sim.x, z: sim.z, th: sim.th, wheelAngle: sim.wheelAngle, hits: sim.hits, elapsed: sim.elapsed, moves: sim.moves, layout: sim.scene.layoutVersion, scene: sim.scene.id, play: lesson ? `lesson:${lesson.L.def.id}` : level ? level.key : city ? cityKey(city.map) : 'garage', car: sim.vehicle.id, mode: sim.mode })); } catch { /* not in the viewer */ }
if (hot?.ready) hot.ready(start); else start(hot?.data ?? {});

// browser checks only (`vite build --mode harness`); other builds drop this
if (import.meta.env.MODE === 'harness') Object.assign(window, { __game: {
  sim, level: () => level, route: () => parRoute, lesson: () => lesson, city: () => city, pedals, enterLesson, playCity, switchMode, parkStart, diveFor,
  /** Time the planner's check of a free space (ms), as the game runs it when you slow down beside one. */
  timeCheck: (i: number) => { const c = city!, s = c.map.slots[i], t0 = performance.now(); s.parkable = undefined; checkSlot(c.map, sim.vehicle, s); return performance.now() - t0; },
  /** Time making a district's road network (ms), as entering it does (the district itself built first). */
  timeNet: (id: string, seed: number) => { const m = buildCity(mapFor(id, seed)!, chosenCar(), seed, settings.drive), t0 = performance.now(); networkOf(m); return performance.now() - t0; },
  /** Time spawning the district's traffic again round where you are (ms), as a reset does. */
  timeSpawn: () => { const t0 = performance.now(); spawnTraffic(city!, sim); return performance.now() - t0; },
  /** Run the frame loop for ms of game time at 30 frames a second (automation tabs get no animation frames). */
  pump: (ms: number) => { const t0 = Math.max(last, clock()); for (let k = 33.4; k <= ms + 1e-9; k += 33.4) tick(t0 + k); clockOffset += Math.max(0, t0 + ms - clock()); },
} });

// offline and installable when served as a web app (not inside the artifact viewer)
if (import.meta.env.MODE !== 'artifact' && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* no offline mode */ }); });
}
