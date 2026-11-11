import { CompanyEnrich } from '@companyenrich/sdk';

export interface FakeRequest {
  method: string;
  path: string;
  url: URL;
  body: any;
  /** Values captured by ":name" segments in the route. */
  params: string[];
}

export type Handler = (request: FakeRequest) => unknown;

/**
 * A real CompanyEnrich client whose `fetch` is answered by in-memory handlers, keyed by
 * "METHOD /path" with ":name" placeholders. Unmatched requests get a 404, like an unknown record.
 */
export function fakeApi(routes: Record<string, Handler> = {}, { maxRetries = 0 } = {}) {
  const calls: FakeRequest[] = [];
  const handlers: Record<string, Handler> = { 'GET /v2/me': () => ME, ...routes };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    for (const [route, handler] of Object.entries(handlers)) {
      const [routeMethod, pattern] = route.split(' ') as [string, string];
      const match = url.pathname.match(new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`));
      if (routeMethod !== method || !match) continue;
      const request = { method, path: url.pathname, url, body, params: match.slice(1) };
      calls.push(request);
      const result = handler(request);
      return result instanceof Response ? result : json(200, result);
    }
    calls.push({ method, path: url.pathname, url, body, params: [] });
    return json(404, { title: 'Not Found', status: 404, detail: `No fake route for ${method} ${url.pathname}` });
  };

  return {
    client: new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries }),
    calls,
    callsTo: (method: string, pathPrefix: string) => calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix)),
  };
}

export const ME = {
  userId: 'test-user',
  credits: { used: 100, total: 1000 },
  capabilities: { lists: true, previews: true, companySearchLimit: 1000, companySearchAsyncLimit: 1000, peopleSearchLimit: 1000, searchTermLimit: 100 },
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function notFound(): Response {
  return json(404, { title: 'Not Found', status: 404 });
}
