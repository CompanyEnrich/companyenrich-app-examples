import { createClient } from '@/server/client';
import { errorResponse, failure } from '@/server/http';
import { sharedState } from '@/server/state';

/** GET /api/autocomplete?q=post -> up to 10 companies whose domain matches. Free. */
export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (query.length > 100) return errorResponse('q must be 100 characters or fewer.', 400);
  if (query === '') return Response.json({ items: [] });

  try {
    const client = createClient();
    // Free, but it still counts toward the shared limit of parallel API calls.
    const { items } = await sharedState().limit(() => client.companies.autocomplete(query));
    return Response.json({
      items: items.map((item) => ({ domain: item.domain, name: item.name || item.domain, logoUrl: item.logoUrl || null })),
    });
  } catch (error) {
    return failure(error);
  }
}
