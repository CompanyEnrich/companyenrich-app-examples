import { handlePlayground } from '@/lib/playground';
import { playgroundDeps } from '@/server/context';
import { respond } from '@/server/respond';

export const dynamic = 'force-dynamic';

/** Rules playground: a free estimate, then a confirmed `enrichBatch` run for up to 20 domains. */
export function POST(request: Request): Promise<Response> {
  return respond(request, (apiRequest) => handlePlayground(apiRequest, playgroundDeps()));
}
