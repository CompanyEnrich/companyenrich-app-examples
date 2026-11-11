import { describe, expect, it } from 'vitest';
import { resolveCitations } from '../src/lib/citations';
import { parseTarget } from '../src/lib/input';
import { runPipeline } from '../src/lib/pipeline';
import { renderBrief } from '../src/lib/render';
import { acmeRoutes, fakeApi, NOW, ok, person, problem, testContext } from './fakes';

// The email's domain (acme-mail.example) differs from the company's primary domain on purpose:
// the brief must follow the person's current company, not the email's domain.
const CONTACT = person(9, 'Morgan Test', 'Head of Revenue Operations', 'head', 'sales/revenue-operations', '2025-01-01');

describe('email input', () => {
  it('parses an email as a person to resolve first', () => {
    expect(parseTarget('Morgan@Acme-Mail.example')).toEqual({ kind: 'email', email: 'morgan@acme-mail.example', emailDomain: 'acme-mail.example' });
    expect(parseTarget('https://www.acme.example/about')).toEqual({ kind: 'domain', domain: 'acme.example' });
    expect(() => parseTarget('not a domain')).toThrow('is not a domain or an email address');
  });

  it('looks the person up (5 credits), then researches their current company', async () => {
    const api = fakeApi(acmeRoutes({ 'POST /v2/people/enrich': () => ok(CONTACT) }));
    const ctx = testContext(api.client);

    const result = await runPipeline(ctx, parseTarget('morgan@acme-mail.example'), 'quick');

    expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/v2/people/enrich', body: { email: 'morgan@acme-mail.example' } });
    expect(api.calls('GET /v2/companies/enrich')[0]?.query.get('domain')).toBe('acme.example');
    expect(ctx.budget.ledger[0]).toMatchObject({ tool: 'lookup_person_by_email', reserved: 5, estimated: 5 });
    expect(ctx.budget.reserved).toBe(13);

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.research.contact?.name).toBe('Morgan Test');
    const body = renderBrief(result.research, NOW);
    expect(body).toContain('### Contact from the input email');
    expect(body).toContain(
      '| Morgan Test [person.name] | Head of Revenue Operations [person.experiences.position] | sales / revenue-operations [person.experiences.department] | head [person.experiences.seniority] | 1.9 years [person.tenureYears] |',
    );
    expect(resolveCitations(body, ctx.calls).every((citation) => citation.sources.length > 0)).toBe(true);
  });

  it('stops without charging when nobody matches the email', async () => {
    const api = fakeApi(acmeRoutes({ 'POST /v2/people/enrich': () => problem(404, 'Person not found') }));
    const ctx = testContext(api.client);

    const result = await runPipeline(ctx, parseTarget('nobody@acme.example'), 'quick');

    expect(result).toEqual({ status: 'error', error: 'no person found for that email (not charged)' });
    expect(ctx.budget.estimated).toBe(0);
    expect(api.calls('GET /v2/companies/enrich')).toHaveLength(0);
  });

  it('in a dry run, assumes the email domain is the company and estimates the lookup', async () => {
    const api = fakeApi(acmeRoutes());
    const ctx = testContext(api.client, 40, true);

    const result = await runPipeline(ctx, parseTarget('someone@acme.example'), 'quick');

    expect(result).toEqual({ status: 'dry-run', domain: 'acme.example' });
    expect(api.calls('POST /v2/people/enrich')).toHaveLength(0);
    expect(ctx.budget.ledger.map((entry) => [entry.tool, entry.reserved])).toEqual([
      ['lookup_person_by_email', 5],
      ['enrich_company', 2],
      ['find_people', 6],
    ]);
  });
});
