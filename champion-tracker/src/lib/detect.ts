import type { Person } from '@companyenrich/sdk';
import {
  type Baseline,
  type Experience,
  baselineAt,
  companyKey,
  currentExperiences,
  isAtCompany,
  isSideRole,
  pickPrimary,
  sameTitle,
  seniorityRank,
  startedAfter,
  unique,
} from './profile.js';

/**
 * The outcome of comparing a fresh profile with the stored baseline. Every variant except
 * "unknown" carries the baseline to store for the next check.
 */
export type Change =
  | { kind: 'none'; baseline: Baseline }
  /** "confirmed": the old role is closed. "likely": the old role is still listed as current too. */
  | { kind: 'moved'; confidence: 'confirmed' | 'likely'; from: Baseline; to: Experience; baseline: Baseline }
  | { kind: 'promoted'; from: Baseline; to: Experience; baseline: Baseline }
  /** No new employer. `otherRoles` are current roles the champion already held, such as a side business. */
  | { kind: 'left'; from: Baseline; otherRoles: Experience[]; baseline: Baseline }
  | { kind: 'unknown'; reason: string };

export type Alert = Extract<Change, { kind: 'moved' | 'promoted' | 'left' }>;

export function detectChange(previous: Baseline, person: Person, lastCheckedAt: string): Change {
  // An empty work history is a data gap, not proof that someone left.
  if (person.experiences.length === 0) {
    return { kind: 'unknown', reason: 'the profile has no work history right now, so the baseline was kept' };
  }

  const current = currentExperiences(person);
  const atCompany = current.filter((experience) => isAtCompany(experience, previous));
  const elsewhere = current.filter((experience) => !isAtCompany(experience, previous) && !isSideRole(experience));
  const newElsewhere = elsewhere.filter((experience) => !previous.otherCurrentCompanies.includes(companyKey(experience)));

  if (previous.status === 'left') {
    // Back at the old company, or the old role reappeared after a data refresh: nothing to report.
    const returned = pickPrimary(atCompany);
    if (returned) return { kind: 'none', baseline: baselineAt(returned, current) };
    const destination = pickPrimary(newElsewhere);
    if (!destination) return { kind: 'none', baseline: previous };
    return { kind: 'moved', confidence: 'confirmed', from: previous, to: destination, baseline: baselineAt(destination, current) };
  }

  if (atCompany.length > 0) {
    // Still listed at the company. A new current role elsewhere usually means the person moved and
    // has not closed the old role yet. Roles that started before the tracked one are older entries
    // that only now appeared in the data, so they are ignored.
    const likelyMove = pickPrimary(
      newElsewhere.filter((experience) => !startedAfter(previous.positionStartDate, experience.startDate)),
    );
    if (likelyMove) {
      return { kind: 'moved', confidence: 'likely', from: previous, to: likelyMove, baseline: baselineAt(likelyMove, current) };
    }
    const role = pickPrimary(atCompany)!;
    const baseline = baselineAt(role, current);
    return isPromotion(previous, role, lastCheckedAt) ? { kind: 'promoted', from: previous, to: role, baseline } : { kind: 'none', baseline };
  }

  // Only an employer that was not already listed counts as a destination. A side business the
  // champion has run for years is not a new job, so ending the main role with only that left is a departure.
  const destination = pickPrimary(newElsewhere);
  if (destination) {
    return { kind: 'moved', confidence: 'confirmed', from: previous, to: destination, baseline: baselineAt(destination, current) };
  }
  return {
    kind: 'left',
    from: previous,
    otherRoles: current,
    baseline: { ...previous, status: 'left', otherCurrentCompanies: unique(current.map(companyKey)) },
  };
}

/**
 * A promotion needs a new title plus either a higher seniority or a later start date. A title
 * edit alone is usually a profile clean-up, and a lower seniority is not worth an alert.
 */
function isPromotion(previous: Baseline, role: Experience, lastCheckedAt: string): boolean {
  if (sameTitle(previous.position, role.position)) return false;
  const before = seniorityRank(previous.seniority);
  const after = seniorityRank(role.seniority);
  if (before !== null && after !== null && after !== before) return after > before;
  // Without a stored start date, a role that started after the last check is new.
  return startedAfter(role.startDate, previous.positionStartDate ?? lastCheckedAt);
}
