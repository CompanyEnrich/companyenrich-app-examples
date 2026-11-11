import { parseSuggestRequest } from '@/lib/requests';
import { createClient } from '@/server/client';
import { mayHaveCharged } from '@/server/errors';
import { errorResponse, failure, overBudget, overConfirmed, readJson } from '@/server/http';
import { sharedState } from '@/server/state';
import { estimateSuggestions, fetchSuggestions } from '@/server/suggest-service';

/**
 * POST /api/suggest { company, count?, peers?, confirm?, maxCredits? }
 *
 * Without `confirm: true`: a free count and the cost of buying the lookalikes.
 * With `confirm: true, maxCredits`: the paid lookalike search, refused if it
 * would cost more than `maxCredits` or than the server's MAX_CREDITS budget has left.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = parseSuggestRequest(await readJson(request));
  if (!parsed.ok) return errorResponse(parsed.error, 400);
  const { company, count, peers } = parsed.value;
  const query = { company, count, peers };

  try {
    const client = createClient();
    const state = sharedState();
    const estimate = await estimateSuggestions(client, state, query);
    if (!parsed.value.confirm) return Response.json({ mode: 'estimate', estimate });

    if (estimate.credits > parsed.value.maxCredits) {
      return overConfirmed(`Suggesting ${count} peers`, estimate.credits, parsed.value.maxCredits, estimate);
    }
    // Nothing to buy: skip the paid search, which would still bill one result.
    if (estimate.pageSize === 0) {
      return Response.json({ mode: 'result', peers: [], creditsCharged: 0, cached: false });
    }
    if (!state.budget.take(estimate.credits)) return overBudget(estimate.credits, state.budget.remaining);

    let charged = estimate.credits;
    try {
      const result = await fetchSuggestions(client, state, query, estimate.pageSize);
      charged = result.creditsCharged;
      return Response.json({ mode: 'result', ...result });
    } catch (error) {
      // A timeout may still have been billed, so it stays counted and is reported.
      if (!mayHaveCharged(error)) charged = 0;
      return failure(error, { creditsCharged: charged });
    } finally {
      state.budget.refund(estimate.credits - charged);
    }
  } catch (error) {
    return failure(error);
  }
}
