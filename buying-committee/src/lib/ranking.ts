import type { Person } from '@companyenrich/sdk';
import { SENIORITY_RANK } from './taxonomy';
import type { MappedPerson, RoleSpec } from './types';

const NEW_IN_ROLE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

type Experience = Person['experiences'][number];

/** The current job at this account. People can hold several current jobs. */
function currentExperience(person: Person, domain: string): Experience | undefined {
  const current = person.experiences.filter((experience) => experience.isCurrent);
  return (
    current.find((experience) => experience.company?.domain === domain) ??
    current.find((experience) => experience.isMatched) ??
    current[0]
  );
}

function monthsBetween(start: Date, end: Date): number {
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  return Math.max(0, months);
}

/** Flatten an API person into what the committee map shows. */
export function toMappedPerson(person: Person, domain: string, now: Date): MappedPerson {
  const experience = currentExperience(person, domain);
  const startDate = experience?.startDate ?? null;
  const start = startDate ? new Date(startDate) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
  const age = validStart ? now.getTime() - validStart.getTime() : null;

  return {
    id: String(person.id),
    name: person.name ?? [person.firstName, person.lastName].filter(Boolean).join(' '),
    // The experience title is cleaner than `position`, which can be a free-form headline.
    title: experience?.position ?? person.position ?? '',
    seniority: experience?.seniority ?? person.seniority ?? null,
    department: experience?.department ?? person.department ?? null,
    roleStartDate: validStart ? startDate : null,
    monthsInRole: validStart ? monthsBetween(validStart, now) : null,
    newInRole: age !== null && age >= 0 && age <= NEW_IN_ROLE_DAYS * DAY_MS,
    linkedinUrl: person.socials.linkedinUrl ?? null,
  };
}

/** Lower is better: the index of the person's seniority in the role's preference list. */
function seniorityFit(person: MappedPerson, role: RoleSpec): number {
  if (!person.seniority) return role.seniority.length + 1;
  const index = role.seniority.indexOf(person.seniority);
  return index === -1 ? role.seniority.length + SENIORITY_RANK[person.seniority] / 10 : index;
}

/** Lower is better: the index of the first title phrase the person's title contains. */
function titleFit(person: MappedPerson, role: RoleSpec): number {
  const title = person.title.toLowerCase();
  const index = role.position.findIndex((phrase) => title.includes(phrase.toLowerCase()));
  return index === -1 ? role.position.length : index;
}

/** Rank by seniority fit, then title phrase match, then longer tenure in the role. */
export function rankCandidates(people: readonly MappedPerson[], role: RoleSpec): MappedPerson[] {
  return [...people].sort(
    (a, b) =>
      seniorityFit(a, role) - seniorityFit(b, role) ||
      titleFit(a, role) - titleFit(b, role) ||
      (b.monthsInRole ?? -1) - (a.monthsInRole ?? -1),
  );
}
