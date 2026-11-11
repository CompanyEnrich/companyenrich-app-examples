import { industries } from '@/lib/handlers';
import { getRoute } from '@/lib/route';

// Never prerender at build time: this calls the API with the server's key.
export const dynamic = 'force-dynamic';

export const GET = getRoute(industries);
