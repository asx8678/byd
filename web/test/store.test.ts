// The store edition's rules and licence keys: what is free and what is Pro, today's level free whatever it is, a
// free player's new layouts going round the first five, and keys from the seller's tool working in the app's check while
// a changed key, a key from another keypair and a missing public key do not.
import { describe, expect, it } from 'vitest';
import { issue, keygen } from '../scripts/licence.mjs';
import { CAR_SPECS } from '../src/core/content';
import { verifyKey } from '../src/core/licence';
import { FREE_CARS, carIsPro, districtIsPro, levelIsPro, nextFreeLayout, trafficIsPro } from '../src/core/tiers';
import { daily } from '../src/ui/progress';

describe('what is free', () => {
  it('the everyday cars; the Ram and the S-Class are Pro', () => {
    expect(CAR_SPECS.filter(s => !carIsPro(s.id)).map(s => s.id)).toEqual(['byd-atto2', 'smart-fortwo-c453', 'peugeot-208-p21', 'skoda-octavia-combi-nx']);
    expect(CAR_SPECS.filter(s => carIsPro(s.id)).map(s => s.id)).toEqual(['ram-1500-dt', 'mercedes-s-class-w223']);
    for (const id of FREE_CARS) expect(CAR_SPECS.some(s => s.id === id), id).toBe(true);
  });
  it('levels 1 to 6 of the car templates, layouts 1 to 5; the rest, and every trailer level, are Pro', () => {
    expect(levelIsPro('kerb', 6, 5)).toBe(false); expect(levelIsPro('bays-in', 1, 1)).toBe(false);
    expect(levelIsPro('kerb', 7, 1)).toBe(true); expect(levelIsPro('bays-back', 3, 6)).toBe(true);
    expect(levelIsPro('tow', 1, 1)).toBe(true);
  });
  it('today\'s level is free whatever level and layout it is', () => {
    const levels = new Set<number>();
    for (let day = 0; day < 40; day++) { const d = daily(day * 86400000); levels.add(d.level); expect(levelIsPro(d.template, d.level, d.seed, true)).toBe(false); }
    expect([...levels].some(l => l > 6)).toBe(true);   // so the exemption matters
  });
  it('busy traffic and the tight districts are Pro', () => {
    expect(trafficIsPro('busy')).toBe(true); expect(trafficIsPro('light')).toBe(false); expect(trafficIsPro('off')).toBe(false);
    expect(districtIsPro(9)).toBe(true); expect(districtIsPro(5)).toBe(false); expect(districtIsPro(2)).toBe(false);
  });
  it('a free player\'s new layouts go round the first five', () => {
    expect([1, 2, 3, 4, 5].map(nextFreeLayout)).toEqual([2, 3, 4, 5, 1]);
    expect(nextFreeLayout(20368)).toBeLessThanOrEqual(5);
  });
  it('every car and the trailer has a generic name for the store edition', () => {
    for (const s of CAR_SPECS) { expect(s.store?.name, s.id).toBeTruthy(); expect(s.store!.name).not.toMatch(/BYD|Atto|Smart|Peugeot|208|Škoda|Skoda|Octavia|Ram|Mercedes|S-Class/); }
  });
});

describe('licence keys', () => {
  const seller = keygen();
  it('a key from the seller\'s tool unlocks, with what it was issued for', async () => {
    const key = issue(seller.privatePem, 'order-1042', 20368);
    expect(key).toMatch(/^PT1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyKey(key, seller.publicJwk)).toEqual({ o: 'order-1042', d: 20368 });
    // pasted with spaces and a line break, as from an e-mail
    expect(await verifyKey(`  ${key.slice(0, 40)}\n${key.slice(40)} `, seller.publicJwk)).toEqual({ o: 'order-1042', d: 20368 });
  });
  it('a changed key, another seller\'s key, and no public key at all do not', async () => {
    const key = issue(seller.privatePem, 'order-1042', 20368), [pre, data, sig] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ o: 'order-9999', d: 20368 })).toString('base64url');
    expect(await verifyKey(`${pre}.${forged}.${sig}`, seller.publicJwk)).toBeNull();
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    expect(await verifyKey(`${pre}.${data}.${flipped}`, seller.publicJwk)).toBeNull();
    expect(await verifyKey(issue(keygen().privatePem, 'order-1042', 20368), seller.publicJwk)).toBeNull();
    expect(await verifyKey(key, null)).toBeNull();
    expect(await verifyKey('PT2' + key.slice(3), seller.publicJwk)).toBeNull();
    expect(await verifyKey('', seller.publicJwk)).toBeNull();
  });
});
