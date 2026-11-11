import { AuthenticationError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CreditLedger, searchCharge } from '../src/lib/credits.js';
import { describeError, UsageError } from '../src/lib/errors.js';
import { parseCliArgs } from '../src/lib/options.js';

describe('CreditLedger budget guard', () => {
  const lines = [
    { step: 'accounts', detail: '10 companies x 1', credits: 10 },
    { step: 'contacts', detail: 'up to 10 people x 2', credits: 20 },
  ];

  it('passes when spent plus the remaining estimate fits the cap, and prints the estimate', () => {
    const logged: string[] = [];
    new CreditLedger(30).check(lines, (line) => logged.push(line));
    expect(logged.join('\n')).toContain('total');
    expect(logged.join('\n')).toContain('(cap 30)');
  });

  it('throws before spending when the estimate is over the cap', () => {
    expect(() => new CreditLedger(29).check(lines, () => undefined)).toThrow(BudgetExceededError);
  });

  it('counts what was already spent', () => {
    const ledger = new CreditLedger(25);
    ledger.record('accounts', 'tier 1', 10, 10);
    expect(() => ledger.check([lines[1]!], () => undefined)).toThrow('would bring this run to 30 credits, above --max-credits 25');
  });

  it('bills an empty page at one base price, and expansions only for returned results', () => {
    expect(searchCharge(0, 1, 1)).toBe(1);
    expect(searchCharge(3, 1, 1)).toBe(6);
    expect(searchCharge(0, 2)).toBe(2);
  });
});

describe('parseCliArgs', () => {
  it('applies the documented defaults', () => {
    expect(parseCliArgs(['--competitor', 'zendesk'])).toEqual({
      competitor: 'zendesk',
      mine: undefined,
      countries: [],
      employees: [],
      categories: [],
      accounts: 10,
      contacts: 1,
      persona: undefined,
      withFunding: false,
      maxCredits: 40,
      exclude: [],
      dryRun: false,
      outDir: 'output',
    });
  });

  it('normalises lists and enum spelling', () => {
    const options = parseCliArgs(['--competitor', 'zendesk', '--country', 'us, gb', '--employees', '1k-5k,51-200', '--categories', 'SaaS']);
    expect(options?.countries).toEqual(['US', 'GB']);
    expect(options?.employees).toEqual(['1K-5K', '51-200']);
    expect(options?.categories).toEqual(['saas']);
  });

  it.each([
    [[], '--competitor is required'],
    [['--competitor', 'x', '--employees', '50-200'], '--employees does not accept 50-200'],
    [['--competitor', 'x', '--country', 'USA'], 'two-letter ISO codes'],
    [['--competitor', 'x', '--persona', 'ceo'], '--persona must be one of'],
    [['--competitor', 'x', '--accounts', '0'], '--accounts must be a whole number from 1 to 100'],
    [['--competitor', 'x', '--contacts', '11'], '--contacts must be a whole number from 0 to 10'],
    [['--competitor', 'x', '--max-credits', 'lots'], '--max-credits must be a whole number'],
    [['--competitor', 'x', '--bogus'], "Unknown option '--bogus'"],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it('returns undefined for --help', () => {
    expect(parseCliArgs(['--help'])).toBeUndefined();
  });
});

describe('describeError', () => {
  it('turns a bad key into one line with a link to the dashboard', () => {
    const error = new AuthenticationError({ status: 401, headers: new Headers(), body: { title: 'Unauthorized' } });
    expect(describeError(error)).toMatch(/^CompanyEnrich rejected the API key \(401\)\..*dashboard$/);
  });

  it('leaves unexpected errors alone so they keep their stack trace', () => {
    expect(describeError(new TypeError('bug'))).toBeUndefined();
  });
});
