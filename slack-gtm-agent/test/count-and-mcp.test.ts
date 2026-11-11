import { CompanyEnrich } from '@companyenrich/sdk';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { redactPeople } from '../src/dev/redact.js';
import { countTools } from '../src/lib/count-tools.js';
import { toToolClient } from '../src/lib/mcp.js';
import { textResult } from '../src/lib/toolbox.js';
import { company, person } from './fixtures.js';

function sdkWith(respond: (path: string, body: unknown) => Response) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    return respond(path, body);
  };
  return { sdk: new CompanyEnrich({ apiKey: 'test-key', fetch, maxRetries: 0, timeoutMs: 30_000 }), requests };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('count tools', () => {
  it('count companies by description and return the interpretation', async () => {
    const { sdk, requests } = sdkWith(() => json({ count: 54_000, total: 54_000, interpretation: { filter: { city: { in: [37140] } } } }));
    const [countCompanies] = countTools(sdk);
    const result = await countCompanies!.run({ semanticQuery: ' fintech startups in Berlin ' });
    expect(requests).toEqual([{ path: '/v2/companies/search/count', body: { semantic: { query: 'fintech startups in Berlin' } } }]);
    expect(result.structuredContent).toEqual({ count: 54_000, total: 54_000, interpretation: { filter: { city: { in: [37140] } } } });
  });

  it('count lookalikes from seed domains', async () => {
    const { sdk, requests } = sdkWith(() => json({ count: 14_131, total: 14_131 }));
    await countTools(sdk)[0]!.run({ lookalikeDomains: ['stripe.com'] });
    expect(requests[0]?.body).toEqual({ lookalike: { domains: ['stripe.com'] } });
  });

  it('require exactly one company query mode', async () => {
    const { sdk, requests } = sdkWith(() => json({}));
    const result = await countTools(sdk)[0]!.run({ semanticQuery: 'x', lookalikeDomains: ['stripe.com'] });
    expect(result).toMatchObject({ isError: true });
    expect(requests).toHaveLength(0);
  });

  it('count people, optionally at given domains', async () => {
    const { sdk, requests } = sdkWith(() => json({ count: 2, total: 2, interpretation: { filter: { seniority: { in: ['vp'] } } } }));
    const countPeople = countTools(sdk)[1]!;
    const result = await countPeople.run({ semanticQuery: 'vp sales', domains: ['stripe.com'] });
    expect(requests[0]).toEqual({ path: '/v2/people/search/count', body: { semantic: { query: 'vp sales' }, filter: { domain: ['stripe.com'] } } });
    expect(result.structuredContent?.count).toBe(2);
  });

  it('turn API errors into one-line tool errors', async () => {
    const { sdk } = sdkWith(() => json({ title: 'Unauthorized', status: 401 }, 401));
    const result = await countTools(sdk)[1]!.run({ semanticQuery: 'vp sales' });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY.' }] });
  });
});

describe('toToolClient', () => {
  it('follows tools/list pagination and keeps text content, structured content and errors', async () => {
    const pages: Record<string, { tools: Array<{ name: string; inputSchema: { type: 'object' } }>; nextCursor?: string }> = {
      first: { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'p2' },
      p2: { tools: [{ name: 'b', inputSchema: { type: 'object' } }] },
    };
    const fake = {
      listTools: async (params?: { cursor?: string }) => pages[params?.cursor ?? 'first'],
      callTool: async () => ({
        content: [{ type: 'text', text: 'not found' }, { type: 'image', data: 'xx', mimeType: 'image/png' }],
        isError: true,
      }),
    } as unknown as Client;

    const tools = toToolClient(fake);
    expect((await tools.listTools()).map((tool) => tool.name)).toEqual(['a', 'b']);
    expect(await tools.callTool('enrich_company', { domain: 'x.example' })).toEqual({ content: [{ type: 'text', text: 'not found' }], isError: true });
  });
});

describe('redactPeople', () => {
  it('replaces names, photos, LinkedIn profiles and emails, and keeps company data', async () => {
    const client = redactPeople({
      listTools: async () => [],
      callTool: async () =>
        textResult({
          items: [{ ...person(1, 'VP Sales'), first_name: 'Jane', last_name: 'Doe', image_url: 'https://img.example/jane.png', email: 'jane@acme.example' }],
          company: company('acme.example', 'Acme'),
        }),
    });
    const result = await client.callTool('search_people', {});
    const text = JSON.stringify(result);
    for (const secret of ['Person 1', 'Jane', 'Doe', 'linkedin.com/in/', 'img.example', 'jane@acme.example']) expect(text).not.toContain(secret);
    expect(result.structuredContent).toMatchObject({
      items: [{ name: '<VP Sales>', position: 'VP Sales', email: '<email>', socials: { linkedin_url: '<linkedin-profile>' } }],
      company: { name: 'Acme', socials: { linkedin_url: 'https://www.linkedin.com/company/acme' } },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
});
