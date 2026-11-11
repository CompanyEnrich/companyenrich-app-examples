// Turns whatever people type or paste into the form a domain lookup expects.
// Shared by the server (cache keys, validation) and the browser components
// (deciding when to offer "Use <typed domain>").

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

// Unicode letters are allowed because the API stores internationalized domains
// as typed (for example `münchen-city-immobilien.de`), not as punycode.
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?`;
const DOMAIN = new RegExp(String.raw`^(?:${LABEL}\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$`, 'u');

/** Shorter queries match too much to be useful, so they are not sent. */
export const MIN_QUERY_LENGTH = 2;
/** The autocomplete endpoint accepts at most 100 characters. */
export const MAX_QUERY_LENGTH = 100;

/**
 * Reduces a URL, bare host or email address to its lowercase host name:
 * `https://www.Stripe.com/pricing?x=1` and `jane@stripe.com` both become `stripe.com`.
 */
export function extractHost(input: string): string {
  let value = input.trim().toLowerCase().replace(SCHEME, '');
  value = value.split(/[/?#]/, 1)[0] ?? '';
  value = value.slice(value.lastIndexOf('@') + 1); // email address or URL user info
  value = value.replace(/:\d*$/, ''); // port
  return value.replace(/^www\./, '').replace(/\.$/, '');
}

/** Returns the registrable-looking host for `input`, or null if it is not a domain. */
export function normalizeDomain(input: string): string | null {
  const host = extractHost(input);
  return host.length <= 253 && DOMAIN.test(host) ? host : null;
}

/**
 * Prepares free text for the autocomplete endpoint, which searches by
 * domain. Only characters a domain can contain are
 * kept (letters, digits, dots and hyphens), so `open ai` finds openai.com,
 * `AT&T` searches `att`, and punctuation such as `<>` never reaches the API.
 */
export function normalizeQuery(input: string): string {
  return extractHost(input).replace(/[^\p{L}\p{M}\p{N}.-]+/gu, '');
}
