// Touch, mouse and keyboard: the steering wheel, the hold-to-move pedals, the toolbar, Setup and Info.
import { clamp, DEG } from '../core/math';
import type { Sim } from '../core/sim';
import { initAudio, tone } from './audio';
import { $ } from './dom';
import { lockDeg, saveSettings, settings, type Settings } from './settings';

export interface ControlHooks { reset(): void; settingChanged(key: keyof Settings): void }

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

  // pedals: hold to move, release to brake
  const pedal = (el: HTMLElement, key: 'fwd' | 'rev') => {
    const on = (e: PointerEvent) => { e.preventDefault(); inp[key] = true; el.classList.add('on'); try { el.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ } initAudio(); };
    const off = () => { inp[key] = false; el.classList.remove('on'); };
    el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
    el.addEventListener('contextmenu', e => e.preventDefault());
  };
  pedal($('btnFwd'), 'fwd'); pedal($('btnRev'), 'rev');

  // keyboard: arrows steer and drive, space straightens, X resets
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowUp' || e.key === 'w') { inp.fwd = true; $('btnFwd').classList.add('on'); }
    if (e.key === 'ArrowDown' || e.key === 's') { inp.rev = true; $('btnRev').classList.add('on'); }
    if (e.key === 'ArrowLeft') { inp.kl = true; sim.wheelTarget = null; }
    if (e.key === 'ArrowRight') { inp.kr = true; sim.wheelTarget = null; }
    if (e.key === ' ') { sim.wheelTarget = 0; e.preventDefault(); }
    if (e.key === 'x' || e.key === 'X' || e.key === 'r' || e.key === 'R') hooks.reset();
    if (e.key.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'ArrowUp' || e.key === 'w') { inp.fwd = false; $('btnFwd').classList.remove('on'); }
    if (e.key === 'ArrowDown' || e.key === 's') { inp.rev = false; $('btnRev').classList.remove('on'); }
    if (e.key === 'ArrowLeft') inp.kl = false;
    if (e.key === 'ArrowRight') inp.kr = false;
  });

  // toolbar and sheets
  $('btnReset').addEventListener('click', () => hooks.reset());
  const toggleSheet = (id: string) => { const el = $(id), open = el.hidden; document.querySelectorAll<HTMLElement>('.sheet').forEach(s => { s.hidden = true; }); el.hidden = !open; };
  $('btnSettings').addEventListener('click', () => toggleSheet('sheetSettings'));
  $('btnInfo').addEventListener('click', () => toggleSheet('sheetInfo'));
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
