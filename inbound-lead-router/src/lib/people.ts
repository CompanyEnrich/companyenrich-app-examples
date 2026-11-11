import type { CompanyEnrich, Person } from '@companyenrich/sdk';
import type { TtlCache } from './cache';
import type { ApiCall } from './client';
import { SingleFlight } from './concurrency';
import type { Persona } from './config';
import { peopleSearchCost, type Budget } from './credits';
import { certainlyNotBilled } from './errors';

// Finds two or three relevant people at a tier A account. The free count runs
// first, so an account with nobody matching the persona costs nothing. Results
// are cached for 24 hours and concurrent lookups for one account share a single
// call, so a repeat or simultaneous signup from the same account is free.

export interface PersonSummary {
  name: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  linkedinUrl: string | null;
  country: string | null;
}

export interface PeopleLookup {
  /** People matching the persona at the company (free count). */
  matching: number;
  people: PersonSummary[];
}

export type PeopleCache = TtlCache<PeopleLookup>;

export type PeopleResult =
  | (PeopleLookup & { status: 'found' | 'none-found'; source: 'api' | 'cache' | 'shared'; credits: number })
  | { status: 'over-budget'; matching: number; reason: string }
  /** The search failed; `uncertainCredits` is what it may still have used (5xx, timeout). */
  | { status: 'failed'; error: unknown; uncertainCredits: number };

type PersonFilter = NonNullable<NonNullable<Parameters<CompanyEnrich['people']['search']>[0]>['filter']>;

export function personaFilter(domain: string, persona: Persona): PersonFilter {
  return {
    domain,
    ...(persona.seniority?.length ? { seniority: persona.seniority } : {}),
    ...(persona.department?.length ? { department: persona.department } : {}),
    ...(persona.position?.length ? { position: persona.position } : {}),
  };
}

export class PeopleLookups {
  private readonly flights = new SingleFlight<PeopleResult>();

  constructor(
    private readonly call: ApiCall,
    private readonly cache: PeopleCache,
  ) {}

  async find(query: { domain: string; persona: Persona; pageSize: number }, budget: Budget): Promise<PeopleResult> {
    const filter = personaFilter(query.domain, query.persona);
    const key = JSON.stringify({ filter, pageSize: query.pageSize });
    const cached = this.cache.get(key);
    if (cached) return { ...cached.value, status: cached.value.people.length ? 'found' : 'none-found', source: 'cache', credits: 0 };

    const running = this.flights.pending(key);
    if (running) {
      // Another request for this account made the calls; this one spent nothing.
      const shared = await running;
      if (shared.status === 'found' || shared.status === 'none-found') return { ...shared, source: 'shared', credits: 0 };
      if (shared.status === 'failed') return { ...shared, uncertainCredits: 0 };
      return shared;
    }
    return this.flights.start(key, () => this.lookup(key, filter, query, budget));
  }

  private async lookup(key: string, filter: PersonFilter, query: { domain: string; pageSize: number }, budget: Budget): Promise<PeopleResult> {
    let count: number;
    try {
      count = (await this.call((client) => client.people.count({ filter }))).count;
    } catch (error) {
      return { status: 'failed', error, uncertainCredits: 0 }; // counts are free
    }
    if (count === 0) {
      this.cache.set(key, { matching: 0, people: [] });
      return { status: 'none-found', matching: 0, people: [], source: 'api', credits: 0 };
    }

    // Ask for no more people than exist, so the reservation is the real worst case.
    const pageSize = Math.min(count, query.pageSize);
    const estimate = peopleSearchCost(pageSize);
    const reservation = budget.reserve(estimate);
    if (!reservation.ok) return { status: 'over-budget', matching: count, reason: reservation.reason };

    let items: Person[];
    try {
      items = (await this.call((client) => client.people.search({ filter, pageSize }))).items;
    } catch (error) {
      const uncertainCredits = certainlyNotBilled(error) ? 0 : estimate;
      budget.settle(reservation.hold, uncertainCredits);
      return { status: 'failed', error, uncertainCredits };
    }
    const credits = peopleSearchCost(items.length);
    budget.settle(reservation.hold, credits);
    const lookup: PeopleLookup = { matching: count, people: items.map((person) => summarize(person, query.domain)) };
    this.cache.set(key, lookup);
    return { ...lookup, status: lookup.people.length ? 'found' : 'none-found', source: 'api', credits };
  }
}

/**
 * A person can hold several current roles, such as an investor with a board seat.
 * Show the role that matched the search at this account, not their headline role elsewhere.
 */
function summarize(person: Person, domain: string): PersonSummary {
  const current = person.experiences.filter((experience) => experience.isCurrent);
  const role = current.find((experience) => experience.isMatched) ?? current.find((experience) => experience.company?.domain === domain);
  return {
    name: person.name ?? null,
    position: role?.position ?? person.position ?? null,
    seniority: role?.seniority ?? person.seniority ?? null,
    department: role?.department ?? person.department ?? null,
    linkedinUrl: person.socials?.linkedinUrl ?? null,
    country: person.location?.country?.code ?? null,
  };
}
