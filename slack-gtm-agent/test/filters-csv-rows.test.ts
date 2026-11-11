import { describe, expect, it } from 'vitest';
import { COMPANY_COLUMNS, csvCell, PERSON_COLUMNS, toCsv } from '../src/lib/csv.js';
import { describeFilter, peopleSearchArgs } from '../src/lib/filters.js';
import { companyRow, compactForModel, mergeRows, personRow, rowsFromResult, type Rows } from '../src/lib/rows.js';
import { company, person } from './fixtures.js';

describe('describeFilter', () => {
  it('reads every filter value form', () => {
    expect(
      describeFilter({
        seniority: { in: ['vp', 'head'] },
        country: { in: ['DE'], notIn: ['US'] },
        city: { in: [37140] },
        fundingAmount: { min: 1_000_000 },
        currentPositionStartDate: { after: '2026-05-01' },
        categories: 'saas',
      }),
    ).toEqual([
      'seniority: vp, head',
      'country: DE; not US',
      'city: 37140',
      'fundingAmount: 1000000 to any',
      'currentPositionStartDate: 2026-05-01 to any',
      'categories: saas',
    ]);
  });

  it('returns nothing for a missing filter', () => {
    expect(describeFilter(undefined)).toEqual([]);
  });
});

describe('peopleSearchArgs', () => {
  it('turns the API interpretation into MCP search_people arguments', () => {
    const result = peopleSearchArgs('stripe.com', { filter: { seniority: { in: ['vp'] }, department: { in: ['c-suite/sales-executive', 'sales'] } } }, 2);
    expect(result).toEqual({
      ok: true,
      args: { domains: ['stripe.com'], seniority: ['vp'], department: ['c-suite/sales-executive', 'sales'], pageSize: 2 },
      filters: ['seniority: vp', 'department: c-suite/sales-executive, sales'],
    });
  });

  it('maps positions, countries, exclusions and start dates', () => {
    const result = peopleSearchArgs(
      'acme.com',
      {
        filter: {
          position: { in: ['CTO', 'Chief Technology Officer'] },
          country: { in: ['DE'], notIn: ['US'] },
          currentPositionStartDate: { after: '2026-05-01' },
          domain: { in: ['acme.com'] },
        },
      },
      5,
    );
    expect(result).toMatchObject({
      ok: true,
      args: {
        domains: ['acme.com'],
        positionQuery: ['CTO', 'Chief Technology Officer'],
        countries: ['DE'],
        exclude: { countries: ['US'] },
        atCurrentPositionAfter: '2026-05-01T00:00:00Z',
        pageSize: 5,
      },
    });
  });

  it('refuses filters the MCP tool cannot apply, before anything is spent', () => {
    expect(peopleSearchArgs('acme.com', { filter: { education: { institutionName: 'MIT' } } }, 5)).toEqual({
      ok: false,
      reason: expect.stringContaining('"education" filter'),
    });
    expect(peopleSearchArgs('acme.com', { filter: {}, company: { query: 'fintech' } }, 5)).toMatchObject({ ok: false });
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(-5)).toBe('-5');
  });

  it('defuses text that a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('writes a header and one CRLF-terminated line per row', () => {
    const csv = toCsv([personRow(person(7, 'VP Sales, EMEA'))], PERSON_COLUMNS);
    expect(csv).toBe(
      'name,position,seniority,department,company,company_domain,country,linkedin_url\r\n' +
        'Person 7,"VP Sales, EMEA",vp,sales,Example,example.com,Germany,https://www.linkedin.com/in/person-7\r\n',
    );
    expect(toCsv([companyRow(company('acme.example', 'Acme'))], COMPANY_COLUMNS).split('\r\n')[0]).toBe(
      'name,domain,industry,employees,revenue,founded_year,city,country,funding_stage,total_funding_usd,similarity_score,linkedin_url,description',
    );
  });
});

describe('rows', () => {
  it('flattens an MCP company record', () => {
    expect(companyRow(company('acme.example', 'Acme'), 0.81)).toEqual({
      name: 'Acme',
      domain: 'acme.example',
      industry: 'Software',
      employees: '51-200',
      revenue: '10m-50m',
      foundedYear: 2015,
      city: 'Berlin',
      country: 'Germany',
      type: 'private',
      fundingStage: 'series_b',
      totalFunding: 42_000_000,
      linkedinUrl: 'https://www.linkedin.com/company/acme',
      logoUrl: 'https://logos.example/acme.example.png',
      description: 'Acme makes example software.',
      score: 0.81,
    });
  });

  it('truncates long descriptions', () => {
    const row = companyRow(company('a.example', 'A', { description: 'x'.repeat(1000) }));
    expect(row.description).toHaveLength(300);
    expect(row.description?.endsWith('…')).toBe(true);
  });

  it('takes the current company from experiences', () => {
    expect(personRow(person(3, 'VP Sales', 'acme.example'))).toMatchObject({ id: '3', company: 'Example', companyDomain: 'acme.example', country: 'Germany' });
  });

  it('reads rows and lookalike scores from tool results', () => {
    const items = [company('one.example', 'One'), company('two.example', 'Two')];
    const rows = rowsFromResult('find_similar_companies', { items, metadata: { scores: { 'id-two.example': 0.7 } } });
    expect(rows.companies.map((row) => [row.domain, row.score])).toEqual([
      ['one.example', undefined],
      ['two.example', 0.7],
    ]);
    expect(rowsFromResult('get_current_user', { credits: {} })).toEqual({ companies: [], people: [] });
  });

  it('gives Claude compact rows plus the credits charged', () => {
    const compact = compactForModel('search_people', { items: [person(1, 'CTO')], page: 1, totalPages: 3, totalItems: 41, creditInfo: { cost: 2 } });
    expect(compact).toEqual({ page: 1, totalPages: 3, totalItems: 41, people: [personRow(person(1, 'CTO'))], creditsCharged: 2 });
    const enriched = compactForModel('enrich_company', { ...company('acme.example', 'Acme'), creditInfo: { cost: 1 } });
    expect(enriched).toMatchObject({ company: { name: 'Acme' }, creditsCharged: 1 });
    expect(JSON.stringify(enriched)).not.toContain('logoUrl');
  });

  it('merges rows without duplicates', () => {
    const target: Rows = { companies: [companyRow(company('a.example', 'A'))], people: [personRow(person(1, 'CTO'))] };
    mergeRows(target, { companies: [companyRow(company('a.example', 'A')), companyRow(company('b.example', 'B'))], people: [personRow(person(1, 'CTO'))] });
    expect(target.companies.map((row) => row.domain)).toEqual(['a.example', 'b.example']);
    expect(target.people).toHaveLength(1);
  });
});
