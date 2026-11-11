const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CHECK_EVERY_DAYS = 30;

/**
 * A champion is due once `checkEveryDays` have passed since their last check, less a 10% grace
 * window. Without it, a job scheduled on the 1st of every month would skip everyone after
 * February's 28 days when checking every 30 days.
 */
export function isDue(lastCheckedAt: string, now: Date, checkEveryDays: number): boolean {
  const last = Date.parse(lastCheckedAt);
  if (Number.isNaN(last)) return true;
  const graceDays = Math.ceil(checkEveryDays * 0.1);
  return now.getTime() >= last + (checkEveryDays - graceDays) * DAY_MS;
}

/**
 * Due champions: anyone left over from an earlier capped or failed run first, then the longest-waiting.
 */
export function dueChampions<T extends { lastCheckedAt: string; pendingCheck?: boolean }>(champions: T[], now: Date, checkEveryDays: number): T[] {
  return champions
    .filter((champion) => champion.pendingCheck || isDue(champion.lastCheckedAt, now, checkEveryDays))
    .sort((a, b) => Number(Boolean(b.pendingCheck)) - Number(Boolean(a.pendingCheck)) || a.lastCheckedAt.localeCompare(b.lastCheckedAt));
}
