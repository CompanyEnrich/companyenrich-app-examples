import type { CreditBudget } from './budget';
import { renderSources, resolveCitations } from './citations';
import {
  cell,
  count,
  departmentLabel,
  employeeRange,
  fundingStage,
  isoDate,
  listing,
  money,
  percent,
  revenueRange,
  roundAmount,
  tenure,
} from './format';
import { observations } from './observations';
import type { Research } from './pipeline';
import type { FundingRound, LookalikeFacts, PersonFacts } from './projections';
import type { ToolCallRecord } from './tools';

const FUNDING_ROUNDS_SHOWN = 3;
const DEPARTMENTS_SHOWN = 6;

export interface Balance {
  before: number;
  after: number;
}

/** The brief body for pipeline mode: title through observations. Sources and credits are appended by assembleBrief. */
export function renderBrief(research: Research, now: Date): string {
  const { company } = research;
  return [
    `# Account brief: ${company.name ?? research.domain} (${research.domain})`,
    snapshot(research),
    funding(research),
    team(research),
    people(research),
    research.depth === 'full' ? lookalikes(research) : undefined,
    talkingPoints(research, now),
  ]
    .filter((section) => section !== undefined)
    .join('\n\n');
}

/** Adds the run details under the title, then the Sources and Credits sections. Used by both modes. */
export function assembleBrief(options: {
  body: string;
  runLine: string;
  calls: ToolCallRecord[];
  budget: CreditBudget;
  balance: Balance;
}): string {
  const [title, ...rest] = options.body.trim().split('\n');
  return [
    [title, '', options.runLine, ...rest].join('\n'),
    renderSources(resolveCitations(options.body, options.calls)),
    `## Credits used\n\n${renderLedger(options.budget, options.balance)}`,
  ].join('\n\n') + '\n';
}

/** The ledger table plus the cap and the before/after balance from me(). */
export function renderLedger(budget: CreditBudget, balance: Balance | undefined, dryRun = false): string {
  const lines = ['| # | Tool | Arguments | Estimated | Reserved |', '|---:|---|---|---:|---:|'];
  budget.ledger.forEach((entry, index) => {
    const args = entry.refused ? `${entry.args} (refused: ${entry.refused})` : entry.args;
    lines.push(`| ${index + 1} | ${entry.tool} | ${cell(args)} | ${entry.estimated ?? '-'} | ${entry.reserved} |`);
  });
  lines.push(`| | **Total** | | **${budget.estimated}** | **${budget.reserved}** |`);
  lines.push(
    '',
    dryRun
      ? `Dry run: nothing was charged. Estimated is what a live run would spend; Reserved is what it would hold against the ${budget.maxCredits}-credit cap.`
      : `Reserved is the worst case held before each call; Estimated is what the response implies was billed. Cap: ${budget.maxCredits} credits (--max-credits), ${budget.remaining} left unreserved.`,
  );
  if (balance) {
    const used = round2(balance.before - balance.after);
    lines.push(
      '',
      `Balance from me(): ${count(balance.before)} before, ${count(balance.after)} after (${count(used)} used while this ran).`,
    );
  }
  return lines.join('\n');
}

function snapshot({ company, domain }: Research): string {
  const { location } = company;
  const hqParts = [location?.city?.name, location?.state?.name, location?.country?.name].filter(Boolean);
  const hqPaths = [
    location?.city && 'company.location.city.name',
    location?.state && 'company.location.state.name',
    location?.country && 'company.location.country.name',
  ].filter(Boolean);
  const rows: [string, string | undefined, string][] = [
    ['Name', company.name, 'company.name'],
    ['Domain', company.domain ?? domain, 'company.domain'],
    ['Industry', company.industry, 'company.industry'],
    ['Size range', company.employees && `${employeeRange(company.employees)} employees`, 'company.employees'],
    ['Revenue range', company.revenue && revenueRange(company.revenue), 'company.revenue'],
    ['Founded', company.foundedYear?.toString(), 'company.foundedYear'],
    ['HQ', hqParts.length > 0 ? hqParts.join(', ') : undefined, hqPaths.join(', ')],
    ['Type', company.type && company.type.charAt(0).toUpperCase() + company.type.slice(1), 'company.type'],
  ];
  const table = [
    '| Field | Value | Source |',
    '|---|---|---|',
    ...rows.map(([label, value, path]) => `| ${label} | ${cell(value)} | ${value ? `[${path}]` : '-'} |`),
  ];
  const description = company.description ? `\n\n${company.description} [company.description]` : '';
  return `## Snapshot\n\n${table.join('\n')}${description}`;
}

function funding({ company }: Research): string {
  const financial = company.financial;
  if (!financial) return '## Funding\n\nNot available: the financial expansion returned no funding data.';
  const lines: string[] = [];
  if (financial.stockSymbol) {
    lines.push(`- Publicly traded: ${listing(financial.stockSymbol, financial.stockExchange)} [company.financial.stockSymbol]`);
  }
  if (financial.fundingStage) lines.push(`- Latest stage: ${fundingStage(financial.fundingStage)} [company.financial.fundingStage]`);
  if (financial.fundingDate) lines.push(`- Latest round date: ${isoDate(financial.fundingDate)} [company.financial.fundingDate]`);
  if (financial.totalFunding) lines.push(`- Total disclosed funding: ${money(financial.totalFunding)} [company.financial.totalFunding]`);

  const rounds = financial.fundingRounds?.slice(0, FUNDING_ROUNDS_SHOWN) ?? [];
  if (rounds.length > 0) {
    const has = (field: keyof FundingRound) => rounds.some((round) => round[field] !== undefined);
    const path = (field: keyof FundingRound) => `company.financial.fundingRounds.${field}`;
    lines.push(
      '',
      `| ${column('Date', path('date'), has('date'))} | ${column('Round', path('type'), has('type'))} | ${column('Amount', path('amount'), has('amount'))} | ${column('Investors', path('investors'), has('investors'))} |`,
      '|---|---|---|---|',
      ...rounds.map(
        (round) =>
          `| ${cell(round.date && isoDate(round.date))} | ${cell(round.type)} | ${cell(roundAmount(round.amount))} | ${cell(round.investors)} |`,
      ),
    );
    const total = financial.fundingRoundsTotal ?? rounds.length;
    if (total > rounds.length) {
      lines.push('', `The ${rounds.length} most recent of ${total} disclosed rounds [company.financial.fundingRoundsTotal].`);
    }
  }
  return `## Funding\n\n${lines.length > 0 ? lines.join('\n') : 'Not available.'}`;
}

function team({ company, workforce, depth, gaps }: Research): string {
  const lines: string[] = [];
  if (company.employees) lines.push(`- Size range: ${employeeRange(company.employees)} employees [company.employees]`);
  if (depth === 'quick') {
    lines.push('- Observed headcount, department mix and 12-month change: fetched at full depth (`--depth full`).');
    return `## Team and growth\n\n${lines.join('\n')}`;
  }
  if (!workforce) {
    const gap = gaps.find((item) => item.step === 'workforce');
    lines.push(`- Workforce data: not available${gap ? ` (${gap.message})` : ''}.`);
    return `## Team and growth\n\n${lines.join('\n')}`;
  }

  lines.push(
    `- Observed headcount: ${count(workforce.observedEmployeeCount)} [workforce.observedEmployeeCount]. This counts people CompanyEnrich can see in its people data, not an official headcount.`,
  );
  const change = workforce.change12m;
  lines.push(
    change
      ? `- 12-month change: ${percent(change.pct, true)} (${count(change.fromCount)} on ${change.fromDate} to ${count(change.toCount)} on ${change.toDate}) [workforce.change12m]`
      : '- 12-month change: not available.',
  );

  const departments = Object.entries(workforce.departmentHeadcount).slice(0, DEPARTMENTS_SHOWN);
  if (departments.length > 0) {
    lines.push(
      '',
      `| Department | Headcount [workforce.departmentHeadcount] | Share [workforce.departmentShare] | ${column('12-month change', 'workforce.departmentChange12m', departments.some(([key]) => workforce.departmentChange12m?.[key]))} |`,
      '|---|---:|---:|---:|',
      ...departments.map(([key, headcount]) => {
        const share = workforce.departmentShare[key];
        const growth = workforce.departmentChange12m?.[key];
        return `| ${departmentLabel(key)} | ${count(headcount)} | ${share === undefined ? '-' : percent(share)} | ${growth ? percent(growth.pct, true) : '-'} |`;
      }),
    );
  }
  return `## Team and growth\n\n${lines.join('\n')}`;
}

const PEOPLE_HEADER = '| Name | Title | Role | Seniority | Tenure | LinkedIn |\n|---|---|---|---|---|---|';

/**
 * Each cell cites the field it was actually read from. Title, role and seniority prefer the
 * person's role at this company (experiences) and fall back to the top-level profile, which can
 * describe a role elsewhere such as a board seat.
 */
function personRow(person: PersonFacts, root: 'people' | 'person'): string {
  const role = person.experiences[0];
  const fromRole = (field: 'position' | 'department' | 'seniority'): Cited =>
    role?.[field] !== undefined
      ? [role[field], `${root}.experiences.${field}`]
      : [person[field], `${root}.${field}`];
  const [department, departmentPath] = fromRole('department');
  const cells: Cited[] = [
    [person.name, `${root}.name`],
    fromRole('position'),
    [department?.replace('/', ' / '), departmentPath],
    fromRole('seniority'),
    [person.tenureYears === undefined ? undefined : tenure(person.tenureYears), `${root}.tenureYears`],
    [person.socials?.linkedinUrl, `${root}.socials.linkedinUrl`],
  ];
  return `| ${cells.map(([value, path]) => (value === undefined ? cell(value) : `${cell(value)} [${path}]`)).join(' | ')} |`;
}

/** A displayed value and the field path it came from. */
type Cited = [string | undefined, string];

function people({ contact, peopleGroups, gaps }: Research): string {
  const parts: string[] = ['## People to talk to'];
  if (contact) {
    parts.push(`### Contact from the input email\n\n${PEOPLE_HEADER}\n${personRow(contact, 'person')}`);
  }
  for (const group of peopleGroups) {
    const heading = `### ${group.label} (${group.people.length} of ${count(group.matched)} matching)`;
    parts.push(
      group.people.length > 0
        ? `${heading}\n\n${PEOPLE_HEADER}\n${group.people.map((person) => personRow(person, 'people')).join('\n')}`
        : `${heading}\n\nNo matches. The free count was 0, so no paid search ran.`,
    );
  }
  const missing = gaps.filter((item) => item.step === 'people');
  if (missing.length > 0) parts.push(missing.map((item) => `- ${item.message}`).join('\n'));
  if (parts.length === 1) parts.push('Not available.');
  return parts.join('\n\n');
}

function lookalikes({ lookalikes: companies, gaps }: Research): string {
  if (!companies || companies.length === 0) {
    const gap = gaps.find((item) => item.step === 'lookalikes');
    return `## Lookalikes\n\nNot available${gap ? `: ${gap.message}.` : '.'}`;
  }
  const has = (field: keyof LookalikeFacts) => companies.some((company) => company[field] !== undefined);
  const rows = companies.map(
    (company, index) =>
      `| ${index + 1} | ${cell(company.name)} | ${company.domain} | ${cell(company.industry)} | ${cell(company.employees)} | ${company.score ?? '-'} |`,
  );
  return [
    '## Lookalikes',
    '',
    `| # | ${column('Company', 'lookalikes.name', has('name'))} | Domain [lookalikes.domain] | ${column('Industry', 'lookalikes.industry', has('industry'))} | ${column('Size', 'lookalikes.employees', has('employees'))} | ${column('Score', 'lookalikes.score', has('score'))} |`,
    '|---:|---|---|---|---|---:|',
    ...rows,
    '',
    'Rows keep the order the API returned. Scores rank similarity; they are not probabilities.',
  ].join('\n');
}

function talkingPoints(research: Research, now: Date): string {
  const points = observations(research, now);
  const body = points.length > 0 ? points.map((point) => `- ${point}`).join('\n') : '- Not enough data for rule-based observations.';
  return `## Observations and talking points\n\n${body}`;
}

/** A table header that cites its field only when some row shows a value from it. */
function column(label: string, path: string, present: boolean): string {
  return present ? `${label} [${path}]` : label;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
