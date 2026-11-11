import { createHash } from 'node:crypto';
import type { Person } from '@companyenrich/sdk';
import { createLimiter } from '../concurrency.js';
import type { NewLeadersConfig, PersonSearchFilter } from '../config.js';
import { CREDITS, searchCharge } from '../credits.js';
import { daysAgo, monthEnd, monthStart, monthsSince } from '../dates.js';
import type { Signal } from '../digest.js';
import { normalizeDomain, websiteUrl } from '../domains.js';
import { formatList, plural } from '../format.js';
import type { NewLeadersState, SeenLeader } from '../state.js';
import type { WatcherContext, WatcherPlan, WatcherRun } from './types.js';

/** Search endpoints return at most 100 results per page. */
const MAX_PAGE_SIZE = 100;
/** Free count calls in flight at once. */
const COUNT_CONCURRENCY = 4;

/** A watched account whose count is higher than the people already reported there. */
interface AccountWithNewPeople {
  domain: string;
  count: number;
  known: number;
}

/** The unit the watcher buys: everyone at one account whose position started in one month. */
interface Slice extends AccountWithNewPeople {
  month: string;
}

/**
 * People at watched accounts whose current position started recently.
 *
 * Position start dates have month precision and profile updates reach the dataset weeks after a
 * move, so the window covers whole months, from `lookbackDays` before the last complete run up to
 * today. Free counts decide what to buy:
 *
 * 1. For each month, count everyone at the watched accounts. If that equals the people already
 *    reported for the month, the month is done.
 * 2. Otherwise split the account list in half and count each half, recursively, until each
 *    slice is one account and one month with new people in it.
 * 3. Buy each slice in full, following the cursor within the run, or leave it untouched for the
 *    next run. People search cannot skip people by id, so a slice is never read partly: a later
 *    run would have to buy the same first page again to get past it.
 */
export async function planNewLeaders(
  ctx: WatcherContext,
  watcher: NewLeadersConfig,
  previous: NewLeadersState | undefined,
): Promise<WatcherPlan> {
  const windowStart = leaderWindowStart(previous?.windowAnchor, watcher.lookbackDays, ctx.now);
  const queryKey = leaderQueryKey(watcher);
  const seen = previous?.seen ?? [];
  // Known counts are only comparable with the free counts when the query has not changed.
  const trustKnown = previous?.queryKey === queryKey;
  const limit = createLimiter(COUNT_CONCURRENCY);

  const countIn = (domains: string[], month: string) =>
    limit(async () => (await ctx.client.people.count({ filter: monthFilter(watcher, domains, month) })).count);
  const knownIn = (domains: string[], month: string) => {
    if (!trustKnown) return 0;
    const accounts = new Set(domains);
    return seen.filter((entry) => entry.startMonth === month && accounts.has(entry.domain)).length;
  };

  const months = monthsSince(windowStart, ctx.now);
  const perMonth = await Promise.all(
    months.map((month) =>
      findAccountsWithNewPeople(
        watcher.domains,
        (domains) => countIn(domains, month),
        (domains) => knownIn(domains, month),
      ),
    ),
  );
  const pending: Slice[] = months.flatMap((month, index) => (perMonth[index] ?? []).map((account) => ({ ...account, month })));
  const chosen = chooseSlices(pending, watcher.maxResultsPerRun);
  const newEstimate = pending.reduce((total, slice) => total + slice.count - slice.known, 0);
  const accountsWithNews = new Set(pending.map((slice) => slice.domain)).size;
  const alreadyReported = seen.filter((entry) => entry.startMonth >= windowStart).length;

  return {
    finding:
      pending.length === 0
        ? `no new people since ${windowStart} (${alreadyReported} already reported)`
        : `${plural(newEstimate, 'new person', 'new people')} at ${plural(accountsWithNews, 'account')} since ${windowStart}`,
    unit: ['person', 'people'],
    unitCost: CREDITS.personResult,
    units: chosen.reduce((total, slice) => total + slice.count, 0),
    // Slices are bought whole, so only grants that cover whole slices are useful.
    fit: (granted) => affordableSlices(chosen, granted).reduce((total, slice) => total + slice.count, 0),
    async execute(granted, checkpoint) {
      const reported = new Set(seen.map((entry) => entry.key));
      const nextSeen: SeenLeader[] = [...seen];
      const signals: Signal[] = [];
      const toBuy = affordableSlices(chosen, granted);
      const leftOver = pending.filter((slice) => !toBuy.includes(slice));
      let creditsCharged = 0;

      const progress = (windowAnchor: string, notes: string[] = []): WatcherRun => {
        const nextWindowStart = leaderWindowStart(windowAnchor, watcher.lookbackDays, ctx.now);
        return {
          signals: [...signals],
          notes,
          creditsCharged,
          nextState: {
            type: 'new-leaders',
            lastRunAt: ctx.now.toISOString(),
            windowAnchor,
            queryKey,
            // People who started before the next window can never match again, so forget them.
            seen: nextSeen.filter((entry) => entry.startMonth >= nextWindowStart),
          },
        };
      };
      // Until every slice with new people is read, the window stays where it is.
      const heldAnchor = previous?.windowAnchor ?? ctx.now.toISOString();

      for (const slice of toBuy) {
        let cursor: string | undefined;
        let read = 0;
        do {
          const page = await ctx.client.people.search({
            filter: monthFilter(watcher, [slice.domain], slice.month),
            pageSize: Math.min(MAX_PAGE_SIZE, slice.count - read),
            ...(cursor && { cursor }),
          });
          creditsCharged += searchCharge(page.items.length, CREDITS.personResult);
          read += page.items.length;

          for (const person of page.items) {
            const role = currentRole(person, slice.domain);
            const key = leaderKey(person.id, role.position);
            if (reported.has(key)) continue;
            reported.add(key);
            // Stored under the month and account searched, so later counts compare like with like.
            nextSeen.push({ key, domain: slice.domain, startMonth: slice.month });
            signals.push(leaderSignal(person, role, slice.domain));
          }
          checkpoint(progress(heldAnchor));
          cursor = page.nextCursor ?? undefined;
        } while (cursor && read < slice.count);
      }

      const notes: string[] = [];
      if (leftOver.length > 0) {
        const where = leftOver.map((slice) => `${slice.domain} (${slice.month.slice(0, 7)})`);
        notes.push(`Left for the next run, nothing bought yet: new people at ${formatList(where)} (maxResultsPerRun or the credit cap).`);
      }
      return progress(leftOver.length === 0 ? ctx.now.toISOString() : heldAnchor, notes);
    },
  };
}

/**
 * Narrows the account list with free counts until each slice is a single account whose count is
 * higher than the people already reported there. Returns them in config order.
 */
export async function findAccountsWithNewPeople(
  domains: string[],
  countIn: (domains: string[]) => Promise<number>,
  knownIn: (domains: string[]) => number,
): Promise<AccountWithNewPeople[]> {
  const count = await countIn(domains);
  const known = knownIn(domains);
  if (count <= known) return [];
  if (domains.length === 1) return [{ domain: domains[0]!, count, known }];

  const middle = Math.ceil(domains.length / 2);
  const halves = await Promise.all([
    findAccountsWithNewPeople(domains.slice(0, middle), countIn, knownIn),
    findAccountsWithNewPeople(domains.slice(middle), countIn, knownIn),
  ]);
  return halves.flat();
}

/**
 * Picks slices, newest month first, until about `maxResults` new people. The first slice is
 * always picked, so one account with many new people cannot block the queue.
 */
function chooseSlices(pending: Slice[], maxResults: number): Slice[] {
  const chosen: Slice[] = [];
  let newPeople = 0;
  for (const slice of pending) {
    const fresh = slice.count - slice.known;
    if (chosen.length > 0 && newPeople + fresh > maxResults) continue;
    chosen.push(slice);
    newPeople += fresh;
  }
  return chosen;
}

/** The slices, in order, that fit in `budget` people when each one is bought whole. */
function affordableSlices(slices: Slice[], budget: number): Slice[] {
  const affordable: Slice[] = [];
  let left = budget;
  for (const slice of slices) {
    if (slice.count > left) continue;
    affordable.push(slice);
    left -= slice.count;
  }
  return affordable;
}

/** First month to check: `lookbackDays` before the last complete run, or before now on the first run. */
export function leaderWindowStart(anchor: string | undefined, lookbackDays: number, now: Date): string {
  return monthStart(daysAgo(anchor ? new Date(anchor) : now, lookbackDays));
}

export function leaderKey(personId: number, position: string): string {
  return `${personId}:${position.trim().toLowerCase()}`;
}

export function leaderQueryKey(watcher: NewLeadersConfig): string {
  const canonical = JSON.stringify([
    [...watcher.domains].sort(),
    [...(watcher.seniority ?? [])].sort(),
    [...(watcher.department ?? [])].sort(),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function monthFilter(watcher: NewLeadersConfig, domains: string[], month: string): PersonSearchFilter {
  return {
    domain: domains,
    ...(watcher.seniority && { seniority: watcher.seniority }),
    ...(watcher.department && { department: watcher.department as PersonSearchFilter['department'] }),
    currentPositionStartDate: { after: month, before: monthEnd(month) },
  };
}

interface Role {
  position: string;
  companyName: string;
  startMonth: string | null;
}

/** The current role that matched the search at `domain`. */
function currentRole(person: Person, domain: string): Role {
  const current = person.experiences.filter((entry) => entry.isCurrent);
  const experience =
    current.find((entry) => entry.isMatched) ??
    current.find((entry) => entry.company?.domain && normalizeDomain(entry.company.domain) === domain) ??
    current[0];
  return {
    position: experience?.position ?? person.position ?? 'New role',
    companyName: experience?.company?.name ?? domain,
    startMonth: experience?.startDate ? `${experience.startDate.slice(0, 7)}-01` : null,
  };
}

function leaderSignal(person: Person, role: Role, domain: string): Signal {
  const started = role.startMonth ? `, started ${role.startMonth.slice(0, 7)}` : '';
  const linkedinUrl = person.socials.linkedinUrl;
  return {
    title: person.name ?? 'Unnamed person',
    domain,
    summary: `${role.position} at ${role.companyName} (${domain})${started}`,
    details: [],
    link: linkedinUrl ? { label: 'LinkedIn', url: linkedinUrl } : { label: domain, url: websiteUrl(domain) },
  };
}
