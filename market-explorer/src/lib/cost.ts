/** Credit math for company search. Counts, previews and autocomplete are free. */

/** The paid sample is capped at this many companies per request, whatever the browser asks for. */
export const MAX_SAMPLE_PAGE_SIZE = 10;

export type SearchMode = 'filter' | 'semantic' | 'lookalike';

/** Base price per returned company, before paid expansions. */
export const CREDITS_PER_RESULT: Record<SearchMode, number> = {
  filter: 1,
  semantic: 2,
  lookalike: 5,
};

/**
 * Credits a search returning `results` companies would cost. An empty page still
 * bills one result's base price, so the minimum is one result.
 */
export function searchCredits(mode: SearchMode, results: number): number {
  return Math.max(1, Math.floor(results)) * CREDITS_PER_RESULT[mode];
}

export interface CostLine {
  results: number;
  credits: number;
}

/**
 * What fetching the first N matches would cost, for a few useful N. Sizes above
 * the match count collapse to "all of them".
 */
export function costLadder(mode: SearchMode, matches: number, sizes: readonly number[] = [10, 100, 1_000]): CostLine[] {
  const lines: CostLine[] = [];
  for (const size of sizes) {
    const results = Math.min(size, matches);
    if (results <= 0 || lines.some((line) => line.results === results)) continue;
    lines.push({ results, credits: searchCredits(mode, results) });
  }
  if (matches > 0 && !lines.some((line) => line.results === matches)) {
    lines.push({ results: matches, credits: searchCredits(mode, matches) });
  }
  return lines;
}
