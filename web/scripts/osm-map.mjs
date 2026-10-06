#!/usr/bin/env node
// A street map from OpenStreetMap (content/maps/*.json, format 2): the streets of a box as straight roads between
// junctions at their real angles, with their names, one-way streets, traffic lights and the buildings along them.
//
//   node scripts/osm-map.mjs fetch <s,w,n,e> <dir>          downloads the box's roads and buildings from Overpass into dir
//   node scripts/osm-map.mjs make <s,w,n,e> <dir> <out.json> --id agadir --name "…"   writes the map from them
//
// What the map takes from OpenStreetMap: where the streets run and meet, their names (the French ones), which are
// one-way, their class (a main road or not), the traffic lights at junctions, and the buildings. What it makes up: a
// street's curves straightened between junctions (and its bends kept as corners), junctions closer than 16 m merged
// into one, the width of each lane, parking lane and pavement (fitted into the room the buildings leave, none of it is
// mapped there), the speed limits (none are mapped), which side road gives way (by class), and who is parked. Alleys
// that lead nowhere, service roads and what the traffic could not drive round in a loop are left out; a road that runs
// off the map's edge stays (the traffic that drives off comes back on where a road comes in). The map file says
// all this in its notes, with the credit OpenStreetMap's licence (ODbL) asks for.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVE = /^(primary|secondary|tertiary|residential|unclassified|living_street|primary_link|secondary_link|tertiary_link)$/;
const MAJOR = /^(primary|secondary|tertiary)/;
const UA = 'parking-trainer-map-import/1.0';
export const CREDIT = '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';

export const queries = ([s, w, n, e]) => ({
  roads: `[out:json][timeout:120];way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|primary_link|secondary_link|tertiary_link|service)$"](${s},${w},${n},${e});out geom tags;node["highway"~"^(traffic_signals|give_way|stop)$"](${s},${w},${n},${e});out;`,
  buildings: `[out:json][timeout:120];way["building"](${s},${w},${n},${e});out geom;`,
});

const r2 = n => Math.round(n * 100) / 100;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Douglas-Peucker: the points of a polyline that keep it within tol of the original. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]], L = dist(a, b) || 1e-9;
  let far = -1, fd = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
    if (d > fd) { fd = d; far = i; }
  }
  if (fd <= tol) return [a, b];
  return [...simplify(pts.slice(0, far + 1), tol).slice(0, -1), ...simplify(pts.slice(far), tol)];
}
/** Where segment p-q crosses the box |x| <= hx, |y| <= hy, going from inside (p) to outside (q). */
function exitPoint(p, q, hx, hy) {
  let t = 1;
  for (const [i, lim] of [[0, hx], [1, hy]]) {
    const d = q[i] - p[i];
    if (d > 0) t = Math.min(t, (lim - p[i]) / d); else if (d < 0) t = Math.min(t, (-lim - p[i]) / d);
  }
  return [r2(p[0] + t * (q[0] - p[0])), r2(p[1] + t * (q[1] - p[1]))];
}
/** The distance from a point to a segment, and how far along it (0 to 1). */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/** Whether two segments cross. */
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
const inPoly = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; };

/**
 * The map from Overpass's answers (roads with their geometry and the signal nodes; buildings) for the box [s, w, n, e].
 * Coordinates: metres from the box's middle, x east and y north.
 */
export function makeMap(roadsJson, buildingsJson, box, o = {}) {
  const [s, w, n, e] = box, la0 = (s + n) / 2, lo0 = (w + e) / 2, kx = 111320 * Math.cos(la0 * Math.PI / 180), ky = 110540;
  const P = (lat, lon) => [r2((lon - lo0) * kx), r2((lat - la0) * ky)], hx = (e - w) * kx / 2, hy = (n - s) * ky / 2;
  const inside = p => Math.abs(p[0]) <= hx + 1e-6 && Math.abs(p[1]) <= hy + 1e-6;
  const signals = roadsJson.elements.filter(x => x.type === 'node' && x.tags?.highway === 'traffic_signals').map(x => P(x.lat, x.lon));
  // 1. the drivable ways inside the box, cut where they leave it; every OSM node a point, shared where ways meet
  const pts = new Map(), runs = [];
  let edgeN = 0;
  for (const x of roadsJson.elements) {
    if (x.type !== 'way' || !x.geometry || !DRIVE.test(x.tags?.highway ?? '')) continue;
    const t = x.tags, name = t['name:fr'] || (t.name ? t.name.replace(/\s*[؀-ۿ].*$/, '').trim() : '');
    const meta = { name, major: MAJOR.test(t.highway), oneway: t.oneway === 'yes' ? 1 : t.oneway === '-1' ? -1 : 0, link: /_link$/.test(t.highway) };
    let cur = [];
    const g = x.geometry.map((q, i) => ({ id: String(x.nodes[i]), p: P(q.lat, q.lon) }));
    g.forEach((q, i) => {
      if (inside(q.p)) {
        if (!cur.length && i > 0) { const id = `edge${++edgeN}`; pts.set(id, exitPoint(q.p, g[i - 1].p, hx, hy)); cur.push(id); }
        pts.set(q.id, q.p); cur.push(q.id);
      } else if (cur.length) { const id = `edge${++edgeN}`; pts.set(id, exitPoint(g[i - 1].p, q.p, hx, hy)); cur.push(id); runs.push({ ids: cur, meta }); cur = []; }
    });
    if (cur.length > 1) runs.push({ ids: cur, meta });
  }
  // 2. chains between junctions: walked along the network, so a street drawn as several ways is one chain; a junction
  //    is where other than two pieces meet, a map edge, or where the name, class or one-way changes. Each chain is
  //    then simplified to straight pieces: its corners become bends
  const segs = [], adj = new Map();
  for (const r of runs) for (let i = 0; i + 1 < r.ids.length; i++) {
    const sg = { p: r.ids[i], q: r.ids[i + 1], meta: r.meta, done: false };
    segs.push(sg);
    for (const id of [sg.p, sg.q]) adj.set(id, [...(adj.get(id) ?? []), sg]);
  }
  const same = (a, b) => a.name === b.name && a.major === b.major && !!a.oneway === !!b.oneway;
  const isJ = id => { const a = adj.get(id) ?? []; return id.startsWith('edge') || a.length !== 2 || !same(a[0].meta, a[1].meta); };
  const chains = [];
  for (const [id] of adj) {
    if (!isJ(id)) continue;
    for (const first of adj.get(id)) {
      if (first.done) continue;
      const ids = [id];
      let at = id, sg = first, ow = 0;
      for (;;) {
        sg.done = true;
        const nx = sg.p === at ? sg.q : sg.p;
        // the one-way, as it runs along the chain: +1 the way the chain is walked, -1 against it
        const o = sg.meta.oneway * (sg.p === at ? 1 : -1);
        if (o) ow = o;
        ids.push(nx); at = nx;
        if (isJ(at)) break;
        sg = adj.get(at).find(q => !q.done);
        if (!sg) break;
      }
      chains.push({ ids, meta: { ...first.meta, oneway: ow } });
    }
  }
  // 3. merge junctions closer than `merge` m (a dual carriageway's two halves, a T a few metres off a crossroads)
  const merge = o.merge ?? 16, jIds = [...new Set(chains.flatMap(c => [c.ids[0], c.ids[c.ids.length - 1]]))];
  const parent = new Map(jIds.map(id => [id, id])), find = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  for (let i = 0; i < jIds.length; i++) for (let k = i + 1; k < jIds.length; k++) {
    if (jIds[i].startsWith('edge') || jIds[k].startsWith('edge')) continue;
    if (dist(pts.get(jIds[i]), pts.get(jIds[k])) < merge) parent.set(find(jIds[i]), find(jIds[k]));
  }
  const groups = new Map();
  for (const id of jIds) { const g = find(id); groups.set(g, [...(groups.get(g) ?? []), id]); }
  const nodeOf = new Map(), nodes = new Map();
  for (const [g, ids] of groups) {
    const ps = ids.map(id => pts.get(id)), at = [r2(ps.reduce((m, p) => m + p[0], 0) / ps.length), r2(ps.reduce((m, p) => m + p[1], 0) / ps.length)];
    nodes.set(g, { id: g, at, edge: ids.some(id => id.startsWith('edge')) });
    for (const id of ids) nodeOf.set(id, g);
  }
  // 4. the roads: each chain straightened (4 m) into pieces between its two junctions and the bends in between
  let roads = [], bendN = 0;
  for (const c of chains) {
    const a = nodeOf.get(c.ids[0]), b = nodeOf.get(c.ids[c.ids.length - 1]);
    if (a === b) continue;
    const line = [nodes.get(a).at, ...c.ids.slice(1, -1).map(id => pts.get(id)), nodes.get(b).at], kept = simplify(line, o.straight ?? 4);
    const ids = [a, ...kept.slice(1, -1).map(p => { const id = `b${++bendN}`; nodes.set(id, { id, at: [r2(p[0]), r2(p[1])], edge: false, bend: true }); return id; }), b];
    for (let i = 0; i + 1 < ids.length; i++) roads.push({ a: ids[i], b: ids[i + 1], ...c.meta });
  }
  // the same piece of road twice (two ways drawn over each other): once
  roads = roads.filter((r, i) => !roads.slice(0, i).some(q => (q.a === r.a && q.b === r.b) || (q.a === r.b && q.b === r.a)));
  // 5. alleys that lead nowhere (an unnamed road to a dead end inside the box), again and again, then what the traffic
  //    cannot drive round: only the biggest part where every road can be reached from every other, both ways
  const degree = () => { const d = new Map(); for (const r of roads) { d.set(r.a, (d.get(r.a) ?? 0) + 1); d.set(r.b, (d.get(r.b) ?? 0) + 1); } return d; };
  for (let changed = true; changed;) {
    const d = degree(), before = roads.length;
    roads = roads.filter(r => !(!r.name && [r.a, r.b].some(id => d.get(id) === 1 && !nodes.get(id).edge)));
    changed = roads.length !== before;
  }
  // a road off the map's edge shorter than 25 m (a junction just inside the box) runs on out to 25 m, so its lanes have
  // room beside the junction's corners (the map's bounds grow to take it in)
  const len = r => dist(nodes.get(r.a).at, nodes.get(r.b).at);
  for (const r of roads) {
    const [inner, outer] = nodes.get(r.a).edge ? [r.b, r.a] : nodes.get(r.b).edge ? [r.a, r.b] : [null, null];
    if (!inner || len(r) >= 25) continue;
    const p = nodes.get(inner).at, q = nodes.get(outer).at, L = dist(p, q) || 1;
    nodes.get(outer).at = [r2(p[0] + (q[0] - p[0]) * 25 / L), r2(p[1] + (q[1] - p[1]) * 25 / L)];
  }
  const dropped = { stubs: 0, cut: 0 }, before = roads.map(r => ({ ...r, pa: nodes.get(r.a).at, pb: nodes.get(r.b).at }));
  // a directed graph of road-ends: going along road r from x to y (allowed by its one-way), then on from y along any
  // other road (not straight back)
  const dirs = rs => rs.flatMap((r, i) => [[i, r.a, r.b, r.oneway >= 0], [i, r.b, r.a, r.oneway <= 0]]).filter(q => q[3]).map(([i, x, y]) => ({ i, x, y }));
  for (let changed = true; changed;) {
    // the map's edge counts as one place: traffic that drives off it comes back on wherever a road comes in (and may
    // come back the way it left)
    const D = dirs(roads), out = new Map(), key = id => (nodes.get(id).edge ? 'OUT' : id);
    for (const [k, q] of D.entries()) out.set(key(q.x), [...(out.get(key(q.x)) ?? []), k]);
    const next = k => (out.get(key(D[k].y)) ?? []).filter(m => D[m].i !== D[k].i || key(D[k].y) === 'OUT');
    // Tarjan's strongly connected components, without recursion
    let idx = 0; const index = new Array(D.length).fill(-1), low = new Array(D.length).fill(0), on = new Array(D.length).fill(false), stack = [], comps = [];
    for (let v0 = 0; v0 < D.length; v0++) {
      if (index[v0] >= 0) continue;
      const work = [[v0, 0]]; index[v0] = low[v0] = idx++; stack.push(v0); on[v0] = true;
      while (work.length) {
        const top = work[work.length - 1], [v, k] = top, nx = next(v);
        if (k < nx.length) {
          top[1]++; const w2 = nx[k];
          if (index[w2] < 0) { index[w2] = low[w2] = idx++; stack.push(w2); on[w2] = true; work.push([w2, 0]); }
          else if (on[w2]) low[v] = Math.min(low[v], index[w2]);
        } else {
          work.pop();
          if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
          if (low[v] === index[v]) { const comp = []; let x2; do { x2 = stack.pop(); on[x2] = false; comp.push(x2); } while (x2 !== v); comps.push(comp); }
        }
      }
    }
    const big = new Set(comps.sort((p, q) => q.length - p.length)[0].map(k => D[k].i));
    // a two-way road is kept only if both its ways are in it
    const keep = roads.filter((r, i) => D.filter(q => q.i === i).every(q => big.has(q.i) && comps[0].includes(D.indexOf(q))));
    changed = keep.length !== roads.length; dropped.cut += roads.length - keep.length; roads = keep;
  }
  // bends left with one road (its other piece dropped) go too
  // 6. the junctions: lights where OSM has traffic signals within 15 m of a junction of three or more roads
  const d = degree(), used = new Set(roads.flatMap(r => [r.a, r.b]));
  const outNodes = [...used].map(id => nodes.get(id)).map(nd => ({ id: nd.id, x: nd.at[0], y: nd.at[1], ...(d.get(nd.id) >= 3 && signals.some(p => dist(p, nd.at) < 15) ? { lights: true } : {}), ...(nd.edge ? { edge: true } : {}) }));
  // 7. the buildings, and how wide each side of each road can be: lane, parking and pavement fitted into the room the
  //    buildings leave (measured every 4 m along it, the closest fifth taken), then any building still in the way left out
  const buildings = [];
  for (const x of buildingsJson.elements) {
    if (x.type !== 'way' || !x.geometry) continue;
    const poly = x.geometry.map(q => P(q.lat, q.lon));
    if (poly.length > 3 && dist(poly[0], poly[poly.length - 1]) < 0.01) poly.pop();
    if (!poly.some(p => inside(p))) continue;
    // a closed outline: simplified in two halves, split at the corner furthest from the first
    let far = 0; poly.forEach((p, i) => { if (dist(p, poly[0]) > dist(poly[far], poly[0])) far = i; });
    const ring = [...simplify(poly.slice(0, far + 1), 0.4).slice(0, -1), ...simplify([...poly.slice(far), poly[0]], 0.4).slice(0, -1)];
    if (ring.length >= 3) buildings.push(ring);
  }
  const at = id => outNodes.find(q => q.id === id), lane = r => (r.oneway ? 3.2 : 3.0);
  const room = (r, side) => {
    const A = at(r.a), B = at(r.b), ux = (B.x - A.x), uy = (B.y - A.y), L = Math.hypot(ux, uy), u = [ux / L, uy / L], nrm = [u[1] * side, -u[0] * side];   // side +1: the right of a to b (y north)
    const hits = [];
    for (let t = 6; t < L - 6; t += 4) {
      const p = [A.x + u[0] * t, A.y + u[1] * t], q = [p[0] + nrm[0] * 18, p[1] + nrm[1] * 18];
      let best = 18;
      for (const b of buildings) for (let i = 0; i < b.length; i++) {
        const c = b[i], dd = b[(i + 1) % b.length];
        if (!crosses(p, q, c, dd)) continue;
        // where along the ray it crosses
        const ex = dd[0] - c[0], ey = dd[1] - c[1], den = (q[0] - p[0]) * ey - (q[1] - p[1]) * ex;
        if (Math.abs(den) < 1e-9) continue;
        const tt = ((c[0] - p[0]) * ey - (c[1] - p[1]) * ex) / den;
        best = Math.min(best, tt * 18);
      }
      hits.push(best);
    }
    hits.sort((p, q) => p - q);
    return hits.length ? hits[Math.floor(hits.length / 5)] : 18;
  };
  const sideOf = (r, side) => {
    const half = r.oneway ? lane(r) / 2 : lane(r), d0 = room(r, side), left = d0 - half;
    // parking where the room allows a 2 m lane and a 1.2 m pavement; the pavement takes the rest (1.2 m to 5 m)
    const park = left >= 3.2 ? 2.0 : 0, walk = Math.round(Math.max(1.2, Math.min(5, left - park)) * 10) / 10;
    return { ...(park ? { park } : {}), walk };
  };
  const outRoads = roads.map((r, i) => ({ id: `r${i + 1}`, name: r.name, a: r.a, b: r.b, lane: lane(r), limit: r.major ? 50 : 30, ...(r.oneway ? { oneway: r.oneway } : {}), ...(r.major ? { major: true } : {}), right: sideOf(r, 1), left: sideOf(r, -1) }));
  // buildings over a carriageway or pavement are left out
  // (along each road clear of its ends: a building on a junction's corner is beside the other road there)
  const corridor = r => {
    const A0 = at(r.a), B0 = at(r.b), L = Math.hypot(B0.x - A0.x, B0.y - A0.y), u = [(B0.x - A0.x) / L, (B0.y - A0.y) / L], nr = [u[1], -u[0]];
    const cut = Math.min(8, L / 3), A = { x: A0.x + u[0] * cut, y: A0.y + u[1] * cut }, B = { x: B0.x - u[0] * cut, y: B0.y - u[1] * cut };
    const hwR = (r.oneway ? r.lane / 2 : r.lane) + (r.right.park ?? 0) + r.right.walk, hwL = (r.oneway ? r.lane / 2 : r.lane) + (r.left.park ?? 0) + r.left.walk;
    return [[A.x + nr[0] * hwR, A.y + nr[1] * hwR], [B.x + nr[0] * hwR, B.y + nr[1] * hwR], [B.x - nr[0] * hwL, B.y - nr[1] * hwL], [A.x - nr[0] * hwL, A.y - nr[1] * hwL]];
  };
  const cors = outRoads.map(corridor);
  const overlaps = (p, q) => p.some(x => inPoly(x, q)) || q.some(x => inPoly(x, p)) || p.some((x, i) => q.some((y, k) => crosses(x, p[(i + 1) % p.length], y, q[(k + 1) % q.length])));
  const kept = buildings.filter(b => !cors.some(c => overlaps(b, c)));
  return { before, nodes: outNodes, roads: outRoads, buildings: kept.map(b => b.map(p => [r2(p[0]), r2(p[1])])), size: [r2(2 * hx), r2(2 * hy)], dropped: { ...dropped, buildings: buildings.length - kept.length } };
}

async function overpass(q) {
  for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      if (r.ok) return await r.json();
    } catch { /* the next mirror */ }
  }
  throw new Error('Overpass did not answer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, boxArg, dir, out] = process.argv.slice(2), flag = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const box = boxArg?.split(',').map(Number);
  if (cmd === 'fetch' && box?.length === 4 && dir) {
    mkdirSync(dir, { recursive: true });
    const q = queries(box);
    writeFileSync(join(dir, 'roads.json'), JSON.stringify(await overpass(q.roads)));
    writeFileSync(join(dir, 'buildings.json'), JSON.stringify(await overpass(q.buildings)));
    console.log(`Saved ${dir}/roads.json and buildings.json (${new Date().toISOString().slice(0, 10)}).`);
  } else if (cmd === 'make' && box?.length === 4 && dir && out) {
    const m = makeMap(JSON.parse(readFileSync(join(dir, 'roads.json'), 'utf8')), JSON.parse(readFileSync(join(dir, 'buildings.json'), 'utf8')), box);
    const spec = {
      format: 2, id: flag('id') ?? 'osm', name: flag('name') ?? 'From OpenStreetMap', credit: CREDIT,
      source: { box, date: flag('date') ?? new Date().toISOString().slice(0, 10), queries: queries(box) },
      notes: [
        'Map frame: x east, y north, metres from the middle of the box. A road runs straight from node a to node b; right and left are as you go from a to b. oneway 1: traffic only from a to b; -1: only from b to a.',
        'From OpenStreetMap: where the streets run and meet, their names, which are one-way, which are main roads (major), the traffic lights at junctions, and the buildings.',
        'Made up here: curves straightened between junctions, junctions closer than 16 m merged, the widths (lane, parking lane, pavement: fitted into the room the buildings leave, as none are mapped), the speed limits (50 km/h on main roads, 30 elsewhere: none are mapped), which side road gives way (the one that is not a main road), and who is parked. Alleys to nowhere, service roads and roads the traffic cannot drive round in a loop are left out, and buildings over a road or pavement.',
        'On a one-way street the free spaces are only on the kerb on the side traffic keeps to; the other kerb has parked cars too.',
      ],
      drive: 'right', bounds: [Math.min(-m.size[0] / 2, ...m.nodes.map(q => q.x)), Math.min(-m.size[1] / 2, ...m.nodes.map(q => q.y)), Math.max(m.size[0] / 2, ...m.nodes.map(q => q.x)), Math.max(m.size[1] / 2, ...m.nodes.map(q => q.y))], corner: 5,
      nodes: m.nodes, roads: m.roads, buildings: m.buildings,
      fill: { occupancy: 0.86, sloppiness: 0.12, guarantee: 6 },
      start: null,
    };
    writeFileSync(out, JSON.stringify(spec));
    if (flag('debug')) writeFileSync(flag('debug'), JSON.stringify(m.before.map(r => [r.pa, r.pb, r.oneway, r.name])));
    console.log(`${out}: ${m.nodes.length} nodes, ${m.roads.length} roads, ${m.buildings.length} buildings; left out ${m.dropped.cut} roads the traffic cannot loop round, ${m.dropped.buildings} buildings over a road.`);
  } else {
    console.error('Usage: node scripts/osm-map.mjs fetch <s,w,n,e> <dir> | make <s,w,n,e> <dir> <out.json> [--id id --name name --date yyyy-mm-dd]');
    process.exit(1);
  }
}
