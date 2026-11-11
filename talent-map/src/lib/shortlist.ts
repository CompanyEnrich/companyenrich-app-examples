import type { Person } from '@companyenrich/sdk';
import { yearsSince } from './tenure.js';

type Experience = Person['experiences'][number];

export interface CompanyRef {
  id: string;
  name: string;
  domain?: string;
}

/** One row of the shortlist: what a recruiter needs to decide whether to reach out. */
export interface Candidate {
  id: number;
  name: string;
  /** Title of the current role, e.g. "Data Engineer". */
  title: string;
  /** The profile headline, which often lists skills, e.g. "Data Engineer | Spark | Snowflake". */
  headline?: string;
  seniority?: string;
  department?: string;
  company?: CompanyRef;
  /** First day at the current company, from the earliest listed role there. */
  joinedCompany?: string;
  tenureYears?: number;
  location?: string;
  linkedinUrl?: string;
}

/** The current role that matched the search, or any current role. */
export function currentExperience(person: Person): Experience | undefined {
  const current = person.experiences.filter((experience) => experience.isCurrent);
  return current.find((experience) => experience.isMatched) ?? current[0];
}

/** A promotion adds a new role at the same company, so tenure starts at the earliest role there. */
export function joinedCompany(person: Person, current: Experience): string | undefined {
  const companyId = current.company?.id;
  const starts = person.experiences
    .filter((experience) => (companyId ? experience.company?.id === companyId : experience === current))
    .map((experience) => experience.startDate)
    .filter((date): date is string => typeof date === 'string' && date.length > 0)
    .sort();
  return starts[0];
}

function companyRef(experience: Experience | undefined): CompanyRef | undefined {
  const company = experience?.company;
  if (!company) return undefined;
  return { id: company.id, name: company.name ?? company.domain ?? company.id, ...(company.domain ? { domain: company.domain } : {}) };
}

export function toCandidate(person: Person, now: Date): Candidate {
  const current = currentExperience(person);
  const company = companyRef(current);
  const joined = current ? joinedCompany(person, current) : undefined;
  const tenureYears = joined ? yearsSince(joined, now) : Number.NaN;
  const location = person.location?.address ?? person.location?.country?.name;
  const linkedinUrl = person.socials.linkedinUrl;

  return {
    id: person.id,
    name: person.name ?? [person.firstName, person.lastName].filter(Boolean).join(' '),
    title: current?.position ?? person.position ?? '',
    ...(person.position ? { headline: person.position } : {}),
    ...(person.seniority ? { seniority: person.seniority } : {}),
    ...(person.department ? { department: person.department } : {}),
    ...(company ? { company } : {}),
    ...(joined ? { joinedCompany: joined } : {}),
    ...(Number.isFinite(tenureYears) ? { tenureYears } : {}),
    ...(location ? { location } : {}),
    ...(linkedinUrl ? { linkedinUrl } : {}),
  };
}

/**
 * Drops repeated profiles, keeping the first. The same person id twice is always a duplicate.
 * The dataset can also hold one person under two profile ids; rows with the same name, current
 * company and start date there are treated as one person too.
 */
export function mergeDuplicates(candidates: readonly Candidate[]): { candidates: Candidate[]; merged: number } {
  const seen = new Set<string>();
  const kept = candidates.filter((candidate) => {
    const keys = [`id:${candidate.id}`];
    if (candidate.company && candidate.joinedCompany && candidate.name) {
      keys.push(`profile:${[candidate.name.trim().toLowerCase(), candidate.company.id, candidate.joinedCompany].join('|')}`);
    }
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
  return { candidates: kept, merged: candidates.length - kept.length };
}
