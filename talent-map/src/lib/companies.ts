import type { Candidate, CompanyRef } from './shortlist.js';
import type { TeamTrend } from './trends.js';

export interface CompanyRow {
  company: CompanyRef;
  /** Shortlisted people currently at this company. */
  shortlisted: number;
  /** Everyone at this company who matches the role filters (free count). */
  pool?: number;
  trend?: TeamTrend;
}

/** Groups candidates by current company, in the order companies first appear. */
export function groupByCompany(candidates: readonly Candidate[]): CompanyRow[] {
  const rows = new Map<string, CompanyRow>();
  for (const candidate of candidates) {
    if (!candidate.company) continue;
    const row = rows.get(candidate.company.id);
    if (row) row.shortlisted++;
    else rows.set(candidate.company.id, { company: candidate.company, shortlisted: 1 });
  }
  return [...rows.values()];
}

/** Largest matching pool first; ties go to more shortlisted people, then the name. Unknown pools sort last. */
export function rankCompanies(rows: readonly CompanyRow[]): CompanyRow[] {
  return [...rows].sort(
    (a, b) =>
      (b.pool ?? -1) - (a.pool ?? -1) ||
      b.shortlisted - a.shortlisted ||
      a.company.name.localeCompare(b.company.name),
  );
}
