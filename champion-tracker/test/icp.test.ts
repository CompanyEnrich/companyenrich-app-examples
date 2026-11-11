import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/lib/config.js';
import { scoreCompany } from '../src/lib/icp.js';
import { company } from './helpers/fixtures.js';

const config = parseConfig({
  icp: {
    employees: { weight: 40, match: ['201-500', '501-1K'] },
    revenue: { weight: 20, match: ['50m-100m'] },
    categories: { weight: 20, match: ['saas'] },
    country: { weight: 20, match: ['US', 'GB'] },
  },
  buyerPersona: { seniority: ['vp'] },
});

describe('scoreCompany', () => {
  it('gives 100 and a strong fit when every criterion matches', () => {
    const score = scoreCompany(company('globex.example'), config.icp);
    expect(score.score).toBe(100);
    expect(score.fit).toBe('strong');
    expect(score.parts.map((part) => part.verdict)).toEqual(['match', 'match', 'match', 'match']);
  });

  it('gives half points to a band next to an accepted one', () => {
    const score = scoreCompany(company('globex.example', { employees: '1K-5K', revenue: 'over-1b' }), config.icp);
    expect(score.parts.find((part) => part.criterion === 'employees')).toMatchObject({ verdict: 'near', points: 20 });
    expect(score.parts.find((part) => part.criterion === 'revenue')).toMatchObject({ verdict: 'miss', points: 0 });
    expect(score.score).toBe(60);
    expect(score.fit).toBe('partial');
  });

  it('scores missing data as unknown, earning nothing', () => {
    const score = scoreCompany(company('globex.example', { employees: null, revenue: null, categories: [], location: null }), config.icp);
    expect(score.parts.every((part) => part.verdict === 'unknown')).toBe(true);
    expect(score.score).toBe(0);
    expect(score.fit).toBe('weak');
  });

  it('only scores the criteria present in the config', () => {
    const countryOnly = parseConfig({ icp: { country: { weight: 1, match: ['DE'] } }, buyerPersona: { seniority: ['vp'] } });
    const score = scoreCompany(company('globex.example', { location: { country: { code: 'DE', name: 'Germany' } } }), countryOnly.icp);
    expect(score.parts).toHaveLength(1);
    expect(score.score).toBe(100);
  });
});

describe('parseConfig', () => {
  it('accepts the shipped example config', () => {
    const example = parseConfig(JSON.parse(readFileSync('config/icp.example.json', 'utf8')));
    expect(example.buyerPersona.department).toContain('sales');
  });

  it('explains invalid values with their path', () => {
    const invalid = { icp: { employees: { weight: 10, match: ['200-500'] }, country: { weight: 5, match: ['usa'] } }, buyerPersona: { seniority: ['boss'] } };
    expect(() => parseConfig(invalid)).toThrow(ConfigError);
    expect(() => parseConfig(invalid)).toThrow(/icp\.employees\.match\.0[\s\S]*icp\.country\.match\.0[\s\S]*buyerPersona\.seniority\.0/);
  });

  it('rejects a department the API does not accept, before any paid call can happen', () => {
    const config = { icp: { country: { weight: 1, match: ['US'] } }, buyerPersona: { seniority: ['vp'], department: ['sales', 'not-a-real-department'] } };
    expect(() => parseConfig(config)).toThrow(/buyerPersona\.department\.1: not a department the API accepts/);
    expect(parseConfig({ ...config, buyerPersona: { seniority: ['vp'], department: ['sales/revenue-operations', 'c-suite/sales-executive'] } }).buyerPersona.department).toHaveLength(2);
  });

  it('rejects misspelled keys instead of silently ignoring them', () => {
    expect(() => parseConfig({ icp: { employes: { weight: 1, match: ['1-10'] } }, buyerPersona: { seniority: ['vp'] } })).toThrow(/employes/);
  });

  it('requires at least one weighted criterion', () => {
    expect(() => parseConfig({ icp: { country: { weight: 0, match: ['US'] } }, buyerPersona: { seniority: ['vp'] } })).toThrow(/at least one criterion/);
  });
});
