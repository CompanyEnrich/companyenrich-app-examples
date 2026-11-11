import type { Person } from '@companyenrich/sdk';
import { normalizeDomain } from './domains.js';

export type Experience = Person['experiences'][number];
export type Seniority = NonNullable<Person['seniority']>;

/**
 * What we remember about a champion between checks. Deliberately small: no name, no
 * LinkedIn URL, no work history. Everything else is fetched fresh at each check.
 */
export interface Baseline {
  /** "active" while they work at the company below, "left" once no current role was found there. */
  status: 'active' | 'left';
  companyId: string | null;
  companyDomain: string | null;
  companyName: string | null;
  position: string | null;
  seniority: Seniority | null;
  /** Month precision, for example "2024-11-01". */
  positionStartDate: string | null;
  /**
   * Other employers listed as current when the baseline was taken, such as a side business or a
   * community membership. Remembering them stops a long-standing second role being reported as a move.
   */
  otherCurrentCompanies: string[];
}

// The API lists seniorities from most to least senior; this is the same order reversed.
const SENIORITY_ORDER: readonly Seniority[] = [
  'intern',
  'entry',
  'senior',
  'manager',
  'director',
  'head',
  'vp',
  'partner',
  'c-suite',
  'founder',
  'owner',
];

// Roles people hold next to their main job. A new one of these is not a job change.
const SIDE_ROLE = /\b(advis[eo]r|advisory|board member|board of directors|non-executive|mentor|volunteer|trustee|angel investor)\b/i;

export function currentExperiences(person: Person): Experience[] {
  return person.experiences.filter((experience) => experience.isCurrent);
}

export function seniorityRank(seniority: Seniority | null | undefined): number | null {
  if (!seniority) return null;
  const rank = SENIORITY_ORDER.indexOf(seniority);
  return rank === -1 ? null : rank;
}

export function isSideRole(experience: Experience): boolean {
  return SIDE_ROLE.test(experience.position ?? '');
}

export function companyLabel(experience: Experience): string {
  return experience.company?.name ?? experience.companyName ?? 'an unnamed company';
}

/** A stable key for an employer: its CompanyEnrich id, or its name when the profile has no company record. */
export function companyKey(experience: Experience): string {
  return experience.company?.id ?? `name:${normalizeText(companyLabel(experience))}`;
}

/**
 * Whether an experience is at the baseline company. Matches on company id first, so a company
 * that changed its domain still counts as the same employer, then on domain, then on name for
 * experiences without a company record.
 */
export function isAtCompany(experience: Experience, baseline: Baseline): boolean {
  const company = experience.company;
  if (baseline.companyId && company?.id === baseline.companyId) return true;
  const domain = normalizeDomain(company?.domain);
  if (domain && domain === normalizeDomain(baseline.companyDomain)) return true;
  if (!company?.id && baseline.companyName) {
    return normalizeText(companyLabel(experience)) === normalizeText(baseline.companyName);
  }
  return false;
}

/**
 * The experience most likely to be the person's main role. Profiles often list several current
 * roles, and new ones are sometimes added before the old one is closed, so the latest start date
 * wins. Undated roles come last; ties keep the API's order.
 */
export function pickPrimary(experiences: Experience[]): Experience | undefined {
  return [...experiences].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
}

export function baselineAt(role: Experience, current: Experience[]): Baseline {
  const roleKey = companyKey(role);
  return {
    status: 'active',
    companyId: role.company?.id ?? null,
    companyDomain: normalizeDomain(role.company?.domain) || null,
    companyName: companyLabel(role),
    position: role.position ?? null,
    seniority: role.seniority ?? null,
    positionStartDate: role.startDate ?? null,
    otherCurrentCompanies: unique(current.map(companyKey).filter((key) => key !== roleKey)),
  };
}

export function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeText(a ?? '') === normalizeText(b ?? '');
}

/** Profile dates have month precision, so compare "YYYY-MM" only. */
export function startedAfter(date: string | null | undefined, reference: string | null | undefined): boolean {
  if (!date || !reference) return false;
  return date.slice(0, 7) > reference.slice(0, 7);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
