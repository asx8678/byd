// Text for the readouts and the result card.
import type { ParkedResult } from '../core/sim';

export const fmtD = (d: number): string => d >= 5 ? '> 5 m' : d.toFixed(2) + ' m';
export const steerText = (sd: number): string => Math.abs(sd) < 0.5 ? '0°' : Math.abs(sd).toFixed(0) + '° ' + (sd > 0 ? 'R' : 'L');

export function parkedCard(r: ParkedResult): { title: string; text: string; stats: [string, string][] } {
  const m = Math.floor(r.elapsed / 60), s = Math.floor(r.elapsed % 60);
  return {
    title: r.kind === 'exit' ? 'Out of the space' : `Parked in ${r.bay}` + (r.noseIn ? '' : ' (reversed in)'),
    text: r.hits ? `${r.hits} touch${r.hits > 1 ? 'es' : ''} on the way in. Try again for a clean run.` : 'Clean run, nothing touched.',
    stats: [
      ['Off centre', `${Math.abs(r.offCentre * 100).toFixed(0)} cm ${r.offCentre > 0 ? 'right' : 'left'}`], ['Angle', `${Math.abs(r.angle).toFixed(1)}°`], ['Gap to wall', fmtD(r.gapWall)],
      ['Gap left line', fmtD(r.gapLeft)], ['Gap right line', fmtD(r.gapRight)], ['Time', `${m}:${String(s).padStart(2, '0')}`],
    ],
  };
}

export const touchTitle = (name: string, part: string): string => `Touched the ${name}` + (part ? ` with the ${part}` : '');
