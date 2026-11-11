import { mapCommittee } from '@/lib/mapping';
import { serverBudgets } from '@/server/budgets';
import { errorResponse, readJson, requireConfirmation, serverClient } from '@/server/http';
import { mapRequest } from '@/server/schemas';

/**
 * POST /api/map { plan, workforce, maxCredits, confirmed: true }
 * Step 2, paid. The browser sends back the plan it showed plus the cap the user
 * confirmed. Every filter is re-validated, `confirmed` must be true, and the run's
 * budget is a child of the server-wide MAP_MAX_CREDITS cap.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { plan, workforce, maxCredits, confirmed } = await readJson(request, mapRequest);
    requireConfirmation(confirmed, `up to ${maxCredits} credits`);
    const map = await mapCommittee(serverClient(), plan, { workforce, budget: serverBudgets.map.child(maxCredits) });
    return Response.json({ map });
  } catch (error) {
    return errorResponse(error);
  }
}
