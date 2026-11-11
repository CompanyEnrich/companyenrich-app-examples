import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DomainCache } from '../src/lib/cache.js';
import { BATCH_LIMIT, chooseEnrichPath, collectBulkResults, enrichDomains } from '../src/lib/enrich.js';
import { BATCH_ID, fakeApi, fixtureCompanies, syntheticCompany } from './fake-api.js';

describe('chooseEnrichPath', () => {
  it('uses one synchronous batch up to 50 domains and a bulk job above that', () => {
    expect(chooseEnrichPath(1)).toBe('batch');
    expect(chooseEnrichPath(BATCH_LIMIT)).toBe('batch');
    expect(chooseEnrichPath(BATCH_LIMIT + 1)).toBe('bulk');
    expect(chooseEnrichPath(3, true)).toBe('bulk');
  });
});

describe('enrichDomains', () => {
  it('sends up to 50 domains in one enrichBatch request and counts credits per unique company', async () => {
    const api = fakeApi(fixtureCompanies, { pending: ['new-company.example'] });
    const outcome = await enrichDomains(api.client, ['twilio.com', 'zoom.us', 'missing.example', 'new-company.example']);

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v2/companies/enrich/batch',
      body: { domains: ['twilio.com', 'zoom.us', 'missing.example', 'new-company.example'], waitForEnrichment: false },
    });
    expect(outcome.path).toBe('batch');
    expect(outcome.creditsUsed).toBe(2);
    expect(outcome.results.map((result) => result.status)).toEqual(['found', 'found', 'not-found', 'pending']);
  });

  it('creates a bulk job above 50 domains, waits for it and streams the results', async () => {
    const companies = Array.from({ length: 50 }, (_, index) => syntheticCompany(index));
    const domains = [...companies.map((company) => company.domain), 'missing.example'];
    const api = fakeApi(companies, { runningPolls: 2 });
    const progress: string[] = [];
    let created = '';

    const outcome = await enrichDomains(api.client, domains, {
      pollIntervalMs: 0,
      onCreated: (batch) => (created = batch.id),
      onProgress: (batch) => progress.push(batch.status),
    });

    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v2/companies/enrich/bulk',
      `GET /v2/batches/${BATCH_ID}`,
      `GET /v2/batches/${BATCH_ID}`,
      `GET /v2/batches/${BATCH_ID}`,
      `GET /v2/companies/enrich/bulk/${BATCH_ID}/results`,
    ]);
    expect(api.calls[0]?.body).toEqual({ domains, waitForEnrichment: true });
    expect(api.calls.at(-1)?.search).toBe('?format=ndjson');
    expect(created).toBe(BATCH_ID);
    expect(progress).toEqual(['running', 'running', 'completed']);
    expect(outcome).toMatchObject({ path: 'bulk', batchId: BATCH_ID, creditsUsed: 50 });
    expect(outcome.results).toHaveLength(51);
    expect(outcome.results.at(-1)).toEqual({ domain: 'missing.example', status: 'not-found' });
  });

  it('forces the bulk path for a small list with --bulk', async () => {
    const api = fakeApi();
    const outcome = await enrichDomains(api.client, ['twilio.com'], { forceBulk: true, pollIntervalMs: 0 });
    expect(outcome.path).toBe('bulk');
    expect(api.paidCalls().map((call) => call.path)).toEqual(['/v2/companies/enrich/bulk']);
  });

  it('hands each result over as it arrives, so a dropped download keeps what was received', async () => {
    const api = fakeApi(fixtureCompanies, { failStreamAfter: 2 });
    const received: string[] = [];
    await expect(
      enrichDomains(api.client, ['twilio.com', 'zoom.us', 'atlassian.com'], {
        forceBulk: true,
        pollIntervalMs: 0,
        onResult: (result) => void received.push(result.domain),
      }),
    ).rejects.toThrow();
    expect(received).toEqual(['twilio.com', 'zoom.us']);
  });

  it('collects an existing bulk job without creating a new one', async () => {
    const api = fakeApi();
    await enrichDomains(api.client, ['twilio.com'], { forceBulk: true, pollIntervalMs: 0 });
    const before = api.paidCalls().length;
    const outcome = await collectBulkResults(api.client, BATCH_ID, { pollIntervalMs: 0 });
    expect(api.paidCalls()).toHaveLength(before);
    expect(outcome.results[0]).toMatchObject({ domain: 'twilio.com', status: 'found' });
  });
});

describe('DomainCache', () => {
  it('stores final results by domain and skips pending and failed ones', async () => {
    const cache = new DomainCache(await mkdtemp(join(tmpdir(), 'crm-diff-cache-')));
    const twilio = fixtureCompanies[0]!;
    await cache.set({ domain: 'twilio.com', status: 'found', company: twilio }, new Date('2026-11-11T00:00:00Z'));
    await cache.set({ domain: 'missing.example', status: 'not-found' });
    await cache.set({ domain: 'later.example', status: 'pending' });
    await cache.set({ domain: 'broken.example', status: 'error', message: 'timeout' });

    expect(await cache.get('twilio.com')).toMatchObject({ status: 'found', fetchedAt: '2026-11-11T00:00:00.000Z' });
    expect((await cache.get('twilio.com'))?.company?.name).toBe('Twilio');
    expect(await cache.get('missing.example')).toMatchObject({ status: 'not-found' });
    expect(await cache.get('later.example')).toBeUndefined();
    expect(await cache.get('broken.example')).toBeUndefined();
    expect(JSON.parse(await readFile(join(cache.dir, 'twilio.com.json'), 'utf8')).domain).toBe('twilio.com');
  });

  it('ignores files that are not a valid entry for the domain looked up', async () => {
    const cache = new DomainCache(await mkdtemp(join(tmpdir(), 'crm-diff-cache-')));
    await cache.set({ domain: 'twilio.com', status: 'found', company: fixtureCompanies[0]! });
    await copyFile(join(cache.dir, 'twilio.com.json'), join(cache.dir, 'zoom.us.json'));
    await writeFile(join(cache.dir, 'broken.example.json'), JSON.stringify({ domain: 'broken.example', status: 'found' }));

    for (const [domain, content] of [['null.example', 'null'], ['array.example', '[]'], ['text.example', '"x"']]) {
      await writeFile(join(cache.dir, `${domain}.json`), content!);
      expect(await cache.get(domain!)).toBeUndefined();
    }
    expect(await cache.get('zoom.us')).toBeUndefined();
    expect(await cache.get('broken.example')).toBeUndefined();
    expect(await cache.get('twilio.com')).toBeDefined();
  });

  it('refuses an output folder it cannot write to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crm-diff-cache-'));
    await writeFile(join(dir, 'not-a-folder'), '');
    await expect(new DomainCache(join(dir, 'not-a-folder', '.cache')).ensureWritable()).rejects.toThrow(/Cannot write/);
  });
});
