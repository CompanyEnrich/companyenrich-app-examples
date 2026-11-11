import { describe, expect, it } from 'vitest';
import { ConfigError, parseScoringConfig } from '../src/lib/config';
import { shippedConfig } from './helpers';

describe('config files', () => {
  it('ships valid scoring and routing configs whose weights add up to 100', () => {
    const { scoring, routing } = shippedConfig();
    const total = Object.values(scoring.dimensions).reduce((sum, dimension) => sum + dimension.weight, 0);
    expect(total).toBe(100);
    expect(routing.rules.length).toBeGreaterThan(0);
  });

  it('names the bad field in the error', () => {
    const { scoring } = shippedConfig();
    const broken = structuredClone(scoring) as unknown as { dimensions: { employees: { match: Record<string, number> } } };
    broken.dimensions.employees.match['11-50'] = 3;
    expect(() => parseScoringConfig(broken, 'config/scoring.json')).toThrow(ConfigError);
    expect(() => parseScoringConfig(broken, 'config/scoring.json')).toThrow(/config\/scoring\.json is invalid[\s\S]*at dimensions\.employees\.match\["11-50"\]/);
  });

  it('rejects tier thresholds out of order', () => {
    const { scoring } = shippedConfig();
    expect(() => parseScoringConfig({ ...scoring, tiers: { A: 40, B: 50, C: 30 } })).toThrow(/A >= B >= C/);
  });
});
