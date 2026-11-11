// Small display helpers shared by the brief renderer and the observations.

const DEPARTMENT_LABELS: Record<string, string> = {
  cSuite: 'C-suite',
  productManagement: 'Product management',
  engineeringTechnical: 'Engineering',
  design: 'Design',
  education: 'Education',
  finance: 'Finance',
  humanResources: 'HR',
  informationTechnology: 'IT',
  legal: 'Legal',
  marketing: 'Marketing',
  medicalHealth: 'Medical and health',
  operations: 'Operations',
  sales: 'Sales',
  consulting: 'Consulting',
};

/** Workforce department keys (camelCase) to labels, e.g. engineeringTechnical -> Engineering. */
export function departmentLabel(key: string): string {
  return DEPARTMENT_LABELS[key] ?? key;
}

/** 863000000 -> "$863M", 1200000000 -> "$1.2B". */
export function money(amount: number): string {
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (amount >= size) return `$${trimZero((amount / size).toFixed(1))}${suffix}`;
  }
  return `$${amount}`;
}

/** Funding round amounts arrive as "300000000 USD". */
export function roundAmount(amount: string | undefined): string | undefined {
  if (!amount) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([A-Z]{3})?$/.exec(amount.trim());
  if (!match) return amount;
  const value = Number(match[1]);
  return match[2] && match[2] !== 'USD' ? `${money(value).slice(1)} ${match[2]}` : money(value);
}

/** "10m-50m" -> "$10M-$50M", "over-1b" -> "over $1B". */
export function revenueRange(range: string): string {
  const amount = (part: string) => `$${part.toUpperCase()}`;
  const [low, high] = range.split('-');
  if (low === 'under' || low === 'over') return `${low} ${amount(high ?? '')}`;
  return high ? `${amount(low ?? '')}-${amount(high)}` : range;
}

/** "series_f" -> "Series F", "post_ipo_debt" -> "Post-IPO debt", "secondary_market" -> "Secondary market". */
export function fundingStage(stage: string): string {
  const words = stage.split('_');
  if (words[0] === 'series' && words[1]) return `Series ${words[1].toUpperCase()}`;
  const text = words.join(' ').replace(/\bpost ipo\b/, 'post-IPO').replace(/\bipo\b/, 'IPO');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "over-10K" -> "over 10K", "501-1K" stays as is. */
export function employeeRange(range: string): string {
  return range.replace(/^over-/, 'over ');
}

/** The stock symbol often carries its exchange already, e.g. "NASDAQ:DDOG". */
export function listing(symbol: string, exchange: string | undefined): string {
  return symbol.includes(':') || !exchange ? symbol : `${exchange.toUpperCase()}: ${symbol}`;
}

/** 8 -> "8 months ago", 30 -> "2 years ago". */
export function monthsAgo(months: number): string {
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.floor(months / 12)} years ago`;
}

/** "2025-09-30T00:00:00" -> "2025-09-30". */
export function isoDate(value: string): string {
  return value.slice(0, 10);
}

export function percent(ratio: number, signed = false): string {
  const text = `${trimZero((ratio * 100).toFixed(1))}%`;
  return signed && ratio > 0 ? `+${text}` : text;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** 6.6 -> "6.6 years", 0.4 -> "5 months". */
export function tenure(years: number): string {
  if (years < 1) {
    const months = Math.max(1, Math.round(years * 12));
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const rounded = trimZero(years.toFixed(1));
  return `${rounded} year${rounded === '1' ? '' : 's'}`;
}

/** Whole months between two dates. */
export function monthsBetween(from: string, to: Date): number {
  const start = new Date(from);
  return (to.getUTCFullYear() - start.getUTCFullYear()) * 12 + (to.getUTCMonth() - start.getUTCMonth());
}

/** Escapes characters that would break a Markdown table cell. */
export function cell(text: string | number | undefined): string {
  if (text === undefined || text === '') return 'not available';
  return String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, '');
}
