import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAssigner } from '../src/lib/assign';
import { TtlCache } from '../src/lib/cache';
import { parseRoutingConfig, parseScoringConfig } from '../src/lib/config';
import { DailyCreditLedger } from '../src/lib/credits';
import { COMPANY_CACHE_TTL_MS, CompanyLookups, type CompanyCache, type CompanyLookup } from '../src/lib/enrich';
import { PeopleLookups, type PeopleLookup } from '../src/lib/people';
import { API_CONCURRENCY, apiCaller, type ApiCall } from '../src/lib/client';
import { Limiter } from '../src/lib/concurrency';
import type { CompanyEnrich } from '@companyenrich/sdk';
import type { PipelineConfig, PipelineDeps } from '../src/lib/pipeline';
import type { FakeApi } from './fake-api';

/** The config files shipped in config/, so tests break if the defaults stop making sense. */
export function shippedConfig(): PipelineConfig {
  const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config', name), 'utf8'));
  return { scoring: parseScoringConfig(read('scoring.json')), routing: parseRoutingConfig(read('routing.json')) };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'inbound-lead-router-'));
}

export const NOW = new Date('2026-11-11T12:00:00Z');

/** The shared, concurrency-limited caller the app builds, around a fake (or given) client. */
export function apiCall(api: FakeApi, client: CompanyEnrich = api.client): ApiCall {
  return apiCaller(() => client, new Limiter(API_CONCURRENCY));
}

export interface TestDepsOptions {
  client?: CompanyEnrich;
  companyCache?: CompanyCache;
  ledger?: DailyCreditLedger;
  maxCreditsPerLead?: number;
  slackWebhookUrl?: string;
  fetch?: typeof fetch;
}

export function pipelineDeps(api: FakeApi, options: TestDepsOptions = {}): PipelineDeps & { logs: string[] } {
  const logs: string[] = [];
  const call = apiCall(api, options.client);
  return {
    companies: new CompanyLookups(call, options.companyCache ?? new TtlCache<CompanyLookup>({ ttlMs: COMPANY_CACHE_TTL_MS })),
    people: new PeopleLookups(call, new TtlCache<PeopleLookup>({ ttlMs: COMPANY_CACHE_TTL_MS })),
    assigner: new OwnerAssigner(),
    ledger: options.ledger ?? new DailyCreditLedger(1000, () => NOW),
    maxCreditsPerLead: options.maxCreditsPerLead ?? 10,
    slackWebhookUrl: options.slackWebhookUrl,
    fetch: options.fetch,
    log: (line) => logs.push(line),
    now: () => NOW,
    logs,
  };
}
