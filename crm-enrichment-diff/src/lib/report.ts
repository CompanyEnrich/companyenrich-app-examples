import type { EnrichPath } from './enrich.js';
import type { Action, ChangeType, DiffCell, RecordStatus, RecordSummary } from './types.js';

export const CHANGE_TYPES: ChangeType[] = ['fill', 'conflict', 'same', 'api-missing'];
export const ACTIONS: Action[] = ['update', 'review', 'skip', 'none'];

export const CHANGE_LABELS: Record<ChangeType, string> = {
  fill: 'CRM is empty, the API has a value',
  conflict: 'both have a value and they differ',
  same: 'equal after normalization',
  'api-missing': 'the API has no value',
};

export const ACTION_LABELS: Record<Action, string> = {
  update: 'proposed in patch.csv',
  review: 'needs a human decision in review.html',
  skip: 'protected or not writable',
  none: 'nothing to change',
};

export const STATUS_LABELS: Record<RecordStatus, string> = {
  found: 'enriched',
  'not-found': 'no company found for this domain',
  'invalid-domain': 'the API rejected the domain',
  pending: 'not enriched yet; CompanyEnrich is fetching it, re-run later',
  error: 'enrichment failed',
  'no-domain': 'no usable domain or website in the CRM row',
  'not-enriched': 'not enriched in this run',
};

export interface Counts {
  byChange: Record<ChangeType, number>;
  byAction: Record<Action, number>;
  byColumn: Record<string, { change: Record<ChangeType, number>; action: Record<Action, number> }>;
}

/** The run ledger, written as run.json. */
export interface RunReport {
  runId: string;
  status: 'completed';
  startedAt: string;
  finishedAt: string;
  input: string;
  mappingFile: string;
  rulesFile: string;
  rows: number;
  domains: { unique: number; fromCache: number; enriched: number };
  enrichment: {
    path: EnrichPath | 'cache-only';
    batchId?: string;
    /** A bulk job collected with --batch. Its credits were charged when it ran, not by this run. */
    importedBatch?: { id: string; records: number; creditsCharged: number };
    statuses: Record<string, number>;
  };
  credits: {
    cap: number;
    estimated: number;
    used: number;
    /** Account balance from the free `me()` call. Shared keys make the difference include other spend. */
    balanceBefore?: number;
    balanceAfter?: number;
  };
  counts: Counts;
  records: RecordSummary[];
  outputs: string[];
}

/** `2026-11-11T10:45:03.120Z` -> `20261111-104503` (UTC), used for output folder names. */
export function formatRunId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Written as run.json when enrichment stops partway (timeout, network, out of credits), so the
 * credits already spent are on record and the results already paid for are in the cache.
 */
export interface FailedRun {
  runId: string;
  status: 'failed';
  startedAt: string;
  failedAt: string;
  input: string;
  error: string;
  enrichment: { path: EnrichPath | 'cache-only'; batchId?: string; resultsCached: number };
  credits: { cap: number; estimated: number; used: number; note: string; balanceBefore?: number };
  /** Collects the bulk job into the cache without paying again. */
  resumeCommand?: string;
}

function zeroes<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export function countCells(cells: DiffCell[], columns: string[]): Counts {
  const counts: Counts = { byChange: zeroes(CHANGE_TYPES), byAction: zeroes(ACTIONS), byColumn: {} };
  for (const column of columns) counts.byColumn[column] = { change: zeroes(CHANGE_TYPES), action: zeroes(ACTIONS) };
  for (const cell of cells) {
    counts.byChange[cell.change]++;
    counts.byAction[cell.action]++;
    const column = counts.byColumn[cell.column];
    if (column) {
      column.change[cell.change]++;
      column.action[cell.action]++;
    }
  }
  return counts;
}

/** A Markdown table. Columns whose header is in `numeric` are right-aligned. */
function table(headers: string[], rows: (string | number)[][], numeric: string[]): string {
  const align = headers.map((header) => (numeric.includes(header) ? '---:' : '---'));
  return [headers, align, ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

export function renderSummary(report: RunReport): string {
  const { counts, credits, enrichment, domains } = report;
  const statusText = Object.entries(enrichment.statuses)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  const method =
    enrichment.path === 'bulk' ? `\`companies.bulkEnrichment\` (job ${enrichment.batchId})` : '`companies.enrichBatch`';
  const enrichmentLine =
    enrichment.path === 'cache-only'
      ? `- Enrichment: all ${domains.unique} domains read from the cache, no API call`
      : `- Enrichment: ${domains.enriched} domains looked up with ${method}, ${domains.fromCache} read from the cache`;

  const attention = report.records.filter((record) => record.status !== 'found' || record.duplicateOf.length > 0);
  const attentionLines = attention.map((record) => {
    const problems = [
      record.status === 'found' ? '' : (record.message ?? STATUS_LABELS[record.status]),
      record.duplicateOf.length > 0 ? `same domain as ${record.duplicateOf.join(', ')}` : '',
    ].filter(Boolean);
    return `- ${record.recordId} ${record.company || '(no name)'} (${record.domain || 'no domain'}): ${problems.join('; ')}`;
  });

  return [
    `# Enrichment diff ${report.runId}`,
    '',
    `- Input: \`${report.input}\`, ${report.rows} rows, ${domains.unique} unique domains`,
    enrichmentLine,
    `- Records: ${statusText}`,
    `- Credits used: ${credits.used} (estimate was up to ${credits.estimated}, cap ${credits.cap})`,
    '',
    '## Changes by type',
    '',
    table(
      ['Change', 'Cells', 'Meaning'],
      CHANGE_TYPES.map((change) => [change, counts.byChange[change], CHANGE_LABELS[change]]),
      ['Cells'],
    ),
    '',
    '## Proposed actions',
    '',
    table(
      ['Action', 'Cells', 'Meaning'],
      ACTIONS.map((action) => [action, counts.byAction[action], ACTION_LABELS[action]]),
      ['Cells'],
    ),
    '',
    '## By field',
    '',
    table(
      ['Field', ...CHANGE_TYPES, 'update', 'review', 'skip'],
      Object.entries(counts.byColumn).map(([column, { change, action }]) => [
        column,
        ...CHANGE_TYPES.map((type) => change[type]),
        action.update,
        action.review,
        action.skip,
      ]),
      [...CHANGE_TYPES, 'update', 'review', 'skip'],
    ),
    '',
    '## Records that need attention',
    '',
    attentionLines.length > 0 ? attentionLines.join('\n') : 'None.',
    '',
  ].join('\n');
}
