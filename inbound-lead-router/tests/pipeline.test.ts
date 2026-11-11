import { join } from 'node:path';
import { CompanyEnrich } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/lib/cache';
import { DailyCreditLedger } from '../src/lib/credits';
import { COMPANY_CACHE_TTL_MS, type CompanyLookup } from '../src/lib/enrich';
import { processLead } from '../src/lib/pipeline';
import { companyFixture, companyHandlers, fakeApi, personFixture } from './fake-api';
import { NOW, pipelineDeps, shippedConfig, tempDir } from './helpers';

const config = shippedConfig();
const tierA = companyFixture();
// Smaller, lower revenue and no matching technologies: scores 64, tier B.
const tierB = companyFixture({ id: 'cmp-beta', domain: 'beta.example', name: 'Beta', employees: '51-200', revenue: '1m-10m', technologies: [] });
const people = [personFixture(1, 'VP Sales'), personFixture(2, 'Head of Marketing'), personFixture(3, 'CRO'), personFixture(4, 'VP Growth')];

describe('processLead', () => {
  it('spends nothing on free-mail addresses and routes them to the fallback', async () => {
    const api = fakeApi(companyHandlers({}));
    const trace = await processLead({ email: 'demo@gmail.com' }, config, pipelineDeps(api));
    expect(api.calls).toHaveLength(0);
    expect(trace.status).toBe('free-mail');
    expect(trace.credits.spent).toBe(0);
    expect(trace.decision).toMatchObject({ tier: null, team: 'nurture', owner: 'Marketing ops' });
    expect(trace.trace.enrichment).toMatchObject({ status: 'skipped' });
    expect(trace.trace.alert).toEqual({ channel: 'none', reason: 'Unscored leads are not alerted' });
  });

  it('enriches with the expansions the scoring config needs and bills 1 + 1 per expansion', async () => {
    const api = fakeApi(companyHandlers({ 'beta.example': tierB }));
    const trace = await processLead({ email: 'demo@beta.example' }, config, pipelineDeps(api));
    const [call] = api.callsTo('GET /v2/companies/enrich');
    expect(call?.query.getAll('expand')).toEqual(['financial', 'technologies']);
    expect(trace.credits).toMatchObject({ spent: 3, uncertain: 0, enrich: 3, people: 0 });
  });

  it('does not re-bill a domain enriched in the last 24 hours, even after a restart', async () => {
    const api = fakeApi(companyHandlers({ 'beta.example': tierB }));
    const file = join(tempDir(), 'company-cache.json');
    const first = await processLead({ email: 'demo@beta.example' }, config, pipelineDeps(api, { companyCache: new TtlCache({ ttlMs: COMPANY_CACHE_TTL_MS, file }) }));
    // A second process (or the CLI) opens the same cache file.
    const second = await processLead({ email: 'other@beta.example' }, config, pipelineDeps(api, { companyCache: new TtlCache({ ttlMs: COMPANY_CACHE_TTL_MS, file }) }));
    expect(api.callsTo('GET /v2/companies/enrich')).toHaveLength(1);
    expect(first.trace.enrichment).toMatchObject({ source: 'api', credits: 3 });
    expect(second.trace.enrichment).toMatchObject({ source: 'cache', credits: 0 });
    expect(second.decision.score).toBe(first.decision.score);
  });

  it('re-fetches a cached company that lacks an expansion the config now needs', async () => {
    const api = fakeApi(companyHandlers({ 'beta.example': tierB }));
    const companyCache = new TtlCache<CompanyLookup>({ ttlMs: COMPANY_CACHE_TTL_MS });
    const noTech = structuredClone(config);
    noTech.scoring.dimensions.technologies.weight = 0;
    await processLead({ email: 'demo@beta.example' }, noTech, pipelineDeps(api, { companyCache }));
    await processLead({ email: 'demo@beta.example' }, config, pipelineDeps(api, { companyCache }));
    expect(api.callsTo('GET /v2/companies/enrich').map((call) => call.query.getAll('expand'))).toEqual([['financial'], ['financial', 'technologies']]);
  });

  it('caches misses too, which cost nothing and release their reservation', async () => {
    const api = fakeApi(companyHandlers({}));
    const deps = pipelineDeps(api);
    const trace = await processLead({ email: 'demo@unknown.example' }, config, deps);
    await processLead({ email: 'demo@unknown.example' }, config, deps);
    expect(trace.status).toBe('not-found');
    expect(trace.credits.spent).toBe(0);
    expect(deps.ledger.remaining()).toBe(1000);
    expect(trace.decision.team).toBe('nurture');
    expect(api.calls).toHaveLength(1);
  });

  it('looks up people for tier A only, with the free count first', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA, 'beta.example': tierB }, people));
    const deps = pipelineDeps(api);
    const a = await processLead({ email: 'demo@acme.example' }, config, deps);
    expect(a.decision).toMatchObject({ tier: 'A', team: 'enterprise-na', owner: 'Jordan' });
    expect(api.callsTo('POST /v2/people/search/count')).toHaveLength(1);
    const [search] = api.callsTo('POST /v2/people/search');
    expect(search?.body).toEqual({
      filter: { domain: 'acme.example', seniority: ['c-suite', 'vp', 'head'], department: ['sales', 'marketing', 'c-suite'] },
      pageSize: 3,
    });
    expect(a.people).toHaveLength(3);
    expect(a.credits).toEqual({ spent: 9, uncertain: 0, enrich: 3, people: 6, remainingToday: 991 });

    const b = await processLead({ email: 'demo@beta.example' }, config, deps);
    expect(b.decision.tier).not.toBe('A');
    expect(b.trace.people).toEqual({ status: 'skipped', reason: `Tier ${b.decision.tier}: the people lookup runs for tier A only` });
    expect(api.callsTo('POST /v2/people/search/count')).toHaveLength(1);
  });

  it('shows the role a person holds at the account, not their headline role elsewhere', async () => {
    const investor = personFixture(9, 'General Partner at Some Fund');
    investor.experiences = [
      { isCurrent: true, isMatched: false, position: 'General Partner', seniority: 'partner', company: { id: 'fund', domain: 'fund.example' } },
      { isCurrent: true, isMatched: true, position: 'Board Member', seniority: 'c-suite', department: 'c-suite/executive', company: { id: 'cmp-acme', domain: 'acme.example' } },
    ];
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, [investor]));
    const trace = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api));
    expect(trace.people[0]).toMatchObject({ position: 'Board Member', seniority: 'c-suite', department: 'c-suite/executive' });
  });

  it('asks for no more people than the free count found, so the reservation is the real worst case', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, [people[0]!]));
    const trace = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api));
    expect(api.callsTo('POST /v2/people/search')[0]?.body.pageSize).toBe(1);
    expect(trace.credits).toMatchObject({ spent: 5, people: 2 });
  });

  it('shares one in-flight lookup between simultaneous signups from the same account', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, people), { delayMs: 20 });
    const deps = pipelineDeps(api);
    const traces = await Promise.all(Array.from({ length: 6 }, () => processLead({ email: 'demo@acme.example' }, config, deps)));
    expect(api.callsTo('GET /v2/companies/enrich')).toHaveLength(1);
    expect(api.callsTo('POST /v2/people/search/count')).toHaveLength(1);
    expect(api.callsTo('POST /v2/people/search')).toHaveLength(1);
    expect(traces.reduce((sum, trace) => sum + trace.credits.spent, 0)).toBe(9);
    expect(traces.filter((trace) => trace.trace.enrichment.status !== 'skipped' && trace.trace.enrichment.source === 'shared')).toHaveLength(5);
    expect(deps.ledger.remaining()).toBe(991);
  });

  it('never has more than 4 CompanyEnrich requests in flight, across all leads', async () => {
    const companies = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i}.example`, companyFixture({ id: `c${i}`, domain: `c${i}.example`, employees: '11-50' })]));
    const api = fakeApi(companyHandlers(companies), { delayMs: 20 });
    const deps = pipelineDeps(api);
    await Promise.all(Object.keys(companies).map((domain) => processLead({ email: `demo@${domain}` }, config, deps)));
    expect(api.callsTo('GET /v2/companies/enrich')).toHaveLength(8);
    expect(api.maxConcurrent()).toBe(4);
  });

  it('stops a lead at MAX_CREDITS_PER_LEAD before each paid call', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, people));
    const capped = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api, { maxCreditsPerLead: 5 }));
    expect(capped.decision.tier).toBe('A');
    expect(capped.trace.people).toEqual({ status: 'skipped', reason: expect.stringContaining('MAX_CREDITS_PER_LEAD (5)') });
    expect(api.callsTo('POST /v2/people/search')).toHaveLength(0);

    const tooLow = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api, { maxCreditsPerLead: 2 }));
    expect(tooLow.status).toBe('over-budget');
    expect(api.callsTo('GET /v2/companies/enrich')).toHaveLength(1);
  });

  it('reports credits that may have been billed by a failed call separately from confirmed spend', async () => {
    const api = fakeApi({
      ...companyHandlers({ 'acme.example': tierA }, people),
      'POST /v2/people/search': () => ({ status: 500, body: { title: 'Error', status: 500 } }),
    });
    const deps = pipelineDeps(api);
    const trace = await processLead({ email: 'demo@acme.example' }, config, deps);
    expect(trace.credits).toMatchObject({ spent: 3, uncertain: 6 });
    expect(trace.trace.people).toMatchObject({ status: 'error', uncertainCredits: 6 });
    expect(deps.ledger.remaining()).toBe(991);
  });

  it('skips the paid people search when the free count is zero', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, []));
    const trace = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api));
    expect(trace.trace.people).toMatchObject({ status: 'none-found', credits: 0 });
    expect(api.callsTo('POST /v2/people/search')).toHaveLength(0);
  });

  it('makes a repeat tier A signup free: company and people both come from cache', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, people));
    const deps = pipelineDeps(api);
    await processLead({ email: 'demo@acme.example' }, config, deps);
    const repeat = await processLead({ email: 'demo@acme.example' }, config, deps);
    expect(repeat.credits.spent).toBe(0);
    expect(repeat.trace.people).toMatchObject({ status: 'found', source: 'cache' });
    expect(repeat.trace.assignment).toMatchObject({ method: 'sticky', owner: { name: 'Jordan' } });
    expect(api.calls).toHaveLength(3);
  });

  it('still routes and alerts when the people lookup fails', async () => {
    const api = fakeApi({
      ...companyHandlers({ 'acme.example': tierA }, people),
      'POST /v2/people/search': () => ({ status: 402, body: { title: 'Payment Required', status: 402 } }),
    });
    const trace = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api));
    expect(trace.trace.people).toMatchObject({ status: 'error' });
    expect(trace.decision.team).toBe('enterprise-na');
    expect(trace.trace.alert.channel).toBe('log');
  });

  it('stops paid calls at the daily credit cap', async () => {
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, people));
    const trace = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api, { ledger: new DailyCreditLedger(2, () => NOW) }));
    expect(trace.status).toBe('over-budget');
    expect(api.calls).toHaveLength(0);

    const peopleCapped = await processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api, { ledger: new DailyCreditLedger(4, () => NOW) }));
    expect(peopleCapped.decision.tier).toBe('A');
    expect(peopleCapped.trace.people).toMatchObject({ status: 'skipped' });
    expect(api.callsTo('POST /v2/people/search')).toHaveLength(0);
  });

  it('posts a Block Kit alert when SLACK_WEBHOOK_URL is set, and logs it otherwise', async () => {
    const posted: { url: string; body: any }[] = [];
    const slackFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const api = fakeApi(companyHandlers({ 'acme.example': tierA }, people));
    const trace = await processLead(
      { email: 'demo@acme.example', name: 'Demo', source: 'website' },
      config,
      pipelineDeps(api, { slackWebhookUrl: 'https://hooks.slack.test/T/B/X', fetch: slackFetch }),
    );
    expect(trace.trace.alert).toEqual({ channel: 'slack', delivered: true, status: 200, error: null });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('https://hooks.slack.test/T/B/X');
    expect(posted[0]?.body.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'Tier A lead: Acme Cloud' } });

    const logged = pipelineDeps(fakeApi(companyHandlers({ 'acme.example': tierA }, people)));
    const viaLog = await processLead({ email: 'demo@acme.example' }, config, logged);
    expect(viaLog.trace.alert.channel).toBe('log');
    expect(logged.logs.some((line) => line.startsWith('[alert] Tier A lead: demo@acme.example'))).toBe(true);
  });

  it('never retries the paid enrich GET after a server error, even with SDK retries on', async () => {
    const api = fakeApi({ 'GET /v2/companies/enrich': () => ({ status: 503, body: { title: 'Unavailable', status: 503 } }) });
    const retrying = new CompanyEnrich({ apiKey: 'test-key', fetch: api.fetch, maxRetries: 2 });
    await expect(processLead({ email: 'demo@acme.example' }, config, pipelineDeps(api, { client: retrying }))).rejects.toThrow(/server error \(503\)/);
    expect(api.calls).toHaveLength(1);
  });

  it('turns API failures into one-line upstream errors and keeps reservations only when billing is uncertain', async () => {
    const rejected = pipelineDeps(fakeApi({ 'GET /v2/companies/enrich': () => ({ status: 401, body: { title: 'Unauthorized', status: 401 } }) }));
    await expect(processLead({ email: 'demo@acme.example' }, config, rejected)).rejects.toThrow(/rejected the API key \(401\)/);
    expect(rejected.ledger.remaining()).toBe(1000);

    const failed = pipelineDeps(fakeApi({ 'GET /v2/companies/enrich': () => ({ status: 500, body: { title: 'Error', status: 500 } }) }));
    await expect(processLead({ email: 'demo@acme.example' }, config, failed)).rejects.toThrow(/server error/);
    expect(failed.ledger.remaining()).toBe(997);
  });
});
