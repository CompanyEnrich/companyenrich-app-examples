/**
 * Turns whatever a CRM holds in a domain or website column into a bare domain:
 * `https://www.Stripe.com/about?x=1` -> `stripe.com`, `jane@stripe.com` -> `stripe.com`.
 * Returns null when the value is empty or is not a domain.
 */
export function normalizeDomain(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;

  let host: string;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(value);
    host = new URL(hasScheme ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }

  host = host.replace(/\.$/, '').replace(/^www\d*\./, '');
  const isDomain = /^([a-z0-9-]+\.)+([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(host);
  return isDomain ? host : null;
}
