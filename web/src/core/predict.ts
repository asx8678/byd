// Where the car goes at the current steering: rolled along its arc in 6 cm steps until it would touch something, 6 m at most.
import { CAR, PLAN_CORNERS, footprint } from './car';
import { collides, type CarPart } from './collision';
import type { Obstacle } from './garage';
import { DEG, type Pt } from './math';

export interface Prediction {
  dir: 1 | -1;
  tracks: { fl: Pt[]; fr: Pt[]; rl: Pt[]; rr: Pt[]; swing: Pt[]; rearAxle: Pt[] };   // swing: the end that swings out
  ghosts: [number, number, number][];   // a pose every 0.8 m
  hit: Obstacle | null;
  part: CarPart;
  dist: number;
  end: [number, number, number];
}

export function predictPath(obstacles: readonly Obstacle[], x: number, z: number, th: number, steerDeg: number, dir: 1 | -1): Prediction {
  const k = Math.tan(-steerDeg * DEG) / CAR.WB, step = 0.06 * dir, sg = Math.sign(steerDeg) || 1;
  const swing: Pt = dir > 0 ? [0, sg * CAR.W / 2] : [3.40, -sg * 0.76];   // inner rear going forward, outer front corner reversing
  const pts = [...PLAN_CORNERS, swing];
  const tracks: Prediction['tracks'] = { fl: [], fr: [], rl: [], rr: [], swing: [], rearAxle: [] }, ghosts: Prediction['ghosts'] = [];
  let px = x, pz = z, ph = th, s = 0, hit: Obstacle | null = null, part: CarPart = '', nextGhost = 0.8;
  const rec = () => { const c = footprint(px, pz, ph, pts); tracks.fl.push(c[0]); tracks.fr.push(c[1]); tracks.rl.push(c[2]); tracks.rr.push(c[3]); tracks.swing.push(c[4]); tracks.rearAxle.push([px, pz]); };
  rec();
  while (Math.abs(s) < 6) {
    let nx, nz, nh;
    if (Math.abs(k) < 1e-6) { nx = px + step * Math.cos(ph); nz = pz - step * Math.sin(ph); nh = ph; }
    else { nh = ph + step * k; nx = px + (Math.sin(nh) - Math.sin(ph)) / k; nz = pz + (Math.cos(nh) - Math.cos(ph)) / k; }
    const o = collides(obstacles, nx, nz, nh); if (o) { hit = o.obstacle; part = o.part; break; }
    px = nx; pz = nz; ph = nh; s += step; rec();
    if (Math.abs(s) >= nextGhost - 1e-9) { ghosts.push([px, pz, ph]); nextGhost += 0.8; }
  }
  return { tracks, ghosts, hit, part, dist: Math.abs(s), end: [px, pz, ph], dir };
}
