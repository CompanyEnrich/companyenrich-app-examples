import { describe, expect, it } from 'vitest';
import { toCompanyFacts } from '../src/lib/company';
import { ConfigError, parseRoutingConfig, type RoutingConfig } from '../src/lib/config';
import { routeLead } from '../src/lib/route';
import { companyFixture } from './fake-api';
import { shippedConfig } from './helpers';

const { routing } = shippedConfig();
const company = (overrides = {}) => toCompanyFacts(companyFixture(overrides), []);

describe('routeLead (shipped config)', () => {
  it('fires the first matching rule and marks later matches as shadowed', () => {
    const decision = routeLead({ tier: 'A', company: company() }, routing);
    expect(decision.firedRule).toBe('Tier A enterprise in North America');
    expect(decision.team).toBe('enterprise-na');
    expect(decision.rules.map((rule) => rule.outcome)).toEqual(['fired', 'shadowed', 'shadowed', 'no-match', 'shadowed']);
  });

  it('records every condition with expected and actual values', () => {
    const decision = routeLead({ tier: 'B', company: company({ employees: '51-200' }) }, routing);
    expect(decision.rules[0]?.checks).toEqual([
      { field: 'tier', expected: 'A', actual: 'B', pass: false },
      { field: 'country', expected: 'one of US, CA', actual: 'US', pass: true },
      { field: 'employees', expected: 'at least 501-1K', actual: '51-200', pass: false },
    ]);
    expect(decision.firedRule).toBe('Mid-market US West');
  });

  it('matches states by code or by name', () => {
    const texas = company({ location: { country: { code: 'US', name: 'United States' }, state: { id: 9, name: 'Texas', code: 'TX' } } });
    expect(routeLead({ tier: 'B', company: texas }, routing).team).toBe('us-east');

    const byName = structuredClone(routing);
    byName.rules[1]!.when.state = ['texas'];
    expect(routeLead({ tier: 'B', company: texas }, byName).team).toBe('us-west');
  });

  it('applies employee ranges as an ordered min and max', () => {
    const config = parseRoutingConfig({
      ...routing,
      rules: [{ name: 'Mid', when: { employees: { min: '51-200', max: '501-1K' } }, team: 'inside-sales' }],
    });
    expect(routeLead({ tier: 'C', company: company({ employees: '201-500' }) }, config).firedRule).toBe('Mid');
    expect(routeLead({ tier: 'C', company: company({ employees: '1K-5K' }) }, config).firedRule).toBeNull();
    expect(routeLead({ tier: 'C', company: company({ employees: null }) }, config).firedRule).toBeNull();
  });

  it('falls through to the fallback team when nothing matches', () => {
    const decision = routeLead({ tier: 'unqualified', company: company() }, routing);
    expect(decision.firedRule).toBeNull();
    expect(decision.team).toBe('nurture');
    expect(decision.rules.every((rule) => rule.outcome === 'no-match')).toBe(true);
    expect(decision.reason).toContain('fallback');
  });

  it('routes unscored leads (free-mail) to the fallback', () => {
    const decision = routeLead({ tier: null, company: null }, routing);
    expect(decision.team).toBe('nurture');
    expect(decision.rules[0]?.checks[0]).toMatchObject({ field: 'tier', actual: 'not scored', pass: false });
  });

  it('uses the rule persona, else the default persona', () => {
    expect(routeLead({ tier: 'A', company: company() }, routing).persona.seniority).toEqual(['c-suite', 'vp', 'head']);
    expect(routeLead({ tier: 'B', company: company() }, routing).persona).toEqual(routing.people.persona);
  });

  it('passes a pinned owner through', () => {
    const config: RoutingConfig = structuredClone(routing);
    config.rules[0]!.owner = 'Riley';
    expect(routeLead({ tier: 'A', company: company() }, config).pinnedOwner).toBe('Riley');
  });
});

describe('parseRoutingConfig', () => {
  it('rejects rules that point at unknown teams or owners', () => {
    const broken = { ...routing, rules: [{ name: 'x', when: {}, team: 'nope' }], fallback: { team: 'nurture', owner: 'Ghost' } };
    expect(() => parseRoutingConfig(broken)).toThrow(ConfigError);
    expect(() => parseRoutingConfig(broken)).toThrow(/Unknown team "nope"\n  → at rules\[0\]\.team/);
    expect(() => parseRoutingConfig(broken)).toThrow(/"Ghost" is not a member of team "nurture"\n  → at fallback\.owner/);
  });

  it('rejects unknown seniority and department values and condition fields', () => {
    expect(() => parseRoutingConfig({ ...routing, people: { persona: { seniority: ['boss'] } } })).toThrow(/seniority/);
    expect(() => parseRoutingConfig({ ...routing, people: { persona: { department: ['engineering-technical/not-a-real-department'] } } })).toThrow(
      /department/,
    );
    expect(parseRoutingConfig({ ...routing, people: { persona: { department: ['sales/revenue-operations'] } } }).people.persona.department).toEqual([
      'sales/revenue-operations',
    ]);
    expect(() => parseRoutingConfig({ ...routing, rules: [{ name: 'x', when: { city: ['Paris'] }, team: 'emea' }] })).toThrow(/city/);
  });
});
