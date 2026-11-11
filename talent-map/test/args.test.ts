import { describe, expect, it } from 'vitest';
import { parseOptions } from '../src/lib/args.js';
import { UsageError } from '../src/lib/errors.js';

describe('parseOptions', () => {
  it('applies defaults and splits comma lists', () => {
    expect(parseOptions(['--role', 'data engineer, analytics engineer', '--technologies', 'snowflake,dbt', '--country', 'us'])).toEqual({
      roles: ['data engineer', 'analytics engineer'],
      seniority: [],
      environment: { technologies: ['snowflake', 'dbt'], employees: [], country: 'US' },
      people: 20,
      trendTop: 3,
      maxCredits: 50,
      dryRun: false,
      outDir: 'output',
    });
  });

  it('reads every flag', () => {
    const options = parseOptions([
      '--role=data engineer',
      '--seniority=senior,director',
      '--company=fintech companies',
      '--employees=51-200,201-500',
      '--min-tenure-years=1.5',
      '--people=10',
      '--trend-top=2',
      '--max-credits=30',
      '--dry-run',
      '--out=reports',
    ]);
    expect(options).toMatchObject({
      seniority: ['senior', 'director'],
      environment: { description: 'fintech companies', employees: ['51-200', '201-500'] },
      minTenureYears: 1.5,
      people: 10,
      trendTop: 2,
      maxCredits: 30,
      dryRun: true,
      outDir: 'reports',
    });
  });

  it('returns undefined for --help', () => {
    expect(parseOptions(['--help'])).toBeUndefined();
  });

  it.each([
    [[], /--role is required/],
    [['--role', 'x', '--seniority', 'senior,lead'], /--seniority accepts .*got "lead"/],
    [['--role', 'x', '--employees', '50-200'], /--employees accepts/],
    [['--role', 'x', '--country', 'USA'], /two-letter code/],
    [['--role', 'x', '--min-tenure-years', '-1'], /--min-tenure-years/],
    [['--role', 'x', '--people', '0'], /--people must be a whole number from 1 to 100/],
    [['--role', 'x', '--trend-top', '11'], /--trend-top/],
    [['--role', 'x', '--bogus'], /Unknown option/],
  ])('rejects %j with a clear message', (argv, message) => {
    expect(() => parseOptions(argv)).toThrow(UsageError);
    expect(() => parseOptions(argv)).toThrow(message);
  });
});
