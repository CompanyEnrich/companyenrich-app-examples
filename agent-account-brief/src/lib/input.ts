/** What the user asked us to research: a company domain, or a person's email address. */
export type Target =
  | { kind: 'domain'; domain: string }
  | { kind: 'email'; email: string; emailDomain: string };

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL = /^[^\s@]+@([^\s@]+)$/;

export class InputError extends Error {
  override name = 'InputError';
}

/** Accepts "stripe.com", "https://www.stripe.com/pricing" or "jane@stripe.com". */
export function parseTarget(raw: string): Target {
  const input = raw.trim();
  const email = EMAIL.exec(input);
  if (email) {
    const emailDomain = normalizeDomain(email[1]!);
    return { kind: 'email', email: input.toLowerCase(), emailDomain };
  }
  return { kind: 'domain', domain: normalizeDomain(input) };
}

export function normalizeDomain(raw: string): string {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '');
  if (!DOMAIN.test(domain)) {
    throw new InputError(`"${raw}" is not a domain or an email address. Try something like stripe.com.`);
  }
  return domain;
}
