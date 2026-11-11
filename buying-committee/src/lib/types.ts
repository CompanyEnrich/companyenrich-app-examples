import type { Company } from '@companyenrich/sdk';
import type { Department, Seniority } from './taxonomy';

/** One seat on a buying committee, expressed as v2 people-search filters. */
export interface RoleSpec {
  /** Stable kebab-case id, e.g. `economic-buyer`. */
  key: string;
  label: string;
  /** One line on why this role matters to the deal. */
  why: string;
  /** Empty means any department. A root such as `finance` includes its children. */
  department: Department[];
  /** Ordered by preference: the first value is the best fit. */
  seniority: Seniority[];
  /** Title phrases, any of which may match. Empty means any title. Earlier phrases rank higher. */
  position: string[];
  /** How many people to map for this role (1-3). Also the paid page size. */
  limit: number;
  /** 1 is the most important. People go to the highest-priority role they match. */
  priority: number;
}

export interface Blueprint {
  /** Preset id, or `custom` for a blueprint drafted from a description. */
  id: string;
  name: string;
  summary: string;
  roles: RoleSpec[];
}

export type EmployeeRange = NonNullable<Company['employees']>;
export type SizeBand = 'small' | 'mid' | 'large' | 'unknown';

export interface Account {
  domain: string;
  name: string;
  companyId: string;
  employees: EmployeeRange | null;
  band: SizeBand;
}

export interface RoleCoverage {
  role: RoleSpec;
  /** Free `people.count` result for this role at this account. */
  count: number;
}

export interface AccountCoverage {
  account: Account;
  /** Why the committee differs from the preset at this company size. */
  adaptation: string[];
  roles: RoleCoverage[];
  /** At most one role has anyone matching: the deal would hang on one thread. */
  singleThreaded: boolean;
}

export interface UnresolvedAccount {
  domain: string;
  reason: string;
}

/** Everything the free step produces. The paid step takes this as its input. */
export interface CoveragePlan {
  blueprint: Blueprint;
  accounts: AccountCoverage[];
  unresolved: UnresolvedAccount[];
}

export interface MappedPerson {
  /** Person ids are 64-bit integers, so they are kept as strings. */
  id: string;
  name: string;
  title: string;
  seniority: Seniority | null;
  department: Department | null;
  /** Start of the current role at this account, `YYYY-MM-DD`. */
  roleStartDate: string | null;
  monthsInRole: number | null;
  /** Started the current role within the last 90 days. */
  newInRole: boolean;
  linkedinUrl: string | null;
}

export interface RoleResult {
  role: RoleSpec;
  count: number;
  people: MappedPerson[];
  /** Things worth knowing about this role, e.g. a workforce relabel. */
  notes: string[];
}

export interface Gap {
  roleKey: string;
  label: string;
  reason: string;
  suggestion: string;
}

export interface AccountMap {
  account: Account;
  adaptation: string[];
  roles: RoleResult[];
  gaps: Gap[];
  /** One person or fewer mapped: the deal depends on a single contact. */
  singleThreaded: boolean;
}

export interface CommitteeMap {
  blueprint: Blueprint;
  generatedAt: string;
  accounts: AccountMap[];
  /** Credits charged by this run, counted from what the API returned. */
  creditsSpent: number;
  /** Set when a paid call failed midway: why the run stopped. Results paid for until then are kept. */
  stoppedEarly: string | null;
}
