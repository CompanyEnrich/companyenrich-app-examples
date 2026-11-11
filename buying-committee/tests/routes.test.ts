import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findPreset } from '../src/lib/blueprints';
import type { CoveragePlan } from '../src/lib/types';
import { fakeApi, person } from './fake-api';

/**
 * The paid route handlers, called directly with the global fetch stubbed by the fake API.
 * Server caps are read from the environment when the module loads, so each test
 * re-imports the routes after setting them.
 */
const domain = 'acme.com';

function setup(env: Record<string, string> = {}) {
  const api = fakeApi([
    {
      domain,
      name: 'Acme',
      employees: '51-200',
      people: [
        person(domain, { seniority: 'vp', department: 'engineering-technical/software-development', title: 'VP Engineering' }),
        person(domain, { seniority: 'manager', department: 'engineering-technical/software-development', title: 'Engineering Manager' }),
      ],
    },
  ]);
  vi.stubEnv('COMPANYENRICH_API_KEY', 'test-key');
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal('fetch', api.fetch);
  return api;
}

async function routes() {
  vi.resetModules();
  const [map, reveal] = await Promise.all([import('../src/app/api/map/route'), import('../src/app/api/reveal/route')]);
  return { map: map.POST, reveal: reveal.POST };
}

const post = (body: unknown) => new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });

function plan(): CoveragePlan {
  const devtools = findPreset('devtools')!;
  return {
    blueprint: devtools,
    accounts: [
      {
        account: { domain, name: 'Acme', companyId: 'id-acme.com', employees: '51-200', band: 'mid' },
        adaptation: [],
        // The economic buyer (1) and champion (1) have matches: 2 people = 4 credits.
        roles: devtools.roles.map((role) => ({ role, count: ['economic-buyer', 'champion'].includes(role.key) ? 1 : 0 })),
        singleThreaded: false,
      },
    ],
    unresolved: [],
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/reveal', () => {
  it.each([
    ['confirmed: false', { personId: '42', domain, confirmed: false }],
    ['confirmed missing', { personId: '42', domain }],
    ['person id 0', { personId: '0', domain, confirmed: true }],
    ['bad domain', { personId: '42', domain: 'not a domain', confirmed: true }],
  ])('refuses %s without calling CompanyEnrich', async (_, body) => {
    const api = setup();
    const response = await (await routes()).reveal(post(body));
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it('reveals one confirmed email, then stops at the server-wide cap', async () => {
    const api = setup({ REVEAL_MAX_CREDITS: '10' });
    const { reveal } = await routes();

    const first = await reveal(post({ personId: '42', domain, confirmed: true }));
    expect(first.status).toBe(200);
    expect((await first.json()).reveal).toMatchObject({ status: 'found', certainty: 'high' });

    const second = await reveal(post({ personId: '43', domain, confirmed: true }));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/REVEAL_MAX_CREDITS/);
    expect(api.calls).toHaveLength(1);
  });
});

describe('POST /api/map', () => {
  it.each([
    ['confirmed: false', { confirmed: false }],
    ['confirmed missing', {}],
  ])('refuses %s without calling CompanyEnrich', async (_, extra) => {
    const api = setup();
    const response = await (await routes()).map(post({ plan: plan(), workforce: false, maxCredits: 4, ...extra }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Not confirmed/);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses a request cap below the cost without calling CompanyEnrich', async () => {
    const api = setup();
    const response = await (await routes()).map(post({ plan: plan(), workforce: false, maxCredits: 3, confirmed: true }));
    expect(response.status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it('maps a confirmed plan and enforces the server-wide cap across requests', async () => {
    const api = setup({ MAP_MAX_CREDITS: '6' });
    const { map } = await routes();
    const body = { plan: plan(), workforce: false, maxCredits: 4, confirmed: true };

    const first = await map(post(body));
    expect(first.status).toBe(200);
    expect((await first.json()).map.creditsSpent).toBe(4);
    const searches = api.calls.length;

    // 2 credits left on the server: the same 4-credit plan is refused before any call.
    const second = await map(post(body));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/only 2 are available/);
    expect(api.calls).toHaveLength(searches);
  });
});
