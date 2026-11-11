/** 12_500_000 -> "$12.5M" */
export function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'unknown';
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(amount) >= size) return `$${trimZero((amount / size).toFixed(1))}${suffix}`;
  }
  return `$${amount}`;
}

/** "series_a" -> "Series A", "post_ipo_equity" -> "Post IPO equity". */
export function formatStage(stage: string | null | undefined): string | undefined {
  if (!stage) return undefined;
  const words = stage
    .toLowerCase()
    .split(/[_\s-]+/)
    .map((word) => (word.length === 1 || word === 'ipo' ? word.toUpperCase() : word));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a, b, c and 4 more" */
export function formatList(items: readonly string[], max = 8): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}
