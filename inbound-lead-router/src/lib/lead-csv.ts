import { itemLookup, planBatch, type BatchLookup, type BatchPlan, type BatchRun, type PlannedItem } from './batch';
import type { RoutingConfig } from './config';
import { parseCsvRecords, toCsv } from './csv';
import type { CompanyCache } from './enrich';
import { evaluateCompany, type Evaluation } from './evaluate';
import type { PipelineConfig } from './pipeline';
import { requiredExpansions } from './score';

// The CSV side of `npm run score`: find the email column, plan the paid
// lookups, and turn results into output rows. No I/O here; the CLI does that.

export interface LeadCsvPlan {
  header: string[];
  emailColumn: string;
  records: Record<string, string>[];
  plan: BatchPlan;
}

export const OUTPUT_COLUMNS = ['domain', 'status', 'company', 'industry', 'employees', 'country', 'score', 'tier', 'route_rule', 'team', 'owner', 'factors', 'enriched_from'];

export function findEmailColumn(header: string[]): string | null {
  const normalized = header.map((name) => name.trim().toLowerCase());
  const exact = normalized.findIndex((name) => name === 'email' || name === 'e-mail');
  const index = exact >= 0 ? exact : normalized.findIndex((name) => name.includes('email'));
  return index >= 0 ? (header[index] ?? null) : null;
}

export function planLeadCsv(text: string, cache: CompanyCache, config: PipelineConfig, maxCredits: number): LeadCsvPlan {
  const { header, records } = parseCsvRecords(text);
  const emailColumn = findEmailColumn(header);
  if (!emailColumn) throw new Error(`No email column found. Columns: ${header.join(', ') || '(none)'}`);
  const emails = records.map((record) => record[emailColumn]?.trim() ?? '');
  // Only addresses count as input here; a bare domain in the email column is invalid.
  const inputs = emails.map((email) => (email.includes('@') ? email : ''));
  const plan = planBatch(inputs, cache, requiredExpansions(config.scoring), maxCredits);
  return { header, emailColumn, records, plan };
}

export interface ScoredLead {
  record: Record<string, string>;
  item: PlannedItem;
  lookup: BatchLookup | null;
  evaluation: Evaluation;
  status: string;
  /** False for rows with no answer yet (dry run, over budget, pending, error): they have no route. */
  routed: boolean;
  owner: string;
}

const UNROUTED = new Set(['would-enrich', 'skipped-max-credits', 'not-sent', 'pending', 'error']);

export function scoreLeads(planned: LeadCsvPlan, run: BatchRun | null, config: PipelineConfig, now: Date): ScoredLead[] {
  return planned.plan.items.map((item, index) => {
    const lookup = itemLookup(item, run);
    const company = lookup?.status === 'found' ? lookup.company : null;
    const evaluation = evaluateCompany(company, config.scoring, config.routing, now);
    const status = rowStatus(item, lookup, run);
    const routed = !UNROUTED.has(status);
    return {
      record: planned.records[index] ?? {},
      item,
      lookup,
      evaluation,
      status,
      routed,
      owner: routed ? ownerLabel(evaluation, config.routing) : '',
    };
  });
}

function rowStatus(item: PlannedItem, lookup: BatchLookup | null, run: BatchRun | null): string {
  if (item.status === 'invalid') return 'invalid-email';
  if (item.status === 'free-mail') return 'free-mail';
  if (item.status === 'over-budget') return 'skipped-max-credits';
  if (!lookup) return run ? 'not-sent' : 'would-enrich';
  return lookup.status === 'found' ? 'scored' : lookup.status;
}

/** The CLI does not advance round-robin state; that happens when the webhook routes a live lead. */
function ownerLabel(evaluation: Evaluation, routing: RoutingConfig): string {
  const { route } = evaluation;
  if (route.pinnedOwner) return route.pinnedOwner;
  const team = routing.teams[route.team];
  if (!team) return '';
  return team.roundRobin && team.members.length > 1 ? 'round-robin' : (team.members[0]?.name ?? '');
}

export function leadsToCsv(planned: LeadCsvPlan, leads: ScoredLead[]): string {
  const rows = leads.map((lead) => {
    const { score, tier, route } = lead.evaluation;
    const company = lead.lookup?.status === 'found' ? lead.lookup.company : null;
    const factors = score?.factors
      .filter((factor) => factor.weight > 0)
      .map((factor) => `${factor.dimension} ${factor.points}/${factor.weight}`)
      .join('; ');
    const source = lead.item.cached ? 'cache' : lead.lookup && lead.lookup.status !== 'error' ? 'api' : '';
    return [
      ...planned.header.map((name) => lead.record[name] ?? ''),
      lead.item.domain,
      lead.status,
      company?.name,
      company?.industry,
      company?.employees,
      company?.country?.code,
      score?.total,
      tier?.tier,
      lead.routed ? (route.firedRule ?? 'fallback') : '',
      lead.routed ? route.team : '',
      lead.owner,
      factors,
      source,
    ];
  });
  return toCsv([[...planned.header, ...OUTPUT_COLUMNS], ...rows]);
}
