import type { Company, CompanySearchParams, Person, PersonSearchParams } from '@companyenrich/sdk';

export type Log = (line: string) => void;

export type CompanyFilter = NonNullable<CompanySearchParams['filter']>;
export type PersonFilter = NonNullable<PersonSearchParams['filter']>;

export type EmployeeRange = Extract<NonNullable<CompanyFilter['employees']>, string>;
export type Category = Extract<NonNullable<CompanyFilter['categories']>, string>;
export type Department = Extract<NonNullable<PersonFilter['department']>, string>;
export type Seniority = Extract<NonNullable<PersonFilter['seniority']>, string>;

export type Tier = 1 | 2 | 3;

/** A fetched target account, in the order it was ranked. */
export interface Account {
  rank: number;
  tier: Tier;
  /** The why-now signals the account was selected for (empty for tier 3). */
  signals: string[];
  company: Company;
}

export type ContactMatch = 'persona' | 'fallback';

export interface Contact {
  account: Account;
  person: Person;
  /** Whether the person matched the persona itself or its broader fallback. */
  match: ContactMatch;
}
