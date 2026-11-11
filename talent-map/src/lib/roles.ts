import type { Department, HeadcountKey, PersonFilter, RootDepartment, Seniority } from './types.js';

/**
 * Words in a job title mapped to the v2 people `department` taxonomy. The first entry with a
 * matching keyword wins, so specific titles come before broad ones. Each pairing was checked with
 * free counts: the department holds most people whose title contains the phrase. Extend it for
 * the roles you hire for.
 */
export const ROLE_DEPARTMENTS: readonly { keywords: readonly string[]; department: Department }[] = [
  { keywords: ['data engineer', 'analytics engineer', 'data scientist', 'data analyst'], department: 'engineering-technical/data-science' },
  { keywords: ['machine learning', 'ml engineer', 'ai engineer'], department: 'engineering-technical/artificial-intelligence-machine-learning' },
  { keywords: ['devops', 'site reliability'], department: 'engineering-technical/devops' },
  { keywords: ['security engineer', 'security analyst'], department: 'information-technology/information-security' },
  { keywords: ['qa engineer', 'quality assurance'], department: 'engineering-technical/test-quality-assurance' },
  { keywords: ['ios', 'mobile'], department: 'engineering-technical/mobile-development' },
  { keywords: ['frontend', 'front-end', 'front end', 'web developer'], department: 'engineering-technical/web-development' },
  {
    keywords: ['software engineer', 'software developer', 'backend', 'back-end', 'full stack', 'full-stack'],
    department: 'engineering-technical/software-development',
  },
  { keywords: ['product designer', 'ux', 'ui designer'], department: 'design/product-ui-ux-design' },
  { keywords: ['designer'], department: 'design' },
  { keywords: ['product manager', 'product owner'], department: 'product-management' },
  { keywords: ['recruiter', 'talent acquisition'], department: 'human-resources/recruiting-talent-acquisition' },
  { keywords: ['customer success'], department: 'sales/customer-success' },
  { keywords: ['account executive', 'sales', 'business development'], department: 'sales' },
  { keywords: ['marketing'], department: 'marketing' },
  { keywords: ['accountant', 'controller', 'finance'], department: 'finance' },
  { keywords: ['counsel', 'lawyer', 'attorney'], department: 'legal' },
  { keywords: ['engineer', 'developer'], department: 'engineering-technical' },
];

/** Below this share of matching titles, the department filter would hide too many people, so it is dropped. */
export const MIN_DEPARTMENT_COVERAGE = 0.5;

const HEADCOUNT_KEYS: Record<RootDepartment, HeadcountKey> = {
  'c-suite': 'cSuite',
  'product-management': 'productManagement',
  'engineering-technical': 'engineeringTechnical',
  design: 'design',
  education: 'education',
  finance: 'finance',
  'human-resources': 'humanResources',
  'information-technology': 'informationTechnology',
  legal: 'legal',
  marketing: 'marketing',
  'medical-health': 'medicalHealth',
  operations: 'operations',
  sales: 'sales',
  consulting: 'consulting',
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasKeyword(title: string, keyword: string): boolean {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(title);
}

export function departmentFor(title: string): Department | undefined {
  return ROLE_DEPARTMENTS.find((entry) => entry.keywords.some((keyword) => hasKeyword(title, keyword)))?.department;
}

export interface TitleCheck {
  phrase: string;
  /** True when positions.autocomplete lists this exact title. */
  known: boolean;
  suggestions: string[];
  department?: Department;
}

export interface RoleSelection {
  titles: string[];
  checks: TitleCheck[];
  departments: Department[];
}

/**
 * Turns the --role phrases and their positions.autocomplete suggestions into people filters.
 * The department comes from the phrase itself, or failing that from the most popular suggestion
 * that the mapping recognises.
 */
export function resolveRole(phrases: readonly string[], suggestions: ReadonlyMap<string, readonly string[]>): RoleSelection {
  const checks = phrases.map((phrase): TitleCheck => {
    const items = [...(suggestions.get(phrase) ?? [])];
    const known = items.some((item) => item.toLowerCase() === phrase.toLowerCase());
    const department = departmentFor(phrase) ?? items.map(departmentFor).find((value) => value !== undefined);
    return { phrase, known, suggestions: items, ...(department ? { department } : {}) };
  });
  const departments = [...new Set(checks.flatMap((check) => (check.department ? [check.department] : [])))];
  return { titles: [...phrases], checks, departments };
}

export function rootDepartment(department: Department): RootDepartment {
  return department.split('/')[0] as RootDepartment;
}

/** The workforce headcount keys to sum for these departments; empty means "whole company". */
export function headcountKeys(departments: readonly Department[]): HeadcountKey[] {
  return [...new Set(departments.map((department) => HEADCOUNT_KEYS[rootDepartment(department)]))];
}

export interface PersonFilterOptions {
  seniority?: readonly Seniority[];
  /** ISO date: only people who joined their current company on or before it. */
  joinedBefore?: string;
}

export function personFilter(role: Pick<RoleSelection, 'titles' | 'departments'>, options: PersonFilterOptions = {}): PersonFilter {
  return {
    position: role.titles,
    ...(role.departments.length > 0 ? { department: role.departments } : {}),
    ...(options.seniority && options.seniority.length > 0 ? { seniority: [...options.seniority] } : {}),
    ...(options.joinedBefore ? { currentCompanyStartDate: { before: options.joinedBefore } } : {}),
  };
}
