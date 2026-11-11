import { interpret } from '@/lib/handlers';
import { postRoute } from '@/lib/route';

export const POST = postRoute(interpret);
