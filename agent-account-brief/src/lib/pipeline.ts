import type { Target } from './input';
import type { CompanyFacts, LookalikeFacts, PersonFacts, WorkforceFacts } from './projections';
import {
  currentCompanyDomain,
  enrichCompany,
  findLookalikes,
  findPeople,
  getWorkforce,
  lookupPersonByEmail,
  type Department,
  type FindPeopleInput,
  type Seniority,
  type ToolContext,
} from './tools';

export type Depth = 'quick' | 'full';

export interface PeopleGroup {
  label: string;
  matched: number;
  people: PersonFacts[];
}

/** Everything the deterministic pipeline gathered for one account. */
export interface Research {
  domain: string;
  depth: Depth;
  company: CompanyFacts;
  workforce?: WorkforceFacts;
  peopleGroups: PeopleGroup[];
  lookalikes?: LookalikeFacts[];
  /** The person behind the input email, when the input was an email. */
  contact?: PersonFacts;
  /** Steps that returned nothing or were refused by the budget. */
  gaps: Gap[];
}

export interface Gap {
  step: 'workforce' | 'people' | 'lookalikes';
  message: string;
}

export type PipelineResult =
  | { status: 'ok'; research: Research }
  | { status: 'dry-run'; domain: string }
  | { status: 'error'; error: string };

const LOOKALIKES = 3;
const EXECUTIVES: Seniority[] = ['c-suite', 'founder', 'vp'];
const DEPARTMENT_LEADER_SENIORITY: Seniority[] = ['vp', 'head', 'director'];
const DEPARTMENT_LEADERS: { label: string; department: Department }[] = [
  { label: 'Sales leaders', department: 'sales' },
  { label: 'Engineering leaders', department: 'engineering-technical' },
  { label: 'Marketing leaders', department: 'marketing' },
];

/**
 * The people searches for each depth. At full depth the executive search leaves out the three
 * departments searched separately, so no person is paid for twice.
 */
export function peopleQueries(depth: Depth): { label: string; input: Omit<FindPeopleInput, 'domain'> }[] {
  if (depth === 'quick') return [{ label: 'Executives', input: { seniority: EXECUTIVES, limit: 3 } }];
  return [
    {
      label: 'Executives',
      input: { seniority: EXECUTIVES, excludeDepartment: DEPARTMENT_LEADERS.map((group) => group.department), limit: 3 },
    },
    ...DEPARTMENT_LEADERS.map(({ label, department }) => ({
      label,
      input: { seniority: DEPARTMENT_LEADER_SENIORITY, department: [department], limit: 2 },
    })),
  ];
}

/**
 * Deterministic research plan, no LLM:
 * quick = company with funding + 3 executives;
 * full  = adds technologies, workforce, 2 leaders each in sales, engineering and marketing, and 3 lookalikes.
 */
export async function runPipeline(ctx: ToolContext, target: Target, depth: Depth): Promise<PipelineResult> {
  const gaps: Gap[] = [];
  let domain: string;
  let contact: PersonFacts | undefined;

  if (target.kind === 'email') {
    const lookup = await lookupPersonByEmail(ctx, { email: target.email });
    if (lookup.status === 'error') return lookup;
    if (lookup.status === 'dry-run') {
      domain = target.emailDomain;
      ctx.log(`note: a dry run cannot resolve the email for free, so the estimate assumes the company is ${domain}`);
    } else {
      contact = lookup.data.person;
      const resolved = currentCompanyDomain(contact);
      if (!resolved) return { status: 'error', error: 'found the person, but their record has no current company domain' };
      domain = resolved;
    }
  } else {
    domain = target.domain;
  }

  const enrich = await enrichCompany(ctx, { domain, includeFunding: true, includeTech: depth === 'full' });
  if (enrich.status === 'error') return enrich;
  const company = enrich.status === 'ok' ? enrich.data.company : undefined;

  let workforce: WorkforceFacts | undefined;
  if (depth === 'full') {
    const outcome = await getWorkforce(ctx, { domain });
    if (outcome.status === 'ok') workforce = outcome.data.workforce;
    if (outcome.status === 'error') gaps.push({ step: 'workforce', message: outcome.error });
  }

  const peopleGroups: PeopleGroup[] = [];
  for (const { label, input } of peopleQueries(depth)) {
    const outcome = await findPeople(ctx, { domain, ...input });
    if (outcome.status === 'ok') peopleGroups.push({ label, matched: outcome.data.matched, people: outcome.data.people });
    if (outcome.status === 'error') gaps.push({ step: 'people', message: `${label}: ${outcome.error}` });
  }

  let lookalikes: LookalikeFacts[] | undefined;
  if (depth === 'full') {
    const outcome = await findLookalikes(ctx, { domain, limit: LOOKALIKES });
    if (outcome.status === 'ok') lookalikes = outcome.data.lookalikes;
    if (outcome.status === 'error') gaps.push({ step: 'lookalikes', message: outcome.error });
  }

  if (ctx.dryRun || !company) return { status: 'dry-run', domain };
  return { status: 'ok', research: { domain, depth, company, workforce, peopleGroups, lookalikes, contact, gaps } };
}
