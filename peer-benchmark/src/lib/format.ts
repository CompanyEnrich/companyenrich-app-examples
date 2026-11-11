// Formatting shared by the insight sentences and the UI, so both always agree.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2025-12-01' -> 'Dec 2025'. Parsed by hand so server and browser never disagree on time zones. */
export function formatMonth(date: string): string {
  const [year, month] = date.split('-');
  const name = MONTHS[Number(month) - 1];
  return name && year ? `${name} ${year}` : date;
}

/** 0.0821 -> '8.2%', 0.17 -> '17%'. One decimal below 10% where it matters. */
export function formatShare(share: number): string {
  const percent = share * 100;
  if (percent === 0) return '0%';
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** Signed: 0.218 -> '+22%', -0.05 -> '-5%', 0.004 -> '+0.4%', 0 -> '0%'. */
export function formatGrowth(rate: number): string {
  const percent = rate * 100;
  if (percent === 0) return '0%';
  const magnitude = Math.abs(percent) < 1 ? Math.abs(percent).toFixed(1) : String(Math.round(Math.abs(percent)));
  if (magnitude === '0.0') return '0%';
  return `${percent > 0 ? '+' : '-'}${magnitude}%`;
}

/** Unsigned magnitude for sentences that already say "grew" or "shrank". */
export function formatChange(rate: number): string {
  return formatGrowth(Math.abs(rate)).replace('+', '');
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}×`;
}

export function formatCount(count: number): string {
  return Math.round(count).toLocaleString('en-US');
}

export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}
