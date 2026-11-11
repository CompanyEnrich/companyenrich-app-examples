import type { AccountChangesConfig } from '../config.js';
import { CREDITS } from '../credits.js';
import { addDays, daysBetween, isoDate } from '../dates.js';
import type { Signal } from '../digest.js';
import { normalizeDomain, websiteUrl } from '../domains.js';
import { formatList, plural } from '../format.js';
import { type CompanySnapshot, diffSnapshots, toSnapshot } from '../snapshot.js';
import type { AccountChangesState } from '../state.js';
import type { WatcherContext, WatcherPlan, WatcherRun } from './types.js';

/** `companies.enrichBatch` accepts up to 50 domains per request. */
const BATCH_SIZE = 50;

/**
 * Re-enriches watched accounts and compares them with the stored snapshot.
 * Each refresh is a paid enrichment, so the cost is controlled by refreshing each account at
 * most every `refreshEveryDays`.
 */
export async function planAccountChanges(
  ctx: WatcherContext,
  watcher: AccountChangesConfig,
  previous: AccountChangesState | undefined,
): Promise<WatcherPlan> {
  const due = dueDomains(watcher, previous, ctx.now);
  const unitCost = CREDITS.companyEnrichment + watcher.expand.length * CREDITS.expansion;
  const nextRefresh = nextRefreshDate(watcher, previous);

  return {
    finding:
      due.length === 0
        ? `all ${plural(watcher.domains.length, 'account')} are fresh; next refresh ${nextRefresh}`
        : `${due.length} of ${plural(watcher.domains.length, 'account')} due for a refresh`,
    unit: ['account', 'accounts'],
    unitCost,
    units: due.length,
    async execute(granted, checkpoint) {
      const snapshots: Record<string, CompanySnapshot> = {};
      for (const domain of watcher.domains) {
        const stored = previous?.snapshots[domain];
        if (stored) snapshots[domain] = stored;
      }

      const signals: Signal[] = [];
      const missing: string[] = [];
      let found = 0;
      let baselines = 0;
      const progress = (notes: string[] = []): WatcherRun => ({
        signals: [...signals],
        notes,
        creditsCharged: found * unitCost,
        nextState: { type: 'account-changes', lastRunAt: ctx.now.toISOString(), snapshots: { ...snapshots } },
      });

      const batch = due.slice(0, granted);
      for (let start = 0; start < batch.length; start += BATCH_SIZE) {
        const domains = batch.slice(start, start + BATCH_SIZE);
        const { items } = await ctx.client.companies.enrichBatch({
          domains,
          ...(watcher.expand.length > 0 && { expand: watcher.expand }),
        });

        for (const item of items) {
          const domain = normalizeDomain(item.domain);
          if (item.status !== 'found' || !item.company) {
            missing.push(`${domain} (${item.status})`);
            continue;
          }
          found += 1;
          const before = snapshots[domain];
          const after = toSnapshot(item.company, watcher.expand, ctx.now.toISOString());
          snapshots[domain] = after;
          if (!before) {
            baselines += 1;
            continue;
          }
          const changes = diffSnapshots(before, after, { headcountChangePct: watcher.headcountChangePct });
          if (changes.length > 0) {
            signals.push({
              title: after.name,
              domain,
              summary: `${plural(changes.length, 'change')} since ${before.capturedAt.slice(0, 10)}`,
              details: changes,
              link: { label: domain, url: websiteUrl(domain) },
            });
          }
        }
        checkpoint(progress());
      }

      const notes: string[] = [];
      if (baselines > 0) {
        notes.push(`Baseline recorded for ${plural(baselines, 'account')}. Changes show up from the next refresh.`);
      }
      const unchanged = found - baselines - signals.length;
      if (unchanged > 0) notes.push(`${plural(unchanged, 'account')} refreshed with no changes.`);
      if (missing.length > 0) notes.push(`No company data for ${formatList(missing)}; retried next run.`);
      if (granted < due.length) {
        notes.push(`${plural(due.length - granted, 'account')} carried to the next run by the credit cap.`);
      }
      if (due.length === 0) notes.push(`All accounts were refreshed recently. Next refresh ${nextRefresh}.`);

      return progress(notes);
    },
  };
}

/** Domains with no snapshot yet, or whose snapshot is at least `refreshEveryDays` old. */
export function dueDomains(watcher: AccountChangesConfig, previous: AccountChangesState | undefined, now: Date): string[] {
  return watcher.domains.filter((domain) => {
    const snapshot = previous?.snapshots[domain];
    return !snapshot || daysBetween(new Date(snapshot.capturedAt), now) >= watcher.refreshEveryDays;
  });
}

function nextRefreshDate(watcher: AccountChangesConfig, previous: AccountChangesState | undefined): string {
  const captured = watcher.domains
    .map((domain) => previous?.snapshots[domain]?.capturedAt)
    .filter((value): value is string => !!value)
    .sort();
  const oldest = captured[0];
  return oldest ? isoDate(addDays(new Date(oldest), watcher.refreshEveryDays)) : 'now';
}
