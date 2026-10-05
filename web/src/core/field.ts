// A fast stand-in for the collision check, for the route planner. Obstacles are rasterised at
// 5 cm with a distance field; the car's outline and mirrors are tested against the raster (grown
// by one cell, so it never under-reports). Routes are re-checked with the exact `collides`.
// Kerbs are half-planes the wheels may not cross; the bumpers may hang over them. A kerb that is not on one of those
// lines (on a street map, a corner's curve near a space at the end of a street) is rasterised for the wheels alone.
import { collides, wheelsOf } from './collision';
import type { Pt } from './math';
import type { Kerb, Obstacle } from './scene';
import type { Vehicle } from './vehicle';

export type { Kerb } from './scene';

export const CELL = 0.05;

function outline(poly: readonly Pt[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 0; k < n; k++) out.push(ax + (bx - ax) * k / n, az + (bz - az) * k / n);
  }
  return out;
}

/** Points and covering circles for one car, worked out once. */
interface CarShape { body: Float64Array; mirrors: Float64Array; wheels: Float64Array; wheelEdge: Float64Array; cover: number[]; coverR: number; bodyR: number }
const shapes = new WeakMap<Vehicle, CarShape>();
function shapeOf(v: Vehicle): CarShape {
  let s = shapes.get(v);
  if (s) return s;
  const body = Float64Array.from(outline(v.body, 0.04));
  const mirrors = Float64Array.from(v.mirrors.flatMap(m => outline(m, 0.03)));
  const wheels: number[] = [];
  for (const w of wheelsOf(v)) for (const [lx, lz] of w.pts) wheels.push(lx, lz);   // the same tyre rectangles collides() uses
  const wheelEdge = Float64Array.from(wheelsOf(v).flatMap(w => outline(w.pts, 0.12)));   // round each tyre, every 12 cm or less
  // three circles along the car; their radius covers every outline point (with and without the mirrors)
  const cover = [0, 1, 2].map(i => -v.OVR + v.L * (2 * i + 1) / 6);
  const reach = (pts: Float64Array) => { let r = 0; for (let k = 0; k < pts.length; k += 2) r = Math.max(r, Math.min(...cover.map(c => Math.hypot(pts[k] - c, pts[k + 1])))); return r; };
  const bodyR = reach(body) + 0.01, coverR = Math.max(bodyR, reach(mirrors) + 0.01);
  s = { body, mirrors, wheels: Float64Array.from(wheels), wheelEdge, cover, coverR, bodyR };
  shapes.set(v, s);
  return s;
}

/** A raster grown by one cell all round. */
function grow(raw: Uint8Array, nx: number, nz: number): Uint8Array {
  const out = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let b = 0;
    for (let dj = -1; dj <= 1 && !b; dj++) for (let di = -1; di <= 1; di++) { const jj = j + dj, ii = i + di; if (jj >= 0 && jj < nz && ii >= 0 && ii < nx && raw[jj * nx + ii]) { b = 1; break; } }
    out[j * nx + i] = b;
  }
  return out;
}

/** Exact squared Euclidean distance transform in 1D (Felzenszwalb & Huttenlocher). */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, zz: Float64Array): void {
  let k = 0; v[0] = 0; zz[0] = -Infinity; zz[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= zz[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; zz[k] = s; zz[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (zz[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}

export class Field {
  readonly nx: number; readonly nz: number;
  readonly body: Uint8Array; readonly tall: Uint8Array; readonly dist: Float32Array;
  /** Kerbs off the half-planes' lines, for the wheels only (null when every kerb is one of the lines). */
  readonly kerbRaster: Uint8Array | null;
  private readonly s: CarShape;
  constructor(readonly v: Vehicle, readonly obstacles: readonly Obstacle[], readonly x0: number, x1: number, readonly z0: number, z1: number, readonly kerbs: readonly Kerb[] = []) {
    this.s = shapeOf(v);
    const nx = this.nx = Math.ceil((x1 - x0) / CELL), nz = this.nz = Math.ceil((z1 - z0) / CELL);
    const body = this.body = new Uint8Array(nx * nz), tall = this.tall = new Uint8Array(nx * nz);
    const raw = new Uint8Array(nx * nz), rawT = new Uint8Array(nx * nz);
    const onLine = (o: Obstacle) => o.kind === 'poly' && kerbs.some(k => [o.pts[0], o.pts[1]].every(p => Math.abs(k.nx * p[0] + k.nz * p[1] - k.c) < 1e-6));
    const offLine = obstacles.filter(o => o.cls === 'kerb' && !onLine(o)), rawK = offLine.length ? new Uint8Array(nx * nz) : null;
    // the wheels meet kerbs through the half-planes, and through a raster of their own for any kerb off those lines
    for (const o of [...obstacles.filter(q => q.cls !== 'kerb'), ...offLine]) {
      const asKerb = o.cls === 'kerb';
      const i0 = Math.max(0, Math.floor((o.bx0 - x0) / CELL)), i1 = Math.min(nx - 1, Math.ceil((o.bx1 - x0) / CELL));
      const j0 = Math.max(0, Math.floor((o.bz0 - z0) / CELL)), j1 = Math.min(nz - 1, Math.ceil((o.bz1 - z0) / CELL));
      const isTall = o.h > v.mirrorY;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * CELL, pz = z0 + (j + 0.5) * CELL;
        let inside: boolean;
        if (o.kind === 'circle') inside = (px - o.x) ** 2 + (pz - o.z) ** 2 <= o.r * o.r;
        else {
          let pos = 0, neg = 0; const P = o.pts;
          for (let k = 0; k < P.length; k++) { const a = P[k], b = P[(k + 1) % P.length]; const c = (b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0]); if (c > 0) pos++; else if (c < 0) neg++; }
          inside = !(pos && neg);
        }
        if (inside) { if (asKerb) rawK![j * nx + i] = 1; else { raw[j * nx + i] = 1; if (isTall) rawT[j * nx + i] = 1; } }
      }
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      let b = 0, t = 0;
      for (let dj = -1; dj <= 1 && !(b && t); dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj, ii = i + di; if (jj < 0 || jj >= nz || ii < 0 || ii >= nx) continue;
        const k = jj * nx + ii; if (raw[k]) b = 1; if (rawT[k]) t = 1;
      }
      body[j * nx + i] = b; tall[j * nx + i] = t;
    }
    this.kerbRaster = rawK ? grow(rawK, nx, nz) : null;
    const INF = 1e12, n = Math.max(nx, nz), f = new Float64Array(n), d = new Float64Array(n), vv = new Int32Array(n), zz = new Float64Array(n + 1);
    const tmp = new Float64Array(nx * nz);
    for (let i = 0; i < nx; i++) { for (let j = 0; j < nz; j++) f[j] = body[j * nx + i] ? 0 : INF; edt1(f, nz, d, vv, zz); for (let j = 0; j < nz; j++) tmp[j * nx + i] = d[j]; }
    const dist = this.dist = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) { for (let i = 0; i < nx; i++) f[i] = tmp[j * nx + i]; edt1(f, nx, d, vv, zz); for (let i = 0; i < nx; i++) dist[j * nx + i] = Math.sqrt(d[i]) * CELL; }
  }

  /** Distance in metres from (x, z) to the nearest obstacle; 0 outside the field. */
  distAt(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return 0;
    return this.dist[j * this.nx + i];
  }
  private hit(layer: Uint8Array, x: number, z: number): boolean {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return true;
    return layer[j * this.nx + i] === 1;
  }
  /** Wheels on the road side of every kerb. */
  wheelsOk(px: number, pz: number, th: number): boolean {
    const cs = Math.cos(th), sn = Math.sin(th);
    if (this.kerbs.length) {
      const W = this.s.wheels;
      for (let k = 0; k < W.length; k += 2) {
        const lx = W[k], lz = W[k + 1], wx = px + lx * cs + lz * sn, wz = pz - lx * sn + lz * cs;
        for (const kb of this.kerbs) if (kb.nx * wx + kb.nz * wz > kb.c) return false;
      }
    }
    if (this.kerbRaster) {
      const E = this.s.wheelEdge;
      for (let k = 0; k < E.length; k += 2) { const lx = E[k], lz = E[k + 1]; if (this.hit(this.kerbRaster, px + lx * cs + lz * sn, pz - lx * sn + lz * cs)) return false; }
    }
    return true;
  }
  /** Free of obstacles (raster) and kerbs at rear-axle pose (px, pz, th)? */
  free(px: number, pz: number, th: number): boolean {
    if (!this.wheelsOk(px, pz, th)) return false;
    const cs = Math.cos(th), sn = Math.sin(th), S = this.s;
    let near = false;
    for (const c of S.cover) if (this.distAt(px + c * cs, pz - c * sn) < S.coverR) { near = true; break; }
    if (!near) return true;
    for (let k = 0; k < S.body.length; k += 2) { const lx = S.body[k], lz = S.body[k + 1]; if (this.hit(this.body, px + lx * cs + lz * sn, pz - lx * sn + lz * cs)) return false; }
    for (let k = 0; k < S.mirrors.length; k += 2) { const lx = S.mirrors[k], lz = S.mirrors[k + 1]; if (this.hit(this.tall, px + lx * cs + lz * sn, pz - lx * sn + lz * cs)) return false; }
    return true;
  }
  /** free() only sees obstacles that cross the car's outline, which is all a moving car can meet. A pose
   *  placed out of nowhere (a start, a parked goal) could have something wholly inside it: check those exactly. */
  freeExact(px: number, pz: number, th: number): boolean {
    return this.free(px, pz, th) && !collides(this.v, this.obstacles, px, pz, th);
  }
  /** A quick lower bound on the body's clearance, from the covering circles. */
  roughClearance(px: number, pz: number, th: number): number {
    const cs = Math.cos(th), sn = Math.sin(th), S = this.s;
    let m = Infinity;
    for (const c of S.cover) m = Math.min(m, this.distAt(px + c * cs, pz - c * sn) - S.bodyR);
    return Math.max(0, m);
  }
  /** Smallest gap (m) between the body outline and any obstacle. */
  clearance(px: number, pz: number, th: number): number {
    const cs = Math.cos(th), sn = Math.sin(th), B = this.s.body;
    let m = Infinity;
    for (let k = 0; k < B.length; k += 2) { const lx = B[k], lz = B[k + 1]; m = Math.min(m, this.distAt(px + lx * cs + lz * sn, pz - lx * sn + lz * cs)); }
    return Math.max(0, m - CELL);
  }
}
