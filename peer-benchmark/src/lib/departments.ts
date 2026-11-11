/**
 * The 14 departments CompanyEnrich classifies people into from their job titles,
 * keyed exactly as `departmentHeadcount` returns them.
 */
export const DEPARTMENTS = [
  { key: 'engineeringTechnical', label: 'Engineering', team: 'engineering team' },
  { key: 'sales', label: 'Sales', team: 'sales team' },
  { key: 'marketing', label: 'Marketing', team: 'marketing team' },
  { key: 'operations', label: 'Operations', team: 'operations team' },
  { key: 'productManagement', label: 'Product', team: 'product team' },
  { key: 'design', label: 'Design', team: 'design team' },
  { key: 'humanResources', label: 'HR & people', team: 'HR and people team' },
  { key: 'finance', label: 'Finance', team: 'finance team' },
  { key: 'informationTechnology', label: 'IT', team: 'IT team' },
  { key: 'legal', label: 'Legal', team: 'legal team' },
  { key: 'cSuite', label: 'C-suite', team: 'C-suite' },
  { key: 'consulting', label: 'Consulting', team: 'consulting team' },
  { key: 'education', label: 'Education', team: 'education team' },
  { key: 'medicalHealth', label: 'Medical & health', team: 'medical and health team' },
] as const;

export type DepartmentKey = (typeof DEPARTMENTS)[number]['key'];
export type Department = (typeof DEPARTMENTS)[number];

/** Headcount per department. The API omits departments with no one in them. */
export type DepartmentCounts = Partial<Record<DepartmentKey, number | null>>;

/** One monthly snapshot from `history`. */
export interface WorkforcePoint {
  date: string;
  observedEmployeeCount: number;
  departmentHeadcount: DepartmentCounts;
  unclassifiedHeadcount: number;
}

/**
 * The fields of a `companies.workforce()` response this app reads. The SDK's
 * `CompanyWorkforce` type is assignable to it, so the math never imports the SDK.
 */
export interface Workforce {
  domain: string;
  observedEmployeeCount: number;
  departmentHeadcount: DepartmentCounts;
  unclassifiedHeadcount: number;
  historyFrom: string;
  historyTo: string;
  history?: WorkforcePoint[] | null;
}

export function countOf(counts: DepartmentCounts, key: DepartmentKey): number {
  return counts[key] ?? 0;
}
