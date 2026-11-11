import { readFile } from 'node:fs/promises';

/** Lowercases a domain and strips scheme, `www.`, path and port, so `https://www.Stripe.com/x` becomes `stripe.com`. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#:].*$/, '');
}

/** Parses a domains file: one domain per line, blank lines and `#` comments ignored, duplicates dropped. */
export function parseDomains(text: string): string[] {
  const domains = text
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .map(normalizeDomain)
    .filter((domain) => domain !== '');
  return [...new Set(domains)];
}

export async function readDomainsFile(path: string): Promise<string[]> {
  return parseDomains(await readFile(path, 'utf8'));
}
