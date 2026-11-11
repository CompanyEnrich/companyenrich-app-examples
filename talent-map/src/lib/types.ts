import type { components } from '@companyenrich/sdk';

type Schemas = components['schemas'];

export type Department = NonNullable<Schemas['NullableOfPersonDepartment']>;
/** A top-level department such as `engineering-technical`; children look like `engineering-technical/data-science`. */
export type RootDepartment = Exclude<Department, `${string}/${string}`>;
export type Seniority = NonNullable<Schemas['NullableOfPersonSeniority']>;
export type EmployeeRange = NonNullable<Schemas['NullableOfCompanyEmployees']>;
export type PersonFilter = Schemas['PersonSearchFilter'];
/** Keys of `departmentHeadcount` in a workforce response, such as `engineeringTechnical`. */
export type HeadcountKey = keyof Schemas['CompanyWorkforceDepartmentResponse'];

export type Log = (line: string) => void;

/** Every seniority level in the v2 taxonomy, most senior first. */
export const SENIORITIES: readonly Seniority[] = [
  'owner',
  'founder',
  'c-suite',
  'partner',
  'vp',
  'head',
  'director',
  'manager',
  'senior',
  'entry',
  'intern',
];

export const EMPLOYEE_RANGES: readonly EmployeeRange[] = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'];
