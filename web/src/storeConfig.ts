// The store edition's settings (npm run build:store). Both start empty: Pro is not on sale, and cannot be unlocked,
// until the seller has made a licence keypair (scripts/licence.mjs keygen, the private half kept outside this repo) and
// has a page where Pro is sold.

/** The public half of the licence keypair, as the JWK keygen prints ({ kty: 'EC', crv: 'P-256', x, y }). */
export const LICENCE_PUBLIC_KEY: JsonWebKey | null = null;
/** Where Pro is sold; '' while it is not. */
export const BUY_URL = '';
