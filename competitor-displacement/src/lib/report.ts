import { describePersonaFilter } from './personas.js';
import { latestRound } from './funding.js';
import type { RunRecord } from './pipeline.js';
import type { CountRow } from './sizing.js';
import { describeTier, fundingSignal, TIERS } from './tiers.js';
import type { Account, Contact } from './types.js';

const number = (value: number) => value.toLocaleString('en-US');
const share = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '-');
const cell = (value: unknown) => (value === undefined || value === null || value === '' ? '-' : String(value).replace(/\|/g, '\\|').replace(/\s+/g, ' '));

function table(headers: string[], rows: unknown[][], align: ('l' | 'r')[] = []): string {
  const divider = headers.map((_, index) => (align[index] === 'r' ? '---:' : '---'));
  return [headers, divider, ...rows.map((row) => row.map(cell))].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function breakdown(label: string, rows: readonly CountRow[], total: number): string {
  return table([label, 'Targets', 'Share'], rows.map((row) => [row.label, number(row.companies), share(row.companies, total)]), ['l', 'r', 'r']);
}

function scope(run: RunRecord): string {
  const { spec } = run;
  const parts = [
    spec.countries.length > 0 && `country ${spec.countries.join(', ')}`,
    spec.employees.length > 0 && `employees ${spec.employees.join(', ')}`,
    spec.categories.length > 0 && `category ${spec.categories.join(' or ')}`,
    spec.exclude.length > 0 && `excluding ${number(spec.exclude.length)} domains from --exclude`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'no firmographic filters';
}

function marketSection(run: RunRecord): string {
  const { market, spec } = run;
  const rows: unknown[][] = [[`Run ${spec.competitor}`, number(market.competitorInstalls)]];
  if (spec.mine && market.overlap !== undefined) rows.push([`Run ${spec.competitor} and ${spec.mine}`, number(market.overlap)]);
  rows.push([`**Targets: ${spec.competitor}${spec.mine ? `, not ${spec.mine}` : ''}**`, `**${number(market.targets)}**`]);
  return [
    '## Market size (free)',
    table(['Segment', 'Companies'], rows, ['l', 'r']),
    '### By country',
    breakdown('Country', market.byCountry, market.targets),
    '### By employee range',
    breakdown('Employees', market.byEmployees, market.targets),
  ].join('\n\n');
}

function tierSection(run: RunRecord): string {
  const now = new Date(run.startedAt);
  const rows = TIERS.map((tier) => [tier, describeTier(tier, now), number(run.tiers[tier]), share(run.tiers[tier], run.market.targets)]);
  return [
    '## Why-now tiers (free)',
    table(['Tier', 'Definition', 'Companies', 'Share'], rows, ['l', 'l', 'r', 'r']),
    `For context, ${number(run.tiers.funded)} targets match the funding signal alone (${fundingSignal(now)}), regardless of growth. Accounts are filled from tier 1 first, then tier 2, then tier 3.`,
  ].join('\n\n');
}

function accountsSection(run: RunRecord): string {
  if (run.accounts.length === 0) return '## Accounts\n\nNo accounts were fetched in this run.';
  const withFunding = run.options.withFunding;
  const headers = ['#', 'Tier', 'Company', 'Domain', 'Country', 'Employees', 'Industry', 'Why now', ...(withFunding ? ['Latest round'] : [])];
  const rows = run.accounts.map(({ rank, tier, signals, company }) => [
    rank,
    tier,
    company.name,
    company.domain,
    company.location?.country?.code,
    company.employees,
    company.industry,
    signals.join('; '),
    ...(withFunding ? [latestRound(company.financial) ?? 'none disclosed'] : []),
  ]);
  return ['## Accounts', table(headers, rows)].join('\n\n');
}

function personaSection(run: RunRecord): string {
  const { name, persona, reason, reach } = run.persona;
  return [
    '## Buyer persona',
    `**${persona.buyer}** (\`${name}\`): ${reason}.`,
    [
      `- Persona: ${describePersonaFilter(persona.primary)}`,
      `- Fallback, used at accounts where the persona has nobody: ${describePersonaFilter(persona.fallback)}`,
      `- People matching the persona across the first 1,000 target companies (free count): ${number(reach)}`,
    ].join('\n'),
  ].join('\n\n');
}

function contactsSection(run: RunRecord): string {
  if (run.contactPlan.length === 0) return '';
  const rows = run.contacts.map(({ account, person, match }) => [
    account.company.name,
    account.tier,
    person.name,
    person.position,
    person.seniority,
    match,
    person.socials.linkedinUrl,
  ]);
  const empty = run.contactPlan.filter((item) => item.take === 0).map((item) => item.account.company.domain);
  return [
    '## Contacts',
    rows.length > 0 ? table(['Company', 'Tier', 'Name', 'Position', 'Seniority', 'Match', 'LinkedIn'], rows) : 'No matching people were found.',
    empty.length > 0 ? `No one matched the persona or its fallback at ${empty.join(', ')}, so no credits were spent there.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function creditsSection(run: RunRecord): string {
  const { credits } = run;
  const lines: string[] = ['## Credits'];
  if (run.status === 'dry-run' || (run.status === 'stopped-by-budget' && credits.entries.length === 0)) {
    lines.push(run.status === 'dry-run' ? 'Dry run: nothing was spent. A real run with the same options would cost at most:' : 'Estimated cost of the paid steps (upper bound):');
    lines.push(table(['Step', 'Detail', 'Credits'], run.estimate.map((line) => [line.step, line.detail, line.credits]), ['l', 'l', 'r']));
  }
  if (credits.entries.length > 0) {
    lines.push(table(['Step', 'Call', 'Estimated', 'Charged'], credits.entries.map((entry) => [entry.step, entry.detail, entry.estimated, entry.credits]), ['l', 'l', 'r', 'r']));
  }
  const balances = credits.balanceBefore !== undefined && credits.balanceAfter !== undefined ? ` Balance before and after: ${number(credits.balanceBefore)} -> ${number(credits.balanceAfter)}.` : '';
  lines.push(`Charged by this run: **${credits.spent}** credits (cap ${credits.maxCredits}).${balances}`);
  return lines.join('\n\n');
}

function statusNote(run: RunRecord): string {
  if (run.status === 'stopped-by-budget') return `> ${run.note ?? 'Stopped by --max-credits.'}`;
  if (run.status === 'failed') return `> **The run failed part way** (${run.note ?? 'unknown error'}). The credits below were already spent.`;
  if (run.status === 'no-targets') return '> No companies match these filters, so no accounts were fetched.';
  if (run.status === 'dry-run') return '> Dry run: market size and tiers are real (free counts); accounts and contacts were not fetched.';
  return '';
}

export function renderReport(run: RunRecord): string {
  const { spec } = run;
  const title = `# Displacement report: ${spec.competitor}${spec.mine ? `, not ${spec.mine}` : ''}`;
  const intro = `Companies that run **${spec.competitor}**${spec.mine ? ` and not **${spec.mine}**` : ''}, ${scope(run)}. Run \`${run.runId}\`, ${run.startedAt.slice(0, 16).replace('T', ' ')} UTC.`;
  const sections = [title, intro, statusNote(run), marketSection(run), tierSection(run), accountsSection(run), personaSection(run), contactsSection(run), creditsSection(run)];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

function csv(headers: string[], rows: unknown[][]): string {
  const escape = (value: unknown) => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n') + '\n';
}

export function accountsCsv(accounts: readonly Account[]): string {
  return csv(
    ['rank', 'tier', 'why_now', 'name', 'domain', 'country', 'employees', 'industry', 'latest_round', 'total_funding_usd', 'linkedin_url'],
    accounts.map(({ rank, tier, signals, company }) => [
      rank,
      tier,
      signals.join('; '),
      company.name,
      company.domain,
      company.location?.country?.code,
      company.employees,
      company.industry,
      latestRound(company.financial),
      company.financial?.totalFunding,
      company.socials?.linkedinUrl,
    ]),
  );
}

export function contactsCsv(contacts: readonly Contact[]): string {
  return csv(
    ['account_rank', 'tier', 'company', 'domain', 'name', 'position', 'seniority', 'department', 'country', 'match', 'linkedin_url'],
    contacts.map(({ account, person, match }) => [
      account.rank,
      account.tier,
      account.company.name,
      account.company.domain,
      person.name,
      person.position,
      person.seniority,
      person.department,
      person.location?.country?.code,
      match,
      person.socials.linkedinUrl,
    ]),
  );
}
