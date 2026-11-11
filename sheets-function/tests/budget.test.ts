import { describe, expect, it } from 'vitest';
import { FakeProperties, FakeSheet, FakeSpreadsheet } from '../harness/fakes.js';
import { confirm, problem, setup } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const spentToday = (properties: FakeProperties) => Number(properties.getProperty(`ce:spent:${today}`) ?? 0);

describe('daily credit cap', () => {
  it('counts what formulas really spend, and nothing for recalculation', () => {
    const { script, documentProperties } = setup();
    script.COMPANYENRICH([['acme.example'], ['globex.example'], ['unknown.example']], 'name');
    expect(spentToday(documentProperties)).toBe(2); // the unknown domain was reserved, then released

    script.COMPANYENRICH([['acme.example'], ['globex.example'], ['unknown.example']], 'industry');
    expect(spentToday(documentProperties)).toBe(2);
  });

  it('refuses a lookup that would pass the cap, before calling the API', () => {
    const documentProperties = new FakeProperties({ 'ce:daily-cap': '2' });
    const { script, urlFetch, lock } = setup({ documentProperties });
    expect(() => script.COMPANYENRICH([['a.example'], ['b.example'], ['c.example']], 'name')).toThrow(
      'Daily credit cap reached for this spreadsheet: 0 of 2 credits used today (UTC), and this needs up to 3. ' +
        'Raise it with CompanyEnrich > Set daily credit cap.',
    );
    expect(urlFetch.requests).toHaveLength(0);
    expect(lock.held).toBe(false);
    expect(script.COMPANYENRICH('acme.example', 'name')).toBe('Acme'); // 1 credit still fits
  });

  it('releases the reservation after a 4xx and keeps it after a 5xx', () => {
    const rejected = setup({ overrides: { '/companies/enrich': () => problem(402, 'No credits') } });
    expect(() => rejected.script.COMPANYENRICH('acme.example', 'name')).toThrow('(402)');
    expect(spentToday(rejected.documentProperties)).toBe(0);

    const unknown = setup({ overrides: { '/companies/enrich': () => problem(502, 'Bad gateway') } });
    expect(() => unknown.script.COMPANYENRICH('acme.example', 'name')).toThrow('(HTTP 502)');
    expect(spentToday(unknown.documentProperties)).toBe(1); // may have been charged
  });

  it('keeps chunks that were already paid for when a later chunk fails', () => {
    let batches = 0;
    const { script, urlFetch, documentProperties } = setup({
      overrides: {
        '/companies/enrich/batch': (request) => {
          batches++;
          if (batches === 2) return problem(402, 'No credits');
          return {
            body: {
              items: request.body.domains.map((domain: string, i: number) => ({
                domain,
                status: 'found',
                company: { id: `cmp_${domain}`, name: `Company ${i}`, domain },
              })),
            },
          };
        },
      },
    });
    const range = Array.from({ length: 60 }, (_, i) => [`c${i}.example`]);
    expect(() => script.COMPANYENRICH(range, 'name')).toThrow('(402)');
    expect(spentToday(documentProperties)).toBe(50);

    // The 50 paid companies are cached; only the other 10 are requested again.
    expect(() => script.COMPANYENRICH(range, 'name')).not.toThrow();
    expect(urlFetch.to('/companies/enrich/batch').at(-1)?.body.domains).toHaveLength(10);
  });

  it('applies to the sidebar too', () => {
    const spreadsheet = new FakeSpreadsheet([new FakeSheet('Accounts', [['acme.example']])]);
    const documentProperties = new FakeProperties({ 'ce:daily-cap': '12' });
    const { script, urlFetch } = setup({ spreadsheet, documentProperties });
    spreadsheet.select('Accounts', 'A1');
    const plan = script.estimateLookalikes({ results: 3 });
    expect(plan).toMatchObject({ maxCredits: 15, capLeft: 12 });
    expect(() => script.runLookalikes(confirm(plan))).toThrow('Daily credit cap reached');
    expect(urlFetch.to('/companies/search')).toHaveLength(0);

    spreadsheet.select('Accounts', 'A1');
    script.runLookalikes(confirm(script.estimateLookalikes({ results: 2 })));
    expect(spentToday(documentProperties)).toBe(10);
  });

  it('settles a reservation against the day it was made, never today', () => {
    const documentProperties = new FakeProperties({ 'ce:daily-cap': '50' });
    const found = (domains: string[]) => ({
      body: { items: domains.map((domain) => ({ domain, status: 'found', company: { id: `id-${domain}`, domain } })) },
    });
    let calls = 0;
    const environment = setup({
      documentProperties,
      overrides: {
        '/companies/enrich/batch': (request) => {
          if (++calls > 1) return found(request.body.domains);
          // The first call starts at 23:59:59 UTC; while it runs, midnight passes and
          // another cell spends today's full cap. Then the first call fails unbilled.
          environment.clock.now += 2000;
          environment.script.COMPANYENRICH(Array.from({ length: 50 }, (_, i) => [`today-${i}.example`]), 'name');
          return problem(402, 'No credits');
        },
      },
    });
    const midnight = Date.UTC(2026, 10, 12);
    environment.clock.now = midnight - 1000;
    const yesterday = Array.from({ length: 50 }, (_, i) => [`yesterday-${i}.example`]);

    expect(() => environment.script.COMPANYENRICH(yesterday, 'name')).toThrow('(402)');
    // Yesterday's refund did not touch today's ledger, so today's cap still holds.
    expect(documentProperties.getProperty('ce:spent:2026-11-12')).toBe('50');
    expect(documentProperties.getProperty('ce:spent:2026-11-11')).toBeNull();
    expect(() => environment.script.COMPANYENRICH('one-more.example', 'name')).toThrow('Daily credit cap reached');
  });

  it('forgets earlier days', () => {
    const documentProperties = new FakeProperties({ 'ce:spent:2020-01-01': '400' });
    const { script } = setup({ documentProperties });
    script.COMPANYENRICH('acme.example', 'name');
    expect(documentProperties.getKeys()).not.toContain('ce:spent:2020-01-01');
    expect(spentToday(documentProperties)).toBe(1);
  });

  it('can be changed from the menu', () => {
    const { script, ui, documentProperties } = setup();
    ui.promptAnswers.push({ text: '50', ok: true }, { text: 'lots', ok: true });
    script.setDailyCreditCap();
    expect(documentProperties.getProperty('ce:daily-cap')).toBe('50');
    script.setDailyCreditCap();
    expect(documentProperties.getProperty('ce:daily-cap')).toBe('50');
    expect(ui.alerts).toEqual([
      'Daily credit cap set to 50 credits.',
      'The cap must be a whole number of credits, 0 or more. Nothing was changed.',
    ]);
    expect(script.getSidebarState().budget).toEqual({ cap: 50, spent: 0 });
  });
});
