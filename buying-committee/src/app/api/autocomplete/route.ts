import { errorResponse, serverClient } from '@/server/http';

/** GET /api/autocomplete?q=stri -> up to 10 companies by domain. Free. */
export async function GET(request: Request): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
    if (query.length < 2 || query.length > 100) return Response.json({ items: [] });
    const { items } = await serverClient().companies.autocomplete(query);
    return Response.json({ items: items.map(({ name, domain }) => ({ name: name ?? domain, domain })) });
  } catch (error) {
    return errorResponse(error);
  }
}
