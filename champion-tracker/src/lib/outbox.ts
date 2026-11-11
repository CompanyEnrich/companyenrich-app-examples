import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckReport } from './check.js';
import { renderDigest } from './digest.js';
import { buildSlackPayload, postToSlack } from './slack.js';

export type Channel = 'file' | 'slack';

/**
 * A digest waiting to be delivered. It is saved in state in the same write that advances the
 * baselines, so an alert can never be marked as seen without also being kept for delivery.
 */
export interface OutboxEntry {
  /** Fixed when the report is created, so a retry rewrites the same file. */
  fileName: string;
  report: CheckReport;
  /** Deliveries still to do. The entry leaves the outbox once this is empty. */
  undelivered: Channel[];
}

export interface DeliveryOptions {
  outputDir: string;
  slackWebhookUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  log: (line: string) => void;
}

export function newOutboxEntry(report: CheckReport, outbox: OutboxEntry[], options: DeliveryOptions): OutboxEntry {
  const newsworthy = report.alerts.length > 0 || report.problems.length > 0 || Boolean(report.stoppedBy);
  if (!options.slackWebhookUrl) options.log('SLACK_WEBHOOK_URL is not set, so nothing will be posted to Slack.');
  else if (!newsworthy) options.log('No changes, so nothing will be posted to Slack.');
  return {
    fileName: uniqueFileName(report.date, outbox, options.outputDir),
    report,
    undelivered: options.slackWebhookUrl && newsworthy ? ['file', 'slack'] : ['file'],
  };
}

/** Delivers what is still undelivered for one entry. Returns the errors; the entry keeps what failed. */
export async function deliver(entry: OutboxEntry, options: DeliveryOptions): Promise<string[]> {
  const errors: string[] = [];
  const digestPath = join(options.outputDir, entry.fileName);

  if (entry.undelivered.includes('file')) {
    try {
      mkdirSync(options.outputDir, { recursive: true });
      writeFileSync(digestPath, renderDigest(entry.report));
      entry.undelivered = entry.undelivered.filter((channel) => channel !== 'file');
      options.log(`Wrote ${digestPath}.`);
    } catch (error) {
      errors.push(`Could not write ${digestPath}: ${message(error)}`);
    }
  }

  if (entry.undelivered.includes('slack')) {
    if (!options.slackWebhookUrl) {
      options.log(`SLACK_WEBHOOK_URL is no longer set, so the digest from ${entry.report.date} will not be posted to Slack.`);
      entry.undelivered = entry.undelivered.filter((channel) => channel !== 'slack');
    } else {
      try {
        await postToSlack(options.slackWebhookUrl, buildSlackPayload(entry.report, digestPath), options.fetch ?? fetch);
        entry.undelivered = entry.undelivered.filter((channel) => channel !== 'slack');
        options.log(`Posted the digest from ${entry.report.date} to Slack.`);
      } catch (error) {
        errors.push(`Slack post failed: ${message(error)}`);
      }
    }
  }

  if (errors.length > 0) options.log(`${errors.join('\n')}\nThe digest stays in the outbox and is delivered again on the next run.`);
  return errors;
}

/** "digest-2026-11-11.md", or "digest-2026-11-11-2.md" for a second run on the same day. */
function uniqueFileName(date: string, outbox: OutboxEntry[], outputDir: string): string {
  for (let run = 1; ; run++) {
    const name = run === 1 ? `digest-${date}.md` : `digest-${date}-${run}.md`;
    if (!outbox.some((entry) => entry.fileName === name) && !existsSync(join(outputDir, name))) return name;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
