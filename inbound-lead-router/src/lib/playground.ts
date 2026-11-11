import { z } from 'zod';
import { itemLookup, planBatch, runBatch, type BatchRun } from './batch';
import type { ApiCall } from './client';
import type { CompanyFacts } from './company';
import { ConfigError } from './config';
import type { DailyCreditLedger } from './credits';
import type { CompanyCache } from './enrich';
import { evaluateCompany } from './evaluate';
import { errorResponse, guard, readJsonBody, type ApiRequest, type ApiResponse, type GuardOptions } from './http';
import type { PipelineConfig } from './pipeline';
import { requiredExpansions } from './score';
import { describeIssues } from './webhook';

// POST /api/playground. Two calls: without `confirm` it returns a free estimate;
// with `confirm` and the `maxCredits` the user agreed to, it runs enrichBatch.

export const MAX_PLAYGROUND_DOMAINS = 20;

const requestSchema = z.object({
  domains: z.array(z.string().max(320)).min(1).max(MAX_PLAYGROUND_DOMAINS),
  confirm: z.boolean().default(false),
  maxCredits: z.int().min(0).optional(),
});

export type PlaygroundRowStatus = 'invalid' | 'free-mail' | 'over-budget' | 'to-enrich' | 'found' | 'not-found' | 'invalid-domain' | 'pending' | 'error';

export interface PlaygroundRow {
  input: string;
  domain: string | null;
  status: PlaygroundRowStatus;
  source: 'api' | 'cache' | null;
  message: string | null;
  company: CompanyFacts | null;
  /** Scored with the server's config files. The page re-scores with edited weights itself. */
  tier: string | null;
  score: number | null;
  team: string | null;
}

export interface PlaygroundResponse {
  mode: 'estimate' | 'result';
  rows: PlaygroundRow[];
  expand: string[];
  creditsPerCompany: number;
  /** Estimate: the most this run can cost. Result: what it cost. */
  credits: number;
  remainingToday: number;
}

export interface PlaygroundDeps extends GuardOptions {
  loadConfig: () => PipelineConfig;
  /** Every SDK call goes through this shared, concurrency-limited caller. */
  call: ApiCall;
  companyCache: CompanyCache;
  ledger: DailyCreditLedger;
  now?: () => Date;
}

export async function handlePlayground(request: ApiRequest, deps: PlaygroundDeps): Promise<ApiResponse> {
  const blocked = guard(request, deps);
  if (blocked) return blocked;
  const body = await readJsonBody(request, 32 * 1024);
  if (!body.ok) return body.response;
  const parsed = requestSchema.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, describeIssues(parsed.error));

  let config: PipelineConfig;
  try {
    config = deps.loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return errorResponse(500, error.message);
    throw error;
  }

  const { domains, confirm, maxCredits } = parsed.data;
  const plan = planBatch(domains, deps.companyCache, requiredExpansions(config.scoring));
  let run: BatchRun | null = null;

  if (confirm) {
    if (plan.maxCredits > (maxCredits ?? 0)) {
      return errorResponse(409, `This run can cost up to ${plan.maxCredits} credits, more than the ${maxCredits ?? 0} you confirmed. Estimate again.`);
    }
    const reservation = deps.ledger.reserve(plan.maxCredits);
    if (!reservation.ok) return errorResponse(402, reservation.reason);
    if (plan.toEnrich.length > 0) run = await runBatch(deps.call, deps.companyCache, plan);
    deps.ledger.settle(reservation.hold, run ? run.credits + run.uncertainCredits : 0);
    // Up to 20 domains is one enrichBatch call, so an error means nothing was enriched.
    if (run?.error) {
      return { status: 502, body: { error: run.error, ...(run.uncertainCredits ? { uncertainCredits: run.uncertainCredits } : {}) } };
    }
  }

  const now = deps.now?.() ?? new Date();
  const rows = plan.items.map((item): PlaygroundRow => {
    const lookup = itemLookup(item, run);
    const company = lookup?.status === 'found' ? lookup.company : null;
    const evaluation = company ? evaluateCompany(company, config.scoring, config.routing, now) : null;
    let status: PlaygroundRowStatus = item.status === 'enrich' ? 'to-enrich' : item.status === 'cached' ? 'found' : item.status;
    if (lookup) status = lookup.status;
    return {
      input: item.input,
      domain: item.domain,
      status,
      source: item.cached ? 'cache' : run && item.status === 'enrich' ? 'api' : null,
      message: lookup?.status === 'error' ? lookup.message : null,
      company,
      tier: evaluation?.tier?.tier ?? null,
      score: evaluation?.score?.total ?? null,
      team: evaluation?.route.team ?? null,
    };
  });

  const response: PlaygroundResponse = {
    mode: confirm ? 'result' : 'estimate',
    rows,
    expand: plan.expand,
    creditsPerCompany: plan.creditsPerCompany,
    credits: run ? run.credits : confirm ? 0 : plan.maxCredits,
    remainingToday: deps.ledger.remaining(),
  };
  return { status: 200, body: response };
}
