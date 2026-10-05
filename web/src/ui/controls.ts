// Touch, mouse and keyboard: the steering wheel, the pedals (hold to move in Park mode; on the street in Drive mode the
// same two buttons are the accelerator and the brake, pressed harder the higher your finger), the toolbar, Setup,
// Play and Info.
import { clamp, DEG } from '../core/math';
import type { Sim } from '../core/sim';
import { initAudio, tone } from './audio';
import { $, openSheet } from './dom';
import { lockDeg, saveSettings, settings, type Settings } from './settings';

export interface ControlHooks { reset(): void; settingChanged(key: keyof Settings): void; levels(): void; mode(): void }

/** The pedals as the player holds them: Forward and Reverse in Park mode, the accelerator and the brake (0 to 1) in
 *  Drive mode. The frame loop passes them on to the car each step, unless the coach is holding one back (a lesson's
 *  guided steps), so what the car sees, and the recording, stay one thing. */
export const pedals = { fwd: false, rev: false, acc: 0, brk: 0 };

/** One of the two buttons: a finger on it (and how far up), or its key held (and how far the key has pressed it). A
 *  stale press began before the buttons changed meaning: it counts for nothing until it is let go. */
interface Btn { el: HTMLElement; held: boolean; stale: boolean; level: number; key: boolean; keyStale: boolean; keyLevel: number }
const mk = (id: string): Btn => ({ el: $(id), held: false, stale: false, level: 0, key: false, keyStale: false, keyLevel: 0 });
const top = mk('btnFwd'), bottom = mk('btnRev');
let drive = false;

function sync(): void {
  const on = (b: Btn) => (b.held && !b.stale) || (b.key && !b.keyStale);
  const lvl = (b: Btn) => Math.max(b.held && !b.stale ? b.level : 0, b.key && !b.keyStale ? b.keyLevel : 0);
  pedals.fwd = !drive && on(top); pedals.rev = !drive && on(bottom);
  pedals.acc = drive ? lvl(top) : 0; pedals.brk = drive ? lvl(bottom) : 0;
  top.el.classList.toggle('on', on(top)); bottom.el.classList.toggle('on', on(bottom));
}
/** Forget what is held: a finger still on a button has to lift and press again. */
export function releasePedals(): void {
  for (const b of [top, bottom]) { b.stale = b.held; b.keyStale = b.key; b.keyLevel = 0; }
  sync();
}
/** The buttons for Park mode (Forward, Reverse) or Drive mode (accelerator, brake). Into Drive mode a finger already
 *  on Forward carries on as the accelerator; anything else held has to be pressed again. */
export function setPedalMode(toDrive: boolean): void {
  if (toDrive === drive) return;
  const keepTop = toDrive;
  drive = toDrive;
  for (const b of [top, bottom]) if (!(keepTop && b === top)) { b.stale = b.held; b.keyStale = b.key; }
  top.keyLevel = keepTop && top.key ? 0.3 : 0; bottom.keyLevel = 0;
  top.el.innerHTML = drive ? '▲<small>Accelerator</small>' : '▲<small>Forward</small>';
  bottom.el.innerHTML = drive ? '■<small>Brake</small>' : '▼<small>Reverse</small>';
  top.el.setAttribute('aria-label', drive ? 'Accelerator: hold, higher up for more' : 'Drive forward (hold)');
  bottom.el.setAttribute('aria-label', drive ? 'Brake: hold, higher up for more' : 'Reverse (hold)');
  top.el.classList.toggle('acc', drive); bottom.el.classList.toggle('brk', drive);
  sync();
}
/** Keys press the pedals gradually in Drive mode: the accelerator over about a second, the brake over half a second. */
export function tickPedals(dt: number): void {
  if (!drive || !(top.key || bottom.key)) return;
  if (top.key && !top.keyStale) top.keyLevel = Math.min(1, Math.max(0.25, top.keyLevel + 0.9 * dt));
  if (bottom.key && !bottom.keyStale) bottom.keyLevel = Math.min(1, Math.max(0.3, bottom.keyLevel + 1.6 * dt));
  sync();
}

export function bindControls(sim: Sim, hooks: ControlHooks): void {
  const inp = sim.input;
  // steering wheel: drag it round like a real one
  const wheelSvg = $('wheelSvg');
  let wheelPointer: number | null = null, lastA = 0;
  const angleAt = (e: PointerEvent) => { const r = wheelSvg.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
  wheelSvg.addEventListener('pointerdown', e => {
    e.preventDefault(); wheelPointer = e.pointerId; inp.wheelHeld = true; lastA = angleAt(e); sim.wheelTarget = null; initAudio();
    try { wheelSvg.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
  });
  wheelSvg.addEventListener('pointermove', e => {
    if (e.pointerId !== wheelPointer) return;
    const a = angleAt(e); let d = a - lastA; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; lastA = a;
    sim.wheelAngle = clamp(sim.wheelAngle + d / DEG, -lockDeg(), lockDeg());
  });
  const releaseWheel = (e: PointerEvent) => { if (e.pointerId === wheelPointer) { wheelPointer = null; inp.wheelHeld = false; } };
  wheelSvg.addEventListener('pointerup', releaseWheel); wheelSvg.addEventListener('pointercancel', releaseWheel);
  $('btnCenter').addEventListener('click', () => { sim.wheelTarget = 0; });

  // pedals: hold to move, release to brake; in Drive mode the higher the finger on the button, the harder it presses
  const pedal = (b: Btn) => {
    const el = b.el, at = (e: PointerEvent) => { const r = el.getBoundingClientRect(); b.level = Math.round(20 * clamp(0.15 + 0.85 * (r.bottom - e.clientY) / r.height, 0.15, 1)) / 20; };
    let pid: number | null = null;
    const on = (e: PointerEvent) => { e.preventDefault(); pid = e.pointerId; b.held = true; b.stale = false; at(e); try { el.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ } initAudio(); sync(); };
    const move = (e: PointerEvent) => { if (e.pointerId === pid && b.held) { at(e); sync(); } };
    const off = () => { pid = null; b.held = false; b.stale = false; sync(); };
    el.addEventListener('pointerdown', on); el.addEventListener('pointermove', move); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', e => e.preventDefault());
  };
  pedal(top); pedal(bottom);
  $('btnMode').addEventListener('click', () => hooks.mode());

  // keyboard: arrows steer and drive, space straightens, X resets
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if ((e.key === 'ArrowUp' || e.key === 'w') && !top.key) { top.key = true; top.keyStale = false; sync(); }
    if ((e.key === 'ArrowDown' || e.key === 's') && !bottom.key) { bottom.key = true; bottom.keyStale = false; sync(); }
    if ((e.key === 'p' || e.key === 'P') && !e.repeat) hooks.mode();
    if (e.key === 'ArrowLeft') { inp.kl = true; sim.wheelTarget = null; }
    if (e.key === 'ArrowRight') { inp.kr = true; sim.wheelTarget = null; }
    if (e.key === ' ') { sim.wheelTarget = 0; e.preventDefault(); }
    if (e.key === 'x' || e.key === 'X' || e.key === 'r' || e.key === 'R') hooks.reset();
    if (e.key.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'ArrowUp' || e.key === 'w') { top.key = false; top.keyStale = false; top.keyLevel = 0; sync(); }
    if (e.key === 'ArrowDown' || e.key === 's') { bottom.key = false; bottom.keyStale = false; bottom.keyLevel = 0; sync(); }
    if (e.key === 'ArrowLeft') inp.kl = false;
    if (e.key === 'ArrowRight') inp.kr = false;
  });

  // toolbar and sheets
  $('btnReset').addEventListener('click', () => hooks.reset());
  $('btnSettings').addEventListener('click', () => openSheet('sheetSettings', true));
  $('btnInfo').addEventListener('click', () => openSheet('sheetInfo', true));
  $('btnLevels').addEventListener('click', () => { hooks.levels(); openSheet('sheetLevels', true); });   // the Play sheet: the course and the levels
  document.querySelectorAll<HTMLElement>('[data-close]').forEach(b => b.addEventListener('click', () => { $(b.dataset.close!).hidden = true; }));
  document.querySelectorAll<HTMLElement>('.seg[data-opt]').forEach(seg => {
    const key = seg.dataset.opt as keyof Settings;
    const sync = () => seg.querySelectorAll<HTMLElement>('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(settings[key])));
    seg.querySelectorAll<HTMLElement>('button').forEach(b => b.addEventListener('click', () => {
      (settings as unknown as Record<string, string>)[key] = b.dataset.v!; saveSettings(); sync();
      if (key === 'pdc') { if (settings.pdc === 'on') initAudio(); else tone(false); }
      hooks.settingChanged(key);
    }));
    sync();
  });
  const syncPlanBtn = () => { $('planMode').textContent = settings.planView === 'area' ? 'Follow car' : 'Whole area'; };
  $('planMode').addEventListener('click', () => { settings.planView = settings.planView === 'area' ? 'car' : 'area'; saveSettings(); syncPlanBtn(); });
  syncPlanBtn();
}
