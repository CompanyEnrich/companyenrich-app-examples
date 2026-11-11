import type { Logger, webApi } from '@slack/bolt';
import type { GtmAgent } from '../lib/agent.js';
import type { Approvals } from '../lib/approvals.js';
import { MAX_INLINE_ROWS } from '../lib/blocks.js';
import { COMPANY_COLUMNS, PERSON_COLUMNS, toCsv } from '../lib/csv.js';
import type { Rows } from '../lib/rows.js';
import type { Toolbox } from '../lib/toolbox.js';

export interface BotServices {
  toolbox: Toolbox;
  approvals: Approvals;
  /** Undefined when ANTHROPIC_API_KEY is not set. */
  agent?: GtmAgent;
}

/**
 * Slack needs an answer within 3 seconds, so listeners acknowledge first and run the
 * slow part (API calls, waiting for an approval) here. `idle()` lets tests and the
 * local simulator wait for that work to finish.
 */
export class BackgroundWork {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly logger: Logger) {}

  run(task: () => Promise<void>): void {
    const promise: Promise<void> = task()
      .catch((error: unknown) => this.logger.error(error))
      .finally(() => this.running.delete(promise));
    this.running.add(promise);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}

export interface CsvFile {
  filename: string;
  title: string;
  content: string;
}

/** A CSV for each table too long to show inline. */
export function csvFilesFor(rows: Rows, baseName: string): CsvFile[] {
  const files: CsvFile[] = [];
  if (rows.companies.length > MAX_INLINE_ROWS) {
    files.push({ filename: `${baseName}-companies.csv`, title: `Companies (${rows.companies.length})`, content: toCsv(rows.companies, COMPANY_COLUMNS) });
  }
  if (rows.people.length > MAX_INLINE_ROWS) {
    files.push({ filename: `${baseName}-people.csv`, title: `People (${rows.people.length})`, content: toCsv(rows.people, PERSON_COLUMNS) });
  }
  return files;
}

export async function uploadCsv(
  client: webApi.WebClient,
  file: CsvFile,
  target: { channelId: string; threadTs?: string },
): Promise<void> {
  const upload = { channel_id: target.channelId, file: Buffer.from(file.content, 'utf8'), filename: file.filename, title: file.title };
  if (target.threadTs) await client.files.uploadV2({ ...upload, thread_ts: target.threadTs });
  else await client.files.uploadV2(upload);
}
