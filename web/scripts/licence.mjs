#!/usr/bin/env node
// Licence keys for Pro in the store edition (see src/core/licence.ts for the format).
//
//   node scripts/licence.mjs keygen <folder>              makes a keypair: writes <folder>/licence-private.pem (keep it
//                                                         secret, and outside any repository) and prints the public key
//                                                         to paste into src/storeConfig.ts
//   node scripts/licence.mjs issue <private.pem> <order>  prints a licence key for that order, to send to the buyer
//
// The key is signed with ECDSA P-256 and SHA-256, the signature as raw r‖s (what the browser's WebCrypto checks), over
// the payload's exact JSON bytes.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A new keypair: the private key as PEM, the public key as a JWK. */
export function keygen() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicJwk: { kty, crv, x, y } };
}

/** A licence key for an order, issued on `day` (days since 1970; today by default). */
export function issue(privatePem, order, day = Math.floor(Date.now() / 86400000)) {
  const data = Buffer.from(JSON.stringify({ o: String(order), d: day }), 'utf8');
  const sig = sign('sha256', data, { key: createPrivateKey(privatePem), dsaEncoding: 'ieee-p1363' });
  return `PT1.${data.toString('base64url')}.${sig.toString('base64url')}`;
}

/** Whether a folder is inside a git repository (where a private key could end up committed). */
function inRepo(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'keygen' && a) {
    const repo = inRepo(a);
    if (repo) { console.error(`${resolve(a)} is inside the repository ${repo}: keep the private key somewhere else.`); process.exit(1); }
    const file = join(resolve(a), 'licence-private.pem');
    if (existsSync(file)) { console.error(`${file} exists already: keys sold with it would stop working if it were replaced.`); process.exit(1); }
    mkdirSync(resolve(a), { recursive: true });
    const k = keygen();
    writeFileSync(file, k.privatePem, { mode: 0o600 });
    console.log(`Private key: ${file} (keep it secret and backed up).`);
    console.log('Public key, for LICENCE_PUBLIC_KEY in src/storeConfig.ts:');
    console.log(JSON.stringify(k.publicJwk));
  } else if (cmd === 'issue' && a && b) {
    console.log(issue(readFileSync(a, 'utf8'), b));
  } else {
    console.error('Usage: node scripts/licence.mjs keygen <folder outside the repo> | issue <private.pem> <order>');
    process.exit(1);
  }
}
