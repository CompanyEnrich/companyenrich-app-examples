import { PRICES } from '@/lib/credits';
import { revealEmail } from '@/lib/email';
import { UserFacingError } from '@/lib/user-error';
import { serverBudgets } from '@/server/budgets';
import { errorResponse, readJson, requireConfirmation, serverClient } from '@/server/http';
import { revealRequest } from '@/server/schemas';

/**
 * POST /api/reveal { personId, domain, confirmed: true } -> one work email.
 * 10 credits when newly found. Each reveal counts against the server-wide
 * REVEAL_MAX_CREDITS cap, so repeated requests cannot bulk-reveal emails.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { personId, domain, confirmed } = await readJson(request, revealRequest);
    requireConfirmation(confirmed, `${PRICES.emailFound} credits`);
    if (serverBudgets.reveal.available < PRICES.emailFound) {
      throw new UserFacingError(
        `This server has used its email reveal cap (REVEAL_MAX_CREDITS=${serverBudgets.reveal.cap}). Restart it or raise REVEAL_MAX_CREDITS.`,
      );
    }
    return Response.json({ reveal: await revealEmail(serverClient(), personId, domain, serverBudgets.reveal) });
  } catch (error) {
    return errorResponse(error);
  }
}
