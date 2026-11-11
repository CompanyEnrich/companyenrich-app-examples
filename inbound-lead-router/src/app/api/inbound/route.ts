import { handleInbound } from '@/lib/webhook';
import { inboundDeps } from '@/server/context';
import { respond } from '@/server/respond';

export const dynamic = 'force-dynamic';

/** Inbound lead webhook: `{ email, name?, source? }` in, decision trace out. */
export function POST(request: Request): Promise<Response> {
  return respond(request, (apiRequest) => handleInbound(apiRequest, inboundDeps()));
}
