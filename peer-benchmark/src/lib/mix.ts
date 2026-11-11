import { DEPARTMENTS, countOf, type DepartmentKey, type Workforce } from './departments';

/**
 * A company's department mix as shares of observed headcount. Some people match
 * more than one department, so department shares plus the unclassified share can
 * add up to slightly more than 100%.
 */
export interface DepartmentMix {
  observed: number;
  counts: Record<DepartmentKey, number>;
  /** 0.21 means 21% of observed headcount. */
  shares: Record<DepartmentKey, number>;
  unclassified: number;
  unclassifiedShare: number;
}

/** Returns null when the company has no observed employees, since shares are undefined. */
export function departmentMix(workforce: Workforce): DepartmentMix | null {
  const observed = workforce.observedEmployeeCount;
  if (!(observed > 0)) return null;

  const counts = {} as Record<DepartmentKey, number>;
  const shares = {} as Record<DepartmentKey, number>;
  for (const { key } of DEPARTMENTS) {
    counts[key] = countOf(workforce.departmentHeadcount, key);
    shares[key] = counts[key] / observed;
  }
  const unclassified = workforce.unclassifiedHeadcount ?? 0;
  return { observed, counts, shares, unclassified, unclassifiedShare: unclassified / observed };
}
