// The coach card at the top of the screen in a lesson, kept short so the map has the room: the step and when to stop in
// one sentence, one line for what needs doing now (the wheel, or the coach's nudge) and how far to the mark. More opens
// what you see at the mark and the handbook's tip for that moment. Once the help has stepped back, one line.
import { sentence, type CoachRun, type Step } from '../core/coach';
import { HELP, type Help, type LessonDef, type Para } from '../core/lesson';
import { $ } from './dom';
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
