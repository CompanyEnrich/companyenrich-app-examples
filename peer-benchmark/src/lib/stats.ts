/** Median of a list, or null for an empty list. Does not mutate the input. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface PercentileRank {
  /** Peers with a strictly lower value. */
  below: number;
  /** Peers with exactly the same value. */
  tied: number;
  /** Peers compared. */
  total: number;
  /** 0-100: the share of peers below, counting ties as half. */
  percentile: number;
}

/**
 * Where `value` sits among `others`. With 8 peers or fewer a percentile is coarse,
 * so the counts are kept for sentences like "above 6 of 8 peers".
 */
export function percentileRank(value: number, others: readonly number[]): PercentileRank | null {
  if (others.length === 0) return null;
  const below = others.filter((other) => other < value).length;
  const tied = others.filter((other) => other === value).length;
  const percentile = Math.round(((below + tied / 2) / others.length) * 100);
  return { below, tied, total: others.length, percentile };
}
