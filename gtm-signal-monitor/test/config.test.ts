import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/lib/config.js';

const errorFor = (yaml: string): string => {
  try {
    parseConfig(yaml, 'test.yaml');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected parseConfig to throw');
};

describe('config', () => {
  it('accepts the shipped example config and applies defaults', () => {
    const config = loadConfig('monitor.config.example.yaml');
    expect(config.watchers.map((watcher) => watcher.type)).toEqual(['new-companies', 'new-leaders', 'account-changes']);

    const leaders = config.watchers[1];
    expect(leaders?.type === 'new-leaders' && leaders.lookbackDays).toBe(30);
  });

  it('normalizes and dedupes domains', () => {
    const config = parseConfig(`
watchers:
  - id: accounts
    type: account-changes
    domains: ["https://www.Stripe.com/pricing", stripe.com, notion.so]
`);
    const watcher = config.watchers[0];
    expect(watcher?.type === 'account-changes' && watcher.domains).toEqual(['stripe.com', 'notion.so']);
    expect(watcher?.type === 'account-changes' && watcher.expand).toEqual(['financial', 'technologies', 'workforce']);
  });

  it('reports bad YAML with its position', () => {
    const message = errorFor('watchers:\n  - id: a\n    type: [unclosed\n');
    expect(message).toMatch(/^test\.yaml is not valid YAML: /);
    expect(message).toMatch(/line \d+/);
  });

  it('reports schema problems with the path to the field', () => {
    const message = errorFor(`
watchers:
  - id: leaders
    type: new-leaders
    domains: []
    seniority: [boss]
`);
    expect(message).toContain('test.yaml is invalid:');
    expect(message).toContain('watchers[0].domains: List at least one domain');
    expect(message).toContain('watchers[0].seniority[0]');
  });

  it('rejects unknown watcher types, unknown keys and duplicate ids', () => {
    expect(errorFor('watchers:\n  - id: a\n    type: new-jobs\n')).toContain('watchers[0].type');
    expect(
      errorFor('watchers:\n  - id: a\n    type: account-changes\n    domains: [a.com]\n    refreshDays: 3\n'),
    ).toContain('refreshDays');
    expect(
      errorFor(
        'watchers:\n  - id: a\n    type: account-changes\n    domains: [a.com]\n  - id: a\n    type: account-changes\n    domains: [b.com]\n',
      ),
    ).toContain('watchers[1].id: Duplicate watcher id "a"');
  });

  it('rejects unknown company filter keys and suggests the right one', () => {
    const companies = (filter: string) => `watchers:\n  - id: a\n    type: new-companies\n    query:\n      filter: ${filter}\n`;

    expect(errorFor(companies('{ country: US, employes: [51-200] }'))).toContain(
      'watchers[0].query.filter.employes: Unknown company filter field "employes". Did you mean "employees"?',
    );
    expect(errorFor(companies('{ industry: Software }'))).toContain(
      'Unknown company filter field "industry". Use naicsCodes (codes from `industries.list()`), keywords or categories.',
    );
    expect(errorFor(companies('{ constructor: x }'))).toContain('Unknown company filter field "constructor"');
  });

  it('checks the keys inside advanced rules, ranges and workforce filters', () => {
    const companies = (filter: string) => `watchers:\n  - id: a\n    type: new-companies\n    query:\n      filter: ${filter}\n`;

    expect(errorFor(companies('{ domain: { notin: [a.com] } }'))).toContain(
      'watchers[0].query.filter.domain.notin: Unknown key "notin" in domain. Did you mean "notIn"?',
    );
    expect(errorFor(companies('{ country: { all: [US] } }'))).toContain('Unknown key "all" in country.');
    expect(errorFor(companies('{ fundingYear: { from: 2026 } }'))).toContain('Unknown key "from" in fundingYear.');
    expect(errorFor(companies('{ workforceGrowth: { periode: m6, min: 0.2 } }'))).toContain('Did you mean "period"?');
    expect(errorFor(companies('[{ department: sales }]'))).toContain('watchers[0].query.filter');
    expect(errorFor(companies('{ workforceSize: [{ department: sales, minimum: 5 }] }'))).toContain(
      'watchers[0].query.filter.workforceSize[0].minimum',
    );

    expect(() =>
      parseConfig(companies('{ technologies: { all: [Snowflake] }, workforceSize: [{ department: sales, min: 5 }] }')),
    ).not.toThrow();
  });

  it('requires a filter or semantic query for new-companies', () => {
    expect(errorFor('watchers:\n  - id: a\n    type: new-companies\n    query: {}\n')).toContain(
      'Set query.filter, query.semantic, or both',
    );
  });

  it('explains how to start when the config file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gtm-config-'));
    expect(() => loadConfig(join(dir, 'monitor.config.yaml'))).toThrow(/Copy monitor\.config\.example\.yaml/);
  });

  it('rejects an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gtm-config-'));
    const path = join(dir, 'empty.yaml');
    writeFileSync(path, '');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});
