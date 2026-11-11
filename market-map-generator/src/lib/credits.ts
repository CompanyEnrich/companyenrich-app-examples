import { UsageError } from './errors.ts';

/** Semantic company search price per returned company. */
export const SEMANTIC_SEARCH_CREDITS = 2;
/** Price of the `keywords` expansion per returned company. */
export const KEYWORDS_EXPANSION_CREDITS = 1;

export function creditsPerCompany(withKeywords: boolean): number {
  return SEMANTIC_SEARCH_CREDITS + (withKeywords ? KEYWORDS_EXPANSION_CREDITS : 0);
}

/**
 * The most the search can cost: every requested company comes back. The free count is no help in
 * narrowing this, because for semantic queries it reports the size of the candidate pool.
 */
export function estimateSearchCredits(companies: number, withKeywords: boolean): number {
  return companies * creditsPerCompany(withKeywords);
}

/** What a finished search cost. An empty result still bills one result's base price. */
export function actualSearchCredits(returned: number, withKeywords: boolean): number {
  return returned === 0 ? SEMANTIC_SEARCH_CREDITS : returned * creditsPerCompany(withKeywords);
}

/** Throws before a paid call that could cost more than the cap, and says how many companies would fit. */
export function assertWithinBudget(estimate: number, maxCredits: number, withKeywords: boolean): void {
  if (estimate <= maxCredits) return;
  const fits = Math.floor(maxCredits / creditsPerCompany(withKeywords));
  const hint = fits > 0 ? `Use --companies ${fits} or raise --max-credits.` : 'Raise --max-credits.';
  throw new UsageError(`This run could cost ${estimate} credits, more than --max-credits ${maxCredits}. Nothing was spent. ${hint}`);
}
