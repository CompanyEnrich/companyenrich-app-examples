import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '@/lib/domains';
import { parseBenchmarkRequest, parseSuggestRequest } from '@/lib/requests';
import { selectionFromQuery, selectionToQuery } from '@/lib/share-url';

const peers = (count: number) => Array.from({ length: count }, (_, index) => `peer${index}.com`);

describe('normalizeDomain', () => {
  it.each([
    ['posthog.com', 'posthog.com'],
    ['  PostHog.com ', 'posthog.com'],
    ['https://www.posthog.com/pricing?x=1', 'posthog.com'],
    ['http://app.example.co.uk:8080/', 'app.example.co.uk'],
    ['posthog.com.', 'posthog.com'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(['', 'posthog', 'not a domain.com', '-bad.com', 'a.b', 'x'.repeat(300) + '.com'])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});

describe('parseBenchmarkRequest', () => {
  it('normalizes, de-duplicates and drops the subject from the peers', () => {
    const parsed = parseBenchmarkRequest({
      company: 'https://acme.com',
      peers: ['beta.io', 'BETA.io', 'acme.com', 'www.gamma.com'],
    });
    expect(parsed).toEqual({ ok: true, value: { company: 'acme.com', peers: ['beta.io', 'gamma.com'], confirm: false } });
  });

  it('allows 8 peers (9 companies) and rejects 9', () => {
    expect(parseBenchmarkRequest({ company: 'acme.com', peers: peers(8) }).ok).toBe(true);
    expect(parseBenchmarkRequest({ company: 'acme.com', peers: peers(9) })).toEqual({
      ok: false,
      error: 'At most 8 peers are allowed (9 companies in total).',
    });
  });

  it('needs a valid company and at least one real peer', () => {
    expect(parseBenchmarkRequest(null).ok).toBe(false);
    expect(parseBenchmarkRequest({ peers: ['beta.io'] })).toEqual({ ok: false, error: 'company is required.' });
    expect(parseBenchmarkRequest({ company: 'acme', peers: ['beta.io'] }).ok).toBe(false);
    expect(parseBenchmarkRequest({ company: 'acme.com', peers: ['acme.com'] })).toEqual({
      ok: false,
      error: 'Pick at least one peer that is not the company itself.',
    });
    expect(parseBenchmarkRequest({ company: 'acme.com', peers: 'beta.io' }).ok).toBe(false);
    expect(parseBenchmarkRequest({ company: 'acme.com', peers: ['beta.io', 'nope'] }).ok).toBe(false);
  });

  it('spends only with confirm: true and a whole, non-negative maxCredits', () => {
    const base = { company: 'acme.com', peers: ['beta.io'] };
    expect(parseBenchmarkRequest({ ...base, confirm: true, maxCredits: 3 })).toMatchObject({
      ok: true,
      value: { confirm: true, maxCredits: 3 },
    });
    expect(parseBenchmarkRequest({ ...base, maxCredits: 3 })).toMatchObject({ ok: true, value: { confirm: false } });
    expect(parseBenchmarkRequest({ ...base, confirm: 'true', maxCredits: 3 })).toMatchObject({ ok: true, value: { confirm: false } });
    for (const maxCredits of [undefined, -1, 1.5, '3']) {
      expect(parseBenchmarkRequest({ ...base, confirm: true, maxCredits }).ok).toBe(false);
    }
  });
});

describe('parseSuggestRequest', () => {
  it('defaults to 5 suggestions', () => {
    expect(parseSuggestRequest({ company: 'acme.com' })).toEqual({
      ok: true,
      value: { company: 'acme.com', count: 5, peers: [], confirm: false },
    });
  });

  it('caps suggestions at 8 and at the free peer slots', () => {
    expect(parseSuggestRequest({ company: 'acme.com', count: 8 }).ok).toBe(true);
    expect(parseSuggestRequest({ company: 'acme.com', count: 9 })).toEqual({
      ok: false,
      error: 'count must be a whole number from 1 to 8.',
    });
    expect(parseSuggestRequest({ company: 'acme.com', count: 3, peers: peers(6) })).toEqual({
      ok: false,
      error: 'Only 2 peer slots left (max 8 peers).',
    });
    expect(parseSuggestRequest({ company: 'acme.com', count: 0 }).ok).toBe(false);
  });
});

describe('share links', () => {
  it('round-trips the selection with readable commas', () => {
    const query = selectionToQuery({ company: 'acme.com', peers: ['beta.io', 'gamma.com'] });
    expect(query).toBe('company=acme.com&peers=beta.io,gamma.com');
    expect(selectionFromQuery(Object.fromEntries(new URLSearchParams(query)))).toEqual({
      company: 'acme.com',
      peers: ['beta.io', 'gamma.com'],
    });
  });

  it('drops invalid, duplicate and extra domains from a hand-edited link', () => {
    const selection = selectionFromQuery({ company: 'acme.com', peers: ['acme.com,bad,beta.io,beta.io,' + peers(10).join(',')] });
    expect(selection.company).toBe('acme.com');
    expect(selection.peers).toHaveLength(8);
    expect(selection.peers.slice(0, 2)).toEqual(['beta.io', 'peer0.com']);
  });

  it('handles an empty link', () => {
    expect(selectionFromQuery({})).toEqual({ company: null, peers: [] });
  });
});
