// Districts made up from a seed: a grid of streets of different widths and speeds, parking on most kerbs, a few zones,
// now and then a car park or two in a block, sometimes the harbour, and a difficulty level that makes the lanes narrower,
// the street fuller and sloppier and the free spaces tighter: from about half a car length to spare at level 1 to a
// metre at level 10. The result is a map spec like the hand-made ones (content/maps/), so the map kit builds it the same
// way and the same checks hold. The same seed and level always give the same district.
import { streetsOf, lotRoads, type MapSpec, type RoadSpec, type ZoneSpec } from './city';
import { mulberry32 } from './generator/templates';
import { layoutLot, type LotSpec } from './lot';

const PLACES = ['Northgate', 'Castleton', 'Saltmarsh', 'Ferryside', 'Kingsmead', 'Abbey Hill', 'Rivermouth', 'Old Wharf', 'Westbury', 'Merchant', 'Crossways', 'Fishergate'];
const ACROSS = ['High Street', 'Chapel Street', 'Bridge Street', 'King Street', 'Station Road', 'Church Lane', 'Victoria Road'];
const UPDOWN = ['Tanner Row', 'Water Lane', 'Silver Street', 'Union Street', 'Castle Hill', 'Garden Lane', 'North Road', 'Ship Street'];
/** The levels the Play sheet offers: roomy, average and tight. */
export const DISTRICT_LEVELS = [2, 5, 9] as const;
/** A made-up district's map id carries its level (gen2, gen5, gen9); its layout seed makes the rest. */
export const districtId = (level: number): string => `gen${level}`;
export const districtLevel = (id: string): number | null => { const m = /^gen(\d+)$/.exec(id); return m ? Math.min(10, Math.max(1, +m[1])) : null; };

const r1 = (n: number) => Math.round(n * 10) / 10;
const pick = <T>(rnd: () => number, xs: readonly T[], taken: Set<T>): T => { const free = xs.filter(x => !taken.has(x)); const x = free[Math.floor(rnd() * free.length)] ?? xs[0]; taken.add(x); return x; };

export function generateDistrict(seed: number, level: number): MapSpec {
  const rnd = mulberry32(seed * 40503 + level * 977 + 11), r = (a: number, b: number) => a + (b - a) * rnd(), t = (Math.min(10, Math.max(1, level)) - 1) / 9;
  // the grid: two or three streets across (along x), two to four up and down (along y)
  const nx = 2 + (rnd() < 0.55 ? 1 : 0), ny = 2 + Math.floor(rnd() * 3);
  const ys = [0], xs = [0];
  for (let k = 1; k < nx; k++) ys.push(Math.round(ys[k - 1] + r(56, 72)));
  for (let k = 1; k < ny; k++) xs.push(Math.round(xs[k - 1] + r(78, 108)));
  const cy = Math.round((ys[0] + ys[nx - 1]) / 2), cx = Math.round((xs[0] + xs[ny - 1]) / 2);
  for (let k = 0; k < nx; k++) ys[k] -= cy;
  for (let k = 0; k < ny; k++) xs[k] -= cx;
  // each street: its lanes (narrower when harder), speed limit, parking and pavement on each side
  const names = new Set<string>(), side = () => ({ ...(rnd() < 0.75 ? { park: r1(r(2.0, 2.2)) } : {}), walk: r1(r(2.4, 3.6)) });
  const road = (axis: 'x' | 'y', at: number, id: string): RoadSpec => {
    const lane = r1(r(3.05, 3.4) - 0.3 * t);
    return { id, name: pick(rnd, axis === 'x' ? ACROSS : UPDOWN, names), axis, at, lane, limit: lane >= 3.15 && rnd() < 0.6 ? 50 : 30, right: side(), left: side() };
  };
  const roads = [...ys.map((y, k) => road('x', y, `x${k}`)), ...xs.map((x, k) => road('y', x, `y${k}`))];
  const spec: MapSpec = {
    format: 1, id: districtId(level), name: `${PLACES[seed % PLACES.length]} district`, notes: [`Made up from layout ${seed} at level ${level}.`],
    drive: 'right', bounds: [xs[0] - 25, ys[0] - 25, xs[ny - 1] + 25, ys[nx - 1] + 25], corner: 6, roads, zones: [], lots: [],
    harbourSide: rnd() < 0.4 ? 'south' : undefined,
    fill: { occupancy: Math.round((0.78 + 0.14 * t) * 100) / 100, sloppiness: Math.round((0.06 + 0.12 * t) * 100) / 100, guarantee: 5, spare: [r1(2.4 - 1.3 * t), r1(3.0 - 1.5 * t)] },
    start: { road: 'x0', at: 0, dir: 1 },
  };
  // the stretches of each street between the junctions, clear of the corners
  const hw = (q: RoadSpec, s: 'right' | 'left') => q.lane + (q[s].park ?? 0);
  const across = (q: RoadSpec) => roads.filter(o => o.axis !== q.axis).map(o => o.at).sort((a, b) => a - b);
  const segments = (q: RoadSpec): [number, number][] => { const cs = across(q); return cs.slice(1).map((c, k) => [cs[k] + 13, c - 13] as [number, number]).filter(([a, b]) => b - a > 12); };
  // a few zones on kerbs with parking: a bus stop on a fast street, loading, no parking, a disabled bay
  const zones: ZoneSpec[] = [];
  for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < 12 && zones.length < n; k++) {
    const q = roads[Math.floor(rnd() * roads.length)], sd = rnd() < 0.5 ? 'right' : 'left', segs = segments(q);
    const kinds = (q.limit === 50 ? ['bus', 'loading', 'none', 'disabled'] : ['loading', 'none', 'disabled']) as ZoneSpec['kind'][];
    const kind = kinds[Math.floor(rnd() * kinds.length)], len = kind === 'bus' ? 20 : kind === 'loading' ? 12 : kind === 'disabled' ? 6.6 : 14;
    if (!q[sd].park || !segs.length) continue;
    const [a, b] = segs[Math.floor(rnd() * segs.length)];
    if (b - a < len + 2) continue;
    const from = r1(r(a, b - len));
    if (zones.some(z => z.road === q.id && z.side === sd && from < z.to + 3 && from + len > z.from - 3)) continue;
    zones.push({ road: q.id, side: sd, from, to: r1(from + len), kind });
  }
  spec.zones = zones;
  // now and then a car park in a block, against one of its streets, at 90°, 60° or 45°
  const lots: LotSpec[] = [], world = lotRoads(streetsOf(spec));
  for (let k = 0, want = rnd() < 0.3 ? 0 : rnd() < 0.6 ? 1 : 2, used = new Set<string>(); k < 8 && lots.length < want; k++) {
    const i = Math.floor(rnd() * (ny - 1)), j = Math.floor(rnd() * (nx - 1)), key = `${i}:${j}`;
    if (used.has(key)) continue;
    const W = roads[nx + i], E = roads[nx + i + 1], S = roads[j], N = roads[j + 1];
    // the block behind its pavements (the map frame: an x road's right side is its south side, a y road's its east side)
    const x0 = W.at + hw(W, 'right') + W.right.walk, x1 = E.at - hw(E, 'left') - E.left.walk, y0 = S.at + hw(S, 'left') + S.left.walk, y1 = N.at - hw(N, 'right') - N.right.walk;
    const face = (['W', 'E', 'S', 'N'] as const)[Math.floor(rnd() * 4)], deep = (f: number) => Math.min(f - 4, 36);
    const rect = face === 'S' ? [x0 + 4, y0 + 0.05, x1 - 4, y0 + deep(y1 - y0)] : face === 'N' ? [x0 + 4, y1 - deep(y1 - y0), x1 - 4, y1 - 0.05]
      : face === 'W' ? [x0 + 0.05, y0 + 4, x0 + deep(x1 - x0), y1 - 4] : [x1 - deep(x1 - x0), y0 + 4, x1 - 0.05, y1 - 4];
    const entry = { S, N, W, E }[face], angle = ([90, 60, 45] as const)[Math.floor(rnd() * 3)], aisle = angle === 90 ? 6.0 : angle === 60 ? 4.6 : 4.0;
    const at = entry.axis === 'x' ? (rect[0] + rect[2]) / 2 : (rect[1] + rect[3]) / 2, first = rnd() < 0.5 ? 'x' : 'y';
    for (const aisles of [first, first === 'x' ? 'y' : 'x'] as const) {
      const lot: LotSpec = { id: `P${lots.length + 1}`, name: `${entry.name} car park`, rect: rect.map(r1), aisles, angle, bay: [2.5, 5.0], aisle, entry: entry.id, at: r1(at) };
      try { layoutLot(lot, world); } catch { continue; }
      lots.push(lot); used.add(key); break;
    }
  }
  spec.lots = lots;
  // you start in your lane on a street across the district, in the middle of a block
  const sr = roads[Math.floor(rnd() * nx)], segs = segments(sr), [a, b] = segs[Math.floor(rnd() * segs.length)] ?? [-10, 10];
  spec.start = { road: sr.id, at: r1((a + b) / 2), dir: rnd() < 0.5 ? 1 : -1 };
  return spec;
}
