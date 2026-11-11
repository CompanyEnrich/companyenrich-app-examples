import type { Company } from '@companyenrich/sdk';
import { mapWithConcurrency } from './concurrency.ts';

/** Company id -> logo as a data URI. Companies without an entry are drawn with their initials. */
export type LogoMap = Map<string, string>;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
const MAX_LOGO_BYTES = 150_000;

/**
 * Downloads each company's `logoUrl` and embeds it as a data URI, so map.html and map.svg are single
 * self-contained files that also render where external images are blocked (an SVG shown through an
 * <img> tag, such as on GitHub, cannot load remote images).
 *
 * CompanyEnrich logo URLs are public: they load without an API key and cost no credits, and a company
 * without a logo returns 404. No Authorization header is ever sent. Any failure (404, timeout, not an
 * image, too large) leaves the company out of the map, and the renderer shows its initials instead.
 *
 * SVG logos are allowed because the renderers only ever use a logo as an image source (`<img src>` in
 * HTML, `<image href>` in SVG). Browsers run no scripts and load nothing external for SVG used that way.
 * A logo is never inlined into the page's own markup.
 */
export async function fetchLogos(
  companies: Company[],
  { fetch = globalThis.fetch, concurrency = 4, timeoutMs = 10_000 }: { fetch?: typeof globalThis.fetch; concurrency?: number; timeoutMs?: number } = {},
): Promise<LogoMap> {
  const results = await mapWithConcurrency(companies, concurrency, async (company) => {
    if (!company.logoUrl?.startsWith('https://')) return null;
    try {
      const response = await fetch(company.logoUrl, { signal: AbortSignal.timeout(timeoutMs) });
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!response.ok || !IMAGE_TYPES.has(type)) {
        await response.body?.cancel();
        return null;
      }
      const bytes = await readAtMost(response, MAX_LOGO_BYTES);
      if (!bytes || bytes.length === 0) return null;
      return [company.id, `data:${type};base64,${bytes.toString('base64')}`] as const;
    } catch {
      return null;
    }
  });
  return new Map(results.filter((entry) => entry !== null));
}

/**
 * Reads a response body, giving up as soon as it passes `maxBytes`: a declared content-length over the
 * limit is refused without reading, and otherwise the body is streamed with a running count and
 * cancelled once it goes over, so a huge response never sits in memory.
 */
export async function readAtMost(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/** "Acme Robotics" -> "AR", "Ledgerly" -> "LE". */
export function initials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
