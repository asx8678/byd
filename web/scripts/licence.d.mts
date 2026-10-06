// Types for scripts/licence.mjs, so the tests can use it.
export function keygen(): { privatePem: string; publicJwk: JsonWebKey };
export function issue(privatePem: string, order: string, day?: number): string;
