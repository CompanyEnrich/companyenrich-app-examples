import { AuthenticationError, CompanyEnrich, PaymentRequiredError, ServerError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { CreditBudget } from '../src/lib/credits';
import { parseDomainList, normalizeDomain } from '../src/lib/domains';
import { revealEmail } from '../src/lib/email';
import { describeError } from '../src/lib/errors';
import { committeeCsv } from '../src/lib/export';
import { UserFacingError } from '../src/lib/user-error';
import type { CommitteeMap } from '../src/lib/types';
import { errorResponse, fakeApi } from './fake-api';

describe('domains', () => {
  it('normalizes URLs and hosts', () => {
    expect(normalizeDomain('https://www.Stripe.com/pricing?x=1')).toBe('stripe.com');
    expect(normalizeDomain('not a domain')).toBeNull();
  });

  it('parses lists, dedupes, and enforces the 20 account limit', () => {
    expect(parseDomainList('stripe.com, www.stripe.com\nposthog.com')).toEqual(['stripe.com', 'posthog.com']);
    expect(() => parseDomainList('')).toThrow(UserFacingError);
    expect(() => parseDomainList('stripe.com,nope')).toThrow(/Not a valid domain: nope/);
    expect(() => parseDomainList(Array.from({ length: 21 }, (_, i) => `a${i}.com`))).toThrow(/At most 20/);
  });
});

describe('describeError', () => {
  it('gives one actionable line for expected API failures', async () => {
    const unauthorized = fakeApi([], { status: 401 });
    const error = await unauthorized.client.me().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(describeError(error)).toMatch(/rejected the API key/);

    const broke = await fakeApi([], { status: 402 }).client.people.search({}).catch((caught: unknown) => caught);
    expect(broke).toBeInstanceOf(PaymentRequiredError);
    expect(describeError(broke)).toMatch(/out of credits/);
  });

  it('explains a missing key', () => {
    const previous = process.env.COMPANYENRICH_API_KEY;
    delete process.env.COMPANYENRICH_API_KEY;
    try {
      expect(() => new CompanyEnrich()).toThrow();
      const error = (() => {
        try {
          new CompanyEnrich();
        } catch (caught) {
          return caught;
        }
      })();
      expect(describeError(error)).toMatch(/COMPANYENRICH_API_KEY is not set/);
    } finally {
      if (previous !== undefined) process.env.COMPANYENRICH_API_KEY = previous;
    }
  });
});

describe('revealEmail', () => {
  it('returns the email with its certainty, one person at a time', async () => {
    const api = fakeApi([]);
    const budget = new CreditBudget(10);
    const reveal = await revealEmail(api.client, '12345678901234567', 'acme.com', budget);
    expect(reveal).toMatchObject({ personId: '12345678901234567', status: 'found', email: 'someone@example.com', certainty: 'high' });
    expect(api.calls[0]!.path).toBe('/v2/people/12345678901234567/email');
    expect(budget.spent).toBe(10);

    // The cap is used up: the next reveal is refused before any API call.
    await expect(revealEmail(api.client, '22', 'acme.com', budget)).rejects.toThrow(/only 0 are left/);
    expect(api.calls).toHaveLength(1);
  });

  it('does not retry a paid lookup after a server error, and books it as possibly charged', async () => {
    const api = fakeApi([], { clientRetries: 2, respond: (path) => (path.endsWith('/email') ? errorResponse(500) : null) });
    const budget = new CreditBudget(50);
    await expect(revealEmail(api.client, '7', 'acme.com', budget)).rejects.toBeInstanceOf(ServerError);
    expect(api.calls).toHaveLength(1);
    expect(budget.spent).toBe(10);
  });

  it('retries a rate-limited lookup, which was not billed', async () => {
    const api = fakeApi([], { respond: (path, nth) => (path.endsWith('/email') && nth === 1 ? errorResponse(429, { 'retry-after': '0.01' }) : null) });
    const reveal = await revealEmail(api.client, '7', 'acme.com', new CreditBudget(10));
    expect(reveal.status).toBe('found');
    expect(api.calls).toHaveLength(2);
  });

  it('rejects bad ids before calling the API', async () => {
    const api = fakeApi([]);
    await expect(revealEmail(api.client, '12; DROP', 'acme.com', new CreditBudget(10))).rejects.toThrow(/Not a valid person id/);
    await expect(revealEmail(api.client, '0', 'acme.com', new CreditBudget(10))).rejects.toThrow(/Not a valid person id/);
    expect(api.calls).toHaveLength(0);
  });
});

describe('committeeCsv', () => {
  it('writes people and gaps, escaping quotes and neutralising formulas', () => {
    const map: CommitteeMap = {
      blueprint: { id: 'generic', name: 'Generic', summary: '', roles: [] },
      generatedAt: '2026-11-10T00:00:00.000Z',
      creditsSpent: 2,
      stoppedEarly: null,
      accounts: [
        {
          account: { domain: 'acme.com', name: 'Acme, Inc.', companyId: 'x', employees: '51-200', band: 'mid' },
          adaptation: [],
          singleThreaded: true,
          roles: [
            {
              role: { key: 'economic-buyer', label: 'Economic buyer', why: '', department: [], seniority: ['vp'], position: [], limit: 1, priority: 1 },
              count: 1,
              notes: [],
              people: [{ id: '7', name: '=HYPERLINK("x")', title: 'VP "Ops"', seniority: 'vp', department: null, roleStartDate: null, monthsInRole: 4, newInRole: false, linkedinUrl: null }],
            },
            { role: { key: 'champion', label: 'Champion', why: '', department: [], seniority: ['manager'], position: [], limit: 1, priority: 2 }, count: 0, notes: [], people: [] },
          ],
          gaps: [{ roleKey: 'champion', label: 'Champion', reason: 'No one matches.', suggestion: 'Ask around.' }],
        },
      ],
    };
    const csv = committeeCsv(map, { '7': { personId: '7', domain: 'acme.com', status: 'found', email: 'vp@acme.com', certainty: 'very-high' } });
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Acme, Inc."');
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain('"VP ""Ops"""');
    expect(lines[1]).toContain('vp@acme.com,very-high');
    expect(lines[2]).toContain(',gap,');
  });
});
