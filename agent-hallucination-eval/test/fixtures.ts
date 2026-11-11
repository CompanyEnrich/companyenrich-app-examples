import type { Company } from '@companyenrich/sdk';

/** A full record, shaped like a real `companies.enrich` response with the `financial` expansion. */
export const stripe: Company = {
  id: '0192577c-1d7a-715c-a5b7-1b9b530445e0',
  name: 'Stripe',
  domain: 'stripe.com',
  website: 'https://stripe.com',
  logoUrl: 'https://api.companyenrich.com/companies/logo/0192577c-1d7a-715c-a5b7-1b9b530445e0',
  type: 'private',
  foundedYear: 2010,
  employees: 'over-10K',
  revenue: 'over-1b',
  industry: 'Finance',
  industries: ['Finance/Credit Cards & Transaction Processing'],
  categories: ['b2b', 'service-provider'],
  location: {
    country: { code: 'US', name: 'United States' },
    state: { id: 4845, name: 'California', code: 'CA' },
    city: { id: 131186, name: 'San Francisco' },
  },
  updatedAt: '2026-11-06T19:56:30.082913Z',
  financial: {
    totalFunding: 8805247725,
    fundingStage: 'secondary_market',
    fundingDate: '2026-03-09T00:00:00',
  },
};

/** A small company with no revenue, no city and no funding data: those questions must be skipped. */
export const tinyCo: Company = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Tiny Analytics',
  domain: 'tinyanalytics.example',
  website: 'https://tinyanalytics.example',
  logoUrl: 'https://api.companyenrich.com/companies/logo/01900000-0000-7000-8000-000000000001',
  foundedYear: 2018,
  employees: '1-10',
  industry: 'Media & Internet',
  categories: ['b2b', 'saas'],
  location: { country: { code: 'EE', name: 'Estonia' } },
  updatedAt: '2026-10-01T00:00:00Z',
};

/** Placeholder funding values that must not become gold answers. */
export const placeholderCo: Company = {
  id: '01900000-0000-7000-8000-000000000002',
  name: 'Placeholder Inc',
  domain: 'placeholder.example',
  website: 'https://placeholder.example',
  logoUrl: 'https://api.companyenrich.com/companies/logo/01900000-0000-7000-8000-000000000002',
  foundedYear: 1999,
  employees: '51-200',
  revenue: '10m-50m',
  industry: 'Software',
  categories: ['b2b'],
  location: { country: { code: 'US', name: 'United States' }, city: { id: 1, name: 'Chicago' } },
  updatedAt: '2026-10-01T00:00:00Z',
  financial: { totalFunding: 1, fundingStage: 'undisclosed' },
};

export const industries = [
  { name: 'Finance', naicsCodes: ['52'] },
  { name: 'Finance/Credit Cards & Transaction Processing', naicsCodes: ['5222'] },
  { name: 'Media & Internet', naicsCodes: ['519'] },
  { name: 'Energy, Utilities & Waste', naicsCodes: ['22'] },
  { name: 'Software', naicsCodes: ['5112'] },
];
