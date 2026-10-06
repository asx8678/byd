// Licence keys for Pro in the store edition, checked on the phone with no server. The seller signs an order's details
// with a private key (ECDSA P-256 with SHA-256, scripts/licence.mjs) and the app holds only the public key, so a key
// cannot be made without the private one; it can be shared, which is accepted for now (the blueprint's note: checks on
// the phone alone can be cracked; later the paid files can come from a server). A key is "PT1." + the payload (the
// base64url of its JSON bytes, signed as they are) + "." + the signature (the base64url of the raw 64-byte r‖s).

/** What a key carries: the order it was sold with, and the day it was issued (days since 1970). */
export interface LicencePayload { o: string; d: number }

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length)); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** The key's payload if the public key's private half signed it, else null (also with no public key at all). Spaces
 *  and line breaks pasted with it are ignored. */
export async function verifyKey(key: string, publicKey: JsonWebKey | null): Promise<LicencePayload | null> {
  if (!publicKey) return null;
  const m = /^PT1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key.replace(/\s+/g, ''));
  if (!m) return null;
  try {
    const data = fromB64url(m[1]), sig = fromB64url(m[2]);
    if (sig.length !== 64) return null;
    const pub = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, data))) return null;
    const p = JSON.parse(new TextDecoder().decode(data)) as LicencePayload;
    return typeof p.o === 'string' && typeof p.d === 'number' ? p : null;
  } catch { return null; }
}
