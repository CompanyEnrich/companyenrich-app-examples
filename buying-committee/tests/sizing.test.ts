import { describe, expect, it } from 'vitest';
import { findEmployeeRange } from '../src/lib/accounts';
import { findPreset } from '../src/lib/blueprints';
import { adaptForSize, bandFor, EMPLOYEE_RANGES } from '../src/lib/size';
import { fakeApi } from './fake-api';

describe('bandFor', () => {
  it('maps employee ranges to size bands', () => {
    expect(bandFor('11-50')).toBe('small');
    expect(bandFor('201-500')).toBe('mid');
    expect(bandFor('501-1K')).toBe('large');
    expect(bandFor(null)).toBe('unknown');
  });
});

describe('adaptForSize', () => {
  const devtools = findPreset('devtools')!;
  const security = findPreset('security')!;

  it('collapses a small committee into a founder-led one', () => {
    const { roles, adaptation } = adaptForSize(devtools, 'small');
    expect(roles.map((role) => role.key)).toEqual(['economic-buyer', 'champion']);
    expect(roles[0]!.seniority).toEqual(['founder', 'owner', 'c-suite']);
    expect(adaptation.join(' ')).toMatch(/1-50 employees/);
  });

  it('keeps the preset for mid-size and unknown accounts', () => {
    expect(adaptForSize(devtools, 'mid').roles).toEqual(devtools.roles);
    expect(adaptForSize(devtools, 'unknown').adaptation[0]).toMatch(/unknown/);
  });

  it('adds review roles and raises the economic buyer for large accounts', () => {
    const { roles } = adaptForSize(devtools, 'large');
    expect(roles.map((role) => role.key)).toContain('security-review');
    expect(roles.map((role) => role.key)).toContain('procurement-legal');
    expect(roles.find((role) => role.key === 'economic-buyer')!.seniority).toEqual(['c-suite', 'vp']);
    expect(roles.map((role) => role.priority)).toEqual([...roles.map((role) => role.priority)].sort((a, b) => a - b));
  });

  it('does not add a second security role to a security committee', () => {
    const keys = adaptForSize(security, 'large').roles.map((role) => role.key);
    expect(keys).not.toContain('security-review');
    expect(keys).toContain('procurement-legal');
  });
});

describe('findEmployeeRange', () => {
  it.each(EMPLOYEE_RANGES)('finds %s with free counts', async (range) => {
    const api = fakeApi([{ domain: 'acme.com', name: 'Acme', employees: range, people: [] }]);
    expect(await findEmployeeRange(api.client, 'acme.com')).toBe(range);
    expect(api.calls.length).toBeLessThanOrEqual(4);
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('returns null when the range is unknown', async () => {
    const api = fakeApi([{ domain: 'acme.com', name: 'Acme', employees: null, people: [] }]);
    expect(await findEmployeeRange(api.client, 'acme.com')).toBeNull();
  });
});
