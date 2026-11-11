import type { Person } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { type NewLeadersConfig, parseConfig } from '../src/lib/config.js';
import { monthEnd, monthsSince } from '../src/lib/dates.js';
import type { NewLeadersState } from '../src/lib/state.js';
import {
  findAccountsWithNewPeople,
  leaderKey,
  leaderQueryKey,
  leaderWindowStart,
  planNewLeaders,
} from '../src/lib/watchers/new-leaders.js';
import type { WatcherRun } from '../src/lib/watchers/types.js';
import { createFakeApi, fakePerson, ignoreProgress } from './helpers/fake-api.js';

const NOW = new Date('2026-11-11T08:00:00Z');
const LATER = new Date('2026-11-18T08:00:00Z');

function leadersWatcher(domains = '[stripe.com, notion.so, figma.com]', extra = ''): NewLeadersConfig {
  return parseConfig(`
watchers:
  - id: leaders
    type: new-leaders
    domains: ${domains}
    seniority: [vp, c-suite]
    department: [sales]
    maxResultsPerRun: 5
${extra}`).watchers[0] as NewLeadersConfig;
}

/** Fake people endpoints that honour the domain and start-date filters, page size and cursor. */
function peopleApi(people: Person[]) {
  const matching = (body: any) =>
    people.filter((person) => {
      const role = person.experiences[0]!;
      const { after, before } = body.filter.currentPositionStartDate;
      return body.filter.domain.includes(role.company!.domain) && role.startDate! >= after && role.startDate! <= before;
    });
  return createFakeApi({
    'POST /v2/people/search/count': (body) => ({ count: matching(body).length, total: matching(body).length }),
    'POST /v2/people/search': (body) => {
      const all = matching(body);
      const offset = body.cursor ? Number(body.cursor) : 0;
      const items = all.slice(offset, offset + body.pageSize);
      const next = offset + items.length;
      return { items, ...(next < all.length && { nextCursor: String(next) }) };
    },
  });
}

const searchedDomains = (api: ReturnType<typeof peopleApi>) =>
  api.callsTo('POST /v2/people/search').map((call) => call.body.filter.domain);

async function runOnce(api: ReturnType<typeof peopleApi>, watcher: NewLeadersConfig, previous?: NewLeadersState, now = NOW, grant?: number) {
  const plan = await planNewLeaders({ client: api.client, now }, watcher, previous);
  const run = await plan.execute(grant ?? plan.units, ignoreProgress);
  return { plan, run, state: run.nextState as NewLeadersState };
}

describe('new-leaders date window', () => {
  it('starts lookbackDays before now on the first run, at the start of that month', () => {
    expect(leaderWindowStart(undefined, 30, NOW)).toBe('2026-10-01');
    expect(leaderWindowStart(undefined, 7, NOW)).toBe('2026-11-01');
  });

  it('starts lookbackDays before the last complete run on later runs', () => {
    expect(leaderWindowStart('2026-11-20T00:00:00Z', 7, new Date('2026-12-15T00:00:00Z'))).toBe('2026-11-01');
    expect(leaderWindowStart('2027-01-05T00:00:00Z', 30, new Date('2027-01-12T00:00:00Z'))).toBe('2026-12-01');
  });

  it('counts each month in the window once, with the watcher filters', async () => {
    const api = peopleApi([]);
    await planNewLeaders({ client: api.client, now: NOW }, leadersWatcher(), undefined);
    const filter = { domain: ['stripe.com', 'notion.so', 'figma.com'], seniority: ['vp', 'c-suite'], department: ['sales'] };
    expect(api.callsTo('POST /v2/people/search/count').map((call) => call.body.filter)).toEqual([
      { ...filter, currentPositionStartDate: { after: '2026-11-01', before: '2026-11-30' } },
      { ...filter, currentPositionStartDate: { after: '2026-10-01', before: '2026-10-31' } },
    ]);
  });

  it('lists the months in the window newest first, with inclusive month ends', () => {
    expect(monthsSince('2026-09-01', NOW)).toEqual(['2026-11-01', '2026-10-01', '2026-09-01']);
    expect(monthEnd('2026-02-01')).toBe('2026-02-28');
    expect(monthEnd('2028-02-01')).toBe('2028-02-29');
  });
});

describe('findAccountsWithNewPeople', () => {
  const counts: Record<string, number> = { a: 0, b: 2, c: 0, d: 1, e: 0 };
  const sum = (domains: string[], table: Record<string, number>) =>
    domains.reduce((total, domain) => total + (table[domain] ?? 0), 0);
  const find = async (known: Record<string, number>) => {
    const counted: string[][] = [];
    const accounts = await findAccountsWithNewPeople(
      ['a', 'b', 'c', 'd', 'e'],
      async (domains) => {
        counted.push(domains);
        return sum(domains, counts);
      },
      (domains) => sum(domains, known),
    );
    return { accounts, counted };
  };

  it('bisects the account list with free counts down to the accounts with new people', async () => {
    const { accounts } = await find({ b: 1 });
    expect(accounts).toEqual([
      { domain: 'b', count: 2, known: 1 },
      { domain: 'd', count: 1, known: 0 },
    ]);
  });

  it('does not split a slice whose count matches what is already known', async () => {
    const { accounts, counted } = await find({ b: 2 });
    expect(accounts).toEqual([{ domain: 'd', count: 1, known: 0 }]);
    expect(counted).toEqual([['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], ['d', 'e'], ['d'], ['e']]);
  });
});

describe('new-leaders watcher', () => {
  const people = () => [
    fakePerson(1, 'stripe.com', 'VP Sales', '2026-10-01'),
    fakePerson(2, 'notion.so', 'Chief Revenue Officer', '2026-10-01'),
    fakePerson(3, 'notion.so', 'VP Sales EMEA', '2026-11-01'),
  ];

  it('reads each account with new people in full and records who was reported', async () => {
    const api = peopleApi(people());
    const { plan, run, state } = await runOnce(api, leadersWatcher());

    expect(plan.finding).toBe('3 new people at 2 accounts since 2026-10-01');
    // One search per account and month with new people, newest month first.
    expect(api.callsTo('POST /v2/people/search').map((call) => [call.body.filter.domain, call.body.filter.currentPositionStartDate.after])).toEqual([
      [['notion.so'], '2026-11-01'],
      [['stripe.com'], '2026-10-01'],
      [['notion.so'], '2026-10-01'],
    ]);
    expect(run.signals.map((signal) => signal.summary)).toEqual([
      'VP Sales EMEA at notion.so (notion.so), started 2026-11',
      'VP Sales at stripe.com (stripe.com), started 2026-10',
      'Chief Revenue Officer at notion.so (notion.so), started 2026-10',
    ]);
    expect(run.creditsCharged).toBe(6);
    expect(state.windowAnchor).toBe(NOW.toISOString());
    expect(state.seen).toContainEqual({ key: leaderKey(1, 'VP Sales'), domain: 'stripe.com', startMonth: '2026-10-01' });
  });

  it('spends nothing when the window count matches the people already reported', async () => {
    const api = peopleApi(people());
    const first = await runOnce(api, leadersWatcher());
    const countsBefore = api.callsTo('POST /v2/people/search/count').length;

    const second = await runOnce(api, leadersWatcher(), first.state, LATER);
    expect(second.plan.units).toBe(0);
    expect(second.plan.finding).toBe('no new people since 2026-10-01 (3 already reported)');
    expect(api.callsTo('POST /v2/people/search/count').length - countsBefore).toBe(2); // one per month
    expect(api.callsTo('POST /v2/people/search')).toHaveLength(3);
  });

  it('reads only the account that changed and drops people already reported', async () => {
    const list = people();
    const api = peopleApi(list);
    const first = await runOnce(api, leadersWatcher());

    list.push(fakePerson(4, 'notion.so', 'VP Marketing', '2026-11-01'));
    const second = await runOnce(api, leadersWatcher(), first.state, LATER);

    expect(searchedDomains(api).slice(3)).toEqual([['notion.so']]);
    expect(second.plan.units).toBe(2); // 1 already reported + 1 new: search cannot skip people by id
    expect(second.run.signals.map((signal) => signal.title)).toEqual(['Person 4']);
    expect(second.run.creditsCharged).toBe(4);
  });

  it('carries accounts it cannot afford to the next run without buying anything twice', async () => {
    const api = peopleApi([
      fakePerson(1, 'stripe.com', 'VP Sales', '2026-10-01'),
      fakePerson(2, 'notion.so', 'Chief Revenue Officer', '2026-10-01'),
      fakePerson(3, 'notion.so', 'VP Sales EMEA', '2026-10-01'),
    ]);
    const watcher = leadersWatcher();

    const first = await runOnce(api, watcher, undefined, NOW, 1);
    expect(first.run.signals.map((signal) => signal.title)).toEqual(['Person 1']);
    expect(first.run.notes).toEqual([
      'Left for the next run, nothing bought yet: new people at notion.so (2026-10) (maxResultsPerRun or the credit cap).',
    ]);
    expect(first.state.windowAnchor).toBe(NOW.toISOString());

    // One person per run is not enough for notion.so (2 people), so it is left alone, not half-read.
    const second = await runOnce(api, watcher, first.state, LATER, 1);
    expect(second.plan.fit?.(1)).toBe(0); // so the credit plan defers it instead of granting 1
    expect(second.run.creditsCharged).toBe(0);

    const third = await runOnce(api, watcher, second.state, new Date('2026-11-19T08:00:00Z'), 2);
    expect(third.run.signals.map((signal) => signal.title)).toEqual(['Person 2', 'Person 3']);
    expect(searchedDomains(api)).toEqual([['stripe.com'], ['notion.so']]);
    expect(third.state.windowAnchor).toBe('2026-11-19T08:00:00.000Z');
  });

  it('pages through an account with more than 100 new people using the cursor', async () => {
    const many = Array.from({ length: 150 }, (_, index) => fakePerson(100 + index, 'stripe.com', `VP ${index}`, '2026-10-01'));
    const api = peopleApi(many);
    const { run } = await runOnce(api, leadersWatcher('[stripe.com]'));

    expect(api.callsTo('POST /v2/people/search').map((call) => [call.body.pageSize, call.body.cursor])).toEqual([
      [100, undefined],
      [50, '100'],
    ]);
    expect(run.signals).toHaveLength(150);
    expect(run.creditsCharged).toBe(300);
  });

  it('limits a run to about maxResultsPerRun new people, but always reads one slice', async () => {
    const watcher = { ...leadersWatcher(), maxResultsPerRun: 1 };
    const { plan, run } = await runOnce(peopleApi(people()), watcher);
    expect(plan.units).toBe(1);
    expect(run.notes[0]).toContain('stripe.com (2026-10), notion.so (2026-10)');

    const twoInOneSlice = peopleApi([
      fakePerson(1, 'stripe.com', 'VP Sales', '2026-11-01'),
      fakePerson(2, 'stripe.com', 'VP Product', '2026-11-01'),
    ]);
    const bigPlan = await planNewLeaders({ client: twoInOneSlice.client, now: NOW }, watcher, undefined);
    expect(bigPlan.units).toBe(2);
  });

  it('reports a promotion: same person, new position', async () => {
    const api = peopleApi([fakePerson(1, 'stripe.com', 'Chief Revenue Officer', '2026-11-01')]);
    const previous: NewLeadersState = {
      type: 'new-leaders',
      lastRunAt: '2026-11-04T00:00:00Z',
      windowAnchor: '2026-11-04T00:00:00Z',
      queryKey: leaderQueryKey(leadersWatcher()),
      seen: [{ key: leaderKey(1, 'VP Sales'), domain: 'stripe.com', startMonth: '2026-10-01' }],
    };
    const { run } = await runOnce(api, leadersWatcher(), previous);
    expect(run.signals.map((signal) => signal.summary)).toEqual(['Chief Revenue Officer at stripe.com (stripe.com), started 2026-11']);
  });

  it('does not trust known counts after the query changes, and still dedupes', async () => {
    const api = peopleApi(people());
    const first = await runOnce(api, leadersWatcher());
    const widened: NewLeadersConfig = { ...leadersWatcher(), seniority: undefined };
    const second = await runOnce(api, widened, first.state, LATER);
    expect(second.plan.units).toBe(3);
    expect(second.run.signals).toEqual([]);
  });

  it('forgets people who started before the next window', async () => {
    const api = peopleApi([fakePerson(1, 'stripe.com', 'VP Sales', '2026-09-01')]);
    const watcher = leadersWatcher('[stripe.com]', '    lookbackDays: 60');
    const first = await runOnce(api, watcher);
    expect(first.state.seen).toHaveLength(1);

    const second = await runOnce(api, watcher, first.state, new Date('2026-12-20T00:00:00Z'));
    expect(second.state.seen).toEqual([]);
  });

  it('checkpoints after every paid page with the spend so far', async () => {
    const api = peopleApi(people());
    const plan = await planNewLeaders({ client: api.client, now: NOW }, leadersWatcher(), undefined);
    const checkpoints: WatcherRun[] = [];
    await plan.execute(plan.units, (progress) => checkpoints.push(progress));

    expect(checkpoints.map((progress) => [progress.signals.length, progress.creditsCharged])).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ]);
    // Mid-run checkpoints keep the window where it was, so an interruption loses nothing.
    expect((checkpoints[0]?.nextState as NewLeadersState).seen).toHaveLength(1);
  });
});
