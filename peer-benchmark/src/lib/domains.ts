const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_PATTERN = new RegExp(`^(?=.{4,253}$)(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);

/**
 * Turns what people paste ("https://www.Stripe.com/pricing") into a bare domain
 * ("stripe.com"). Returns null when the result is not a plausible domain.
 */
export function normalizeDomain(input: string): string | null {
  const domain = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}
