// The edition and Pro. The personal edition (your own page, development and the tests) has everything, with the makers'
// names. The store edition (npm run build:store) keeps the special cars, the hard levels and the busy street for Pro
// (core/tiers.ts), unlocked with a licence key checked on the phone (core/licence.ts), and calls the cars by generic
// names, which lowers the risk of using makers' names in something sold (it is not legal advice). The Pro sheet says
// what Pro adds, where it is sold, and takes a key.
import { CAR_SPECS, TRAILERS, VEHICLES } from '../core/content';
import { verifyKey } from '../core/licence';
import { FREE_LAYOUTS, FREE_LEVELS, carIsPro, districtIsPro, trafficIsPro } from '../core/tiers';
import type { VehicleSpec } from '../core/vehicle';
import { BUY_URL, LICENCE_PUBLIC_KEY } from '../storeConfig';
import { $, openSheet } from './dom';

type Edition = 'personal' | 'store';
let edition: Edition = import.meta.env.MODE === 'store' ? 'store' : 'personal';
let publicKey: JsonWebKey | null = LICENCE_PUBLIC_KEY, buyUrl = BUY_URL, unlocked = false;
const KEY = 'atto2-pro';

export const isStore = (): boolean => edition === 'store';
/** Everything open: the personal edition, or the store edition with a good licence key. */
export const isPro = (): boolean => edition === 'personal' || unlocked;
/** Pro can be bought and unlocked: the store edition has its public key. */
export const onSale = (): boolean => !!publicKey;

/** The store edition: the key kept in this browser, if there is one and it is good (await it before restoring what was
 *  being played, so a Pro player is not sent back to the free part). */
export async function checkStoredKey(): Promise<void> {
  if (!isStore()) return;
  let k: string | null = null;
  try { k = localStorage.getItem(KEY); } catch { /* storage blocked: not remembered */ }
  unlocked = !!k && !!(await verifyKey(k, publicKey));
}

/** The store edition calls the cars and the trailer by generic names, and drops what names their makers: the model
 *  each is based on, the sources and the estimates' words, and whose turning-circle figure it is. Once, at start. */
export function applyStoreNames(): void {
  if (!isStore()) return;
  for (const s of [...CAR_SPECS, ...Object.values(TRAILERS).map(t => t.spec)] as (VehicleSpec & { turning?: VehicleSpec['turning'] })[]) {
    if (!s.store) continue;
    Object.assign(s, { name: s.store.name, short: s.store.short, basedOn: undefined, sources: [], estimates: s.estimates?.length ? ['some figures, where no maker publishes them'] : [] });
    if (s.turning) s.turning.by = 'the maker';
  }
  for (const v of Object.values(VEHICLES)) Object.assign(v as { name: string; short: string }, { name: v.spec.name, short: v.spec.short ?? v.spec.name });
  for (const t of Object.values(TRAILERS)) Object.assign(t as { name: string; short: string }, { name: t.spec.name, short: t.spec.short ?? t.spec.name });
}

/** The Pro sheet, saying why it opened ("Level 8 is part of Pro."). */
export function openPro(why: string): void {
  $('proWhy').textContent = why;
  const pick = CAR_SPECS.filter(s => carIsPro(s.id)).map(s => s.short ?? s.name);
  $('proList').replaceChildren(...[
    `The special cars: ${pick.join(' and ')}, with more to come.`,
    `Levels ${FREE_LEVELS + 1} to 10 of every kind, and new layouts of every level past the first ${FREE_LAYOUTS}.`,
    'All the trailer levels.',
    'Busy traffic, spot thieves and the tight districts on the street.',
  ].map(t => { const li = document.createElement('li'); li.textContent = t; return li; }));
  $('proBuy').hidden = !buyUrl || !onSale(); ($('proBuy') as HTMLAnchorElement).href = buyUrl || '#';
  $('proNotYet').hidden = onSale() && !!buyUrl;
  $('proNotYet').textContent = onSale() ? 'Pro is not on sale here yet. If you have a licence key, paste it below.' : 'Pro is not on sale yet.';
  $('proKeyWrap').hidden = !onSale();
  $('proMsg').textContent = unlocked ? 'Pro is unlocked on this phone.' : '';
  openSheet('sheetPro');
}

/** The key field and button: a good key unlocks Pro and is kept in this browser, then onUnlock runs. */
export function bindPro(onUnlock: () => void): void {
  $('proUnlock').addEventListener('click', async () => {
    const field = $<HTMLTextAreaElement>('proKey'), msg = $('proMsg'), k = field.value.trim();
    if (!k) { msg.textContent = 'Paste the licence key from your receipt first.'; return; }
    msg.textContent = 'Checking…';
    const ok = await verifyKey(k, publicKey);
    if (!ok) { msg.textContent = 'That key does not work: check it is the whole key, from PT1. to the end.'; return; }
    unlocked = true; msg.textContent = 'Pro is unlocked on this phone. Thank you!';
    try { localStorage.setItem(KEY, k.replace(/\s+/g, '')); } catch { /* not remembered: it works until the page is closed */ }
    field.value = '';
    onUnlock();
  });
}

/** In the store edition without Pro, a 'Pro' tag on the choices it keeps: the special cars, busy traffic, tight districts. */
export function markLocked(): void {
  const lock = isStore() && !isPro();
  document.querySelectorAll<HTMLElement>('#segCar button').forEach(b => b.classList.toggle('pro', lock && carIsPro(b.dataset.v!)));
  document.querySelectorAll<HTMLElement>('.seg[data-opt=traffic] button').forEach(b => b.classList.toggle('pro', lock && trafficIsPro(b.dataset.v!)));
  document.querySelectorAll<HTMLElement>('.seg[data-opt=district] button').forEach(b => b.classList.toggle('pro', lock && districtIsPro(+b.dataset.v!)));
  $('infoPro').hidden = !lock;
}

/** The harness only: become the store edition with this public key (null: not on sale) and shop page. */
export function storeForTest(jwk: JsonWebKey | null, url = ''): void {
  edition = 'store'; publicKey = jwk; buyUrl = url; unlocked = false;
  applyStoreNames();
}
