import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderReport, safeHref } from '../src/lib/report.js';
import { buildTalentMap, type TalentMap } from '../src/lib/talent-map.js';
import { COMPANIES, fakeApi, makePerson } from './fake-api.js';

const NOW = new Date('2026-11-11T09:30:00Z');

async function talentMap(options: { dryRun?: boolean; people?: ReturnType<typeof makePerson>[]; companyCount?: number } = {}): Promise<TalentMap> {
  const api = fakeApi({ ...(options.people ? { people: options.people } : {}), ...(options.companyCount ? { companyCount: options.companyCount } : {}) });
  return buildTalentMap(
    {
      roles: ['data engineer'],
      seniority: ['senior'],
      environment: { description: 'fintech companies', technologies: [], employees: [], country: 'US' },
      minTenureYears: 2,
      people: 5,
      trendTop: 2,
      maxCredits: 50,
      dryRun: options.dryRun ?? false,
    },
    { client: api.client, log: () => {}, now: NOW },
  );
}

/** Parses with the HTML5 algorithm browsers use and collects every parse error. */
function parseErrors(html: string): string[] {
  const errors: string[] = [];
  parse(html, { onParseError: (error) => errors.push(`${error.code} at line ${error.startLine}`) });
  return errors;
}

describe('renderReport', () => {
  it('produces a complete document that parses without errors', async () => {
    const html = renderReport(await talentMap());
    expect(parseErrors(html)).toEqual([]);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script|<link|src=/); // self-contained, no scripts or external assets
  });

  it('shows the pool, the companies with trend arrows and the shortlist', async () => {
    const html = renderReport(await talentMap());
    expect(html).toContain('<title>Talent map: data engineer</title>');
    expect(html).toContain('Beta Ledger');
    expect(html).toContain('▲</span> +20 (+20%)');
    expect(html).toContain('▼</span> −10 (−20%)');
    expect(html).toContain('href="https://www.linkedin.com/in/candidate-1"');
    expect(html).toContain('5 yr 8 mo');
    expect(html).toContain('Respect opt-outs and local privacy law');
  });

  it('escapes every value that comes from the API', async () => {
    const hostile = makePerson(1, { ...COMPANIES.alpha, name: '<img src=x onerror=alert(1)>' });
    hostile.name = '<script>alert("x")</script>';
    hostile.experiences[0]!.position = 'Engineer & "Lead" <b>';
    hostile.socials.linkedinUrl = 'javascript:alert(1)';
    const html = renderReport(await talentMap({ people: [hostile] }));

    expect(parseErrors(html)).toEqual([]);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('Engineer &amp; &quot;Lead&quot; &lt;b&gt;');
  });

  it('shows that a semantic company query searches at most the 1,000 best matches', async () => {
    const html = renderReport(await talentMap({ companyCount: 54_000 }));
    expect(html).toContain('<p class="value">1,000</p><p class="note">best matches from a semantic pool of 54,000</p>');
  });

  it('renders a dry run without a shortlist', async () => {
    const html = renderReport(await talentMap({ dryRun: true }));
    expect(parseErrors(html)).toEqual([]);
    expect(html).toContain('Dry run: sizing only.');
    expect(html).toContain('Dry run: 0 credits spent. The paid steps would cost up to 12 credits');
  });
});

describe('escapeHtml and safeHref', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  });

  it('only allows http and https links', () => {
    expect(safeHref('https://www.linkedin.com/in/someone?x=1&y=2')).toBe('https://www.linkedin.com/in/someone?x=1&amp;y=2');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,hi')).toBeUndefined();
    expect(safeHref('not a url')).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});
