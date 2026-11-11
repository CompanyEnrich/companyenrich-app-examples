import type { Company, CompanyEnrich, components } from '@companyenrich/sdk';

export type { Company, CompanyEnrich };
// The generated schemas allow null at the top level; the app always works with a filter object.
export type CompanySearchFilter = NonNullable<components['schemas']['CompanySearchFilter']>;
export type PersonSearchFilter = NonNullable<components['schemas']['PersonSearchFilter']>;
export type IndustryCodes = ReadonlyMap<string, readonly string[]>;

export type Log = (line: string) => void;
