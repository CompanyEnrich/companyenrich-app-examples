import { describe, expect, it } from 'vitest';
import { FakeSheet, FakeSpreadsheet } from '../harness/fakes.js';
import { confirm, setup } from './helpers.js';

function sheetWith(rows: unknown[][]) {
  return new FakeSpreadsheet([new FakeSheet('Accounts', rows)]);
}

describe('getSidebarState', () => {
  it('reports the balance and the choices the sidebar shows', () => {
    const { script } = setup();
    const state = script.getSidebarState();
    expect(state).toMatchObject({ hasKey: true, balance: 989.5, balanceError: '', budget: { cap: 500, spent: 0 } });
    expect(state.fields.filter((field: { pick?: boolean }) => field.pick).map((field: { path: string }) => field.path)).toEqual([
      'name',
      'industry',
      'employees',
      'location.country.name',
    ]);
    expect(state.costs).toEqual({ enrich: 1, lookalike: 5, person: 2 });
  });

  it('works without a key and shows API errors as text', () => {
    expect(setup({ apiKey: null }).script.getSidebarState()).toMatchObject({ hasKey: false, balance: null });
    const broken = setup({ overrides: { '/me': () => ({ status: 401, body: {} }) } });
    expect(broken.script.getSidebarState().balanceError).toContain('rejected the API key (401)');
  });
});

describe('Enrich selected column', () => {
  const rows = [['Website', 'Owner'], ['acme.example', 'Ann'], ['https://globex.example', 'Bo'], ['unknown.example', 'Cy'], ['acme.example', 'Di'], ['', '']];

  it('estimates only new domains, using no paid calls', () => {
    const spreadsheet = sheetWith(rows.map((row) => [...row]));
    const { script, urlFetch } = setup({ spreadsheet });
    script.COMPANYENRICH('acme.example', 'name'); // already cached
    spreadsheet.select('Accounts', 'A1:A1000'); // like selecting the whole column

    const job = script.estimateEnrichSelection(['name', 'employees']);
    expect(job).toMatchObject({
      rangeA1: 'Accounts!A1:A1000',
      headerRow: 1,
      firstRow: 2,
      rowCount: 4,
      domains: 3,
      cached: 1,
      invalid: 0,
      maxCredits: 2,
      balance: 989.5,
      capLeft: 499, // the cached company cost 1 credit earlier today
    });
    expect(urlFetch.requests.map((request) => request.path)).toEqual(['/companies/enrich', '/me']);
  });

  it('inserts columns with headers and fills them in chunks of 50', () => {
    const spreadsheet = sheetWith(rows.map((row) => [...row]));
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:A6');

    let job = script.estimateEnrichSelection(['name', 'country']);
    job = script.enrichSelectionChunk(confirm(job));
    expect(job).toMatchObject({ done: true, offset: 4, billed: 2, targetColumn: 2 });
    expect(spreadsheet.getSheetByName('Accounts')?.values()).toEqual([
      ['Website', 'Name', 'Country', 'Owner'],
      ['acme.example', 'Acme', 'United States', 'Ann'],
      ['https://globex.example', 'Globex', 'Germany', 'Bo'],
      ['unknown.example', 'Not found', '', 'Cy'],
      ['acme.example', 'Acme', 'United States', 'Di'],
      ['', '', '', ''],
    ]);
    expect(urlFetch.to('/companies/enrich/batch')[0]?.body).toEqual({
      domains: ['acme.example', 'globex.example', 'unknown.example'],
      waitForEnrichment: true,
    });
  });

  it('processes long selections over several calls', () => {
    const domains = Array.from({ length: 120 }, (_, i) => [`company-${i}.example`]);
    const spreadsheet = sheetWith(domains);
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:A120');

    let job = confirm(script.estimateEnrichSelection(['name']));
    expect(job).toMatchObject({ headerRow: 0, firstRow: 1, rowCount: 120, maxCredits: 120 });
    const offsets = [];
    while (!job.done) {
      job = script.enrichSelectionChunk(job);
      offsets.push(job.offset);
    }
    expect(offsets).toEqual([50, 100, 120]);
    expect(urlFetch.to('/companies/enrich/batch').map((request) => request.body.domains.length)).toEqual([50, 50, 20]);
    expect(spreadsheet.getSheetByName('Accounts')?.values()[119]).toEqual(['company-119.example', 'Not found']);
  });

  it('refuses to spend more than the confirmed estimate', () => {
    const spreadsheet = sheetWith([['acme.example'], ['globex.example']]);
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:A2');
    const job = script.estimateEnrichSelection(['name']);
    expect(() => script.enrichSelectionChunk({ ...confirm(job), maxCredits: 1 })).toThrow(
      'This needs up to 2 credits, more than the 1 you confirmed.',
    );
    expect(urlFetch.to('/companies/enrich/batch')).toHaveLength(0);
  });

  it('asks for a single column', () => {
    const spreadsheet = sheetWith(rows.map((row) => [...row]));
    const { script } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:B3');
    expect(() => script.estimateEnrichSelection(['name'])).toThrow('Select a single column of domains.');
  });
});

describe('Find lookalikes', () => {
  it('counts for free, then searches and writes a new sheet', () => {
    const spreadsheet = sheetWith([['acme.example']]);
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1');

    const plan = script.estimateLookalikes({ results: 2, country: '' });
    expect(plan).toMatchObject({ domain: 'acme.example', available: 1234, results: 2, maxCredits: 10 });
    const query = { lookalike: { domains: ['acme.example'] }, filter: { domain: { notIn: ['acme.example'] } } };
    expect(urlFetch.to('/companies/search/count')[0]?.body).toEqual(query);
    expect(urlFetch.to('/companies/search')).toHaveLength(0);

    const result = script.runLookalikes(confirm(plan));
    expect(result).toEqual({ sheetName: 'Lookalikes - acme.example', rows: 2, credits: 10 });
    expect(urlFetch.to('/companies/search')[0]?.body).toEqual({ ...query, pageSize: 2 });
    expect(spreadsheet.getSheetByName('Lookalikes - acme.example')?.values()).toEqual([
      ['Rank', 'Score', 'Name', 'Domain', 'Industry', 'Employees', 'Country', 'LinkedIn'],
      [1, 0.9, 'Globex', 'globex.example', 'Software Development', '201-500', 'Germany', ''],
      [2, 0.8, 'Initech', 'initech.example', 'IT Services and IT Consulting', '51-200', 'United States', ''],
    ]);

    // The lookalikes were paid for, so formulas on them are now free.
    script.COMPANYENRICH('globex.example', 'name');
    expect(urlFetch.to('/companies/enrich')).toHaveLength(0);
  });

  it('adds a country filter and names a second sheet uniquely', () => {
    const spreadsheet = sheetWith([['acme.example']]);
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1');
    const plan = script.estimateLookalikes({ results: 1, country: 'Germany' });
    expect(urlFetch.to('/companies/search/count')[0]?.body.filter.country).toEqual(['DE']);
    script.runLookalikes(confirm(plan));
    expect(script.runLookalikes(confirm(plan)).sheetName).toBe('Lookalikes - acme.example (2)');
  });

  it('caps the request to what exists and refuses to overspend', () => {
    const spreadsheet = sheetWith([['acme.example']]);
    const { script } = setup({ spreadsheet, overrides: { '/companies/search/count': () => ({ body: { count: 1, total: 1 } }) } });
    spreadsheet.select('Accounts', 'A1');
    const plan = script.estimateLookalikes({ results: 5 });
    expect(plan).toMatchObject({ results: 1, maxCredits: 5 });
    expect(() => script.runLookalikes({ ...confirm(plan), results: 3 })).toThrow('This would cost 15 credits, more than the 5 you confirmed');
    expect(() => script.estimateLookalikes({ results: 26 })).toThrow('Number of lookalikes must be a whole number from 1 to 25.');
  });

  it('needs a domain in the current cell', () => {
    const spreadsheet = sheetWith([['Website']]);
    const { script } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1');
    expect(() => script.estimateLookalikes({ results: 1 })).toThrow('Click a cell that contains a domain');
  });
});

describe('Find people at selected domains', () => {
  const options = { seniorities: ['c-suite', 'vp', 'head'], department: 'sales', titles: 'sales, revenue', perCompany: 2 };

  it('counts per company for free, so the estimate is exact', () => {
    const spreadsheet = sheetWith([['Domain'], ['acme.example'], ['globex.example'], ['initech.example']]);
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:A4');

    const plan = script.estimatePeople(options);
    expect(plan.companies).toEqual([
      { domain: 'acme.example', available: 3, take: 2 },
      { domain: 'globex.example', available: 1, take: 1 },
      { domain: 'initech.example', available: 0, take: 0 },
    ]);
    expect(plan).toMatchObject({ people: 3, maxCredits: 6 });
    expect(urlFetch.to('/people/search/count')[0]?.body).toEqual({
      filter: { seniority: ['c-suite', 'vp', 'head'], department: 'sales', position: ['sales', 'revenue'], domain: 'acme.example' },
    });
    expect(urlFetch.to('/people/search')).toHaveLength(0);
  });

  it('searches only companies with matches and writes a new sheet', () => {
    const spreadsheet = sheetWith([['acme.example'], ['globex.example'], ['initech.example']]);
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:A3');

    const result = script.runPeople(confirm(script.estimatePeople(options)));
    expect(result).toEqual({ sheetName: 'People - 2 companies', rows: 3, credits: 6, error: '' });
    expect(urlFetch.to('/people/search').map((request) => [request.body.filter.domain, request.body.pageSize])).toEqual([
      ['acme.example', 2],
      ['globex.example', 1],
    ]);
    expect(spreadsheet.getSheetByName('People - 2 companies')?.values()).toEqual([
      ['Name', 'Title', 'Seniority', 'Department', 'Company', 'Domain', 'Country', 'LinkedIn'],
      ['<CEO>', 'Chief Executive Officer', 'c-suite', 'sales', 'Acme', 'acme.example', 'United States', 'https://www.linkedin.com/in/person-1'],
      ['<VP Sales>', 'VP Sales', 'vp', 'sales', 'Acme', 'acme.example', 'United States', 'https://www.linkedin.com/in/person-2'],
      ['<CTO>', 'CTO', 'c-suite', 'sales', 'Globex', 'globex.example', 'United States', 'https://www.linkedin.com/in/person-4'],
    ]);
  });

  it('keeps people already paid for when a later call fails', () => {
    const spreadsheet = sheetWith([['acme.example'], ['globex.example']]);
    let searches = 0;
    const { script } = setup({
      spreadsheet,
      overrides: {
        '/people/search': (request) => {
          searches++;
          if (searches === 2) return { status: 402, body: { detail: 'Insufficient credits' } };
          return { body: { items: [{ id: 9, name: '<Person>', experiences: [], socials: {} }].slice(0, request.body.pageSize) } };
        },
      },
    });
    spreadsheet.select('Accounts', 'A1:A2');
    const result = script.runPeople(confirm(script.estimatePeople({ perCompany: 1 })));
    expect(result).toMatchObject({ rows: 1, credits: 2, error: expect.stringContaining('(402)') });
  });

  it('validates the inputs before counting', () => {
    const spreadsheet = sheetWith(Array.from({ length: 30 }, (_, i) => [`c${i}.example`]));
    const { script, urlFetch } = setup({ spreadsheet });
    spreadsheet.select('Accounts', 'A1:A30');
    expect(() => script.estimatePeople(options)).toThrow('Select at most 25 domains at a time (the selection has 30).');
    spreadsheet.select('Accounts', 'A1:A2');
    expect(() => script.estimatePeople({ ...options, seniorities: ['boss'] })).toThrow('Unknown seniority "boss"');
    expect(() => script.estimatePeople({ ...options, perCompany: 0 })).toThrow('People per company must be a whole number');
    expect(urlFetch.requests).toHaveLength(0);
  });
});
