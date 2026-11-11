import { describe, expect, it } from 'vitest';
import { planBatch, runBatch } from '../src/lib/batch';
import { TtlCache } from '../src/lib/cache';
import { toCompanyFacts } from '../src/lib/company';
import { parseCsv, parseCsvRecords, toCsv } from '../src/lib/csv';
import { COMPANY_CACHE_TTL_MS, type CompanyLookup } from '../src/lib/enrich';
import { findEmailColumn, leadsToCsv, planLeadCsv, scoreLeads } from '../src/lib/lead-csv';
import { companyFixture, companyHandlers, fakeApi } from './fake-api';
import { apiCall, NOW, shippedConfig } from './helpers';

const config = shippedConfig();
const expand = ['financial', 'technologies'] as const;
const newCache = () => new TtlCache<CompanyLookup>({ ttlMs: COMPANY_CACHE_TTL_MS });
const acme = companyFixture();
const beta = companyFixture({ id: 'cmp-beta', domain: 'beta.example', name: 'Beta' });

describe('csv', () => {
  it('parses quotes, escaped quotes, embedded commas and newlines, CRLF and a BOM', () => {
    const text = '﻿email,name\r\n"a@x.com","Doe, ""J"""\r\nb@y.com,"two\nlines"\n\n';
    expect(parseCsv(text)).toEqual([
      ['email', 'name'],
      ['a@x.com', 'Doe, "J"'],
      ['b@y.com', 'two\nlines'],
    ]);
    expect(parseCsvRecords(text).records[0]).toEqual({ email: 'a@x.com', name: 'Doe, "J"' });
  });

  it('quotes when needed and defuses spreadsheet formulas', () => {
    expect(toCsv([['a,b', 'say "hi"', '=HYPERLINK("x")', -5, null]])).toBe('"a,b","say ""hi""","\'=HYPERLINK(""x"")",-5,\n');
  });

  it('finds the email column by name', () => {
    expect(findEmailColumn(['Name', 'Email'])).toBe('Email');
    expect(findEmailColumn(['work_email', 'name'])).toBe('work_email');
    expect(findEmailColumn(['name'])).toBeNull();
  });
});

describe('planBatch', () => {
  it('sorts inputs into invalid, free-mail, cached and to-enrich, and prices the paid part', () => {
    const cache = newCache();
    cache.set('beta.example', { status: 'found', company: toCompanyFacts(beta, [...expand]), expand: [...expand] });
    const plan = planBatch(['demo@acme.example', 'demo@gmail.com', 'beta.example', 'nonsense', 'https://acme.example/x', 'new.example'], cache, [...expand]);
    expect(plan.items.map((item) => item.status)).toEqual(['enrich', 'free-mail', 'cached', 'invalid', 'enrich', 'enrich']);
    expect(plan.toEnrich).toEqual(['acme.example', 'new.example']);
    expect(plan.maxCredits).toBe(6);
  });

  it('marks domains beyond the budget as over-budget', () => {
    const plan = planBatch(['a.example', 'b.example', 'c.example'], newCache(), [...expand], 7);
    expect(plan.items.map((item) => item.status)).toEqual(['enrich', 'enrich', 'over-budget']);
    expect(plan.maxCredits).toBe(6);
  });
});

describe('runBatch', () => {
  it('sends one enrichBatch call, bills found companies only and caches every answer except pending', async () => {
    const api = fakeApi({
      ...companyHandlers({ 'acme.example': acme }),
      'POST /v2/companies/enrich/batch': () => ({
        items: [
          { domain: 'acme.example', status: 'found', company: acme },
          { domain: 'www-acme.example', status: 'found', company: acme },
          { domain: 'gone.example', status: 'not-found' },
          { domain: 'slow.example', status: 'pending' },
        ],
      }),
    });
    const cache = newCache();
    const plan = planBatch(['acme.example', 'www-acme.example', 'gone.example', 'slow.example'], cache, [...expand]);
    const run = await runBatch(apiCall(api), cache, plan);
    expect(api.callsTo('POST /v2/companies/enrich/batch')[0]?.body).toEqual({ domains: plan.toEnrich, expand: [...expand] });
    // Two domains resolved to the same company: billed once.
    expect(run.credits).toBe(3);
    expect(cache.get('gone.example')?.value).toEqual({ status: 'not-found' });
    expect(cache.get('slow.example')).toBeUndefined();
    expect(run.lookups.get('slow.example')).toEqual({ status: 'pending' });
  });

  it('records an API error instead of throwing', async () => {
    const api = fakeApi({ 'POST /v2/companies/enrich/batch': () => ({ status: 402, body: { title: 'Payment Required', status: 402 } }) });
    const run = await runBatch(apiCall(api), newCache(), planBatch(['acme.example'], newCache(), [...expand]));
    expect(run.error).toContain('402');
    expect(run.credits).toBe(0);
  });
});

describe('scoring a lead CSV', () => {
  const csv = 'email,name\ndemo@acme.example,A\ndemo@gmail.com,B\ndemo@beta.example,C\nbroken,D\n';

  it('plans without calling the API (dry run) and writes would-enrich rows', () => {
    const api = fakeApi(companyHandlers({}));
    const planned = planLeadCsv(csv, newCache(), config, 100);
    const leads = scoreLeads(planned, null, config, NOW);
    expect(api.calls).toHaveLength(0);
    expect(planned.plan.maxCredits).toBe(6);
    expect(leads.map((lead) => lead.status)).toEqual(['would-enrich', 'free-mail', 'would-enrich', 'invalid-email']);
    expect(leads.map((lead) => lead.routed)).toEqual([false, true, false, true]);
    expect(leadsToCsv(planned, leads).split('\n')[1]).toBe('demo@acme.example,A,acme.example,would-enrich,,,,,,,,,,,');
  });

  it('scores, tiers and routes every row, and the cache makes a rerun free', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': acme, 'beta.example': beta }));
    const cache = newCache();
    const planned = planLeadCsv(csv, cache, config, 100);
    const run = await runBatch(apiCall(api), cache, planned.plan);
    const leads = scoreLeads(planned, run, config, NOW);
    expect(run.credits).toBe(6);
    expect(leads.map((lead) => [lead.status, lead.evaluation.tier?.tier ?? null, lead.evaluation.route.team])).toEqual([
      ['scored', 'A', 'enterprise-na'],
      ['free-mail', null, 'nurture'],
      ['scored', 'A', 'enterprise-na'],
      ['invalid-email', null, 'nurture'],
    ]);

    const [header, first] = leadsToCsv(planned, leads).split('\n');
    expect(header).toBe('email,name,domain,status,company,industry,employees,country,score,tier,route_rule,team,owner,factors,enriched_from');
    expect(first).toContain('demo@acme.example,A,acme.example,scored,Acme Cloud,Software,501-1K,US,92.5,A,Tier A enterprise in North America,enterprise-na,round-robin,');

    const rerun = planLeadCsv(csv, cache, config, 100);
    expect(rerun.plan.toEnrich).toEqual([]);
    expect(rerun.plan.maxCredits).toBe(0);
  });

  it('respects --max-credits by skipping rows beyond it', () => {
    const planned = planLeadCsv(csv, newCache(), config, 3);
    expect(planned.plan.items.map((item) => item.status)).toEqual(['enrich', 'free-mail', 'over-budget', 'invalid']);
    expect(scoreLeads(planned, null, config, NOW)[2]?.status).toBe('skipped-max-credits');
  });

  it('fails clearly without an email column', () => {
    expect(() => planLeadCsv('name\nx\n', newCache(), config, 10)).toThrow('No email column found. Columns: name');
  });
});
