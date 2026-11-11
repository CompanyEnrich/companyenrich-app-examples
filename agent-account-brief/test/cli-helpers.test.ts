import { AuthenticationError, CompanyEnrichError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { extractCitations } from '../src/lib/citations';
import { describeError } from '../src/lib/errors';
import { employeeRange, fundingStage, listing, money, revenueRange, roundAmount, tenure } from '../src/lib/format';
import { parseOptions, UsageError } from '../src/lib/options';

describe('parseOptions', () => {
  it('defaults to pipeline mode with a notice when there is no Anthropic key', () => {
    const options = parseOptions(['stripe.com'], {});
    expect(options).toMatchObject({
      target: { kind: 'domain', domain: 'stripe.com' },
      mode: 'pipeline',
      depth: 'quick',
      maxCredits: 40,
      dryRun: false,
      outDir: 'output',
    });
    expect(options?.notice).toContain('ANTHROPIC_API_KEY is not set');
  });

  it('defaults to agent mode when an Anthropic key is set', () => {
    const options = parseOptions(['jane@acme.example', '--depth', 'full', '--max-credits', '25', '--dry-run'], { ANTHROPIC_API_KEY: 'sk-test' });
    expect(options).toMatchObject({ mode: 'agent', depth: 'full', maxCredits: 25, dryRun: true, target: { kind: 'email' } });
    expect(options?.notice).toBeUndefined();
  });

  it('rejects agent mode without a key, and bad flags, with one-line usage errors', () => {
    expect(() => parseOptions(['stripe.com', '--mode', 'agent'], {})).toThrow(UsageError);
    expect(() => parseOptions(['stripe.com', '--depth', 'deep'], {})).toThrow('--depth must be quick or full.');
    expect(() => parseOptions(['stripe.com', '--max-credits', 'lots'], {})).toThrow('--max-credits must be a whole number');
    expect(() => parseOptions(['stripe.com', '--max-credits', '-1'], {})).toThrow("Option '--max-credits' argument is ambiguous. Run with --help for usage.");
    expect(() => parseOptions(['stripe.com', '--verbose'], {})).toThrow(UsageError);
    expect(() => parseOptions([], {})).toThrow('Give exactly one domain or email');
  });

  it('returns undefined for --help', () => {
    expect(parseOptions(['--help'], {})).toBeUndefined();
  });
});

describe('describeError', () => {
  it('turns expected failures into one line', () => {
    const unauthorized = new AuthenticationError({ status: 401, headers: new Headers(), body: { title: 'Unauthorized' } });
    expect(describeError(unauthorized)).toContain('rejected the API key (401)');
    expect(describeError(new CompanyEnrichError('Missing API key.'))).toBe('CompanyEnrich: Missing API key.');
    expect(describeError(new Error('a bug'))).toBeUndefined();
  });
});

describe('extractCitations', () => {
  it('finds field paths, with indexes and comma lists, and ignores Markdown links', () => {
    const text =
      'Series B [company.financial.fundingStage] led by [people[0].name]. HQ [company.location.city.name, company.location.country.name]. ' +
      'See [company](https://example.com) and [not a citation] and [company.financial.fundingStage] again.';
    expect(extractCitations(text)).toEqual([
      'company.financial.fundingStage',
      'people[0].name',
      'company.location.city.name',
      'company.location.country.name',
    ]);
  });
});

describe('format helpers', () => {
  it('turns API enums into readable text', () => {
    expect(fundingStage('series_f')).toBe('Series F');
    expect(fundingStage('post_ipo_debt')).toBe('Post-IPO debt');
    expect(fundingStage('secondary_market')).toBe('Secondary market');
    expect(revenueRange('10m-50m')).toBe('$10M-$50M');
    expect(revenueRange('over-1b')).toBe('over $1B');
    expect(employeeRange('over-10K')).toBe('over 10K');
    expect(listing('NASDAQ:DDOG', 'nasdaq')).toBe('NASDAQ:DDOG');
    expect(listing('ACME', 'nyse')).toBe('NYSE: ACME');
    expect(roundAmount('300000000 USD')).toBe('$300M');
    expect(money(8_800_000_000)).toBe('$8.8B');
    expect(tenure(1.04)).toBe('1 year');
    expect(tenure(0.4)).toBe('5 months');
  });
});
