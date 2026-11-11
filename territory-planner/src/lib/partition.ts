/**
 * Balanced partitioning of weighted items (states, or whole regions) into a fixed number of bins
 * (territories). Pure functions, no I/O, deterministic for the same input.
 */

export interface WeightedItem {
  key: string;
  weight: number;
}

export interface Bin<T extends WeightedItem = WeightedItem> {
  items: T[];
  load: number;
}

/** Heaviest first; equal weights in key order, so the result never depends on input order. */
function byWeightThenKey(a: WeightedItem, b: WeightedItem): number {
  return b.weight - a.weight || a.key.localeCompare(b.key);
}

/**
 * Greedy longest-processing-time assignment: take items heaviest first and give each to the
 * currently lightest bin (lowest index on ties). Within 4/3 of the optimal max load.
 */
export function assignGreedy<T extends WeightedItem>(items: readonly T[], binCount: number): Bin<T>[] {
  if (!Number.isInteger(binCount) || binCount < 1) throw new RangeError(`binCount must be a positive integer, got ${binCount}`);
  const bins: Bin<T>[] = Array.from({ length: binCount }, () => ({ items: [], load: 0 }));
  for (const item of [...items].sort(byWeightThenKey)) {
    let lightest = bins[0]!;
    for (const bin of bins) if (bin.load < lightest.load) lightest = bin;
    lightest.items.push(item);
    lightest.load += item.weight;
  }
  return bins;
}

interface Move<T extends WeightedItem> {
  fromItem: T;
  toItem: T | null;
  /** Weight that leaves the heavier bin. */
  delta: number;
}

/** The single move or swap between two bins that leaves their loads closest together, if any helps. */
function bestMove<T extends WeightedItem>(heavy: Bin<T>, light: Bin<T>, epsilon: number): Move<T> | null {
  const gap = heavy.load - light.load;
  const candidates: Move<T>[] = [];
  for (const fromItem of heavy.items) {
    candidates.push({ fromItem, toItem: null, delta: fromItem.weight });
    for (const toItem of light.items) {
      candidates.push({ fromItem, toItem, delta: fromItem.weight - toItem.weight });
    }
  }
  let best: Move<T> | null = null;
  for (const move of candidates) {
    // Only a shift strictly between 0 and the full gap brings both bins closer together.
    if (move.delta <= epsilon || move.delta >= gap - epsilon) continue;
    if (!best || Math.abs(gap - 2 * move.delta) < Math.abs(gap - 2 * best.delta) - epsilon) best = move;
  }
  return best;
}

/**
 * Local improvement after the greedy pass. Looks at pairs of bins, largest load gap first (so the
 * heaviest and lightest come first), and applies the single move or swap that best narrows the gap.
 * Repeats until no pair improves.
 *
 * Every applied step keeps both bins inside the current [min, max] load range, so the max/min
 * spread never grows, and it strictly lowers the sum of squared loads, so the loop always ends.
 */
export function improveBySwaps<T extends WeightedItem>(bins: Bin<T>[], maxSteps = 10_000): Bin<T>[] {
  const total = bins.reduce((sum, bin) => sum + bin.load, 0);
  const epsilon = 1e-9 * Math.max(1, total);
  for (let step = 0; step < maxSteps; step++) {
    const pairs: [Bin<T>, Bin<T>][] = [];
    for (const a of bins) for (const b of bins) if (a.load - b.load > epsilon) pairs.push([a, b]);
    // Stable sort keeps index order for equal gaps, which keeps the result deterministic.
    pairs.sort(([a1, b1], [a2, b2]) => (a2.load - b2.load) - (a1.load - b1.load));

    let applied = false;
    for (const [heavy, light] of pairs) {
      const move = bestMove(heavy, light, epsilon);
      if (!move) continue;
      heavy.items = heavy.items.filter((item) => item !== move.fromItem);
      light.items = light.items.filter((item) => item !== move.toItem);
      light.items.push(move.fromItem);
      if (move.toItem) heavy.items.push(move.toItem);
      heavy.items.sort(byWeightThenKey);
      light.items.sort(byWeightThenKey);
      heavy.load -= move.delta;
      light.load += move.delta;
      applied = true;
      break;
    }
    if (!applied) break;
  }
  return bins;
}

/** Greedy assignment followed by local improvement. Items inside each bin are heaviest first. */
export function partitionBalanced<T extends WeightedItem>(items: readonly T[], binCount: number): Bin<T>[] {
  const bins = assignGreedy(items, binCount);
  for (const bin of bins) bin.items.sort(byWeightThenKey);
  return improveBySwaps(bins);
}

export interface Balance {
  mean: number;
  min: number;
  max: number;
  /** max / min. Null when a territory is empty (min is 0). */
  maxMinRatio: number | null;
  /** Population standard deviation of the loads. */
  stdDev: number;
  /** stdDev / mean: the typical deviation from an even split, as a fraction. */
  coefficientOfVariation: number;
}

export function balanceOf(loads: readonly number[]): Balance {
  if (loads.length === 0) throw new RangeError('balanceOf needs at least one load');
  const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length;
  const min = Math.min(...loads);
  const max = Math.max(...loads);
  const variance = loads.reduce((sum, load) => sum + (load - mean) ** 2, 0) / loads.length;
  const stdDev = Math.sqrt(variance);
  return {
    mean,
    min,
    max,
    maxMinRatio: min > 0 ? max / min : null,
    stdDev,
    coefficientOfVariation: mean > 0 ? stdDev / mean : 0,
  };
}
