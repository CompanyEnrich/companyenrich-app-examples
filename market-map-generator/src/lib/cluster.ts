import { cosine, mean, type Vector } from './tfidf.ts';

/** Pairwise cosine similarities. Fine for the 10-100 companies a market map holds. */
export function similarityMatrix(vectors: Vector[]): number[][] {
  return vectors.map((a, i) => vectors.map((b, j) => (i === j ? 1 : cosine(a, b))));
}

/**
 * Spherical k-means: ordinary k-means where "closest" means the highest cosine similarity.
 *
 * There is no randomness, so the same companies always produce the same map. The first seed is the
 * most central company (highest total similarity to the others); each next seed is the company least
 * similar to every seed chosen so far. Then the usual loop runs: assign each company to its most
 * similar centroid, recompute centroids as the mean of their members, stop when nothing moves.
 *
 * Returns a cluster number per company, renumbered 0..m-1 in order of first appearance. A cluster
 * that ends up empty disappears, so m can be smaller than k.
 */
export function kMeans(vectors: Vector[], k: number, similarity = similarityMatrix(vectors), maxIterations = 50): number[] {
  if (k >= vectors.length) return vectors.map((_, index) => index);

  let centroids = farthestFirstSeeds(similarity, k).map((index) => vectors[index]!);
  let assignment: number[] = [];
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const next = vectors.map((vector) => mostSimilar(vector, centroids));
    if (next.every((cluster, index) => cluster === assignment[index])) break;
    assignment = next;
    centroids = centroids.map((centroid, cluster) => {
      const members = vectors.filter((_, index) => assignment[index] === cluster);
      return members.length > 0 ? mean(members) : centroid;
    });
  }
  return renumber(assignment);
}

/**
 * Mean silhouette score, from -1 to 1, with distance = 1 - cosine similarity.
 *
 * For each company: a = average distance to the rest of its own cluster, b = average distance to the
 * nearest other cluster, s = (b - a) / max(a, b). High s means the company sits well inside its cluster
 * and far from the next one. A company alone in its cluster scores 0.
 */
export function silhouette(similarity: number[][], assignment: number[]): number {
  const clusters = [...new Set(assignment)];
  if (clusters.length < 2) return 0;

  const averageDistance = (index: number, cluster: number) => {
    const others = assignment.flatMap((c, j) => (c === cluster && j !== index ? [j] : []));
    if (others.length === 0) return null;
    return others.reduce((sum, j) => sum + 1 - similarity[index]![j]!, 0) / others.length;
  };

  let total = 0;
  assignment.forEach((own, index) => {
    const a = averageDistance(index, own);
    if (a === null) return;
    const b = Math.min(...clusters.filter((c) => c !== own).map((c) => averageDistance(index, c) ?? Infinity));
    const denominator = Math.max(a, b);
    total += denominator === 0 ? 0 : (b - a) / denominator;
  });
  return total / assignment.length;
}

/**
 * A company alone in its cluster joins the cluster it is most similar to on average, because a
 * one-logo box makes a poor market map category. Repeats until no cluster has a single member.
 */
export function absorbSingletons(similarity: number[][], assignment: number[]): number[] {
  const result = [...assignment];
  for (;;) {
    const sizes = new Map<number, number>();
    for (const cluster of result) sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
    const lonely = result.findIndex((cluster) => sizes.get(cluster) === 1);
    if (lonely === -1 || sizes.size <= 1) return renumber(result);

    let best = -1;
    let bestScore = -Infinity;
    for (const cluster of sizes.keys()) {
      if (cluster === result[lonely]) continue;
      const members = result.flatMap((c, index) => (c === cluster ? [index] : []));
      const score = members.reduce((sum, index) => sum + similarity[lonely]![index]!, 0) / members.length;
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    result[lonely] = best;
  }
}

export interface KScore {
  /** The k that k-means was asked for. */
  k: number;
  /** Clusters left after single-company clusters were absorbed. */
  clusters: number;
  silhouette: number;
}

export interface KChoice {
  assignment: number[];
  /** Number of clusters in the chosen assignment. */
  clusters: number;
  scores: KScore[];
}

/**
 * Runs k-means for every k in [min, max] (capped so clusters average at least two companies), absorbs
 * single-company clusters, and keeps the assignment with the highest silhouette; ties go to fewer
 * clusters. Returns null when there are too few companies to split into `min` clusters.
 */
export function chooseK(vectors: Vector[], { min = 3, max = 6 } = {}): KChoice | null {
  const upper = Math.min(max, Math.floor(vectors.length / 2));
  if (upper < min) return null;

  const similarity = similarityMatrix(vectors);
  const candidates: Array<KScore & { assignment: number[] }> = [];
  for (let k = min; k <= upper; k++) {
    const assignment = absorbSingletons(similarity, kMeans(vectors, k, similarity));
    candidates.push({ k, assignment, clusters: new Set(assignment).size, silhouette: silhouette(similarity, assignment) });
  }

  const [best] = [...candidates].sort((x, y) => y.silhouette - x.silhouette || x.clusters - y.clusters);
  return {
    assignment: best!.assignment,
    clusters: best!.clusters,
    scores: candidates.map(({ k, clusters, silhouette: score }) => ({ k, clusters, silhouette: score })),
  };
}

/**
 * For each company, the index of the most similar category hint, or -1 when it shares no terms with
 * any hint. Ties go to the hint listed first in the theme.
 */
export function assignByHints(vectors: Vector[], hintVectors: Vector[]): number[] {
  return vectors.map((vector) => {
    let best = -1;
    let bestScore = 0;
    hintVectors.forEach((hint, index) => {
      const score = cosine(vector, hint);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    return best;
  });
}

function farthestFirstSeeds(similarity: number[][], k: number): number[] {
  const totals = similarity.map((row) => row.reduce((sum, value) => sum + value, 0));
  const seeds = [totals.indexOf(Math.max(...totals))];
  while (seeds.length < k) {
    let next = -1;
    let lowest = Infinity;
    similarity.forEach((row, index) => {
      if (seeds.includes(index)) return;
      const closestSeed = Math.max(...seeds.map((seed) => row[seed]!));
      if (closestSeed < lowest) {
        next = index;
        lowest = closestSeed;
      }
    });
    seeds.push(next);
  }
  return seeds;
}

function mostSimilar(vector: Vector, centroids: Vector[]): number {
  let best = 0;
  let bestScore = -Infinity;
  centroids.forEach((centroid, index) => {
    const score = cosine(vector, centroid);
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function renumber(assignment: number[]): number[] {
  const order = new Map<number, number>();
  return assignment.map((cluster) => {
    if (!order.has(cluster)) order.set(cluster, order.size);
    return order.get(cluster)!;
  });
}
