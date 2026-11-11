import { CompanyEnrichError, NotFoundError, RateLimitError } from '@companyenrich/sdk';
import { buildBenchmark, type Benchmark, type CompanyOutcome, type Role } from '@/lib/benchmark';
import { PRICES, workforceCost, type CreditAllowance } from '@/lib/credits';
import { buildInsights } from '@/lib/insights';
import type { BenchmarkClient } from './client';
import { CapReachedError, exclusionReason, isFatal, mayHaveCharged } from './errors';
import type { CompanyName, ServerState, WorkforceLookup } from './state';

/** A 429 is never billed, so it is safe to retry; this many times at most. */
const RATE_LIMIT_RETRIES = 2;

export interface BenchmarkEstimate {
  companies: number;
  /** Companies whose workforce response is cached: free. */
  cached: number;
  /** Upper bound: a company without workforce data costs nothing. */
  credits: number;
  /** What this server process may still spend (MAX_CREDITS minus what it has spent). */
  budgetRemaining: number;
}

export interface CompanyMeta {
  domain: string;
  name: string;
  logoUrl: string | null;
  role: Role;
}

export interface BenchmarkRun {
  benchmark: Benchmark;
  insights: string[];
  /** Every requested company, in request order, for labels and logos. */
  companies: CompanyMeta[];
  creditsCharged: number;
  cached: number;
}

/**
 * The API's 12-month window moves with the calendar month, so the cache key
 * holds the UTC month too: a response cached on 31 October is not reused for
 * a 1 November request, whose window starts a month later.
 */
export function workforceKey(state: ServerState, domain: string): string {
  return `${domain}@${new Date(state.now()).toISOString().slice(0, 7)}`;
}

export function estimateBenchmark(state: ServerState, domains: readonly string[]): BenchmarkEstimate {
  const cached = domains.filter((domain) => state.workforce.has(workforceKey(state, domain))).length;
  return {
    companies: domains.length,
    cached,
    credits: workforceCost(domains.length - cached),
    budgetRemaining: state.budget.remaining,
  };
}

async function retryRateLimited<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= RATE_LIMIT_RETRIES) throw error;
      const seconds = Number(error.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 10) * 1000));
    }
  }
}

/** Runs one API call through the shared limiter, unless the run has already failed. */
type Call = <T>(request: () => Promise<T>) => Promise<T>;

/**
 * 1 credit: the current snapshot plus the latest 12 months of history. The
 * credit is claimed from the run's allowance before the call, so a run can
 * never spend more than was confirmed. The call is paid, so it gets
 * `maxRetries: 0` and only a rate-limited attempt (never billed) is tried again.
 */
async function loadWorkforce(
  client: BenchmarkClient,
  call: Call,
  domain: string,
  allowance: CreditAllowance,
): Promise<WorkforceLookup> {
  if (!allowance.take(PRICES.workforcePage)) throw new CapReachedError();
  try {
    const workforce = await retryRateLimited(() =>
      call(() => client.companies.workforce({ domain }, { maxRetries: 0 })),
    );
    return { status: 'found', workforce };
  } catch (error) {
    if (!mayHaveCharged(error)) allowance.refund(PRICES.workforcePage);
    if (error instanceof NotFoundError) return { status: 'not-found' };
    throw error;
  }
}

/** Display name and logo from the free autocomplete endpoint. */
async function resolveName(client: BenchmarkClient, state: ServerState, call: Call, domain: string): Promise<CompanyName> {
  try {
    const { value } = await state.names.getOrLoad(domain, async () => {
      const { items } = await call(() => client.companies.autocomplete(domain));
      const match = items.find((item) => item.domain === domain);
      return { name: match?.name || domain, logoUrl: match?.logoUrl || null };
    });
    return value;
  } catch {
    // Names are cosmetic. The workforce call that follows reports any real problem.
    return { name: domain, logoUrl: null };
  }
}

/**
 * Fetches (or reuses) workforce data for every company and builds the
 * benchmark. Paid calls draw on `allowance`. On a fatal error it still waits
 * for calls already in flight, so `allowance.spent` is final when it throws.
 */
export async function runBenchmark(
  client: BenchmarkClient,
  state: ServerState,
  request: { company: string; peers: readonly string[] },
  allowance: CreditAllowance,
): Promise<BenchmarkRun> {
  const companies: { domain: string; role: Role }[] = [
    { domain: request.company, role: 'subject' },
    ...request.peers.map((domain) => ({ domain, role: 'peer' as const })),
  ];
  // A bad key fails every call. The flag is set inside the limited task, before
  // its slot passes to the next waiting call, so nothing new goes out after it.
  // Calls already in flight are left to finish: cutting one off could leave a
  // billed result unrecorded.
  let fatal: unknown = null;
  const call: Call = (request) =>
    state.limit(async () => {
      if (fatal) throw fatal;
      try {
        return await request();
      } catch (error) {
        if (isFatal(error)) fatal ??= error;
        throw error;
      }
    });
  let cached = 0;

  const settled = await Promise.allSettled(
    companies.map(async ({ domain, role }) => {
      const { name, logoUrl } = await resolveName(client, state, call, domain);
      const meta: CompanyMeta = { domain, name, logoUrl, role };
      const ref = { domain, name, role };
      try {
        const { value, source } = await state.workforce.getOrLoad(workforceKey(state, domain), () =>
          loadWorkforce(client, call, domain, allowance),
        );
        if (source !== 'loaded') cached += 1;
        const outcome: CompanyOutcome =
          value.status === 'found'
            ? { ...ref, status: 'ok', workforce: value.workforce }
            : { ...ref, status: 'excluded', reason: 'no workforce data for this domain' };
        return { meta, outcome };
      } catch (error) {
        if (isFatal(error)) throw error;
        if (!(error instanceof CompanyEnrichError) && !(error instanceof CapReachedError)) {
          console.error(`Workforce lookup for ${domain} failed`, error);
        }
        const outcome: CompanyOutcome = { ...ref, status: 'excluded', reason: exclusionReason(error) };
        return { meta, outcome };
      }
    }),
  );

  // Only a fatal error rejects a task; every other failure became an exclusion.
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  const results = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

  const benchmark = buildBenchmark(results.map((result) => result.outcome));
  return {
    benchmark,
    insights: buildInsights(benchmark),
    companies: results.map((result) => result.meta),
    creditsCharged: allowance.spent,
    cached,
  };
}
