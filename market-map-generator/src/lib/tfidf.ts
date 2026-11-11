import { extractTerms, type Term } from './text.ts';

/** A sparse vector: term -> weight. Terms that are absent have weight 0. */
export type Vector = Map<string, number>;

export interface CorpusDocument {
  text: string;
  /**
   * Labels from a fixed taxonomy (industries, categories). They count toward similarity at half the
   * weight of a word, and their keys start with "#" so they are never used in a cluster name.
   */
  tags?: string[];
  /** Word stems to drop from this document only, such as the company's own name. */
  ignore?: ReadonlySet<string>;
}

export const TAG_WEIGHT = 0.5;

export function isTag(term: string): boolean {
  return term.startsWith('#');
}

export interface Corpus {
  /** One unit-length TF-IDF vector per document, in input order. */
  vectors: Vector[];
  /** Number of documents each term appears in. */
  documentFrequency: Map<string, number>;
  /** The most common written form of each term, for display ("invoices" rather than the stem "invoice"). */
  surface: Map<string, string>;
  /** Vectorizes new text (such as a category hint) in the same term space. Terms the corpus never saw are dropped. */
  vectorize(text: string): Vector;
}

/**
 * Builds TF-IDF vectors.
 *
 *   tf(term, doc) = how many times the term appears in the document (a tag counts 0.5)
 *   idf(term)     = ln((1 + N) / (1 + df(term))) + 1      (N documents, df = documents containing the term)
 *   weight        = tf * idf, then the vector is scaled to length 1
 *
 * Rare terms get a high idf, so two companies that share "accounts payable" look more alike than two
 * that share "finance". Scaling to length 1 means long descriptions do not dominate short ones.
 */
export function buildCorpus(documents: CorpusDocument[], { minDocumentFrequency = 1 } = {}): Corpus {
  const surfaceCounts = new Map<string, Map<string, number>>();
  const termCounts = documents.map((document) => {
    const terms = extractTerms(document.text, document.ignore);
    for (const term of terms) {
      const forms = surfaceCounts.get(term.key) ?? new Map<string, number>();
      forms.set(term.surface, (forms.get(term.surface) ?? 0) + 1);
      surfaceCounts.set(term.key, forms);
    }
    const counts = countKeys(terms);
    for (const tag of document.tags ?? []) {
      const key = `#${tag.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + TAG_WEIGHT);
    }
    return counts;
  });

  const documentFrequency = new Map<string, number>();
  for (const counts of termCounts) {
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const idf = new Map<string, number>();
  for (const [term, df] of documentFrequency) {
    if (df >= minDocumentFrequency) idf.set(term, Math.log((1 + documents.length) / (1 + df)) + 1);
  }

  const weigh = (counts: Map<string, number>): Vector => {
    const vector: Vector = new Map();
    for (const [term, tf] of counts) {
      const termIdf = idf.get(term);
      if (termIdf !== undefined) vector.set(term, tf * termIdf);
    }
    return normalize(vector);
  };

  const surface = new Map<string, string>();
  for (const [term, forms] of surfaceCounts) {
    // Most frequent form wins; ties go to the alphabetically first so output is deterministic.
    const [best] = [...forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (best) surface.set(term, best[0]);
  }

  return {
    vectors: termCounts.map(weigh),
    documentFrequency,
    surface,
    vectorize: (text) => weigh(countKeys(extractTerms(text))),
  };
}

/** Cosine similarity: 1 for vectors pointing the same way, 0 when they share no terms. */
export function cosine(a: Vector, b: Vector): number {
  const normA = norm(a);
  const normB = norm(b);
  if (normA === 0 || normB === 0) return 0;
  return dot(a, b) / (normA * normB);
}

export function dot(a: Vector, b: Vector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, weight] of small) sum += weight * (large.get(term) ?? 0);
  return sum;
}

export function norm(vector: Vector): number {
  let sum = 0;
  for (const weight of vector.values()) sum += weight * weight;
  return Math.sqrt(sum);
}

export function normalize(vector: Vector): Vector {
  const length = norm(vector);
  if (length === 0) return new Map();
  return new Map([...vector].map(([term, weight]) => [term, weight / length]));
}

/** The average of several vectors (a cluster centroid). */
export function mean(vectors: Vector[]): Vector {
  const sum: Vector = new Map();
  for (const vector of vectors) {
    for (const [term, weight] of vector) sum.set(term, (sum.get(term) ?? 0) + weight);
  }
  for (const [term, weight] of sum) sum.set(term, weight / Math.max(1, vectors.length));
  return sum;
}

function countKeys(terms: Term[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term.key, (counts.get(term.key) ?? 0) + 1);
  return counts;
}
