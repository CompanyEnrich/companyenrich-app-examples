import type { CompanyEnrich } from '@companyenrich/sdk';
import { UsageError } from './errors.js';

/**
 * Resolves user input to the exact technology name the API filters on, using the free
 * autocomplete. Technology names are lowercase in the API, so the match ignores case.
 * Anything short of an exact match stops the run with the closest suggestions.
 */
export async function resolveTechnology(client: CompanyEnrich, input: string, flag: string): Promise<string> {
  const query = input.trim();
  if (!query) throw new UsageError(`${flag} needs a technology name.`);

  const { items } = await client.technologies.autocomplete(query);
  const exact = items.find((name) => name.toLowerCase() === query.toLowerCase());
  if (exact) return exact;

  if (items.length === 0) {
    throw new UsageError(`${flag} "${query}" is not a known technology, and nothing starts with it. Try a shorter prefix.`);
  }
  const suggestions = items.map((name) => (name.includes(' ') ? `"${name}"` : name)).join(', ');
  throw new UsageError(`${flag} "${query}" is not an exact technology name. Closest matches: ${suggestions}.`);
}
