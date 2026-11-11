// Browser-side fakes for the component tests. Both stand in for `window.fetch`.

import { createCompanyHandler } from '../src/server/handler';
import { createFakeApi, type FakeApiRoutes } from './fake-api';

/**
 * Routes the component's requests through the real server handler, which talks
 * to the fake CompanyEnrich API. This exercises the whole stack in one test.
 */
export function handlerBackedFetch(routes: FakeApiRoutes = {}) {
  const api = createFakeApi(routes);
  const handler = createCompanyHandler({ apiKey: 'test-key', fetch: api.fetch, onError: () => {} });
  const requests: URL[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url);
    return handler(new Request(url, init));
  };
  return { fetch, requests, api };
}

/**
 * A fetch whose responses the test releases one at a time, in any order. It
 * records the abort signal but ignores it, like a response already in flight,
 * so tests can check that late answers to stale requests are dropped.
 */
export function deferredFetch() {
  const pending: { url: URL; signal: AbortSignal | undefined; respond: (body: unknown) => void }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({
        url: new URL(String(input), 'http://localhost'),
        signal: init?.signal ?? undefined,
        respond: (body) => resolve(Response.json(body)),
      });
    });
  return { fetch, pending };
}
