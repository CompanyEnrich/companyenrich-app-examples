import { UserFacingError } from './user-error';

export const MAX_ACCOUNTS = 20;

const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `https://www.Stripe.com/pricing` -> `stripe.com`. Returns null for anything that is not a domain. */
export function normalizeDomain(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  return DOMAIN_PATTERN.test(host) ? host : null;
}

/** Parse a comma, space or newline separated list. Throws on bad input or more than 20 accounts. */
export function parseDomainList(input: string | readonly string[]): string[] {
  const raw = (typeof input === 'string' ? input.split(/[\s,;]+/) : [...input]).filter((value) => value.trim() !== '');
  if (raw.length === 0) throw new UserFacingError('Give at least one account domain, e.g. stripe.com.');

  const invalid = raw.filter((value) => normalizeDomain(value) === null);
  if (invalid.length > 0) throw new UserFacingError(`Not a valid domain: ${invalid.join(', ')}`);

  const domains = [...new Set(raw.map((value) => normalizeDomain(value)!))];
  if (domains.length > MAX_ACCOUNTS) {
    throw new UserFacingError(`At most ${MAX_ACCOUNTS} accounts per run (got ${domains.length}).`);
  }
  return domains;
}
