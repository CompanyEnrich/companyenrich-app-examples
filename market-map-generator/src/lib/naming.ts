import { titleCase } from './text.ts';
import { isTag, mean, type Corpus } from './tfidf.ts';

export interface DistinctiveTermsOptions {
  /** Word stems never used in a name, such as the words of the theme title ("finance" on a finance map says nothing). */
  exclude?: ReadonlySet<string>;
  limit?: number;
}

/**
 * The terms that best set a group of companies apart from the rest of the map:
 *
 *   score(term) = mean TF-IDF weight inside the group - mean weight outside it
 *
 * Rules that keep the result readable:
 * - A term must appear in at least two members (when the group has two or more), so a name never
 *   comes from a single company's description.
 * - A two-word phrase beats a word it contains unless the word scores more than twice as high
 *   ("financial close" says more than "close").
 * - A term that shares a word with a better one is skipped ("accounts payable" and "payable" would
 *   say the same thing twice).
 * - Two picked words that also appear together as a phrase become that phrase ("close" and
 *   "financial" become "financial close").
 *
 * Returns display forms ("invoices", "accounts payable"), best first.
 */
export function distinctiveTerms(corpus: Corpus, members: number[], { exclude = new Set(), limit = 5 }: DistinctiveTermsOptions = {}): string[] {
  const memberSet = new Set(members);
  const inside = mean(members.map((index) => corpus.vectors[index]!));
  const outside = mean(corpus.vectors.filter((_, index) => !memberSet.has(index)));
  const minimumMembers = Math.min(2, members.length);

  const candidates = [...inside]
    .filter(([term]) => !isTag(term) && term.split(' ').every((word) => !exclude.has(word)))
    .filter(([term]) => members.filter((index) => corpus.vectors[index]!.has(term)).length >= minimumMembers)
    .map(([term, weight]) => ({ term, words: term.split(' '), score: weight - (outside.get(term) ?? 0) }))
    .filter(({ score }) => score > 0);

  const phrases = candidates.filter(({ words }) => words.length > 1);
  const ranked = candidates
    .filter(({ term, words, score }) => words.length > 1 || !phrases.some((phrase) => phrase.words.includes(term) && phrase.score * 2 >= score))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

  const picked: string[] = [];
  const usedWords = new Set<string>();
  for (const { term, words } of ranked) {
    if (words.some((word) => usedWords.has(word))) continue;
    const partner = words.length === 1 ? picked.findIndex((other) => !other.includes(' ') && corpus.surface.has(`${term} ${other}`)) : -1;
    const reversed = words.length === 1 ? picked.findIndex((other) => !other.includes(' ') && corpus.surface.has(`${other} ${term}`)) : -1;
    if (partner !== -1) picked[partner] = `${term} ${picked[partner]}`;
    else if (reversed !== -1) picked[reversed] = `${picked[reversed]} ${term}`;
    else picked.push(term);
    words.forEach((word) => usedWords.add(word));
    if (picked.length === limit) break;
  }
  return picked.map((term) => corpus.surface.get(term) ?? term);
}

/**
 * A short label from the top terms. A multi-word top term stands alone ("Invoice Processing"); a single
 * word gets a partner ("Accounting & Reporting"). Other combinations are tried so two clusters never
 * share a name, and `fallback` is used when nothing is free.
 */
export function nameFromTerms(terms: string[], taken: ReadonlySet<string>, fallback: string): string {
  const titled = terms.slice(0, 4).map(titleCase);
  const pairs: string[] = [];
  for (let i = 0; i < titled.length; i++) {
    for (let j = i + 1; j < titled.length; j++) pairs.push(`${titled[i]} & ${titled[j]}`);
  }
  const isPhrase = (term: string) => /[\s-]/.test(term);
  const candidates = titled[0] && isPhrase(titled[0]) ? [titled[0], ...pairs, ...titled.slice(1)] : [...pairs, ...titled];

  const isTaken = (name: string) => [...taken].some((existing) => existing.toLowerCase() === name.toLowerCase());
  const free = candidates.find((name) => !isTaken(name));
  if (free) return free;
  let suffix = 1;
  while (isTaken(suffix === 1 ? fallback : `${fallback} ${suffix}`)) suffix++;
  return suffix === 1 ? fallback : `${fallback} ${suffix}`;
}

/** One line describing a group from its terms. */
export function describeTerms(terms: string[]): string {
  return terms.length > 0 ? `Common terms: ${terms.slice(0, 4).join(', ')}` : 'No shared terms';
}
