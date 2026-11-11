import { describe, expect, it } from 'vitest';
import { companyTags, companyText } from '../src/lib/categorize.ts';
import { absorbSingletons, assignByHints, chooseK, kMeans, silhouette, similarityMatrix } from '../src/lib/cluster.ts';
import { buildCorpus } from '../src/lib/tfidf.ts';
import { COMPANIES, GROUPS } from './fixtures.ts';

const corpus = buildCorpus(COMPANIES.map((company) => ({ text: companyText(company), tags: companyTags(company) })));
const names = COMPANIES.map((company) => company.name!);

/** Cluster membership as sorted lists of company names, independent of cluster numbering. */
function groupsOf(assignment: number[]): string[][] {
  const groups = new Map<number, string[]>();
  assignment.forEach((cluster, index) => groups.set(cluster, [...(groups.get(cluster) ?? []), names[index]!]));
  return [...groups.values()].map((group) => group.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

const expectedGroups = Object.values(GROUPS)
  .map((group) => [...group].sort())
  .sort((a, b) => a[0]!.localeCompare(b[0]!));

/** Two tight pairs: 0-1 and 2-3. Similarity 0.8 inside a pair and 0.2 across. */
const PAIRS = [
  [1, 0.8, 0.2, 0.2],
  [0.8, 1, 0.2, 0.2],
  [0.2, 0.2, 1, 0.8],
  [0.2, 0.2, 0.8, 1],
];

describe('kMeans', () => {
  it('separates three obvious groups', () => {
    expect(groupsOf(kMeans(corpus.vectors, 3))).toEqual(expectedGroups);
  });

  it('is deterministic', () => {
    expect(kMeans(corpus.vectors, 4)).toEqual(kMeans(corpus.vectors, 4));
  });

  it('numbers clusters in order of first appearance', () => {
    expect(kMeans(corpus.vectors, 3)[0]).toBe(0);
  });

  it('puts every company in its own cluster when k >= n', () => {
    expect(kMeans(corpus.vectors.slice(0, 2), 3)).toEqual([0, 1]);
  });
});

describe('silhouette', () => {
  it('matches the hand-computed value for a good split', () => {
    // Every point: a = 1 - 0.8 = 0.2, b = 1 - 0.2 = 0.8, s = (0.8 - 0.2) / 0.8 = 0.75
    expect(silhouette(PAIRS, [0, 0, 1, 1])).toBeCloseTo(0.75, 10);
  });

  it('is negative for a split that cuts through the pairs', () => {
    // a = 0.8; b = mean(0.2, 0.8) = 0.5; s = (0.5 - 0.8) / 0.8 = -0.375
    expect(silhouette(PAIRS, [0, 1, 0, 1])).toBeCloseTo(-0.375, 10);
  });

  it('scores a company alone in its cluster as 0, and a single cluster as 0', () => {
    // Points 0 and 1 score 0.75 each in cluster 0; point 2 (alone) scores 0; point 3 alone scores 0.
    expect(silhouette(PAIRS, [0, 0, 1, 2])).toBeCloseTo(0.375, 10);
    expect(silhouette(PAIRS, [0, 0, 0, 0])).toBe(0);
  });
});

describe('absorbSingletons', () => {
  it('moves a lone company into the cluster it is most similar to', () => {
    expect(absorbSingletons(PAIRS, [0, 0, 1, 2])).toEqual([0, 0, 1, 1]);
  });

  it('leaves clusters of two or more alone', () => {
    expect(absorbSingletons(PAIRS, [0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
  });
});

describe('chooseK', () => {
  it('picks three clusters for three obvious groups and reports a score per k', () => {
    const choice = chooseK(corpus.vectors)!;
    expect(choice.clusters).toBe(3);
    expect(groupsOf(choice.assignment)).toEqual(expectedGroups);
    // Nine companies cap k at floor(9 / 2) = 4.
    expect(choice.scores.map((score) => score.k)).toEqual([3, 4]);
    const best = Math.max(...choice.scores.map((score) => score.silhouette));
    expect(choice.scores.find((score) => score.clusters === 3)?.silhouette).toBe(best);
  });

  it('returns null when there are too few companies for three clusters of two', () => {
    expect(chooseK(corpus.vectors.slice(0, 5))).toBeNull();
  });

  it('has a symmetric similarity matrix with ones on the diagonal', () => {
    const matrix = similarityMatrix(corpus.vectors);
    expect(matrix[2]![2]).toBe(1);
    expect(matrix[0]![3]).toBeCloseTo(matrix[3]![0]!, 12);
  });
});

describe('assignByHints', () => {
  it('assigns each company to the most similar hint', () => {
    const hints = ['accounts payable invoice', 'bank reconciliation month-end close', 'budgeting forecasting'].map((text) => corpus.vectorize(text));
    const assignment = assignByHints(corpus.vectors, hints);
    const byHint = [0, 1, 2].map((hint) => names.filter((_, index) => assignment[index] === hint).sort());
    expect(byHint).toEqual([[...GROUPS.payables].sort(), [...GROUPS.close].sort(), [...GROUPS.planning].sort()]);
  });

  it('returns -1 when a company shares no terms with any hint, and breaks ties by hint order', () => {
    const local = buildCorpus([{ text: 'tax filing' }, { text: 'carbon offsets' }]);
    const hints = [local.vectorize('tax'), local.vectorize('tax')];
    expect(assignByHints(local.vectors, hints)).toEqual([0, -1]);
  });
});
