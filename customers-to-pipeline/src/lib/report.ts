import type { Person } from '@companyenrich/sdk';
import { toCsv } from './csv.js';
import type { DerivedIcp } from './icp.js';
import type { Account } from './lookalikes.js';
import type { MarketSize } from './market.js';
import { DIMENSIONS, type Dimension, type Profile } from './profile.js';
import type { CompanySearchFilter } from './types.js';

const TITLES: Record<Dimension, string> = {
  industry: 'Industry (every industry listed on a company)',
  categories: 'Categories',
  employees: 'Employees',
  revenue: 'Revenue',
  country: 'Country',
  foundedYear: 'Founded (by decade)',
  technologies: 'Technologies',
};

// The profile dimension behind each filter key the ICP builder writes.
const FILTER_KEY: Record<Dimension, keyof CompanySearchFilter> = {
  industry: 'naicsCodes',
  categories: 'categories',
  employees: 'employees',
  revenue: 'revenue',
  country: 'country',
  foundedYear: 'foundedYear',
  technologies: 'technologies',
};

const MAX_ROWS = 10;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const number = (value: number) => value.toLocaleString('en-US');

export interface ProfileReport {
  csvPath: string;
  date: string;
  minShare: number;
  profile: Profile;
  icp: DerivedIcp;
  market: MarketSize;
}

export function renderProfile({ csvPath, date, minShare, profile, icp, market }: ProfileReport): string {
  const lines: string[] = [
    '# Customer profile',
    '',
    `${profile.customers} enriched customers from \`${csvPath}\`, profiled on ${date}.`,
    `A value joins the ICP when at least ${percent(minShare)} of customers share it (\`--min-share ${minShare}\`).`,
    '',
    '## ICP',
    '',
    '| Dimension | ICP values | Search filter |',
    '| --- | --- | --- |',
  ];
  const skipped: string[] = [];
  for (const dimension of DIMENSIONS) {
    const values = icp.selected[dimension];
    const key = FILTER_KEY[dimension];
    if (values) {
      lines.push(`| ${dimension} | ${values.join(', ')} | \`${key}: ${JSON.stringify(icp.filter[key])}\` |`);
    } else if (profile.unknown[dimension] < profile.customers) {
      skipped.push(dimension);
    }
  }
  if (skipped.length > 0) lines.push('', `Left out because no value reached ${percent(minShare)}: ${skipped.join(', ')}.`);

  lines.push('', '## Market size', '');
  lines.push(`**${number(market.count)}** companies match the ICP (free count; ${number(market.total)} before plan limits).`);
  if (market.relaxed.length > 0) {
    lines.push('', 'The full ICP matched no companies, so dimensions were dropped one at a time, most restrictive first:', '');
    for (const step of market.relaxed) {
      lines.push(`- ${step.dimension} (${number(step.soloTotal)} companies on its own): ${number(step.countAfter)} matches after dropping it`);
    }
  }

  lines.push('', '## Customer distributions');
  for (const dimension of DIMENSIONS) {
    if (profile.unknown[dimension] === profile.customers) continue; // no data, e.g. technologies without --with-tech
    const picked = new Set(icp.selected[dimension]);
    const rows = profile.dimensions[dimension];
    lines.push('', `### ${TITLES[dimension]}`, '', '| Value | Customers | Share | In ICP |', '| --- | ---: | ---: | --- |');
    for (const row of rows.slice(0, MAX_ROWS)) {
      lines.push(`| ${row.value} | ${row.customers} | ${percent(row.share)} | ${picked.has(row.value) ? 'yes' : ''} |`);
    }
    if (rows.length > MAX_ROWS) lines.push(`| ${rows.length - MAX_ROWS} more values | | | |`);
    if (profile.unknown[dimension] > 0) lines.push(`| (unknown) | ${profile.unknown[dimension]} | | |`);
  }
  return lines.join('\n') + '\n';
}

export interface IcpFileContent {
  about: string;
  filter: CompanySearchFilter;
  industries?: Record<string, readonly string[]>;
}

/** icp.json keeps `filter` first: it is the part to edit before re-running with --icp. */
export function renderIcpFile({ about, filter, industries }: IcpFileContent): string {
  return JSON.stringify({ filter, about, ...(industries ? { industries } : {}) }, null, 2) + '\n';
}

export const ACCOUNT_COLUMNS = ['rank', 'domain', 'name', 'score', 'industry', 'employees', 'country', 'matched_icp_dimensions'] as const;

export function accountsCsv(accounts: readonly Account[]): string {
  return toCsv(
    ACCOUNT_COLUMNS,
    accounts.map(({ rank, company, score, matched }) => [
      rank,
      company.domain,
      company.name ?? '',
      score === undefined ? '' : score.toFixed(3),
      company.industry ?? '',
      company.employees ?? '',
      company.location?.country?.code ?? '',
      matched.join('; '),
    ]),
  );
}

export interface Contact {
  account: string;
  person: Person;
}

export const CONTACT_COLUMNS = ['account', 'name', 'title', 'seniority', 'department', 'linkedin_url'] as const;

export function contactsCsv(contacts: readonly Contact[]): string {
  return toCsv(
    CONTACT_COLUMNS,
    contacts.map(({ account, person }) => [
      account,
      person.name ?? '',
      person.position ?? '',
      person.seniority ?? '',
      person.department ?? '',
      person.socials.linkedinUrl ?? '',
    ]),
  );
}
