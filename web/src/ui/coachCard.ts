// The coach card at the top of the screen in a lesson: the step, what to do and when to stop, how far to the mark,
// where the wheel should be, and the handbook's tip for that moment; or one line once the help has stepped back.
import { sentence, type CoachRun, type Step } from '../core/coach';
import { HELP, type Help, type LessonDef, type Para } from '../core/lesson';
import { $ } from './dom';

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
  let wheel = '';
  if (st && full && c.watching < 0) {
    const want = st.lvl * c.lockDeg, ok = Math.abs(c.wheel - want) <= (st.lvl === 0 ? 5 : 15);
    wheel = st.lvl === 0 ? (ok ? 'Wheels straight ✓' : 'Tap Straighten')
      : ok ? `Wheel: full lock ${st.lvl > 0 ? 'right' : 'left'} ✓ hold it there` : `Turn the wheel to full lock ${st.lvl > 0 ? 'right' : 'left'}: ${turns(st.lvl, c.lockDeg)}`;
  }
  const missed = run?.phase === 'missed' && !run.passive;
  const left = run && st && run.phase !== 'wheel' && c.watching < 0 ? Math.max(0, run.left) : -1;
  const frac = st && left >= 0 ? Math.min(1, Math.max(0, 1 - left / st.len)) : 0;
  const leftTxt = left < 0 ? '' : left <= 0.15 && Math.abs(c.v) < 0.02 ? 'On the mark' : `${fmtLeft(left)} to the mark`;
  const note = run ? (run.hint || run.note) : '';
  const tip = st ? c.tips[String(st.n)]?.text ?? '' : '';
  const brief = c.over ? 'This try is over: Try again (or Reset) for the next one.' : !full ? (c.help === 1 ? (run?.phase === 'missed' ? 'Off the marks: finish as you can, then see what to work on.' : 'Stop on each mark: the outline on the plan shows where.')
    : c.help === 2 ? 'Show me and the coach are there if you need them.' : 'No help: the stars count.') : '';
  const sig = [c.def.id, mode, stepTxt, full, wheel, missed, leftTxt, frac.toFixed(2), note, brief, c.slow, c.help, k].join('|');
  if (sig === last && !card.hidden) return;
  last = sig; card.hidden = false;
  $('cLesson').textContent = `Lesson ${c.def.n} · ${mode}`;
  $('cStep').textContent = stepTxt;
  $('cBody').hidden = !full || !st;
  if (full && st) {
    $('cSay').textContent = c.watching >= 0 ? sentence(st) : st.say + (st.say.includes(',') ? ',' : '');
    $('cUntil').hidden = c.watching >= 0; $('cUntil').textContent = st.until + '.';
    $('cSee').hidden = !st.see; $('cSee').textContent = st.see ? `At the mark, ${st.see}.` : '';
    $('cBar').hidden = left < 0; ($('cBar').firstElementChild as HTMLElement).style.width = `${(frac * 100).toFixed(0)}%`; $('cLeft').textContent = leftTxt;
    $('cWheel').hidden = !wheel; $('cWheel').textContent = wheel; $('cWheel').className = wheel.includes('✓') ? 'ok' : '';
    $('cTip').hidden = !tip; $('cTip').textContent = tip;
  }
  $('cBrief').hidden = !brief; $('cBrief').textContent = brief;
  $('cNote').hidden = !note; $('cNote').textContent = note;
  $('cBtns').hidden = !missed;
  $('cSummon').hidden = !(c.help === 2 && !c.summoned && c.watching < 0);
  $('cSlow').hidden = !c.slow;
}
