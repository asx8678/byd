// 2D geometry: polygon overlap (separating axes), circle against polygon, segment distances.
import { clamp, type Pt } from './math';

export function polysOverlap(A: Pt[], B: Pt[]): boolean {
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length], nx = -(q[1] - p[1]), nz = q[0] - p[0];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const w of A) { const d = w[0] * nx + w[1] * nz; if (d < a0) a0 = d; if (d > a1) a1 = d; }
    for (const w of B) { const d = w[0] * nx + w[1] * nz; if (d < b0) b0 = d; if (d > b1) b1 = d; }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

export function circleHitsPoly(cx: number, cz: number, r: number, P: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a[1] > cz) !== (b[1] > cz) && cx < (b[0] - a[0]) * (cz - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    if (ptSeg(cx, cz, a[0], a[1], b[0], b[1]) < r) return true;
  }
  return inside;
}

/** Distance from a point to a segment. */
export function ptSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  const t = l2 ? clamp(((px - ax) * vx + (pz - az) * vz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

function segsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => Math.sign((qx - px) * (rz - pz) - (qz - pz) * (rx - px));
  return o(ax, az, bx, bz, cx, cz) !== o(ax, az, bx, bz, dx, dz) && o(cx, cz, dx, dz, ax, az) !== o(cx, cz, dx, dz, bx, bz);
}

/** Distance between two segments (0 when they cross). */
export function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segsCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return 0;
  return Math.min(ptSeg(a[0], a[1], c[0], c[1], d[0], d[1]), ptSeg(b[0], b[1], c[0], c[1], d[0], d[1]), ptSeg(c[0], c[1], a[0], a[1], b[0], b[1]), ptSeg(d[0], d[1], a[0], a[1], b[0], b[1]));
}
