import { describe, expect, it } from 'vitest';
import { detectChange } from '../src/lib/detect.js';
import { baseline, person, role } from './helpers/fixtures.js';

const LAST_CHECK = '2026-10-01T08:00:00.000Z';

describe('detectChange: no change', () => {
  it('reports nothing when the champion still holds the same role', () => {
    const change = detectChange(baseline(), person([role('acme.example')]), LAST_CHECK);
    expect(change.kind).toBe('none');
  });

  it('treats a company that changed its domain as the same employer and updates the baseline', () => {
    const rebranded = role('acmehq.example', { companyId: 'co-acme.example', companyName: 'Acme' });
    const change = detectChange(baseline(), person([rebranded]), LAST_CHECK);
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.baseline.companyId).toBe('co-acme.example');
    expect(change.baseline.companyDomain).toBe('acmehq.example');
  });

  it('ignores a second current role the champion already had when the baseline was taken', () => {
    const sideBusiness = role('consulting.example', { position: 'Owner', seniority: 'owner', start: '2019-01-01' });
    const previous = baseline({ otherCurrentCompanies: ['co-consulting.example'] });
    const change = detectChange(previous, person([role('acme.example'), sideBusiness]), LAST_CHECK);
    expect(change.kind).toBe('none');
  });

  it('ignores a new advisory or board role next to the main job', () => {
    const advisor = role('startup.example', { position: 'Advisory Board Member', seniority: null, start: '2026-09-01' });
    const change = detectChange(baseline(), person([role('acme.example'), advisor]), LAST_CHECK);
    expect(change.kind).toBe('none');
  });

  it('does not alert on a title edit without a new start date or higher seniority', () => {
    const edited = role('acme.example', { position: 'Sales Director' });
    const change = detectChange(baseline(), person([edited]), LAST_CHECK);
    expect(change.kind).toBe('none');
    if (change.kind === 'none') expect(change.baseline.position).toBe('Sales Director');
  });

  it('does not alert on a move to a lower seniority', () => {
    const lower = role('acme.example', { position: 'Sales Manager', seniority: 'manager', start: '2026-09-01' });
    expect(detectChange(baseline(), person([lower]), LAST_CHECK).kind).toBe('none');
  });

  it('keeps the baseline when the profile has no work history at all', () => {
    const change = detectChange(baseline(), person([]), LAST_CHECK);
    expect(change.kind).toBe('unknown');
  });
});

describe('detectChange: moved', () => {
  it('reports a confirmed move when the old role has ended and a new one started', () => {
    const experiences = [
      role('globex.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' }),
      role('acme.example', { end: '2026-08-01' }),
    ];
    const change = detectChange(baseline(), person(experiences), LAST_CHECK);
    expect(change.kind).toBe('moved');
    if (change.kind !== 'moved') return;
    expect(change.confidence).toBe('confirmed');
    expect(change.to.company?.domain).toBe('globex.example');
    expect(change.from.companyName).toBe('Acme');
    expect(change.baseline).toMatchObject({ companyId: 'co-globex.example', position: 'VP Sales', seniority: 'vp', positionStartDate: '2026-09-01' });
  });

  it('reports a likely move when the old role is still listed as current (data lag)', () => {
    const experiences = [role('acme.example'), role('globex.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' })];
    const change = detectChange(baseline(), person(experiences), LAST_CHECK);
    expect(change.kind).toBe('moved');
    if (change.kind !== 'moved') return;
    expect(change.confidence).toBe('likely');
    // The old employer is remembered, so the next check does not report the same move again.
    expect(change.baseline.otherCurrentCompanies).toContain('co-acme.example');
    expect(detectChange(change.baseline, person(experiences), LAST_CHECK).kind).toBe('none');
  });

  it('ignores a newly listed role that started before the tracked one (backfilled history)', () => {
    const backfilled = role('oldjob.example', { position: 'Consultant', seniority: 'senior', start: '2018-01-01' });
    const change = detectChange(baseline(), person([role('acme.example'), backfilled]), LAST_CHECK);
    expect(change.kind).toBe('none');
  });

  it('picks the newest of several current roles as the destination', () => {
    const experiences = [
      role('acme.example', { end: '2026-06-01' }),
      role('family-firm.example', { position: 'Partner', seniority: 'partner', start: '2015-01-01' }),
      role('globex.example', { position: 'VP Sales', seniority: 'vp', start: '2026-07-01' }),
    ];
    const change = detectChange(baseline({ otherCurrentCompanies: ['co-family-firm.example'] }), person(experiences), LAST_CHECK);
    expect(change.kind === 'moved' && change.to.company?.domain).toBe('globex.example');
  });

  it('reports a move on the first check when init found the champion away from the account', () => {
    const notAtAccount = baseline({ companyId: null, companyDomain: 'acme.example', companyName: 'acme.example', position: null, seniority: null, positionStartDate: null });
    const change = detectChange(notAtAccount, person([role('initech.example', { position: 'VP Revenue', start: '2024-02-01' })]), LAST_CHECK);
    expect(change.kind === 'moved' && change.to.company?.domain).toBe('initech.example');
  });

  it('still detects a move when start dates are missing', () => {
    const experiences = [role('acme.example', { start: null, end: '2026-06-01' }), role('globex.example', { start: null })];
    const change = detectChange(baseline({ positionStartDate: null }), person(experiences), LAST_CHECK);
    expect(change.kind === 'moved' && change.to.company?.domain).toBe('globex.example');
  });

  it('prefers a dated role over an undated one', () => {
    const experiences = [role('acme.example', { end: '2026-06-01' }), role('undated.example', { start: null }), role('globex.example', { start: '2026-07-01' })];
    const change = detectChange(baseline(), person(experiences), LAST_CHECK);
    expect(change.kind === 'moved' && change.to.company?.domain).toBe('globex.example');
  });

  it('handles employers without a company record', () => {
    const experiences = [role('acme.example', { end: '2026-06-01' }), role(null, { companyName: 'Stealth Startup', start: '2026-07-01' })];
    const change = detectChange(baseline(), person(experiences), LAST_CHECK);
    expect(change.kind).toBe('moved');
    if (change.kind === 'moved') expect(change.baseline.otherCurrentCompanies).toEqual([]);
  });
});

describe('detectChange: left', () => {
  it('reports left, destination unknown, when no role is current', () => {
    const change = detectChange(baseline(), person([role('acme.example', { end: '2026-08-01' })]), LAST_CHECK);
    expect(change.kind).toBe('left');
    if (change.kind === 'left') expect(change.baseline.status).toBe('left');
  });

  it('reports left, not a move, when only a side business they already had remains', () => {
    const sideBusiness = role('consulting.example', { position: 'Owner', seniority: 'owner', start: '2019-01-01' });
    const previous = baseline({ otherCurrentCompanies: ['co-consulting.example'] });
    const change = detectChange(previous, person([role('acme.example', { end: '2026-08-01' }), sideBusiness]), LAST_CHECK);
    expect(change.kind).toBe('left');
    if (change.kind !== 'left') return;
    expect(change.otherRoles.map((other) => other.company?.domain)).toEqual(['consulting.example']);
    // Later, a genuinely new employer is reported as a move; the side business never is.
    expect(detectChange(change.baseline, person([sideBusiness]), LAST_CHECK).kind).toBe('none');
    const newJob = role('globex.example', { position: 'VP Sales', start: '2026-10-01' });
    const later = detectChange(change.baseline, person([newJob, sideBusiness]), LAST_CHECK);
    expect(later.kind === 'moved' && later.to.company?.domain).toBe('globex.example');
  });

  it('reports left when only side roles remain', () => {
    const experiences = [role('acme.example', { end: '2026-08-01' }), role('charity.example', { position: 'Volunteer Mentor', seniority: null })];
    expect(detectChange(baseline(), person(experiences), LAST_CHECK).kind).toBe('left');
  });

  it('turns into a move from the old company once the new role appears', () => {
    const left = baseline({ status: 'left' });
    const experiences = [role('globex.example', { position: 'VP Sales', start: '2026-10-01' }), role('acme.example', { end: '2026-08-01' })];
    const change = detectChange(left, person(experiences), LAST_CHECK);
    expect(change.kind).toBe('moved');
    if (change.kind === 'moved') expect(change.from.companyName).toBe('Acme');
  });

  it('stays quiet while someone who left has no new role yet', () => {
    const left = baseline({ status: 'left' });
    expect(detectChange(left, person([role('acme.example', { end: '2026-08-01' })]), LAST_CHECK).kind).toBe('none');
  });

  it('does not alert when the old role reappears after a data refresh', () => {
    const change = detectChange(baseline({ status: 'left' }), person([role('acme.example')]), LAST_CHECK);
    expect(change.kind).toBe('none');
    if (change.kind === 'none') expect(change.baseline.status).toBe('active');
  });
});

describe('detectChange: promoted', () => {
  it('reports a new title with a higher seniority at the same company', () => {
    const promoted = role('acme.example', { position: 'VP Sales', seniority: 'vp', start: null });
    const change = detectChange(baseline(), person([promoted]), LAST_CHECK);
    expect(change.kind).toBe('promoted');
    if (change.kind === 'promoted') expect(change.baseline.seniority).toBe('vp');
  });

  it('reports a new title with a newer start date when seniority is unknown', () => {
    const promoted = role('acme.example', { position: 'Head of Revenue', seniority: null, start: '2026-09-01' });
    expect(detectChange(baseline({ seniority: null }), person([promoted]), LAST_CHECK).kind).toBe('promoted');
  });

  it('uses the newest role when the old title is still listed as current at the same company', () => {
    const experiences = [role('acme.example'), role('acme.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' })];
    const change = detectChange(baseline(), person(experiences), LAST_CHECK);
    expect(change.kind === 'promoted' && change.to.position).toBe('VP Sales');
  });

  it('compares with the last check date when the baseline has no start date', () => {
    const previous = baseline({ positionStartDate: null, seniority: null });
    const startedBefore = role('acme.example', { position: 'Head of Sales', seniority: null, start: '2026-05-01' });
    const startedAfter = role('acme.example', { position: 'Head of Sales', seniority: null, start: '2026-11-01' });
    expect(detectChange(previous, person([startedBefore]), LAST_CHECK).kind).toBe('none');
    expect(detectChange(previous, person([startedAfter]), LAST_CHECK).kind).toBe('promoted');
  });
});
