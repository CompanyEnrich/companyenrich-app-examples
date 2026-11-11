import type { CreditEstimate } from './credits';
import type { EmailReveal } from './email';
import { coverageMatrix } from './matrix';
import { BAND_LABELS } from './size';
import type { CommitteeMap, CoveragePlan, MappedPerson } from './types';

/** Revealed emails keyed by person id. */
export type EmailBook = Record<string, EmailReveal>;

const CSV_COLUMNS = [
  'domain', 'company', 'employees', 'role_key', 'role', 'matching_people', 'status',
  'person_id', 'name', 'title', 'seniority', 'department', 'months_in_role', 'new_in_role',
  'linkedin_url', 'email', 'email_certainty', 'note',
] as const;

type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null>>;

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Quote when needed, and neutralise spreadsheet formulas in untrusted text.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(rows: CsvRow[]): string {
  return [CSV_COLUMNS.join(','), ...rows.map((row) => CSV_COLUMNS.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
}

/** One row per account x role, before any people are fetched. */
export function coverageCsv(plan: CoveragePlan): string {
  return toCsv(
    plan.accounts.flatMap(({ account, roles }) =>
      roles.map(({ role, count }) => ({
        domain: account.domain, company: account.name, employees: account.employees, role_key: role.key, role: role.label,
        matching_people: count, status: count > 0 ? 'not-fetched' : 'gap',
      })),
    ),
  );
}

/** One row per mapped person, plus one row per gap. */
export function committeeCsv(map: CommitteeMap, emails: EmailBook = {}): string {
  const rows: CsvRow[] = [];
  for (const { account, roles, gaps } of map.accounts) {
    const base = { domain: account.domain, company: account.name, employees: account.employees };
    for (const { role, count, people } of roles) {
      for (const person of people) {
        const email = emails[person.id];
        rows.push({
          ...base, role_key: role.key, role: role.label, matching_people: count, status: 'mapped',
          person_id: person.id, name: person.name, title: person.title, seniority: person.seniority,
          department: person.department, months_in_role: person.monthsInRole, new_in_role: person.newInRole,
          linkedin_url: person.linkedinUrl, email: email?.email ?? null, email_certainty: email?.certainty ?? null,
        });
      }
      const gap = gaps.find((candidate) => candidate.roleKey === role.key);
      if (gap) rows.push({ ...base, role_key: role.key, role: role.label, matching_people: count, status: 'gap', note: `${gap.reason} ${gap.suggestion}` });
    }
  }
  return toCsv(rows);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function coverageMarkdown(plan: CoveragePlan): string {
  const matrix = coverageMatrix(plan);
  const lines = [
    `| Account | Employees | ${matrix.columns.map((column) => column.label).join(' | ')} |`,
    `| --- | --- | ${matrix.columns.map(() => '---:').join(' | ')} |`,
    ...matrix.rows.map(
      ({ account, cells, singleThreaded }) =>
        `| ${escapeCell(account.name)} (${account.domain})${singleThreaded ? ' **single-threaded**' : ''} | ${account.employees ?? '?'} | ${cells.map((cell) => (cell === null ? '-' : String(cell))).join(' | ')} |`,
    ),
  ];
  for (const { domain, reason } of plan.unresolved) lines.push(`\nSkipped ${domain}: ${reason}`);
  return lines.join('\n');
}

export function personLine(person: MappedPerson, email?: EmailReveal): string {
  const parts = [
    `${person.name}, ${person.title || 'no title'}`,
    person.seniority ?? 'seniority unknown',
    person.monthsInRole === null ? 'tenure unknown' : `${person.monthsInRole} mo in role`,
  ];
  if (person.newInRole) parts.push('NEW IN ROLE');
  if (email?.email) parts.push(`${email.email} (certainty: ${email.certainty ?? 'unknown'})`);
  if (person.linkedinUrl) parts.push(person.linkedinUrl);
  return parts.join(' · ');
}

export function committeeMarkdown(map: CommitteeMap, emails: EmailBook = {}): string {
  const sections = map.accounts.map(({ account, adaptation, roles, gaps, singleThreaded }) => {
    const lines = [`### ${account.name} (${account.domain}), ${account.employees ?? 'size unknown'} employees`, ''];
    if (singleThreaded) lines.push('**Single-threaded:** this deal depends on one contact or fewer.', '');
    lines.push(...adaptation.map((note) => `> ${note}`), '');
    for (const { role, count, people, notes } of roles) {
      lines.push(`**${role.label}** (${count} matching) - ${role.why}`);
      for (const person of people) lines.push(`- ${personLine(person, emails[person.id])}`);
      const gap = gaps.find((candidate) => candidate.roleKey === role.key);
      if (gap) lines.push(`- GAP: ${gap.reason} Suggestion: ${gap.suggestion}`);
      for (const note of notes.filter((note) => !gap?.reason.includes(note))) lines.push(`- Note: ${note}`);
      lines.push('');
    }
    return lines.join('\n');
  });
  return sections.join('\n');
}

export function reportMarkdown(input: {
  plan: CoveragePlan;
  notes: string[];
  estimate: CreditEstimate;
  map?: CommitteeMap;
  emails?: EmailBook;
  creditsSpent: number;
}): string {
  const { plan, notes, estimate, map, emails, creditsSpent } = input;
  const parts = [
    `# Buying committee: ${plan.blueprint.name}`,
    '',
    ...notes.map((note) => `- ${note}`),
    '',
    '## Coverage (free people counts per role)',
    '',
    coverageMarkdown(plan),
    '',
    ...plan.accounts.map(({ account, adaptation }) => `- ${account.name} (${BAND_LABELS[account.band]}): ${adaptation.join(' ')}`),
    '',
    `Mapping people would cost up to ${estimate.maxCredits} credits.`,
  ];
  if (map) {
    parts.push('', '## Role map', '');
    if (map.stoppedEarly) parts.push(`**Stopped early:** ${map.stoppedEarly} People found before the error are kept below.`, '');
    parts.push(committeeMarkdown(map, emails));
  }
  parts.push('', `Credits spent by this run: ${creditsSpent}.`, '');
  return parts.join('\n');
}
