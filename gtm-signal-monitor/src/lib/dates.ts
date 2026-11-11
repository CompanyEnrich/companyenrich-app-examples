const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-11" for a Date, in UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** First day of the date's month, as "YYYY-MM-01" (UTC). */
export function monthStart(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

/** Last day of the month that starts on `start` ("YYYY-MM-01"). */
export function monthEnd(start: string): string {
  const [year, month] = start.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one.
  return isoDate(new Date(Date.UTC(year, month, 0)));
}

/** Every month start from `firstMonth` up to and including the month of `now`, newest first. */
export function monthsSince(firstMonth: string, now: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(`${firstMonth}T00:00:00Z`);
  const last = monthStart(now);
  while (isoDate(cursor) <= last) {
    months.push(isoDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months.reverse();
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export function daysBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / DAY_MS;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
