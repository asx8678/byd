// The road network of a graph map (core/graphMap.ts), the same kind the grid districts have (core/traffic.ts): a lane
// each way along a two-way street and one along a one-way street, between the junctions' corners; at each junction a path
// from every lane in to every lane out but the way back, a line, an arc and a line. A junction OpenStreetMap gives traffic
// lights has them (the main pair of arms green, then the others); where main roads meet side roads, or at a T, the side
// road gives way; elsewhere the first one there goes, and a turn across the oncoming lane gives way.
//
// Where a street runs off the map, traffic drives off it and comes back on where a street comes in (the other way along
// the same street when it can, else the nearest): the way between is a path well off the map, where nothing sees the cars
// on it, so they need nothing of their own.
import { streetPt, streetST, type CityMap, type Street } from './city';
import { headingOf, kerbSideOf, type GNode } from './graphMap';
import { wrapPi, type Pt } from './math';
import type { Rect } from './scene';
import { CYCLE, OFF, TYPES, fitting, laneT, poseOn, settleJunction, type Control, type El, type Junction, type Network, type Piece, type Turn } from './traffic';

/** Far off the map: where the ways between the map's edges run. */
const AWAY = 20000;

export function buildGraphNetwork(map: CityMap): Network {
  const G = map.graph!, drive = map.drive, R = (map.spec as { corner?: number }).corner ?? 5, els: El[] = [], junctions: Junction[] = [];
  const nodeIx = new Map<string, number>(), major = new Set((map.spec as { roads: { id: string; major?: boolean }[] }).roads.filter(r => r.major).map(r => r.id));
  // the junctions: every node with two arms or more (a bend has two and nothing to decide); one more for the map's edge
  for (const n of G.nodes) {
    if (n.edge || n.arms.length < 2) continue;
    nodeIx.set(n.id, junctions.length);
    const xs = n.poly.map(p => p[0]), zs = n.poly.map(p => p[1]), rect: Rect = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    junctions.push({ id: n.id, name: junctionName(n), rect, control: 'none', arms: n.arms.length, offset: (junctions.length * 17) % CYCLE, minor: null, approaches: [], poly: n.poly });
  }
  const EDGE = junctions.length;
  junctions.push({ id: 'edge', name: 'the edge of the map', rect: [AWAY, AWAY + 1, AWAY, AWAY + 1], control: 'none', arms: 0, offset: 0, minor: null, approaches: [] });
  // each junction's groups: its main pair of arms (the two most nearly in line, main roads first) is 'x', the others 'z';
  // lights for a node OpenStreetMap marks, a give-way line for the side roads where main roads meet them or at a T
  const group = new Map<string, 'x' | 'z'>();   // `${node}|${street}`
  for (const n of G.nodes) {
    const ji = nodeIx.get(n.id); if (ji === undefined) continue;
    const J = junctions[ji], arms = n.arms;
    let best: [number, number] = [0, 1], bs = -Infinity;
    for (let i = 0; i < arms.length; i++) for (let k = i + 1; k < arms.length; k++) {
      const line = -(arms[i].dx * arms[k].dx + arms[i].dz * arms[k].dz), mj = +major.has(arms[i].st.id) + +major.has(arms[k].st.id), sc = line + 2 * mj;
      if (sc > bs) { bs = sc; best = [i, k]; }
    }
    arms.forEach((m, i) => group.set(`${n.id}|${m.st.id}`, best.includes(i) ? 'x' : 'z'));
    if (arms.length < 3) continue;
    const mains = arms.filter(m => major.has(m.st.id)).length, mixed = mains > 0 && mains < arms.length;
    const control: Control = n.lights ? 'lights' : mixed || arms.length === 3 ? 'giveway' : 'none';
    J.control = control;
    J.minor = control === 'giveway' ? 'z' : null;
    if (mixed && control === 'giveway') for (const m of arms) group.set(`${n.id}|${m.st.id}`, major.has(m.st.id) ? 'x' : 'z');
  }
  // the lanes: along each street, from where one end's corners end to where the other's begin (to the map's edge where it
  // runs off: there it starts or ends 2 m in)
  const startJ = new Map<number, number>();
  for (const st of map.streets) {
    const f = st.f!, sides: (1 | -1)[] = f.oneway ? [([1, -1] as const).find(sd => kerbSideOf(st, sd, drive)) ?? 1] : [1, -1];
    for (const side of sides) {
      const dir: 1 | -1 = f.oneway ? f.oneway : ((side > 0) === (drive === 'right') ? 1 : -1);
      const at = (k: 0 | 1) => { const nd = k ? f.b : f.a, arm = G.nodes.find(q => q.id === nd)!.arms.find(m => m.st === st && m.end === (k ? 'b' : 'a')); return f.edge[k] ? 1.5 : (arm?.back ?? 0) + 0.5; };
      let s0 = at(0), s1 = f.len - at(1);
      if (s1 - s0 < 2) { const mid = (s0 + s1) / 2; s0 = mid - 1; s1 = mid + 1; }
      const [from, to] = dir > 0 ? [s0, s1] : [s1, s0], t = f.oneway ? 0 : side * laneT(st), [x, z] = streetPt(st, from, t), h = dir > 0 ? headingOf(f.ux, f.uz) : wrapPi(headingOf(f.ux, f.uz) + Math.PI);
      const endNode = dir > 0 ? f.b : f.a, beginNode = dir > 0 ? f.a : f.b, endEdge = f.edge[dir > 0 ? 1 : 0], beginEdge = f.edge[dir > 0 ? 0 : 1];
      const j = endEdge ? EDGE : nodeIx.get(endNode)!, len = Math.abs(to - from);
      startJ.set(els.length, beginEdge ? EDGE : nodeIx.get(beginNode)!);
      els.push({ id: els.length, kind: 'lane', pieces: [{ s0: 0, len, x, z, h, k: 0 }], len, limit: st.limit, kmax: 0, next: [], from: -1, j, axis: endEdge ? 'x' : group.get(`${endNode}|${st.id}`) ?? 'x', street: st.id, side, turn: 'straight', dh: 0, conflicts: [], siblings: [], name: st.name });
    }
  }
  const lanes = els.slice();
  // the paths through each junction: the biggest arc that touches both lane lines between the two ends (no wider than
  // the corner's kerb plus the further lane's distance from its kerb, on the kerb side), with a straight before or after it
  const fromKerb = (l: El) => { const st = map.streets.find(s => s.id === l.street)!; return st.side[l.side].hw - laneT(st); };
  junctions.forEach((J, ji) => {
    if (ji === EDGE) return;
    const ins = lanes.filter(l => l.j === ji), outs = lanes.filter(l => startJ.get(l.id) === ji), paths: El[] = [];
    for (const a of ins) for (const b of outs) {
      if (a.street === b.street) continue;   // no U-turns
      const [ax, az, ah] = poseOn(a, a.len), [bx, bz, bh] = poseOn(b, 0), dh = wrapPi(bh - ah), pieces: Piece[] = [];
      let s = 0;
      const add = (len: number, x: number, z: number, h: number, k: number) => { if (len > 1e-6) { pieces.push({ s0: s, len, x, z, h, k }); s += len; } };
      const turn: Turn = Math.abs(dh) < Math.PI / 6 ? 'straight' : (dh < 0) === (drive === 'right') ? 'near' : 'far';
      const ux = Math.cos(ah), uz = -Math.sin(ah), vx = Math.cos(bh), vz = -Math.sin(bh), det = ux * (-vz) - uz * (-vx);
      let done = false;
      if (Math.abs(Math.sin(dh)) > 0.05 && Math.abs(det) > 1e-9) {
        const qx = bx - ax, qz = bz - az, dIn = (qx * (-vz) - qz * (-vx)) / det, dOut = -(ux * qz - uz * qx) / det;
        if (dIn >= 0 && dOut >= 0) {
          const X: Pt = [ax + ux * dIn, az + uz * dIn], half = Math.abs(dh) / 2, tn = Math.tan(half);
          const rho = Math.min(dIn, dOut, turn === 'near' ? (R + Math.max(fromKerb(a), fromKerb(b))) * tn : Infinity) / tn;   // tangent length = rho tan(half)
          const T = rho * tn;
          add(dIn - T, ax, az, ah, 0);
          add(rho * Math.abs(dh), X[0] - ux * T, X[1] - uz * T, ah, Math.sign(dh) / rho);
          add(dOut - T, X[0] + vx * T, X[1] + vz * T, bh, 0);
          done = true;
        }
      }
      if (!done) add(Math.hypot(bx - ax, bz - az), ax, az, Math.atan2(-(bz - az), bx - ax), 0);   // nearly straight on: a line
      const e: El = { id: els.length, kind: 'path', pieces, len: s, limit: a.limit, kmax: Math.max(...pieces.map(p => Math.abs(p.k))), next: [b.id], from: a.id, j: ji, axis: a.axis, street: a.street, side: a.side, turn, dh, conflicts: [], siblings: [], name: J.name };
      els.push(e); paths.push(e); a.next.push(e.id);
    }
    settleJunction(J, ji, ins, paths, a => {
      const st = map.streets.find(q => q.id === a.street)!, [ex, ez, eh] = poseOn(a, a.len), [at] = streetST(st, ex, ez);
      // a one-way street's line runs right across it
      const [t0, t1] = st.f!.oneway ? [-st.side[-1].hw, st.side[1].hw] : [0, a.side * st.side[a.side].hw], toKerb = st.f!.oneway ? (kerbSideOf(st, 1, drive) ? 1 : -1) : a.side;
      return { line: [streetPt(st, at, t0), streetPt(st, at, t1)], head: streetPt(st, at, toKerb * (st.side[toKerb].hw + 0.7)), th: eh };
    });
  });
  // off the map's edge and back on: from each lane running off it to the lane coming back on along the same street, or the
  // nearest that comes on, along a line far away
  const offs = lanes.filter(l => l.j === EDGE), ons = lanes.filter(l => startJ.get(l.id) === EDGE);
  offs.forEach((a, k) => {
    const [ax, az] = poseOn(a, a.len), back = ons.find(b => b.street === a.street);
    const b = back ?? ons.slice().sort((p, q) => Math.hypot(p.pieces[0].x - ax, p.pieces[0].z - az) - Math.hypot(q.pieces[0].x - ax, q.pieces[0].z - az))[0];
    if (!b) return;
    const len = 40 + Math.hypot(b.pieces[0].x - ax, b.pieces[0].z - az) / 2, e: El = { id: els.length, kind: 'path', pieces: [{ s0: 0, len, x: AWAY + 60 * k, z: AWAY, h: 0, k: 0 }], len, limit: 50, kmax: 0, next: [b.id], from: a.id, j: EDGE, axis: 'x', street: a.street, side: a.side, turn: 'straight', dh: 0, conflicts: [], siblings: [], name: 'off the map', portal: true };
    els.push(e); a.next.push(e.id);
  });
  // each street's lanes' groups at the junctions they come to, for the rules (which light is yours)
  for (const l of lanes) { const st = map.streets.find(s => s.id === l.street)!; (st.f!.axis ??= {})[l.side] = l.axis; }
  void OFF;
  return { map, drive, els, junctions, laneLen: lanes.reduce((m, l) => m + l.len, 0), ok: TYPES.map(ty => fitting(map, els, ty)) };
}

/** A junction's name: its streets' names (two of them, or one and another), or its place on the street. */
function junctionName(n: GNode): string {
  const names = [...new Set(n.arms.map(m => m.st.name).filter(Boolean))];
  return names.length >= 2 ? `${names[0]} and ${names[1]}` : names.length ? `the corner of ${names[0]}` : 'the junction';
}
export type { Street };
