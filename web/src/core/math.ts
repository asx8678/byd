// Small numeric helpers shared by the simulation and the UI.

export type Pt = [number, number];   // a point on the floor: [x, z] in metres

export const DEG = Math.PI / 180;
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const wrapPi = (a: number): number => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
