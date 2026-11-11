/** Lowercases a domain or URL and strips the scheme, path, port and a leading "www." so values compare equal. */
export function normalizeDomain(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#:].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}
