/**
 * Resolves country names, aliases and ISO codes to an ISO 3166-1 alpha-2 code, so that
 * `United States`, `USA`, `U.S.` and `US` all compare equal.
 *
 * English names come from the runtime's ICU data (`Intl.DisplayNames`), so the table covers
 * every country without shipping a list. The aliases cover common CRM spellings ICU does not use.
 */

const ALIASES: Record<string, string> = {
  usa: 'US',
  'u s a': 'US',
  'u s': 'US',
  america: 'US',
  'united states of america': 'US',
  uk: 'GB',
  'u k': 'GB',
  gbr: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  deutschland: 'DE',
  deu: 'DE',
  germany: 'DE',
  fra: 'FR',
  can: 'CA',
  aus: 'AU',
  nld: 'NL',
  holland: 'NL',
  'the netherlands': 'NL',
  swe: 'SE',
  sverige: 'SE',
  che: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  esp: 'ES',
  espana: 'ES',
  ita: 'IT',
  italia: 'IT',
  irl: 'IE',
  isr: 'IL',
  ind: 'IN',
  jpn: 'JP',
  chn: 'CN',
  bra: 'BR',
  brasil: 'BR',
  sgp: 'SG',
  turkey: 'TR',
  'south korea': 'KR',
  korea: 'KR',
  'republic of korea': 'KR',
  'korea republic of': 'KR',
  'czech republic': 'CZ',
  uae: 'AE',
  'u a e': 'AE',
  'russian federation': 'RU',
  'hong kong': 'HK',
  macau: 'MO',
  'ivory coast': 'CI',
  burma: 'MM',
  myanmar: 'MM',
};

/** Lowercase, strip accents and punctuation: `Côte d’Ivoire` -> `cote d ivoire`. */
export function foldCountry(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let index: Map<string, string> | undefined;

function buildIndex(): Map<string, string> {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const map = new Map<string, string>();
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      const name = names.of(code);
      if (!name || name === code) continue;
      map.set(foldCountry(code), code);
      map.set(foldCountry(name), code);
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) map.set(alias, code);
  return map;
}

/** Returns the ISO alpha-2 code for a country name, alias or code, or null if unknown. */
export function countryCode(value: string): string | null {
  index ??= buildIndex();
  return index.get(foldCountry(value)) ?? null;
}
