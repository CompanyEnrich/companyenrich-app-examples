/** Reduces "https://www.Stripe.com/pricing" to "stripe.com" so state keys and filters match. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

export function websiteUrl(domain: string): string {
  return `https://${domain}`;
}
