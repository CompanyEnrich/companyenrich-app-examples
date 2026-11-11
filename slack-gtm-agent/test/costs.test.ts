import { describe, expect, it } from 'vitest';
import { COST_RULES, costRuleFor, pageSizeOf } from '../src/lib/costs.js';

const estimate = (tool: string, args: Record<string, unknown> = {}) => {
  const rule = costRuleFor(tool);
  if (!rule) throw new Error(`no rule for ${tool}`);
  return rule.estimate(args);
};

describe('cost estimates', () => {
  it('prices the free tools at zero', () => {
    for (const tool of ['get_current_user', 'count_companies', 'count_people']) expect(estimate(tool)).toBe(0);
  });

  it('prices company lookups at 1 credit, plus 5 for workforce', () => {
    for (const tool of ['enrich_company', 'get_company_by_id', 'enrich_company_by_properties']) {
      expect(estimate(tool, { domain: 'stripe.com' })).toBe(1);
      expect(estimate(tool, { domain: 'stripe.com', includeWorkforce: true })).toBe(6);
    }
    expect(estimate('get_company_workforce', { domain: 'stripe.com' })).toBe(5);
  });

  it('prices a search as a full page at the MCP default page size of 20', () => {
    expect(estimate('search_companies')).toBe(20);
    expect(estimate('search_people')).toBe(40);
    expect(estimate('find_similar_companies', { domains: ['stripe.com'] })).toBe(100);
  });

  it('prices semantic company search at 2 credits per company, as measured live', () => {
    expect(estimate('search_companies', { semanticQuery: 'fintech in Berlin', pageSize: 5 })).toBe(10);
    expect(estimate('search_companies', { semanticQuery: '   ', pageSize: 5 })).toBe(5);
  });

  it('adds workforce per returned company', () => {
    expect(estimate('search_companies', { pageSize: 3, includeWorkforce: true })).toBe(18);
    expect(estimate('find_similar_companies', { pageSize: 2, includeWorkforce: true })).toBe(20);
  });

  it('prices person tools per call', () => {
    expect(estimate('search_people', { pageSize: 3 })).toBe(6);
    expect(estimate('get_person_by_id', { id: 1 })).toBe(2);
    expect(estimate('lookup_person_by_email', { email: 'a@b.co' })).toBe(5);
    expect(estimate('enrich_person_email', { id: 1 })).toBe(10);
  });

  it('clamps page sizes the way the MCP server does', () => {
    expect(pageSizeOf({ pageSize: 500 })).toBe(100);
    expect(pageSizeOf({ pageSize: 0 })).toBe(1);
    expect(pageSizeOf({ pageSize: 2.7 })).toBe(2);
    expect(pageSizeOf({ pageSize: 'lots' })).toBe(20);
  });

  it('has no rule for unknown tools, including inherited object keys', () => {
    expect(costRuleFor('brand_new_tool')).toBeUndefined();
    expect(costRuleFor('toString')).toBeUndefined();
  });

  it('describes every rule in words', () => {
    for (const rule of Object.values(COST_RULES)) expect(rule.pricing.length).toBeGreaterThan(3);
  });
});
