// Choosing the car (Setup) and its facts (Info). Every number comes from the car's data file or is worked out from it,
// with the file's sources and the figures that are estimates.
import { ackermann } from '../core/car';
import { CAR_SPECS } from '../core/content';
import { DEG } from '../core/math';
import { circlesOf, type Vehicle } from '../core/vehicle';
import { $ } from './dom';

const button = (v: string, label: string): HTMLButtonElement => { const b = document.createElement('button'); b.type = 'button'; b.dataset.v = v; b.textContent = label; return b; };

/** The Setup rows: one button per car file, and the rear-axle steering settings. Before the controls are bound. */
export function renderCarPicker(): void {
  $('segCar').replaceChildren(...CAR_SPECS.map(s => button(s.id, s.short ?? s.name)));
  const opts = [...new Set(CAR_SPECS.flatMap(s => s.rearSteer?.options ?? []))].sort((a, b) => b - a);
  $('segRas').replaceChildren(...opts.map(d => button(String(d), d ? `${d}°` : 'Off')));
}
/** The rear-axle steering row only for a car that has it, with its own settings. */
export function syncCarPicker(v: Vehicle): void {
  const rs = v.spec.rearSteer;
  $('optRas').hidden = !rs;
  $('segRas').querySelectorAll<HTMLElement>('button').forEach(b => { b.hidden = !rs?.options.includes(+b.dataset.v!); });
}

const m = (x: number, d = 2) => `${x.toFixed(d)} m`;
/** A figure as its file gives it, with two decimals at least (1 m reads 1.00 m). */
const n = (x: number) => (/\.\d\d/.test(String(x)) ? String(x) : x.toFixed(2));
const SENSORS: Record<string, string> = {
  '4-front-4-rear-2-each-side': 'four in each bumper and two on each side',
  '4-front-4-rear': 'four in each bumper',
  '4-rear': 'four in the rear bumper',
};

/** The Info sheet's table for the car being driven. */
export function renderCarFacts(v: Vehicle): void {
  const s = v.spec, d = s.dims, c = circlesOf(v);
  const pub = s.turning.kerbRadius !== undefined ? { kerbDiameter: 2 * s.turning.kerbRadius } : (s.turning.circles ?? []).find(k => (k.rearSteer ?? 0) === v.REAR_DEG);
  const mirrorW = d.widthMirrors ?? (s.mirrors ? 2 * s.mirrors.box[3] : d.width);
  const [inner, outer] = ackermann(v, v.MAXSTEER * DEG).map(a => Math.abs(a) / DEG);
  const rows: [string, string, string][] = [
    ['Length / width / height', `${n(d.length)} / ${n(d.width)} / ${n(d.height)} m`, ''],
    ['Width with mirrors', m(mirrorW), ''],
    ['Wheelbase, track', `${n(d.wheelbase)} m, ${n(d.track)} m`, ''],
    ['Overhangs front / rear', `${n(d.overhangFront)} / ${n(d.overhangRear)} m`, ''],
    ['Turning circle, kerb to kerb', m(c.kerb), pub?.kerbDiameter ? `published ${pub.kerbDiameter} m: the outer front wheel's circle` : 'the outer front wheel\'s circle'],
    ['Turning circle, wall to wall', m(c.wall), pub?.wallDiameter ? `published ${pub.wallDiameter} m: what the body sweeps` : 'what the body sweeps'],
  ];
  if (s.rearSteer) rows.push(['Rear-axle steering', v.REAR_DEG ? `${v.REAR_DEG}° at full lock` : 'off', v.RA ? `the rear wheels turn against the front ones, so the car turns about a point ${m(-v.RA)} ahead of the rear axle` : 'the car turns about its rear axle']);
  rows.push(
    ['Road-wheel angle at full lock', `${v.MAXSTEER.toFixed(1)}°`, `inner wheel ${inner.toFixed(1)}°, outer ${outer.toFixed(1)}° (Ackermann); worked out from the turning circle`],
    ['Steering wheel, lock to lock', s.turning.turnsLockToLock ? `${s.turning.turnsLockToLock} turns` : 'not published', 'the game uses the setting in Setup'],
    ['Parking sensors', s.parkingSensors ? SENSORS[s.parkingSensors.layout] ?? s.parkingSensors.layout : 'none', ''],
  );
  // label | value, with the note under the value: three columns do not fit a phone
  const tr = ([label, value, note]: [string, string, string]) => {
    const t = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td');
    a.textContent = label; b.textContent = value;
    if (note) { const n = document.createElement('small'); n.textContent = note; b.append(n); }
    t.append(a, b); return t;
  };
  const table = document.createElement('table'); table.className = 'dim'; table.append(...rows.map(tr));
  const h = document.createElement('h4'); h.textContent = s.name;
  const out: HTMLElement[] = [h];
  if (s.basedOn) { const p = document.createElement('p'); p.className = 'est'; p.textContent = s.basedOn; out.push(p); }
  out.push(table);
  if (s.estimates?.length) { const p = document.createElement('p'); p.className = 'est'; p.textContent = `Estimates, not from a source: ${s.estimates.join('; ')}.`; out.push(p); }
  if (s.sources?.length) {
    const ul = document.createElement('ul'); ul.className = 'src';
    for (const src of s.sources) {
      const li = document.createElement('li'), at = src.search(/https?:\/\//);
      if (at < 0) li.textContent = src;
      else { const url = src.slice(at).trim(), a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = new URL(url).hostname.replace(/^www\./, ''); li.append(src.slice(0, at).trim() + ' ', a); }
      ul.append(li);
    }
    out.push(ul);
  }
  $('carFacts').replaceChildren(...out);
}
