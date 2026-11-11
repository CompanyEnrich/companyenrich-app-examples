import { FREE_EMAIL_DOMAINS } from './free-email-domains';

const FREE_SET = new Set(FREE_EMAIL_DOMAINS);
const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** Lowercases and trims a domain, dropping `www.` and a trailing dot. Returns null when it is not a valid domain. */
export function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

/** The domain part of an email address, normalized. Null for anything that is not a plausible address. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1 || /\s/.test(email)) return null;
  return normalizeDomain(email.slice(at + 1));
}

/**
 * Turns whatever a user pasted (a domain, an email address or a URL) into a domain.
 * Used by the rules playground and the batch CLI.
 */
export function domainFromInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (value.includes('@') && !value.includes('/')) return emailDomain(value);
  const host = value.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]?.replace(/:\d+$/, '') ?? '';
  return normalizeDomain(host);
}

/** The free-mail domain that `domain` belongs to (itself or a parent), or null for a company domain. */
export function freeMailMatch(domain: string): string | null {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (FREE_SET.has(candidate)) return candidate;
  }
  return null;
}

export function isFreeMailDomain(domain: string): boolean {
  return freeMailMatch(domain) !== null;
}
