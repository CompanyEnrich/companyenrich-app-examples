/**
 * Heatmap shading. Market segments differ by orders of magnitude, so cells are
 * binned on a log scale into a one-hue sequential ramp. Level 0 is reserved for
 * empty cells; levels 1..HEAT_LEVELS run from fewest to most companies.
 */
export const HEAT_LEVELS = 6;

export function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const position = Math.log10(count + 1) / Math.log10(max + 1);
  return Math.min(HEAT_LEVELS, Math.max(1, Math.ceil(position * HEAT_LEVELS)));
}

export interface LegendStep {
  level: number;
  /** Smallest count that lands in this level. */
  from: number;
}

/** The lower bound of each level, for the scale legend. */
export function heatLegend(max: number): LegendStep[] {
  if (max <= 0) return [];
  const steps: LegendStep[] = [];
  for (let level = 1; level <= HEAT_LEVELS; level++) {
    // Smallest integer n with ceil(log(n+1)/log(max+1) * L) >= level.
    const from = Math.max(1, Math.floor(Math.pow(max + 1, (level - 1) / HEAT_LEVELS)));
    let n = from;
    while (heatLevel(n, max) < level && n < max) n++;
    if (heatLevel(n, max) === level && !steps.some((s) => s.from === n)) steps.push({ level, from: n });
  }
  return steps;
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
