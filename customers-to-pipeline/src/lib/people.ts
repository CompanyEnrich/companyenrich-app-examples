import type { Person } from '@companyenrich/sdk';
import { MAX_CONCURRENCY, mapLimit } from './concurrency.js';
import type { CompanyEnrich, PersonSearchFilter } from './types.js';

const LEADERSHIP: PersonSearchFilter['seniority'] = ['c-suite', 'vp', 'head', 'director'];

/**
 * Who to reach at each account. A department root such as `sales` includes its sub-departments, and
 * the `c-suite/...` department catches the matching C-level title (CRO, CTO, CMO, CFO).
 */
export const PERSONAS = {
  'sales-leader': {
    seniority: LEADERSHIP,
    department: ['sales', 'c-suite/sales-executive'],
    // The sales department also holds customer success and account management leads; these title
    // phrases keep the list to people who own new revenue.
    position: ['sales', 'revenue', 'business development', 'partnerships', 'go-to-market'],
  },
  'eng-leader': {
    seniority: LEADERSHIP,
    department: ['engineering-technical', 'c-suite/information-technology-executive'],
  },
  'marketing-leader': {
    seniority: LEADERSHIP,
    department: ['marketing', 'c-suite/marketing-executive'],
  },
  founder: {
    seniority: ['founder', 'owner'],
  },
  'finance-leader': {
    seniority: LEADERSHIP,
    department: ['finance', 'c-suite/finance-executive'],
  },
} satisfies Record<string, PersonSearchFilter>;

export type PersonaName = keyof typeof PERSONAS;

export function isPersona(name: string): name is PersonaName {
  return Object.hasOwn(PERSONAS, name);
}

function personaFilter(persona: PersonaName, domain: string): PersonSearchFilter {
  return { ...PERSONAS[persona], domain };
}

/** Free count of persona matches at each account. */
export function countPeople(client: CompanyEnrich, domains: readonly string[], persona: PersonaName): Promise<number[]> {
  return mapLimit(domains, MAX_CONCURRENCY, async (domain) => {
    const { count } = await client.people.count({ filter: personaFilter(persona, domain) });
    return count;
  });
}

/**
 * Spreads `wanted` contacts across accounts in rank order, one per account per pass, so the best
 * accounts get covered first and an account with nobody left is skipped.
 */
export function allocateContacts(available: readonly number[], wanted: number): number[] {
  const allocation = available.map(() => 0);
  let remaining = wanted;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    available.forEach((count, index) => {
      if (remaining > 0 && (allocation[index] ?? 0) < count) {
        allocation[index] = (allocation[index] ?? 0) + 1;
        remaining--;
        progressed = true;
      }
    });
  }
  return allocation;
}

export async function findPeople(client: CompanyEnrich, domain: string, persona: PersonaName, pageSize: number): Promise<Person[]> {
  const { items } = await client.people.search({ filter: personaFilter(persona, domain), pageSize });
  return items;
}
