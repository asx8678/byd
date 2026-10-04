// The live generator on the Build Plan page: pick a template, level and seed; see the level,
// the planner's route, the coach's steps, and a Show me run. Plan view in the game's style.
import { ATTO2 } from '../../../src/core/content';
import type { Pt } from '../../../src/core/math';
import { generate, type Level } from './generate';
import { sample } from './planner';
import type { TemplateId, WayIn } from './templates';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>('genCanvas'), ctx = cv.getContext('2d')!;
const COL = {
  bg: '#0d0e12', asphalt: '#1c1e24', pavement: '#25282e', kerb: '#8e939c', bay: '#d9ab2b', mark: 'rgba(235,232,223,.55)',
  car: '#23262d', carLine: '#6d747a', wall: '#c9ccc8', ink: '#ebe8df', mute: '#a7afb9', yellow: '#f2c230', cyan: 'rgba(94,208,216,.95)', green: '#5ed08a',
};
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const S = { tpl: 'bays' as TemplateId, way: 'reverse' as WayIn, level: 4, seed: 4821, L: null as Level | null, anim: null as null | { t0: number; raf: number }, at: -1 };
let W = 0, H = 0, DPR = 1, view = { s: 10, cx: 0, cz: 0 };
let pts: ReturnType<typeof sample> = [], dist: number[] = [];

function regenerate(): void {
  stop();
  $('genStatus').textContent = 'Solving…';
  // let the status paint before the (synchronous) search
  requestAnimationFrame(() => setTimeout(() => {
    S.L = generate(S.tpl, S.level, S.seed, S.way, { maxMs: Infinity, maxNodes: 150000 });   // a step limit, never a time limit, so every device makes the same level
    pts = S.L ? sample(S.L.plan.pieces, 0.05) : [];
    dist = []; let d = 0; pts.forEach((p, i) => { if (i) d += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z); dist.push(d); });
    S.at = -1; fit(); draw(); panel();
  }, 0));
}

function fit(): void {
  const L = S.L; if (!L) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = (x: number, z: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); };
  for (const p of pts) { add(p.x - 1, p.z - 1); add(p.x + 3.6 * Math.cos(p.th), p.z - 3.6 * Math.sin(p.th)); add(p.x + 1, p.z + 1); }
  for (const a of L.scene.areas) if (a.kind === 'target') for (const [x, z] of a.pts) add(x, z);
  const m = 2.2; x0 -= m; x1 += m; z0 -= m; z1 += m;
  const [bx0, bx1, bz0, bz1] = L.scene.bounds; x0 = Math.max(x0, bx0); x1 = Math.min(x1, bx1); z0 = Math.max(z0, bz0); z1 = Math.min(z1, bz1);
  view = { s: Math.min(W / (x1 - x0), H / (z1 - z0)), cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}
const X = (x: number) => W / 2 + (x - view.cx) * view.s, Z = (z: number) => H / 2 + (z - view.cz) * view.s;
function poly(P: Pt[]): void { ctx.beginPath(); P.forEach(([x, z], i) => i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z))); ctx.closePath(); }
function foot(px: number, pz: number, th: number, P: Pt[]): Pt[] { const c = Math.cos(th), s = Math.sin(th); return P.map(([a, b]): Pt => [px + a * c + b * s, pz - a * s + b * c]); }

function drawCar(p: { x: number; z: number; th: number }, style: 'solid' | 'ghost' | 'final'): void {
  poly(foot(p.x, p.z, p.th, ATTO2.body));
  if (style === 'solid') {
    ctx.fillStyle = 'rgba(16,18,22,.96)'; ctx.fill(); ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.6; ctx.setLineDash([]); ctx.stroke();
    for (const m of ATTO2.mirrors) { poly(foot(p.x, p.z, p.th, m)); ctx.fillStyle = 'rgba(16,18,22,.96)'; ctx.fill(); ctx.lineWidth = 1; ctx.stroke(); }
    poly(foot(p.x, p.z, p.th, [[3.36, 0], [2.96, -0.27], [2.96, 0.27]])); ctx.fillStyle = COL.yellow; ctx.fill();
  } else {
    ctx.strokeStyle = style === 'final' ? COL.green : 'rgba(235,232,223,.45)'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
}

function draw(): void {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
  const L = S.L; if (!L) { ctx.fillStyle = COL.mute; ctx.font = `500 13px ${MONO}`; ctx.fillText('No level for these settings', 16, 28); return; }
  const sc = L.scene, [bx0, bx1, bz0, bz1] = sc.bounds;
  ctx.fillStyle = COL.asphalt; ctx.fillRect(X(bx0), Z(bz0), (bx1 - bx0) * view.s, (bz1 - bz0) * view.s);
  for (const a of sc.areas) if (a.kind === 'pavement') { poly(a.pts); ctx.fillStyle = COL.pavement; ctx.fill(); }
  ctx.strokeStyle = COL.kerb; ctx.lineWidth = 1;
  for (const k of sc.kerbs) { const z = k.c / k.nz; ctx.beginPath(); ctx.moveTo(X(bx0), Z(z)); ctx.lineTo(X(bx1), Z(z)); ctx.stroke(); }
  // painted lines: bay lines yellow, lane lines dashed white
  ctx.lineWidth = Math.max(1, 0.1 * view.s);
  for (const [x0, z0, x1, z1] of sc.lines) {
    ctx.strokeStyle = sc.template === 'bays' ? COL.bay : COL.mark; ctx.setLineDash(sc.template === 'kerb' ? [3 * view.s, 3 * view.s] : []);
    ctx.beginPath(); ctx.moveTo(X(x0), Z(z0)); ctx.lineTo(X(x1), Z(z1)); ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const a of sc.areas) if (a.kind === 'target') { poly(a.pts); ctx.fillStyle = 'rgba(94,208,138,.12)'; ctx.fill(); ctx.strokeStyle = 'rgba(94,208,138,.6)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
  for (const o of sc.obstacles) {
    if (o.kind === 'circle') { ctx.beginPath(); ctx.arc(X(o.x), Z(o.z), o.r * view.s, 0, 7); ctx.fillStyle = COL.wall; ctx.fill(); continue; }
    poly(o.pts);
    if (o.cls === 'car') { ctx.fillStyle = COL.car; ctx.fill(); ctx.strokeStyle = COL.carLine; ctx.lineWidth = 1; ctx.stroke(); }
    else { ctx.fillStyle = 'rgba(201,204,200,.85)'; ctx.fill(); }
  }
  // the route: forward yellow, reverse dashed cyan
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.strokeStyle = b.dir > 0 ? COL.yellow : COL.cyan; ctx.lineWidth = 2; ctx.setLineDash(b.dir > 0 ? [] : [6, 4]);
    ctx.beginPath(); ctx.moveTo(X(a.x), Z(a.z)); ctx.lineTo(X(b.x), Z(b.z)); ctx.stroke();
  }
  ctx.setLineDash([]);
  // where each move ends, and where you finish
  const pcs = L.plan.pieces;
  pcs.forEach((p, i) => { if (i < pcs.length - 1 && pcs[i + 1].dir !== p.dir) drawCar(p.to, 'ghost'); });
  drawCar(pcs[pcs.length - 1].to, 'final');
  // numbered cues; when several fall on one spot, fan them out with a leader line
  const placed: [number, number][] = [];
  L.steps.forEach(st => {
    const ox = X(st.end.x), oz = Z(st.end.z), done = S.at >= 0 && stepAt(S.at) > st.n - 1;
    let x = ox, z = oz;
    for (let k = 1; placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 21) && k < 12; k++) { x = ox + 22 * k * 0.6; z = oz + 22 * k * 0.8; }
    placed.push([x, z]);
    if (x !== ox) { ctx.strokeStyle = 'rgba(242,194,48,.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ox, oz); ctx.lineTo(x, z); ctx.stroke(); ctx.beginPath(); ctx.arc(ox, oz, 2.5, 0, 7); ctx.fillStyle = COL.yellow; ctx.fill(); }
    ctx.beginPath(); ctx.arc(x, z, 10, 0, 7); ctx.fillStyle = done ? COL.yellow : '#0d0e12'; ctx.fill(); ctx.strokeStyle = COL.yellow; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = done ? '#0d0e12' : COL.yellow; ctx.font = `600 11px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(st.n), x, z + 0.5);
  });
  // the car: at the start, or where Show me has got to
  const p = S.at >= 0 ? pts[S.at] : pts[0];
  drawCar(p, 'solid');
  // scale bar
  const nice = [1, 2, 5, 10, 20], m = nice.find(n => n * view.s >= 50) || 20, w = m * view.s, y = H - 12;
  ctx.fillStyle = 'rgba(13,14,18,.8)'; ctx.fillRect(6, H - 26, w + 52, 22);
  ctx.strokeStyle = COL.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(12 + w, y); ctx.moveTo(12, y - 4); ctx.lineTo(12, y); ctx.moveTo(12 + w, y - 4); ctx.lineTo(12 + w, y); ctx.stroke();
  ctx.fillStyle = COL.ink; ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(`${m} m`, 18 + w, y - 1);
}

/** Which coach step a route sample belongs to. */
function stepAt(i: number): number {
  const L = S.L!; const piece = pts[i].i;
  const k = L.steps.findIndex(s => s.pieceEnd >= piece);
  return k < 0 ? L.steps.length - 1 : k;
}

function panel(): void {
  const L = S.L, stats = $('genStats'), list = $('genSteps');
  if (!L) { stats.innerHTML = ''; list.innerHTML = ''; $('genStatus').textContent = 'No route found for these settings. Try another seed.'; return; }
  const m = L.measure, sk = L.skipped;
  const skippedText = [sk.none && `${sk.none} with no route`, sk.gaveUp && `${sk.gaveUp} gave up`, sk.off && `${sk.off} eased to match the level`, sk.mismatch && `${sk.mismatch} failed the exact check`].filter(Boolean).join(', ') || 'none';
  const rows: [string, string][] = [
    ['Level', `asked ${S.level} · measured ${m.score.toFixed(1)}`],
    ['Par', `${m.moves} ${m.moves === 1 ? 'move' : 'moves'}`],
    ['Route', `${m.length.toFixed(1)} m`],
    ['Tightest on the way in', `${Math.round(m.minClear * 100)} cm`],
    ...Object.entries(L.scene.knobs).map(([k, v]): [string, string] => [k[0].toUpperCase() + k.slice(1), String(v)]),
    ['Solved in', `${Math.round(L.ms)} ms`],
    ['Seeds skipped', skippedText],
  ];
  stats.replaceChildren(...rows.map(([k, v]) => { const d = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; d.append(dt, dd); return d; }));
  list.replaceChildren(...L.steps.map(st => { const li = document.createElement('li'); const t = document.createElement('span'); t.textContent = st.text; const d = document.createElement('small'); d.textContent = st.detail; li.append(t, d); return li; }));
  $('genStatus').textContent = `${S.tpl === 'kerb' ? 'Kerb' : 'Bays'} · level ${S.level} · seed ${S.seed}${L.knobLevel !== S.level ? ` (settings eased to level ${L.knobLevel})` : ''}`;
  cv.setAttribute('aria-label', `Generated ${S.tpl === 'kerb' ? 'parallel parking space' : 'parking bay'}, level ${S.level}, par ${m.moves} moves. Steps: ${L.steps.map(s => s.text).join(' ')}`);
  highlight();
}
function highlight(): void {
  const k = S.at >= 0 ? stepAt(S.at) : -1;
  [...$('genSteps').children].forEach((li, i) => li.classList.toggle('now', i === k));
}

function stop(): void { if (S.anim) cancelAnimationFrame(S.anim.raf); S.anim = null; $('genShow').textContent = 'Show me'; }
function play(): void {
  if (!S.L || !pts.length) return;
  if (S.anim) { stop(); return; }
  $('genShow').textContent = 'Stop';
  const speed = 1.6, pause = 0.6;
  // time along the route, with a pause wherever the direction changes
  const times: number[] = []; let t = 0;
  pts.forEach((p, i) => { if (i) { t += (dist[i] - dist[i - 1]) / speed; if (p.dir !== pts[i - 1].dir) t += pause; } times.push(t); });
  const t0 = performance.now();
  const tick = (now: number) => {
    const el = (now - t0) / 1000; let i = times.findIndex(x => x >= el); if (i < 0) i = pts.length - 1;
    S.at = i; draw(); highlight();
    if (el < times[times.length - 1] + 1) S.anim = { t0, raf: requestAnimationFrame(tick) };
    else { S.anim = null; $('genShow').textContent = 'Show me again'; }
  };
  S.anim = { t0, raf: requestAnimationFrame(tick) };
}

function resize(): void {
  const w = cv.parentElement!.clientWidth, h = Math.round(Math.min(520, Math.max(300, w * 0.6)));
  DPR = Math.min(window.devicePixelRatio || 1, 2); W = w; H = h;
  cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); cv.style.height = h + 'px';
  fit(); draw();
}

function press(group: string, attr: string, val: string): void { document.querySelectorAll<HTMLButtonElement>(`#${group} button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === val))); }
document.querySelectorAll<HTMLButtonElement>('#genTpl button').forEach(b => b.addEventListener('click', () => {
  S.tpl = b.dataset.tpl as TemplateId; press('genTpl', 'tpl', S.tpl);
  ($('genWay') as HTMLElement).hidden = S.tpl === 'kerb'; regenerate();
}));
document.querySelectorAll<HTMLButtonElement>('#genWay button').forEach(b => b.addEventListener('click', () => { S.way = b.dataset.way as WayIn; press('genWay', 'way', S.way); regenerate(); }));
const lv = $<HTMLInputElement>('genLevel');
lv.addEventListener('input', () => { $('genLevelOut').textContent = lv.value; });
lv.addEventListener('change', () => { S.level = +lv.value; regenerate(); });
const sd = $<HTMLInputElement>('genSeed');
sd.addEventListener('change', () => { const v = Math.max(1, Math.min(99999, Math.round(+sd.value) || 1)); sd.value = String(v); S.seed = v; regenerate(); });
$('genNew').addEventListener('click', () => { S.seed = 1 + Math.floor(Math.random() * 99999); sd.value = String(S.seed); regenerate(); });
$('genShow').addEventListener('click', play);
window.addEventListener('resize', resize);
resize(); regenerate();
