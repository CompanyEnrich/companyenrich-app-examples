import { afterEach, describe, expect, it } from 'vitest';
import { count } from '@/lib/handlers';
import { postRoute } from '@/lib/route';

describe('route glue', () => {
  const saved = process.env.COMPANYENRICH_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.COMPANYENRICH_API_KEY;
    else process.env.COMPANYENRICH_API_KEY = saved;
  });

  it('answers with a one-line error when the API key is missing', async () => {
    delete process.env.COMPANYENRICH_API_KEY;
    const response = await postRoute(count)(new Request('http://localhost/api/count', { method: 'POST', body: '{"filter":{}}' }));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/^COMPANYENRICH_API_KEY is not set\./);
  });

  it('rejects a body that is not JSON without calling the API', async () => {
    process.env.COMPANYENRICH_API_KEY = 'test-key';
    const response = await postRoute(count)(new Request('http://localhost/api/count', { method: 'POST', body: 'not json' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
