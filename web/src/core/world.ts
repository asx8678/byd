// A spatial grid over a scene's obstacles, so that collisions and sensor rays on a big map only look at what is
// nearby. Small scenes (the garage, the levels, the lessons) are left as they are: the same list in the same order.
import type { Obstacle } from './scene';

const CELL = 10, SMALL = 64;
interface Grid { x0: number; z0: number; nx: number; nz: number; cells: number[][] }
const grids = new WeakMap<readonly Obstacle[], Grid>();

function gridOf(obs: readonly Obstacle[]): Grid {
  let g = grids.get(obs);
  if (g) return g;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const o of obs) { x0 = Math.min(x0, o.bx0); x1 = Math.max(x1, o.bx1); z0 = Math.min(z0, o.bz0); z1 = Math.max(z1, o.bz1); }
  const nx = Math.max(1, Math.ceil((x1 - x0) / CELL)), nz = Math.max(1, Math.ceil((z1 - z0) / CELL));
  const cells: number[][] = Array.from({ length: nx * nz }, () => []);
  obs.forEach((o, k) => {
    const i0 = Math.floor((o.bx0 - x0) / CELL), i1 = Math.min(nx - 1, Math.floor((o.bx1 - x0) / CELL));
    const j0 = Math.floor((o.bz0 - z0) / CELL), j1 = Math.min(nz - 1, Math.floor((o.bz1 - z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * nx + i].push(k);
  });
  g = { x0, z0, nx, nz, cells };
  grids.set(obs, g);
  return g;
}

/** The obstacles whose bounding boxes may reach the square (x ± r, z ± r), in the scene's own order (so the first
 *  thing touched is always the same one). A small scene's whole list. */
export function nearby(obs: readonly Obstacle[], x: number, z: number, r: number): readonly Obstacle[] {
  if (obs.length <= SMALL) return obs;
  const g = gridOf(obs);
  const i0 = Math.max(0, Math.floor((x - r - g.x0) / CELL)), i1 = Math.min(g.nx - 1, Math.floor((x + r - g.x0) / CELL));
  const j0 = Math.max(0, Math.floor((z - r - g.z0) / CELL)), j1 = Math.min(g.nz - 1, Math.floor((z + r - g.z0) / CELL));
  if (i0 > i1 || j0 > j1) return [];
  const ks = new Set<number>();
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const k of g.cells[j * g.nx + i]) ks.add(k);
  return [...ks].sort((a, b) => a - b).map(k => obs[k]);
}
