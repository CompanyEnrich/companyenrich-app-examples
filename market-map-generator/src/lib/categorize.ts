import type { Company } from '@companyenrich/sdk';
import { assignByHints, chooseK, type KScore } from './cluster.ts';
import { describeTerms, distinctiveTerms, nameFromTerms } from './naming.ts';
import { buildCorpus } from './tfidf.ts';
import { wordKeys } from './text.ts';
import type { Theme } from './theme.ts';

export interface Category {
  name: string;
  description: string;
  /** The most distinctive terms of the group, best first. */
  terms: string[];
  companies: Company[];
  /** Where the category came from: a theme hint, automatic clustering, or the catch-all "Other" box. */
  kind: 'hint' | 'cluster' | 'other';
}

export type Method =
  | { kind: 'hints'; unmatched: number; emptyHints: string[] }
  | { kind: 'clusters'; clusters: number; scores: KScore[] }
  | { kind: 'single' };

export interface Categorization {
  categories: Category[];
  method: Method;
}

/** The prose the clustering reads about a company. Periods keep two-word terms from spanning fields. */
export function companyText(company: Company): string {
  return [company.description, ...(company.keywords ?? [])].filter((part): part is string => Boolean(part)).join('. ');
}

/** Taxonomy labels: "Software", "Business Services/Custom Software & IT Services", "saas". */
export function companyTags(company: Company): string[] {
  return [...(company.industries ?? (company.industry ? [company.industry] : [])), ...(company.categories ?? [])];
}

/** A company's own name and location say nothing about what it does, so they are left out of its vector. */
function companyNoise(company: Company): Set<string> {
  const location = company.location;
  return wordKeys([company.name, location?.city?.name, location?.state?.name, location?.country?.name].filter(Boolean).join(' '));
}

/**
 * Groups companies into map categories.
 *
 * - With category hints in the theme, each company goes to the hint whose name and keywords are most
 *   similar to it (TF-IDF cosine). Companies that share no terms with any hint go to "Other".
 * - Without hints, k-means runs for every k from 3 to 6, single-company clusters join their nearest
 *   neighbour, and the result with the best silhouette wins. Each cluster is named by its most
 *   distinctive terms.
 * - Companies with no usable text (no description, industries or keywords, or, when clustering, no
 *   term shared with any other company) go to "Other".
 */
export function categorize(companies: Company[], theme: Theme): Categorization {
  // Clustering compares companies with each other, so a term only one company uses cannot help and
  // only dilutes its vector. Hint matching keeps every term (one company may be the only CSRD tool),
  // and so does a single company, which has nothing to share terms with.
  const corpus = buildCorpus(
    companies.map((company) => ({ text: companyText(company), tags: companyTags(company), ignore: companyNoise(company) })),
    { minDocumentFrequency: theme.categories.length > 0 || companies.length < 2 ? 1 : 2 },
  );
  const withText = companies.map((_, index) => index).filter((index) => corpus.vectors[index]!.size > 0);
  const withoutText = companies.map((_, index) => index).filter((index) => corpus.vectors[index]!.size === 0);
  const exclude = wordKeys(theme.title);
  const termsOf = (members: number[]) => distinctiveTerms(corpus, members, { exclude });
  const pick = (members: number[]) => members.map((index) => companies[index]!);
  const clusterCategory = (members: number[], taken: ReadonlySet<string>, fallback: string): Category => {
    const terms = termsOf(members);
    return { name: nameFromTerms(terms, taken, fallback), description: describeTerms(terms), terms, companies: pick(members), kind: 'cluster' };
  };

  let categories: Category[];
  let method: Method;
  let unmatched = withoutText;

  if (theme.categories.length > 0) {
    const hintVectors = theme.categories.map((hint) => corpus.vectorize([hint.name, ...hint.keywords].join('. ')));
    const assignment = assignByHints(
      withText.map((index) => corpus.vectors[index]!),
      hintVectors,
    );
    const groups = theme.categories.map((_, hintIndex) => withText.filter((_, position) => assignment[position] === hintIndex));
    unmatched = [...withText.filter((_, position) => assignment[position] === -1), ...withoutText];
    categories = theme.categories.flatMap((hint, hintIndex) => {
      const members = groups[hintIndex]!;
      if (members.length === 0) return [];
      const terms = termsOf(members);
      return [{ name: hint.name, description: describeTerms(terms), terms, companies: pick(members), kind: 'hint' as const }];
    });
    method = {
      kind: 'hints',
      unmatched: unmatched.length,
      emptyHints: theme.categories.filter((_, hintIndex) => groups[hintIndex]!.length === 0).map((hint) => hint.name),
    };
  } else {
    const choice = chooseK(withText.map((index) => corpus.vectors[index]!));
    if (!choice) {
      categories = withText.length > 0 ? [clusterCategory(withText, new Set(), 'All companies')] : [];
      method = { kind: 'single' };
    } else {
      const clusters = groupBy(withText, (_, position) => choice.assignment[position]!);
      // Name the biggest clusters first so they get the best names when two would collide.
      clusters.sort((a, b) => b.length - a.length);
      const taken = new Set<string>();
      categories = clusters.map((members, index) => {
        const category = clusterCategory(members, taken, `Group ${index + 1}`);
        taken.add(category.name);
        return category;
      });
      method = { kind: 'clusters', clusters: choice.clusters, scores: choice.scores };
    }
  }

  if (unmatched.length > 0) {
    categories.push({
      name: 'Other',
      description:
        theme.categories.length > 0 ? 'Companies that match none of the category hints' : 'Companies with no description, or no terms in common with the others',
      terms: [],
      companies: pick(unmatched),
      kind: 'other',
    });
  }
  return { categories, method };
}

/** Groups items by key, keeping groups in order of first appearance and items in input order. */
function groupBy<T>(items: T[], key: (item: T, position: number) => number): T[][] {
  const groups = new Map<number, T[]>();
  items.forEach((item, position) => {
    const k = key(item, position);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  });
  return [...groups.values()];
}
