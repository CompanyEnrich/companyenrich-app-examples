import type { Company } from '@companyenrich/sdk';
import type { ACCOUNT_EXPANSIONS } from './config.js';
import { formatList, formatStage, formatUsd } from './format.js';

type AccountExpansion = (typeof ACCOUNT_EXPANSIONS)[number];

/** The few company fields account-changes compares between runs. Everything else is left out of state. */
export interface CompanySnapshot {
  capturedAt: string;
  name: string;
  employees: string | null;
  revenue: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
  /** Present when the `financial` expansion was requested. */
  funding?: { stage: string | null; date: string | null; total: number | null };
  /** Present when the `technologies` expansion was requested. Sorted. */
  technologies?: string[];
  /** Present when the `workforce` expansion was requested. */
  workforce?: { observed: number; departments: Record<string, number> };
}

const DEPARTMENT_LABELS: Record<string, string> = {
  cSuite: 'C-suite',
  productManagement: 'Product',
  engineeringTechnical: 'Engineering',
  design: 'Design',
  education: 'Education',
  finance: 'Finance',
  humanResources: 'HR',
  informationTechnology: 'IT',
  legal: 'Legal',
  marketing: 'Marketing',
  medicalHealth: 'Medical',
  operations: 'Operations',
  sales: 'Sales',
  consulting: 'Consulting',
};

/** Ignore department moves smaller than this, so 1 -> 2 people does not read as +100%. */
const MIN_DEPARTMENT_CHANGE = 3;

export function toSnapshot(company: Company, expand: readonly AccountExpansion[], capturedAt: string): CompanySnapshot {
  const snapshot: CompanySnapshot = {
    capturedAt,
    name: company.name ?? company.domain,
    employees: company.employees ?? null,
    revenue: company.revenue ?? null,
    industry: company.industry ?? null,
    country: company.location?.country?.code ?? null,
    city: company.location?.city?.name ?? null,
  };
  if (expand.includes('financial')) {
    const financial = company.financial;
    snapshot.funding = {
      stage: financial?.fundingStage ?? null,
      date: financial?.fundingDate?.slice(0, 10) ?? null,
      total: financial?.totalFunding ?? null,
    };
  }
  if (expand.includes('technologies')) {
    snapshot.technologies = [...new Set(company.technologies ?? [])].sort();
  }
  if (expand.includes('workforce') && company.workforce) {
    const departments: Record<string, number> = {};
    for (const [key, value] of Object.entries(company.workforce.departmentHeadcount)) {
      if (typeof value === 'number') departments[key] = value;
    }
    snapshot.workforce = { observed: company.workforce.observedEmployeeCount, departments };
  }
  return snapshot;
}

/**
 * Lists human-readable changes between two snapshots of the same company.
 * Expansion fields are compared only when both snapshots have them.
 */
export function diffSnapshots(
  before: CompanySnapshot,
  after: CompanySnapshot,
  { headcountChangePct }: { headcountChangePct: number },
): string[] {
  const changes: string[] = [];
  const compare = (label: string, from: string | null, to: string | null) => {
    if (from !== to) changes.push(`${label}: ${from ?? 'unknown'} → ${to ?? 'unknown'}`);
  };

  compare('Employees', before.employees, after.employees);
  compare('Revenue', before.revenue, after.revenue);
  compare('Industry', before.industry, after.industry);
  compare('HQ', formatPlace(before), formatPlace(after));

  if (before.funding && after.funding) {
    const from = before.funding;
    const to = after.funding;
    if (from.stage !== to.stage || from.date !== to.date) {
      changes.push(`Latest funding: ${formatRound(from)} → ${formatRound(to)}`);
    }
    if (from.total !== to.total) {
      changes.push(`Total funding: ${formatUsd(from.total)} → ${formatUsd(to.total)}`);
    }
  }

  if (before.technologies && after.technologies) {
    const previous = new Set(before.technologies);
    const current = new Set(after.technologies);
    const added = after.technologies.filter((tech) => !previous.has(tech));
    const removed = before.technologies.filter((tech) => !current.has(tech));
    if (added.length > 0) changes.push(`Technologies added: ${formatList(added)}`);
    if (removed.length > 0) changes.push(`Technologies removed: ${formatList(removed)}`);
  }

  if (before.workforce && after.workforce) {
    const overall = headcountChange('Observed headcount', before.workforce.observed, after.workforce.observed, {
      minPct: headcountChangePct,
      minDelta: 1,
    });
    if (overall) changes.push(overall);

    const keys = new Set([...Object.keys(before.workforce.departments), ...Object.keys(after.workforce.departments)]);
    for (const key of keys) {
      const line = headcountChange(
        `${DEPARTMENT_LABELS[key] ?? key} headcount`,
        before.workforce.departments[key] ?? 0,
        after.workforce.departments[key] ?? 0,
        { minPct: headcountChangePct, minDelta: MIN_DEPARTMENT_CHANGE },
      );
      if (line) changes.push(line);
    }
  }

  return changes;
}

function headcountChange(
  label: string,
  before: number,
  after: number,
  { minPct, minDelta }: { minPct: number; minDelta: number },
): string | undefined {
  const delta = after - before;
  if (delta === 0 || Math.abs(delta) < minDelta) return undefined;
  if (before === 0) return `${label}: 0 → ${after} (new)`;
  const pct = (delta / before) * 100;
  if (Math.abs(pct) < minPct) return undefined;
  return `${label}: ${before} → ${after} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
}

function formatPlace(snapshot: CompanySnapshot): string | null {
  const parts = [snapshot.city, snapshot.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatRound(funding: NonNullable<CompanySnapshot['funding']>): string {
  const stage = formatStage(funding.stage) ?? 'none';
  return funding.date ? `${stage} (${funding.date})` : stage;
}
