import type { Person } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { rankCandidates, toMappedPerson } from '../src/lib/ranking';
import type { RoleSpec } from '../src/lib/types';
import { person } from './fake-api';

const now = new Date('2026-11-10T00:00:00Z');

describe('toMappedPerson', () => {
  it('uses the current job at the account and flags starts within 90 days', () => {
    const recent = toMappedPerson(person('acme.com', { seniority: 'vp', department: 'sales', title: 'VP Sales', start: '2026-09-01' }), 'acme.com', now);
    expect(recent).toMatchObject({ title: 'VP Sales', newInRole: true, monthsInRole: 2, roleStartDate: '2026-09-01' });

    const settled = toMappedPerson(person('acme.com', { seniority: 'vp', department: 'sales', title: 'VP Sales', start: '2026-07-01' }), 'acme.com', now);
    expect(settled.newInRole).toBe(false);
  });

  it('prefers the experience at the account over another current job', () => {
    const p = person('acme.com', { seniority: 'vp', department: 'sales', title: 'VP Sales' });
    const withAdvisory: Person = {
      ...p,
      position: 'helping founders grow | advisor',
      experiences: [
        { isCurrent: true, isMatched: false, startDate: '2020-01-01', position: 'Advisor', company: { id: 'o', name: 'Other', domain: 'other.com' } },
        ...p.experiences,
      ],
    };
    expect(toMappedPerson(withAdvisory, 'acme.com', now).title).toBe('VP Sales');
  });
});

describe('rankCandidates', () => {
  const role: RoleSpec = {
    key: 'economic-buyer', label: '', why: '', department: [], seniority: ['c-suite', 'vp'], position: ['security', 'it'], limit: 3, priority: 1,
  };
  const base = { id: '', name: '', department: null, roleStartDate: null, newInRole: false, linkedinUrl: null };

  it('orders by seniority fit, then title phrase, then tenure', () => {
    const ranked = rankCandidates(
      [
        { ...base, id: 'vp-it', title: 'VP IT', seniority: 'vp', monthsInRole: 50 },
        { ...base, id: 'vp-sec-new', title: 'VP Security', seniority: 'vp', monthsInRole: 3 },
        { ...base, id: 'vp-sec-old', title: 'VP Security', seniority: 'vp', monthsInRole: 30 },
        { ...base, id: 'ciso', title: 'CISO', seniority: 'c-suite', monthsInRole: 1 },
      ],
      role,
    );
    expect(ranked.map((p) => p.id)).toEqual(['ciso', 'vp-sec-old', 'vp-sec-new', 'vp-it']);
  });
});
