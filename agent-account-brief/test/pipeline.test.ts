import { describe, expect, it } from 'vitest';
import { resolveCitations } from '../src/lib/citations';
import { parseTarget } from '../src/lib/input';
import { runPipeline } from '../src/lib/pipeline';
import { assembleBrief, renderBrief } from '../src/lib/render';
import { ACME, acmeRoutes, EXECUTIVES, fakeApi, NOW, ok, testContext } from './fakes';

async function brief(depth: 'quick' | 'full', maxCredits = 40) {
  const api = fakeApi(acmeRoutes());
  const ctx = testContext(api.client, maxCredits);
  const result = await runPipeline(ctx, parseTarget('acme.example'), depth);
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  const body = renderBrief(result.research, NOW);
  const markdown = assembleBrief({ body, runLine: 'Generated in a test.', calls: ctx.calls, budget: ctx.budget, balance: { before: 900, after: 885 } });
  return { api, ctx, body, markdown };
}

describe('pipeline mode, quick depth', () => {
  it('enriches with funding and finds 3 executives, within 8 credits', async () => {
    const { api, ctx } = await brief('quick');

    expect(api.calls('GET /v2/companies/enrich')[0]?.query.getAll('expand')).toEqual(['financial']);
    expect(api.calls('POST /v2/people/search')).toHaveLength(1);
    expect(api.calls('GET /v2/companies/workforce')).toHaveLength(0);
    expect(api.calls('POST /v2/companies/search')).toHaveLength(0);
    expect(ctx.budget.reserved).toBe(8);
  });

  it('renders every section in order, with no lookalikes at quick depth', async () => {
    const { markdown } = await brief('quick');
    const headings = markdown.split('\n').filter((line) => line.startsWith('## '));

    expect(markdown.startsWith('# Account brief: Acme Cloud (acme.example)\n\nGenerated in a test.')).toBe(true);
    expect(headings).toEqual([
      '## Snapshot',
      '## Funding',
      '## Team and growth',
      '## People to talk to',
      '## Observations and talking points',
      '## Sources',
      '## Credits used',
    ]);
    expect(markdown).toContain('| Revenue range | $10M-$50M | [company.revenue] |');
    expect(markdown).toContain('| HQ | Austin, Texas, United States | [company.location.city.name, company.location.state.name, company.location.country.name] |');
    expect(markdown).toContain('- Latest stage: Series B [company.financial.fundingStage]');
    expect(markdown).toContain('| 2025-06-15 | Series B | $40M | Example Ventures |');
    expect(markdown).toContain(
      '| Avery Example [people.name] | Chief Executive Officer [people.experiences.position] | c-suite / executive [people.experiences.department] | c-suite [people.experiences.seniority] | 10.9 years [people.tenureYears] | https://www.linkedin.com/in/avery-example-example [people.socials.linkedinUrl] |',
    );
    expect(markdown).toContain('Balance from me(): 900 before, 885 after (15 used while this ran).');
  });

  it('cites only fields that exist in a tool result', async () => {
    const { body, ctx } = await brief('quick');
    const citations = resolveCitations(body, ctx.calls);

    expect(citations.length).toBeGreaterThan(10);
    expect(citations.filter((citation) => citation.sources.length === 0)).toEqual([]);
  });

  it('writes rule-based observations that cite their fields', async () => {
    const { body } = await brief('quick');
    expect(body).toContain(
      '- Last round: Series B on 2025-06-15, 17 months ago [company.financial.fundingStage][company.financial.fundingDate].',
    );
    expect(body).toContain('1 of 3 leaders found started their current role within the last year [people.tenureYears].');
  });
});

describe('pipeline mode, full depth', () => {
  it('adds tech, workforce, department leaders and lookalikes without paying twice for a person', async () => {
    const { api, ctx } = await brief('full');

    expect(api.calls('GET /v2/companies/enrich')[0]?.query.getAll('expand')).toEqual(['financial', 'technologies']);
    const filters = api.calls('POST /v2/people/search/count').map((request) => request.body.filter);
    expect(filters).toEqual([
      { domain: 'acme.example', seniority: ['c-suite', 'founder', 'vp'], department: { notIn: ['sales', 'engineering-technical', 'marketing'] } },
      { domain: 'acme.example', seniority: ['vp', 'head', 'director'], department: ['sales'] },
      { domain: 'acme.example', seniority: ['vp', 'head', 'director'], department: ['engineering-technical'] },
      { domain: 'acme.example', seniority: ['vp', 'head', 'director'], department: ['marketing'] },
    ]);
    // Marketing has no matches in the fake, so its paid search is skipped.
    expect(api.calls('POST /v2/people/search')).toHaveLength(3);
    // Engineering reserves 4 but only 1 person comes back, and lookalikes reserve 15 for 2 results.
    expect(ctx.budget.reserved).toBe(3 + 1 + 6 + 4 + 4 + 15);
    expect(ctx.budget.estimated).toBe(3 + 1 + 6 + 4 + 2 + 10);
  });

  it('renders workforce, lookalike and growth observations', async () => {
    const { markdown, body, ctx } = await brief('full');

    expect(markdown).toContain('## Lookalikes');
    expect(markdown).toContain('| 1 | Beta Billing | beta.example | Software | 51-200 | 0.81 |');
    expect(markdown).toContain('| Engineering | 123 | 41% | +11.8% |');
    expect(body).toContain('- Engineering is 41% of observed headcount (123 of 300) [workforce.departmentHeadcount.engineeringTechnical][workforce.observedEmployeeCount].');
    expect(body).toContain('- Observed headcount up 20% over 12 months (250 in 2025-12 to 300 in 2026-11) [workforce.change12m].');
    expect(body).toContain('- Sales is the fastest-growing function: 40 to 60 (+50%) [workforce.departmentChange12m.sales].');
    expect(body).toContain('### Marketing leaders (0 of 0 matching)\n\nNo matches. The free count was 0, so no paid search ran.');
    expect(markdown).toContain('`workforce.change12m` (derived: oldest vs newest snapshot in workforce history)');
    expect(resolveCitations(body, ctx.calls).every((citation) => citation.sources.length > 0)).toBe(true);
  });

  it('stays under a tight cap: refused steps are noted, never sent', async () => {
    const { api, markdown, ctx } = await brief('full', 12);

    expect(ctx.budget.reserved).toBeLessThanOrEqual(12);
    expect(api.calls('POST /v2/companies/search')).toHaveLength(0);
    expect(markdown).toContain('- Sales leaders: budget exceeded: this call needs 4 credits, 2 remaining');
    expect(markdown).toContain('## Lookalikes\n\nNot available: budget exceeded: this call needs 15 credits, 2 remaining.');
    expect(markdown).toMatch(/\| find_lookalikes \| .*refused: budget exceeded/);
  });
});

describe('pipeline mode, sparse data', () => {
  it('cites the field each cell was read from, including fallbacks', async () => {
    // A person with no experience record at this company: title, role and seniority fall back to the profile.
    const { experiences: _unused, ...profile } = EXECUTIVES[0]!;
    const sparse = { ...profile, name: 'Sam Sparse', position: 'CEO', experiences: [] };
    const api = fakeApi(acmeRoutes({ 'POST /v2/people/search': () => ok({ items: [sparse] }) }));
    const ctx = testContext(api.client);

    const result = await runPipeline(ctx, parseTarget('acme.example'), 'quick');
    if (result.status !== 'ok') throw new Error('expected ok');
    const body = renderBrief(result.research, NOW);

    expect(body).toContain('| Sam Sparse [people.name] | CEO [people.position] | c-suite / executive [people.department] | c-suite [people.seniority] | not available |');
    expect(resolveCitations(body, ctx.calls).filter((citation) => citation.sources.length === 0)).toEqual([]);
  });

  it('reports real totals when the tool result is capped', async () => {
    const technologies = Array.from({ length: 35 }, (_, index) => `Tech ${index + 1}`);
    const api = fakeApi(acmeRoutes({ 'GET /v2/companies/enrich': () => ok({ ...ACME, technologies }) }));
    const ctx = testContext(api.client);

    const result = await runPipeline(ctx, parseTarget('acme.example'), 'full');
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.research.company.technologies).toHaveLength(30);
    expect(result.research.company.technologiesTotal).toBe(35);
    expect(renderBrief(result.research, NOW)).toContain(
      'Tracked technologies include Tech 1, Tech 2, Tech 3, Tech 4, Tech 5, Tech 6 (6 of 35 shown) [company.technologies][company.technologiesTotal].',
    );
  });
});

describe('pipeline mode, failures', () => {
  it('stops with a clear error when the company is not found', async () => {
    const api = fakeApi(acmeRoutes());
    const result = await runPipeline(testContext(api.client), parseTarget('unknown.example'), 'quick');

    expect(result).toEqual({ status: 'error', error: 'no company found for unknown.example (not charged)' });
    expect(api.calls('POST /v2/people/search/count')).toHaveLength(0);
  });

  it('in a dry run, estimates the full plan from free endpoints only', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client, 40, true);

    const result = await runPipeline(ctx, parseTarget('acme.example'), 'full');

    expect(result).toEqual({ status: 'dry-run', domain: 'acme.example' });
    expect(api.requests.every((request) => request.path.endsWith('/count') || request.path.endsWith('/autocomplete'))).toBe(true);
    expect(ctx.budget.estimated).toBe(33);
  });
});
