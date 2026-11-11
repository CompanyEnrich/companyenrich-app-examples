import type { Category } from '../categorize.ts';
import type { LogoMap } from '../logos.ts';

/** Everything the HTML and SVG renderers need. */
export interface MarketMap {
  title: string;
  /** The semantic query the companies came from. */
  query: string;
  /** YYYY-MM-DD */
  generatedOn: string;
  categories: Category[];
  logos: LogoMap;
  /** How the categories were made, for the footer, e.g. "Grouped by TF-IDF k-means (k=4)". */
  method: string;
}

/** Escapes text for use in XML or HTML text and attribute values. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[char]};`);
}

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…` : text;
}

export function companyCount(map: MarketMap): number {
  return map.categories.reduce((sum, category) => sum + category.companies.length, 0);
}

/** Honest about the sample: these are the top results by relevance, not every company in the market. */
export function subtitle(map: MarketMap): string {
  const count = companyCount(map);
  const categories = map.categories.length;
  return `The ${count} ${count === 1 ? 'company' : 'companies'} most relevant to the theme, in ${categories} ${categories === 1 ? 'category' : 'categories'}`;
}

export function sourceLine(map: MarketMap): string {
  return `Data: CompanyEnrich API (companyenrich.com), semantic company search for "${truncate(map.query, 110)}"`;
}

export function methodLine(map: MarketMap): string {
  return `Generated ${map.generatedOn} · ${map.method}`;
}

/**
 * Color tokens for light and dark mode. Box accents use a validated categorical palette in a fixed
 * order; text always uses the ink tokens, never the accent, and every box is labelled, so color is
 * never the only way to tell categories apart. Logos sit on a white tile in both modes.
 */
export function colorTokens(selector: string): string {
  const light = {
    page: '#f9f9f7', surface: '#fcfcfb', ink: '#0b0b0b', 'ink-2': '#52514e', muted: '#77756f',
    border: 'rgba(11,11,11,0.12)', tile: '#ffffff', 'initials-bg': '#f0efec', other: '#c3c2b7',
    c1: '#2a78d6', c2: '#eb6834', c3: '#1baf7a', c4: '#eda100', c5: '#e87ba4', c6: '#008300', c7: '#6250d6', c8: '#e34948',
  };
  const dark = {
    page: '#0d0d0d', surface: '#1a1a19', ink: '#f0efec', 'ink-2': '#c3c2b7', muted: '#a3a199',
    border: 'rgba(255,255,255,0.12)', tile: '#ffffff', 'initials-bg': '#383835', other: '#52514e',
    c1: '#3987e5', c2: '#d95926', c3: '#199e70', c4: '#c98500', c5: '#d55181', c6: '#008300', c7: '#9085e9', c8: '#e66767',
  };
  const declarations = (tokens: Record<string, string>) =>
    Object.entries(tokens)
      .map(([name, value]) => `--${name}: ${value};`)
      .join(' ');
  return `${selector} { color-scheme: light dark; ${declarations(light)} }
@media (prefers-color-scheme: dark) { ${selector} { ${declarations(dark)} } }`;
}

export function accentVar(color: number | null): string {
  return color === null ? 'var(--other)' : `var(--c${color + 1})`;
}
