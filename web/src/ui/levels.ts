// The Levels sheet (today's level, your garage, ten levels per template with your best stars) and the
// result card that comes up when you have parked: stars, what earned them, and where to go next.
import { TEMPLATES, type TemplateId } from '../core/generator/templates';
import type { Stars } from '../core/score';
import type { ParkedResult } from '../core/sim';
import { $, openSheet } from './dom';
import { fmtD, parkedCard } from './format';
import { TEMPLATE_NAMES, bestStars, daily, seedFor } from './progress';

export interface LevelHooks {
  playLevel(t: TemplateId, level: number, seed: number): void;
  playGarage(): void;
  playCity(fresh: boolean): void;   // the street map, its last layout or a new one
  playDistrict(fresh: boolean): void;   // a made-up district at the chosen level, the last one or a new one
}
let hooks: LevelHooks;

const starText = (n: number) => (n < 0 ? '' : '★'.repeat(n) + '☆'.repeat(3 - n));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

/** The street map's entry: its name, a line under it, the best stars there. */
export interface CityEntry { name: string; sub: string; stars: number }
/** Refresh the sheet: best stars, and which one is being played (a level key, "garage", "city" or "district"). */
export function renderLevels(playing: string, garageName: string, garageSlot: string, city: CityEntry, district: CityEntry): void {
  const d = daily();
  $('lvDailyName').textContent = `${TEMPLATE_NAMES[d.template].long} · level ${d.level}`;
  $('lvGarageName').textContent = garageName;
  $('lvGarageStars').textContent = starText(bestStars(garageSlot));
  $('lvGarage').classList.toggle('cur', playing === 'garage');
  $('lvCityName').textContent = city.name; $('lvCitySub').textContent = city.sub; $('lvCityStars').textContent = starText(city.stars);
  $('lvCity').classList.toggle('cur', playing === 'city');
  $('lvGenName').textContent = district.name; $('lvGenSub').textContent = district.sub; $('lvGenStars').textContent = starText(district.stars);
  $('lvGen').classList.toggle('cur', playing === 'district');
  const cur = /^([a-z-]+):(\d+):/.exec(playing);
  $('lvGroups').replaceChildren(...TEMPLATES.map(t => {
    const g = el('div', 'lvGroup'), grid = el('div', 'lvGrid');
    g.append(el('h4', '', TEMPLATE_NAMES[t].long), grid);
    for (let n = 1; n <= 10; n++) {
      const b = el('button'), best = bestStars(`${t}:${n}`);
      b.type = 'button'; b.dataset.t = t; b.dataset.l = String(n);
      b.setAttribute('aria-label', `${TEMPLATE_NAMES[t].long}, level ${n}${best >= 0 ? `, best ${best} of 3 stars` : ''}`);
      b.append(el('b', '', String(n)), el('small', '', starText(best) || '·'));
      if (cur && cur[1] === t && +cur[2] === n) b.classList.add('cur');
      grid.append(b);
    }
    return g;
  }));
}

export function bindLevels(h: LevelHooks): void {
  hooks = h;
  $('lvGroups').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-t]'); if (!b) return;
    const t = b.dataset.t as TemplateId, n = +b.dataset.l!;
    hooks.playLevel(t, n, seedFor(t, n));
  });
  $('lvDailyGo').addEventListener('click', () => { const d = daily(); hooks.playLevel(d.template, d.level, d.seed); });
  $('lvGarage').addEventListener('click', () => hooks.playGarage());
  $('lvCity').addEventListener('click', () => hooks.playCity(false));
  $('lvCityNew').addEventListener('click', () => hooks.playCity(true));
  $('lvGen').addEventListener('click', () => hooks.playDistrict(false));
  $('lvGenNew').addEventListener('click', () => hooks.playDistrict(true));
}

export interface ResultInfo {
  title: string; sub: string; par: number; limit: number; better: boolean;
  retry(): void; newLayout: (() => void) | null; next: (() => void) | null; nextLabel: string;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The measurements under a result: tyres to the kerb in a kerb space, centring and gaps in a bay. */
export const statsFor = (r: ParkedResult): [string, string][] => r.kind === 'kerb'
  ? [['Tyres to kerb', fmtD(r.kerbGap)], ['Angle', `${Math.abs(r.angle).toFixed(1)}°`], ['Moves', String(r.moves)], ['Gap ahead', fmtD(r.gapFront)], ['Gap behind', fmtD(r.gapRear)], ['Time', mmss(r.elapsed)]]
  : r.kind === 'exit' ? [['Angle', `${Math.abs(r.angle).toFixed(1)}°`], ['Moves', String(r.moves)], ['Touches', String(r.hits)], ['Gap ahead', fmtD(r.gapFront)], ['Gap behind', fmtD(r.gapRear)], ['Time', mmss(r.elapsed)]]
  : parkedCard(r).stats;

/** The result card: the stars, one line per star, the measurements, and Try again / New layout / Next. */
export function showResult(r: ParkedResult, st: Stars, info: ResultInfo): void {
  const stars = $('resStars');
  stars.replaceChildren(...[0, 1, 2].map(i => el('i', i < st.count ? 'on' : '', '★')));
  stars.setAttribute('aria-label', `${st.count} of 3 stars`);
  $('resTitle').textContent = info.title + (info.better ? ' · new best' : '');
  $('resSub').textContent = info.sub;
  const kerb = r.kind === 'kerb';
  const neatHow = kerb ? `tyres ${Math.round(r.kerbGap * 100)} cm from the kerb, ${Math.abs(r.angle).toFixed(1)}° off straight (30 cm and 3° or less)`
    : `${Math.round(Math.abs(r.offCentre) * 100)} cm off centre, ${Math.abs(r.angle).toFixed(1)}° off straight (15 cm and 3° or less)`;
  const lines: [boolean, string][] = [
    [st.clean, st.clean ? 'Nothing touched' : `${r.hits} touch${r.hits > 1 ? 'es' : ''} on the way in`],
    [st.neat, `Neat: ${neatHow}`],
    [st.efficient, `Efficient: ${r.moves} ${r.moves === 1 ? 'move' : 'moves'} (par ${info.par}, one more allowed), ${mmss(r.elapsed)} of ${mmss(info.limit)}`],
  ];
  $('resList').replaceChildren(...lines.map(([ok, t]) => { const li = el('li', ok ? 'ok' : 'no'); li.append(el('i', '', ok ? '★' : '☆'), el('span', '', t)); return li; }));
  $('resStats').hidden = false;
  $('resStats').replaceChildren(...statsFor(r).map(([k, v]) => { const d = el('div'); d.append(el('span', '', k), el('b', '', v)); return d; }));
  const nb = $('resNew'), nx = $('resNext'), rt = $('resRetry');
  nb.hidden = !info.newLayout; nb.textContent = 'New layout'; nx.textContent = info.nextLabel;
  nx.classList.add('primary'); rt.classList.remove('primary'); rt.textContent = 'Try again';
  rt.onclick = () => info.retry();
  nb.onclick = () => info.newLayout?.();
  nx.onclick = () => (info.next ?? (() => openSheet('sheetLevels')))();
  openSheet('sheetResult');
}
export const hideResult = (): void => { $('sheetResult').hidden = true; };
