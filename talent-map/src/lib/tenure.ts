// Date math for "time at current company". Profile dates have month precision, so whole months are
// the unit throughout, and all calculations use UTC so the result does not depend on the machine's zone.

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Subtracts whole months, clamping the day so 31 March minus one month is 28 or 29 February. */
export function subtractMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

/**
 * The `currentCompanyStartDate.before` value for a minimum tenure: people who joined on or before
 * this date have been at their company at least `years` years. Fractions round to whole months.
 */
export function tenureCutoff(now: Date, years: number): string {
  return isoDate(subtractMonths(now, Math.round(years * 12)));
}

export function yearsSince(startDate: string, now: Date): number {
  const start = Date.parse(startDate);
  if (Number.isNaN(start)) return Number.NaN;
  return Math.max(0, (now.getTime() - start) / MS_PER_DAY / DAYS_PER_YEAR);
}

/** "3 yr 4 mo", "11 mo", "under 1 mo". */
export function formatTenure(years: number): string {
  const months = Math.floor(years * 12 + 1e-9);
  if (months < 1) return 'under 1 mo';
  const whole = Math.floor(months / 12);
  const rest = months % 12;
  if (whole === 0) return `${rest} mo`;
  return rest === 0 ? `${whole} yr` : `${whole} yr ${rest} mo`;
}
