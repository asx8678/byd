// Where the car goes at the current steering: rolled along its arc in 6 cm steps until it would touch something, 6 m at most.
import { footprint } from './car';
import { collides, type CarPart } from './collision';
import { DEG, type Pt } from './math';
import type { Obstacle } from './scene';
import { ballAt, folded, towStep, trailerHits, type Trailer } from './trailer';
import type { Vehicle } from './vehicle';

export interface Prediction {
  dir: 1 | -1;
  tracks: { fl: Pt[]; fr: Pt[]; rl: Pt[]; rr: Pt[]; swing: Pt[]; rearAxle: Pt[] };   // swing: the end that swings out
  ghosts: [number, number, number][];   // a pose every 0.8 m
  hit: Obstacle | null;
  part: CarPart;
  dist: number;
  end: [number, number, number];
}

export function predictPath(v: Vehicle, obstacles: readonly Obstacle[], x: number, z: number, th: number, steerDeg: number, dir: 1 | -1, extra?: readonly Obstacle[]): Prediction {
  const k = Math.tan(-steerDeg * DEG) / v.WB, step = 0.06 * dir, sg = Math.sign(steerDeg) || 1;
  const fc = v.planCorners[1];   // front-right corner, mirrored for the side that swings
  const swing: Pt = dir > 0 ? [0, sg * v.W / 2] : [fc[0], -sg * fc[1]];   // inner rear going forward, outer front corner reversing
  const pts = [...v.planCorners, swing];
  const tracks: Prediction['tracks'] = { fl: [], fr: [], rl: [], rr: [], swing: [], rearAxle: [] }, ghosts: Prediction['ghosts'] = [];
  let px = x, pz = z, ph = th, s = 0, hit: Obstacle | null = null, part: CarPart = '', nextGhost = 0.8;
  const rec = () => { const c = footprint(px, pz, ph, pts); tracks.fl.push(c[0]); tracks.fr.push(c[1]); tracks.rl.push(c[2]); tracks.rr.push(c[3]); tracks.swing.push(c[4]); tracks.rearAxle.push([px, pz]); };
  rec();
  while (Math.abs(s) < 6) {
    let nx, nz, nh;
    if (Math.abs(k) < 1e-6) { nx = px + step * Math.cos(ph); nz = pz - step * Math.sin(ph); nh = ph; }
    else { nh = ph + step * k; nx = px + (Math.sin(nh) - Math.sin(ph)) / k; nz = pz + (Math.cos(nh) - Math.cos(ph)) / k; }
    const o = collides(v, obstacles, nx, nz, nh, extra); if (o) { hit = o.obstacle; part = o.part; break; }
    px = nx; pz = nz; ph = nh; s += step; rec();
    if (Math.abs(s) >= nextGhost - 1e-9) { ghosts.push([px, pz, ph]); nextGhost += 0.8; }
  }
  return { tracks, ghosts, hit, part, dist: Math.abs(s), end: [px, pz, ph], dir };
}

/** With a trailer on: the trailer's way at the current steering as well, from its back corners, an outline of it every
 *  0.8 m, and whether it would fold into the car (a jackknife) before anything else is touched. */
export interface TowPrediction extends Prediction { tow: { rl: Pt[]; rr: Pt[]; ghosts: [number, number, number][]; folded: boolean; thit: Obstacle | null } }

export function predictTow(v: Vehicle, t: Trailer, obstacles: readonly Obstacle[], x: number, z: number, th: number, tth: number, steerDeg: number, dir: 1 | -1): TowPrediction {
  const k = Math.tan(-steerDeg * DEG) / v.WB, step = 0.06 * dir, sg = Math.sign(steerDeg) || 1;
  const fc = v.planCorners[1], swing: Pt = dir > 0 ? [0, sg * v.W / 2] : [fc[0], -sg * fc[1]], pts = [...v.planCorners, swing];
  const back: Pt[] = [[-t.length, -t.width / 2], [-t.length, t.width / 2]];
  const tracks: Prediction['tracks'] = { fl: [], fr: [], rl: [], rr: [], swing: [], rearAxle: [] }, ghosts: Prediction['ghosts'] = [];
  const tow: TowPrediction['tow'] = { rl: [], rr: [], ghosts: [], folded: false, thit: null };
  let px = x, pz = z, ph = th, pt = tth, s = 0, hit: Obstacle | null = null, part: CarPart = '', nextGhost = 0.8;
  const rec = () => {
    const c = footprint(px, pz, ph, pts); tracks.fl.push(c[0]); tracks.fr.push(c[1]); tracks.rl.push(c[2]); tracks.rr.push(c[3]); tracks.swing.push(c[4]); tracks.rearAxle.push([px, pz]);
    const [bx, bz] = ballAt(v, px, pz, ph), b = footprint(bx, bz, pt, back); tow.rl.push(b[0]); tow.rr.push(b[1]);
  };
  rec();
  while (Math.abs(s) < 6) {
    let nx, nz, nh;
    if (Math.abs(k) < 1e-6) { nx = px + step * Math.cos(ph); nz = pz - step * Math.sin(ph); nh = ph; }
    else { nh = ph + step * k; nx = px + (Math.sin(nh) - Math.sin(ph)) / k; nz = pz + (Math.cos(nh) - Math.cos(ph)) / k; }
    const nt = towStep(t.L1, ballAt(v, px, pz, ph), ballAt(v, nx, nz, nh), pt);
    const o = collides(v, obstacles, nx, nz, nh); if (o) { hit = o.obstacle; part = o.part; break; }
    if (folded(v, t, nx, nz, nh, nt)) { tow.folded = true; part = 'jackknife'; break; }
    const [bx, bz] = ballAt(v, nx, nz, nh), th2 = trailerHits(t, obstacles, bx, bz, nt);
    if (th2) { tow.thit = th2.obstacle; part = th2.part; break; }
    px = nx; pz = nz; ph = nh; pt = nt; s += step; rec();
    if (Math.abs(s) >= nextGhost - 1e-9) { ghosts.push([px, pz, ph]); const [gx, gz] = ballAt(v, px, pz, ph); tow.ghosts.push([gx, gz, pt]); nextGhost += 0.8; }
  }
  return { tracks, ghosts, hit, part, dist: Math.abs(s), end: [px, pz, ph], dir, tow };
}
