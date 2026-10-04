export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/** Open one bottom sheet (closing any other), or toggle it. */
export function openSheet(id: string, toggle = false): void {
  const el = $(id), open = el.hidden || !toggle;
  document.querySelectorAll<HTMLElement>('.sheet').forEach(s => { s.hidden = true; });
  el.hidden = !open;
}
export const closeSheets = (): void => document.querySelectorAll<HTMLElement>('.sheet').forEach(s => { s.hidden = true; });

/** Canvas pixel ratio: phones get 1.5x, which is sharp and paints ~45% fewer pixels than 2x. */
export const MAX_DPR = matchMedia('(pointer: coarse)').matches ? 1.5 : 2;
export const screen = { dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR) };

/** Size a canvas's backing store to its CSS size times the pixel ratio; returns its CSS size, or null when hidden. */
export function fitCanvas(cv: HTMLCanvasElement): { w: number; h: number } | null {
  const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return null;
  const bw = Math.round(w * screen.dpr), bh = Math.round(h * screen.dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  return { w, h };
}
