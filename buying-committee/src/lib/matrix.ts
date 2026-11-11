import type { Account, CoveragePlan } from './types';

export interface MatrixColumn {
  key: string;
  label: string;
}

export interface MatrixRow {
  account: Account;
  /** People count per column, or null when the role is not part of this account's committee. */
  cells: (number | null)[];
  singleThreaded: boolean;
}

export interface CoverageMatrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
}

const SHORT_LABELS: Record<string, string> = {
  'economic-buyer': 'Econ. buyer',
  champion: 'Champion',
  'technical-evaluator': 'Tech eval',
  'security-review': 'Security',
  'end-user-lead': 'End users',
  'procurement-legal': 'Procurement',
};

function shortLabel(key: string, fallback: string): string {
  return SHORT_LABELS[key] ?? fallback.replace(/\s*\(.*\)$/, '').slice(0, 14);
}

/**
 * Accounts x roles. Committees differ by company size, so the columns are the union
 * of every account's roles, in priority order.
 */
export function coverageMatrix(plan: CoveragePlan): CoverageMatrix {
  const columns = new Map<string, { label: string; priority: number }>();
  for (const { roles } of plan.accounts) {
    for (const { role } of roles) {
      const existing = columns.get(role.key);
      if (!existing || role.priority < existing.priority) {
        columns.set(role.key, { label: shortLabel(role.key, role.label), priority: role.priority });
      }
    }
  }
  const ordered = [...columns.entries()].sort((a, b) => a[1].priority - b[1].priority).map(([key, { label }]) => ({ key, label }));

  return {
    columns: ordered,
    rows: plan.accounts.map(({ account, roles, singleThreaded }) => ({
      account,
      cells: ordered.map(({ key }) => roles.find(({ role }) => role.key === key)?.count ?? null),
      singleThreaded,
    })),
  };
}
