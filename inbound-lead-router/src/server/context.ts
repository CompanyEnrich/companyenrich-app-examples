import { join } from 'node:path';
import { OwnerAssigner } from '../lib/assign';
import { TtlCache } from '../lib/cache';
import { API_CONCURRENCY, apiCaller, createClient, type ApiCall } from '../lib/client';
import { Limiter } from '../lib/concurrency';
import { loadPipelineConfig } from '../lib/config-files';
import { DailyCreditLedger } from '../lib/credits';
import { COMPANY_CACHE_TTL_MS, CompanyLookups } from '../lib/enrich';
import { PeopleLookups } from '../lib/people';
import type { PlaygroundDeps } from '../lib/playground';
import { RateLimiter } from '../lib/rate-limit';
import { openCompanyCache, stateDir } from '../lib/state';
import type { InboundDeps } from '../lib/webhook';

// Long-lived server state: caches, in-flight lookups, the API concurrency limit,
// the rate limiter, the daily credit ledger and the round-robin assigner. Kept on
// globalThis because Next.js may load this module once per route bundle, and every
// route must share one of each.

interface AppContext {
  limiter: RateLimiter;
  ledger: DailyCreditLedger;
  call: ApiCall;
  companies: CompanyLookups;
  people: PeopleLookups;
  assigner: OwnerAssigner;
  maxCreditsPerLead: number;
}

const KEY = Symbol.for('inbound-lead-router.context');

function appContext(): AppContext {
  const store = globalThis as typeof globalThis & { [KEY]?: AppContext };
  store[KEY] ??= createAppContext();
  return store[KEY];
}

function createAppContext(): AppContext {
  // One limiter for every CompanyEnrich call this process makes.
  const call = apiCaller(createClient, new Limiter(API_CONCURRENCY));
  const companyCache = openCompanyCache();
  return {
    limiter: new RateLimiter(intFromEnv('RATE_LIMIT_PER_MINUTE', 60)),
    ledger: new DailyCreditLedger(intFromEnv('DAILY_CREDIT_CAP', 250)),
    call,
    companies: new CompanyLookups(call, companyCache),
    // People results stay in memory only, so names never land on disk.
    people: new PeopleLookups(call, new TtlCache({ ttlMs: COMPANY_CACHE_TTL_MS })),
    assigner: new OwnerAssigner(join(stateDir(), 'round-robin.json')),
    maxCreditsPerLead: intFromEnv('MAX_CREDITS_PER_LEAD', 10),
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return value;
}

/** The secret is read per request, so it can be rotated by restarting with a new env value. */
function secret(): string | undefined {
  return process.env.INBOUND_WEBHOOK_SECRET?.trim() || undefined;
}

/** In production the paid routes refuse to run without a secret, unless explicitly opted out. */
function secretRequired(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.ALLOW_UNAUTHENTICATED_WEBHOOK !== '1';
}

/** Whether the pages should ask for the secret. */
export function secretConfigured(): boolean {
  return secret() !== undefined;
}

export function inboundDeps(): InboundDeps {
  const context = appContext();
  return {
    secret: secret(),
    secretRequired: secretRequired(),
    limiter: context.limiter,
    loadConfig: () => loadPipelineConfig(),
    pipeline: {
      companies: context.companies,
      people: context.people,
      assigner: context.assigner,
      ledger: context.ledger,
      maxCreditsPerLead: context.maxCreditsPerLead,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL?.trim() || undefined,
    },
  };
}

export function playgroundDeps(): PlaygroundDeps {
  const context = appContext();
  return {
    secret: secret(),
    secretRequired: secretRequired(),
    limiter: context.limiter,
    loadConfig: () => loadPipelineConfig(),
    call: context.call,
    companyCache: context.companies.cache,
    ledger: context.ledger,
  };
}
