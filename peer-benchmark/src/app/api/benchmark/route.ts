import { CreditAllowance } from '@/lib/credits';
import { parseBenchmarkRequest } from '@/lib/requests';
import { estimateBenchmark, runBenchmark } from '@/server/benchmark-service';
import { createClient } from '@/server/client';
import { errorResponse, failure, overBudget, overConfirmed, readJson } from '@/server/http';
import { sharedState } from '@/server/state';

/**
 * POST /api/benchmark { company, peers, confirm?, maxCredits? }
 *
 * Without `confirm: true`: the cost estimate only (free; cached companies cost 0).
 * With `confirm: true, maxCredits`: fetches workforce data and returns the
 * benchmark. Refused if the estimate is now above `maxCredits` or above what is
 * left of the server's MAX_CREDITS budget.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parseBenchmarkRequest(await readJson(request));
  if (!parsed.ok) return errorResponse(parsed.error, 400);
  const { company, peers } = parsed.value;

  try {
    // Fails fast with a clear message when the key is missing, before any confirm step.
    const client = createClient();
    const state = sharedState();
    const estimate = estimateBenchmark(state, [company, ...peers]);
    if (!parsed.value.confirm) return Response.json({ mode: 'estimate', estimate });

    if (estimate.credits > parsed.value.maxCredits) {
      return overConfirmed('This benchmark', estimate.credits, parsed.value.maxCredits, estimate);
    }
    if (!state.budget.take(estimate.credits)) return overBudget(estimate.credits, state.budget.remaining);

    // The run may spend at most what was estimated; give back whatever it did not use.
    const allowance = new CreditAllowance(estimate.credits);
    try {
      const result = await runBenchmark(client, state, { company, peers }, allowance);
      return Response.json({ mode: 'result', ...result });
    } catch (error) {
      // Calls that succeeded before the failure were billed (and cached): say so.
      return failure(error, { creditsCharged: allowance.spent });
    } finally {
      state.budget.refund(estimate.credits - allowance.spent);
    }
  } catch (error) {
    return failure(error);
  }
}
