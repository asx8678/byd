// The coach card at the top of the screen in a lesson, kept short so the map has the room: the step and when to stop in
// one sentence, one line for what needs doing now (the wheel, or the coach's nudge) and how far to the mark. More opens
// what you see at the mark and the handbook's tip for that moment. Once the help has stepped back, one line. A towing
// lesson fills the same card from the trailer's coach (renderTowCard).
import { sentence, type CoachRun, type Step } from '../core/coach';
import { HELP, type Help, type LessonDef, type Para } from '../core/lesson';
import type { TowCoach } from '../core/towing';
import { $ } from './dom';
import { WHEEL_OK } from './hud';
import { saveSettings, settings } from './settings';

export interface CardView {
  def: LessonDef; help: Help; steps: readonly Step[];
  tips: Record<string, Para>;   // the lesson's tips by this route's step numbers (another car's route can differ)
  run: CoachRun | null;      // the coach following this try (guided, or keeping up with cue marks)
  summoned: boolean;         // help on request: the coach was asked for in this try
  watching: number;          // the step the ghost is on while watching (-1 when not)
  over: boolean;             // this try has its result
  slow: boolean; lockDeg: number; wheel: number; v: number;
}
export interface CardHooks { back(): void; restart(): void; summon(): void; slow(): void }

const fmtLeft = (m: number) => (m < 0.95 ? `${Math.max(0, Math.round(m * 20) * 5)} cm` : `${m.toFixed(1)} m`);
const turns = (lvl: number, lockDeg: number) => `${(Math.abs(lvl) * lockDeg / 360).toFixed(2)} turns`;
let last = '';

export function bindCard(h: CardHooks): void {
  $('cBack').addEventListener('click', () => h.back());
  $('cRestart').addEventListener('click', () => h.restart());
  $('cSummon').addEventListener('click', () => h.summon());
  $('cSlow').addEventListener('click', () => h.slow());
  const more = $('cMore'), sync = () => {
    const on = settings.coachMore === 'on'; $('coach').classList.toggle('more', on); more.textContent = on ? 'Less' : 'More'; more.setAttribute('aria-expanded', String(on));
  };
  more.addEventListener('click', () => { settings.coachMore = settings.coachMore === 'on' ? 'off' : 'on'; saveSettings(); sync(); });
  sync();
}

/** Show or update the card; does nothing when nothing on it changed. */
export function renderCard(c: CardView | null): void {
  const card = $('coach');
  if (!c) { if (!card.hidden) { card.hidden = true; last = ''; } return; }
  const run = c.run, k = c.watching >= 0 ? c.watching : run ? run.k : -1, st: Step | undefined = c.steps[k];
  const full = !c.over && (c.watching >= 0 || (!!run && !run.passive) || c.summoned);
  const mode = c.watching >= 0 ? 'Watch' : c.summoned ? 'Coach' : HELP[c.help].name;
  const stepTxt = c.over ? '' : st ? `Step ${st.n} of ${c.steps.length}` : '';
  // the wheel against what this step wants
  let wheel = '', wheelOk = false;
  if (st && full && c.watching < 0) {
    const want = st.lvl * c.lockDeg; wheelOk = Math.abs(c.wheel - want) <= (st.lvl === 0 ? 5 : 15);
    wheel = st.lvl === 0 ? (wheelOk ? 'Wheels straight ✓' : 'Tap Straighten')
      : wheelOk ? `Wheel: full lock ${st.lvl > 0 ? 'right' : 'left'} ✓ hold it there` : `Turn the wheel to full lock ${st.lvl > 0 ? 'right' : 'left'}: ${turns(st.lvl, c.lockDeg)}`;
  }
  const missed = run?.phase === 'missed' && !run.passive;
  // coaching a step: the line and the bar are always there (the whole step's length while the wheel is set), so the card
  // keeps its height and the map does not jump under it
  const coaching = full && !!st && !!run && c.watching < 0;
  const left = coaching && st ? (run!.phase === 'wheel' ? st.len : Math.max(0, run!.left)) : -1;
  const frac = st && left >= 0 ? Math.min(1, Math.max(0, 1 - left / st.len)) : 0;
  const leftTxt = left < 0 ? '' : left <= 0.15 && Math.abs(c.v) < 0.02 ? 'On the mark' : `${fmtLeft(left)} to the mark`;
  const note = run ? (run.hint || run.note) : '';
  // the one line for now: the pedals' nudge, then the wheel until it is set (once off the marks, how far off), then the
  // coach's note, then the wheel set
  const line = !coaching ? '' : run!.hint || (missed && run!.note ? run!.note : !wheelOk ? wheel : run!.note || wheel);
  const lineOk = line === wheel && wheelOk;
  const see = st && full && st.see ? `At the mark, ${st.see}.` : '';
  const tip = st && full ? c.tips[String(st.n)]?.text ?? '' : '';
  const brief = c.over ? 'This try is over: Try again (or Reset) for the next one.' : !full ? (c.help === 1 ? (run?.phase === 'missed' ? 'Off the marks: finish as you can, then see what to work on.' : 'Stop on each mark: the outline on the plan shows where.')
    : c.help === 2 ? 'Show me and the coach are there if you need them.' : 'No help: the stars count.') : '';
  const sig = [c.def.id, mode, stepTxt, full, line, lineOk, missed, leftTxt, frac.toFixed(2), note, see, tip, brief, c.slow, c.help, k].join('|');
  if (sig === last && !card.hidden) return;
  last = sig; card.hidden = false;
  $('cLesson').textContent = `Lesson ${c.def.n} · ${mode}`;
  $('cStep').textContent = stepTxt;
  $('cBody').hidden = !full || !st;
  if (full && st) {
    $('cDo').textContent = c.watching >= 0 ? sentence(st) : st.say + (st.say.includes(',') ? ',' : '');
    $('cUntil').hidden = c.watching >= 0; $('cUntil').textContent = st.until + '.';
    $('cLine').hidden = !coaching; $('cLine').textContent = line; $('cLine').className = lineOk ? 'ok' : '';
    $('cBar').hidden = left < 0; ($('cBar').firstElementChild as HTMLElement).style.width = `${(frac * 100).toFixed(0)}%`; $('cLeft').textContent = leftTxt;
    $('cSee').hidden = !see; $('cSee').textContent = see;
    $('cTip').hidden = !tip; $('cTip').textContent = tip;
    $('cExtra').hidden = !see && !tip;
  }
  $('cMore').hidden = !(full && st && (see || tip));
  $('cBrief').hidden = !brief; $('cBrief').textContent = brief;
  $('cNote').hidden = full || !note; $('cNote').textContent = note;
  $('cBtns').hidden = !missed;
  $('cSummon').hidden = !(c.help === 2 && !c.summoned && c.watching < 0);
  $('cSlow').hidden = !c.slow;
}

/** A towing lesson's card: the same places, filled from the trailer's coach. The one line says where your hand at the
 *  bottom of the wheel should go (the trailer goes the way your hand moves), or to hold it there. */
export interface TowCardView {
  def: LessonDef; help: Help; run: TowCoach | null; summoned: boolean;
  watching: boolean; over: boolean; slow: boolean; wheel: number; v: number; pathLen: number;
}
const amount = (d: number) => (d < 60 ? 'a little' : d < 135 ? 'a quarter turn' : d < 225 ? 'half a turn' : d < 315 ? 'three quarters of a turn' : 'a full turn');
/** The hand at the bottom of the wheel: towards `want` from `wheel` (degrees, + clockwise: the bottom moves left). */
export function handLine(want: number, wheel: number): { text: string; ok: boolean } {
  const d = want - wheel;
  if (Math.abs(d) <= WHEEL_OK) return { text: 'Hold the wheel there ✓', ok: true };
  return { text: `Hand at the bottom of the wheel ${d > 0 ? 'to the left' : 'to the right'}: ${amount(Math.abs(d))}`, ok: false };
}

export function renderTowCard(c: TowCardView): void {
  const card = $('coach'), run = c.run;
  const full = !c.over && (c.watching || (!!run && !run.passive) || c.summoned);
  const mode = c.watching ? 'Watch' : c.summoned ? 'Coach' : HELP[c.help].name;
  const fwd = run?.phase === 'forward';
  const coaching = full && !!run && !c.watching;
  const want = run ? run.wheelWant : 0;
  const wheel = !coaching ? null : fwd ? (Math.abs(c.wheel) <= 5 ? { text: 'Wheels straight ✓', ok: true } : { text: 'Tap Straighten', ok: false }) : handLine(want, c.wheel);
  const line = !coaching ? '' : run!.hint || (fwd && run!.note && !wheel!.ok ? run!.note : wheel!.text);
  const lineOk = !!wheel && line === wheel.text && wheel.ok;
  const left = coaching && !fwd ? run!.left : -1, frac = left >= 0 ? Math.min(1, Math.max(0, 1 - left / c.pathLen)) : 0;
  const leftTxt = left < 0 ? '' : left <= 0.15 && Math.abs(c.v) < 0.02 ? 'In the space' : `${fmtLeft(left)} to go`;
  const note = run ? (run.hint || run.note) : '';
  const brief = c.over ? 'This try is over: Try again (or Reset) for the next one.' : !full ? (c.help === 1 ? 'The trailer’s line is on the plan: keep it there yourself, with small corrections, early.'
    : c.help === 2 ? 'Show me and the coach are there if you need them.' : 'No help: the stars count.') : '';
  const say = fwd ? 'Pull forward with the wheels straight' : 'Reverse slowly, your hand at the bottom of the wheel';
  const until = fwd ? 'until the trailer is back in line behind the car' : 'until the trailer is in the green space, straight';
  const sig = [c.def.id, mode, full, fwd, line, lineOk, leftTxt, frac.toFixed(2), note, brief, c.slow, c.help, c.watching].join('|');
  if (sig === last && !card.hidden) return;
  last = sig; card.hidden = false;
  $('cLesson').textContent = `Lesson ${c.def.n} · ${mode}`;
  $('cStep').textContent = c.over ? '' : fwd ? 'Straightening up' : '';
  $('cBody').hidden = !full;
  if (full) {
    $('cDo').textContent = c.watching ? `${say}, ${until}.` : say + ',';
    $('cUntil').hidden = c.watching; $('cUntil').textContent = until + '.';
    $('cLine').hidden = !coaching; $('cLine').textContent = line; $('cLine').className = lineOk ? 'ok' : '';
    $('cBar').hidden = left < 0; ($('cBar').firstElementChild as HTMLElement).style.width = `${(frac * 100).toFixed(0)}%`; $('cLeft').textContent = leftTxt;
    $('cSee').hidden = true; $('cTip').hidden = true; $('cExtra').hidden = true;
  }
  $('cMore').hidden = true;
  $('cBrief').hidden = !brief; $('cBrief').textContent = brief;
  $('cNote').hidden = full || !note; $('cNote').textContent = note;
  $('cBtns').hidden = true;
  $('cSummon').hidden = !(c.help === 2 && !c.summoned && !c.watching);
  $('cSlow').hidden = !c.slow;
}
