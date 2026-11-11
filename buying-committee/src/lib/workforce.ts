import type { CompanyWorkforce } from '@companyenrich/sdk';
import { workforceKey, type Department } from './taxonomy';
import type { RoleCoverage, RoleSpec } from './types';

export type DepartmentHeadcount = CompanyWorkforce['departmentHeadcount'];

export type WorkforceVerdict =
  | { action: 'keep'; note?: string }
  | { action: 'skip'; note: string }
  | { action: 'relabel'; role: RoleSpec; note: string };

const ROOT_NAMES: Record<string, string> = {
  'c-suite': 'C-suite',
  'product-management': 'product',
  'engineering-technical': 'engineering',
  design: 'design',
  education: 'education',
  finance: 'finance',
  'human-resources': 'HR',
  'information-technology': 'IT and security',
  legal: 'legal',
  marketing: 'marketing',
  'medical-health': 'medical',
  operations: 'operations',
  sales: 'sales',
  consulting: 'consulting',
};

/** Who usually covers a role when its home team does not exist. */
const EXECUTIVE_COVER: Record<string, { label: string; position: string[]; who: string }> = {
  'security-review': {
    label: 'Security review (CTO or CIO)',
    position: ['CTO', 'Chief Technology Officer', 'CIO', 'Chief Information Officer'],
    who: 'the CTO or CIO likely reviews security',
  },
  'procurement-legal': {
    label: 'Contract sign-off (CFO or CEO)',
    position: ['CFO', 'Chief Financial Officer', 'CEO', 'Chief Executive Officer', 'COO'],
    who: 'a finance or general executive likely signs the contract',
  },
  'technical-evaluator': {
    label: 'Technical evaluation (CTO)',
    position: ['CTO', 'Chief Technology Officer'],
    who: 'the CTO likely evaluates it',
  },
};

/** A role's home team is its first department. */
function homeDepartment(role: RoleSpec): Department | undefined {
  return role.department[0];
}

/** Roles the workforce check could relabel: nobody matched and they have a home team. */
export function relabelCandidates(roles: readonly RoleCoverage[]): RoleCoverage[] {
  return roles.filter(({ role, count }) => count === 0 && homeDepartment(role) !== undefined && role.key !== 'end-user-lead');
}

/**
 * Decide what to do with a role once we know the department headcounts.
 * Only roles with no matches change: if their home team has no observed people,
 * the team likely does not exist, so we point to the executive who covers it
 * (or skip an end-user lead, since there is no team to lead).
 */
export function workforceVerdict(role: RoleSpec, count: number, headcount: DepartmentHeadcount): WorkforceVerdict {
  const home = homeDepartment(role);
  if (count > 0 || home === undefined) return { action: 'keep' };

  const root = home.split('/')[0]!;
  const teamName = ROOT_NAMES[root] ?? root;
  const teamSize = headcount[workforceKey(home)] ?? 0;
  if (teamSize > 0) {
    return { action: 'keep', note: `${teamSize} ${teamName} people observed, but none match this role's seniority or title filters.` };
  }

  if (role.key === 'end-user-lead') {
    return { action: 'skip', note: `No ${teamName} team observed, so there is no end-user team to lead.` };
  }
  const cover = EXECUTIVE_COVER[role.key] ?? { label: `${role.label} (executive)`, position: [], who: 'an executive likely covers this role' };
  return {
    action: 'relabel',
    note: `No ${teamName} team observed, so ${cover.who}.`,
    role: {
      ...role,
      label: cover.label,
      department: ['c-suite'],
      seniority: ['c-suite', 'founder', 'owner'],
      position: cover.position,
      limit: 1,
    },
  };
}
