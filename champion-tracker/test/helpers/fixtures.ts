import type { Company, Person } from '@companyenrich/sdk';
import type { Baseline, Experience, Seniority } from '../../src/lib/profile.js';

// Fictional people and companies on reserved .example domains.

interface RoleOptions {
  position?: string | null;
  seniority?: Seniority | null;
  start?: string | null;
  end?: string | null;
  current?: boolean;
  /** Override the company id, for example to model a company that changed its domain. */
  companyId?: string;
  companyName?: string;
}

/** An experience at a company with a CompanyEnrich record. Pass a null domain for a name-only employer. */
export function role(domain: string | null, options: RoleOptions = {}): Experience {
  const current = options.current ?? !options.end;
  const name = options.companyName ?? (domain ? capitalize(domain.split('.')[0]!) : 'Name Only Ltd');
  return {
    isCurrent: current,
    isMatched: false,
    position: options.position === undefined ? 'Director of Sales' : options.position,
    seniority: options.seniority === undefined ? 'director' : options.seniority,
    startDate: options.start === undefined ? '2023-04-01' : options.start,
    endDate: options.end ?? null,
    ...(domain ? { company: { id: options.companyId ?? `co-${domain}`, name, domain } } : { companyName: name }),
  };
}

export function person(experiences: Experience[], overrides: Partial<Person> = {}): Person {
  return {
    id: 101,
    name: 'Jane Champion',
    position: experiences[0]?.position ?? null,
    seniority: experiences[0]?.seniority ?? null,
    socials: { linkedinUrl: 'https://www.linkedin.com/in/jane-champion-example' },
    experiences,
    updatedAt: '2026-10-20T00:00:00Z',
    ...overrides,
  };
}

/** Jane, Director of Sales at Acme since April 2023. */
export function baseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    status: 'active',
    companyId: 'co-acme.example',
    companyDomain: 'acme.example',
    companyName: 'Acme',
    position: 'Director of Sales',
    seniority: 'director',
    positionStartDate: '2023-04-01',
    otherCurrentCompanies: [],
    ...overrides,
  };
}

export function company(domain: string, overrides: Partial<Company> = {}): Company {
  return {
    id: `co-${domain}`,
    name: capitalize(domain.split('.')[0]!),
    domain,
    website: `https://${domain}`,
    logoUrl: `https://logos.example/${domain}.png`,
    updatedAt: '2026-10-01T00:00:00Z',
    employees: '201-500',
    revenue: '50m-100m',
    industry: 'Software Development',
    categories: ['saas', 'b2b'],
    location: { country: { code: 'US', name: 'United States' } },
    ...overrides,
  };
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
