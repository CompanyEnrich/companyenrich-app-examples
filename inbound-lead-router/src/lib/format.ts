// Small display helpers shared by the trace, the Slack alert, the CLI and the UI.

/** "series_f" -> "Series F", "post_ipo_debt" -> "Post-IPO debt". */
export function fundingStageLabel(stage: string): string {
  const words = stage.split('_');
  if (words[0] === 'series' && words[1]) return `Series ${words[1].toUpperCase()}`;
  const text = words.join(' ').replace(/\bpost ipo\b/, 'post-IPO').replace(/\bipo\b/, 'IPO');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 863000000 -> "$863M". */
export function formatUsd(amount: number): string {
  if (amount >= 1e9) return `$${trim(amount / 1e9)}B`;
  if (amount >= 1e6) return `$${trim(amount / 1e6)}M`;
  if (amount >= 1e3) return `$${trim(amount / 1e3)}K`;
  return `$${amount}`;
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

/** Whole months from `isoDate` to `now`, never negative. */
export function monthsSince(isoDate: string, now: Date): number | null {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  let months = (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + (now.getUTCMonth() - date.getUTCMonth());
  if (now.getUTCDate() < date.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
