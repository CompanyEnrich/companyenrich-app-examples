import { describe, expect, it } from 'vitest';
import { normalizeDomain, parseCommand } from '../src/lib/commands.js';

describe('parseCommand', () => {
  it('shows help for empty input and "help"', () => {
    expect(parseCommand('')).toEqual({ kind: 'help' });
    expect(parseCommand('  HELP ')).toEqual({ kind: 'help' });
  });

  it('parses balance', () => {
    expect(parseCommand('balance')).toEqual({ kind: 'balance' });
  });

  it('parses company with a normalized domain', () => {
    expect(parseCommand('company https://www.Stripe.com/pricing')).toEqual({ kind: 'company', domain: 'stripe.com' });
    expect(parseCommand('company <http://stripe.com|stripe.com>')).toEqual({ kind: 'company', domain: 'stripe.com' });
  });

  it('rejects company without exactly one valid domain', () => {
    expect(parseCommand('company').kind).toBe('invalid');
    expect(parseCommand('company stripe').kind).toBe('invalid');
    expect(parseCommand('company stripe.com adyen.com').kind).toBe('invalid');
  });

  it('parses company and people counts', () => {
    expect(parseCommand('count fintech startups in Berlin')).toEqual({ kind: 'count', target: 'companies', query: 'fintech startups in Berlin' });
    expect(parseCommand('count companies fintech in Berlin')).toEqual({ kind: 'count', target: 'companies', query: 'fintech in Berlin' });
    expect(parseCommand('count people CTOs in Paris')).toEqual({ kind: 'count', target: 'people', query: 'CTOs in Paris' });
    expect(parseCommand('count').kind).toBe('invalid');
    expect(parseCommand('count people').kind).toBe('invalid');
  });

  it('parses people with the default and an explicit fetch size', () => {
    expect(parseCommand('people stripe.com vp sales')).toEqual({ kind: 'people', domain: 'stripe.com', roles: 'vp sales', limit: 5 });
    expect(parseCommand('people stripe.com head of sales 3')).toEqual({ kind: 'people', domain: 'stripe.com', roles: 'head of sales', limit: 3 });
  });

  it('treats a lone number after the domain as role words, not a size', () => {
    expect(parseCommand('people stripe.com 3')).toEqual({ kind: 'people', domain: 'stripe.com', roles: '3', limit: 5 });
  });

  it('rejects people without roles or with a size out of range', () => {
    expect(parseCommand('people stripe.com').kind).toBe('invalid');
    expect(parseCommand('people not-a-domain vp sales').kind).toBe('invalid');
    expect(parseCommand('people stripe.com vp sales 0')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('between 1 and 25') });
    expect(parseCommand('people stripe.com vp sales 99').kind).toBe('invalid');
  });

  it('parses lookalikes', () => {
    expect(parseCommand('lookalikes stripe.com')).toEqual({ kind: 'lookalikes', domain: 'stripe.com', limit: 5 });
    expect(parseCommand('similar stripe.com 2')).toEqual({ kind: 'lookalikes', domain: 'stripe.com', limit: 2 });
    expect(parseCommand('lookalikes stripe.com two').kind).toBe('invalid');
    expect(parseCommand('lookalikes stripe.com 2 extra').kind).toBe('invalid');
  });

  it('names unknown subcommands', () => {
    expect(parseCommand('enrich stripe.com')).toEqual({ kind: 'invalid', message: 'Unknown command "enrich". Try `/ce help`.' });
  });
});

describe('normalizeDomain', () => {
  it.each([
    ['stripe.com', 'stripe.com'],
    ['WWW.Stripe.COM', 'stripe.com'],
    ['https://stripe.com/', 'stripe.com'],
    ['http://docs.stripe.com:443/x?y=1#z', 'docs.stripe.com'],
    ['<https://stripe.com>', 'stripe.com'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(['', 'stripe', 'not a domain', '-bad-.com', 'a.b'])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeUndefined();
  });
});
