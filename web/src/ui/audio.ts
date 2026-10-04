// The parking-sensor beeper, staged like the car: slow → faster → fast → continuous; front sensors one pitch, rear another.
import type { Sim } from '../core/sim';
import { rangeOf } from '../core/sensors';
import { settings } from './settings';

let actx: AudioContext | null = null, beepNext = 0, toneOsc: OscillatorNode | null = null;

/** Phones only play sound after a touch, so this runs on the first press of the wheel or a pedal. */
export function initAudio(): void {
  if (settings.pdc !== 'on') return;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') void actx.resume();
  } catch { /* no audio */ }
}

export function beep(freq: number, dur: number, gain: number): void {
  if (!actx || settings.pdc !== 'on') return;
  const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = freq; o.type = 'triangle';
  const t0 = actx.currentTime;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  g.gain.setValueAtTime(gain, t0 + Math.max(0.01, dur - 0.015)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + dur + 0.01);
}

export function tone(on: boolean, freq = 0): void {   // continuous tone under 30 cm
  if (!actx) return;
  if (on && !toneOsc) {
    toneOsc = actx.createOscillator(); const g = actx.createGain(); toneOsc.type = 'triangle'; toneOsc.frequency.value = freq; g.gain.value = 0.11;
    toneOsc.connect(g).connect(actx.destination); toneOsc.start();
  } else if (!on && toneOsc) { try { toneOsc.stop(); } catch { /* already stopped */ } toneOsc = null; }
  else if (on && toneOsc) toneOsc.frequency.value = freq;
}

export function updateBeeper(sim: Sim, now: number): void {
  const armed = settings.pdc === 'on' && sim.armed;
  const g = sim.lastMoveDir >= 0 ? 'front' : 'rear', d = sim.pdc[g], freq = g === 'front' ? 1750 : 1250;
  if (!armed || d >= rangeOf(g)) { tone(false); return; }
  if (d < 0.3) { tone(true, freq); return; }
  tone(false);
  const period = d < 0.45 ? 0.16 : d < 0.7 ? 0.33 : d < 1.0 ? 0.6 : 0.9;
  if (now >= beepNext) { beep(freq, 0.07, 0.14); beepNext = now + period; }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) tone(false); });
