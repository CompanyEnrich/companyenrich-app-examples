import type { Blueprint, EmployeeRange, RoleSpec, SizeBand } from './types';
import type { Department, Seniority } from './taxonomy';

export const EMPLOYEE_RANGES = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'] as const satisfies readonly EmployeeRange[];

export function bandFor(range: EmployeeRange | null): SizeBand {
  if (range === null) return 'unknown';
  if (range === '1-10' || range === '11-50') return 'small';
  if (range === '51-200' || range === '201-500') return 'mid';
  return 'large';
}

export const BAND_LABELS: Record<SizeBand, string> = {
  small: '1-50 employees',
  mid: '51-500 employees',
  large: '501+ employees',
  unknown: 'size unknown',
};

/** Roles that only appear at large accounts, where formal reviews gate the deal. */
const SECURITY_REVIEW: RoleSpec = {
  key: 'security-review',
  label: 'Security review',
  why: 'Runs the vendor security questionnaire; nothing gets signed until it passes.',
  department: ['information-technology/information-security', 'information-technology/it-audit-it-compliance', 'legal/privacy'],
  seniority: ['director', 'head', 'manager'],
  position: [],
  limit: 1,
  priority: 4,
};

const PROCUREMENT_LEGAL: RoleSpec = {
  key: 'procurement-legal',
  label: 'Procurement and legal',
  why: 'Negotiates terms and signs the contract; large deals often stall here.',
  department: ['finance/sourcing-procurement', 'information-technology/it-procurement', 'legal/contracts', 'legal/legal-counsel', 'legal/legal'],
  seniority: ['director', 'head', 'manager', 'vp'],
  position: [],
  limit: 2,
  priority: 6,
};

export interface SizedCommittee {
  roles: RoleSpec[];
  /** Plain-English explanation of what changed and why. */
  adaptation: string[];
}

/** Adapt a blueprint (written for 51-500 people) to the account's size. */
export function adaptForSize(blueprint: Blueprint, band: SizeBand): SizedCommittee {
  switch (band) {
    case 'small':
      return collapseForSmallCompany(blueprint.roles);
    case 'large':
      return expandForLargeCompany(blueprint.roles);
    case 'mid':
      return { roles: blueprint.roles, adaptation: ['51-500 employees: standard committee.'] };
    case 'unknown':
      return { roles: blueprint.roles, adaptation: ['Employee range unknown: using the standard committee.'] };
  }
}

function collapseForSmallCompany(roles: RoleSpec[]): SizedCommittee {
  const champion = roles.find((role) => role.key === 'champion');
  const endUserLead = roles.find((role) => role.key === 'end-user-lead');
  const mergedRoleKeys = new Set(['economic-buyer', 'technical-evaluator', 'champion', 'end-user-lead']);

  const founder: RoleSpec = {
    key: 'economic-buyer',
    label: 'Founder or executive (buys and evaluates)',
    why: 'At this size a founder or C-level exec usually both decides and evaluates.',
    department: [],
    seniority: ['founder', 'owner', 'c-suite'],
    position: [],
    limit: 2,
    priority: 1,
  };

  const collapsed: RoleSpec[] = [founder];
  if (champion || endUserLead) {
    collapsed.push({
      key: 'champion',
      label: 'Champion (hands-on lead)',
      why: 'The person closest to the problem; at a small company they also lead the users.',
      department: unique<Department>([...(champion?.department ?? []), ...(endUserLead?.department ?? [])]),
      seniority: ['head', 'director', 'manager', 'senior'],
      position: [],
      limit: 1,
      priority: 2,
    });
  }
  // Any other roles in a custom blueprint are kept, minus large-company reviews.
  const others = roles.filter((role) => !mergedRoleKeys.has(role.key) && !isReviewRole(role));

  return {
    roles: [...collapsed, ...others],
    adaptation: [
      '1-50 employees: founders and C-level usually both buy and evaluate, so the economic buyer and technical evaluator are merged into one founder/exec role.',
      'The champion and end-user lead are merged into one hands-on lead.',
      'No security review or procurement roles: at this size the founders handle both.',
    ],
  };
}

function expandForLargeCompany(roles: RoleSpec[]): SizedCommittee {
  const adaptation = ['501+ employees: the economic buyer is pushed up to VP and C-level.'];
  const vpAndAbove: Seniority[] = ['c-suite', 'vp'];
  const expanded = roles.map((role) => (role.key === 'economic-buyer' ? { ...role, seniority: vpAndAbove } : role));

  // A security blueprint's committee already is the security team; a second security role would duplicate it.
  const buyerOwnsSecurity = roles.some(
    (role) => role.key === 'economic-buyer' && role.department.includes('information-technology/information-security'),
  );
  if (!buyerOwnsSecurity && !roles.some((role) => role.key === SECURITY_REVIEW.key)) {
    expanded.push(SECURITY_REVIEW);
    adaptation.push('Added a security review role: large companies review vendors before signing.');
  }
  if (!roles.some((role) => role.key === PROCUREMENT_LEGAL.key)) {
    expanded.push(PROCUREMENT_LEGAL);
    adaptation.push('Added a procurement and legal role: large contracts go through formal procurement.');
  }
  return { roles: expanded.sort((a, b) => a.priority - b.priority), adaptation };
}

function isReviewRole(role: RoleSpec): boolean {
  return role.key === SECURITY_REVIEW.key || role.key === PROCUREMENT_LEGAL.key;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
