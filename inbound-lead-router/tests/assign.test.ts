import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnerAssigner } from '../src/lib/assign';
import type { Team } from '../src/lib/config';
import { tempDir } from './helpers';

const team: Team = { label: 'US West', roundRobin: true, members: [{ name: 'Casey' }, { name: 'Morgan', slackUserId: 'U0MORGAN1' }] };

describe('OwnerAssigner', () => {
  it('rotates new accounts through the members', () => {
    const assigner = new OwnerAssigner();
    const owners = ['a.example', 'b.example', 'c.example'].map((account) => assigner.assign('us-west', team, { pinnedOwner: null, account }).owner.name);
    expect(owners).toEqual(['Casey', 'Morgan', 'Casey']);
  });

  it('keeps an account with its first owner (sticky)', () => {
    const assigner = new OwnerAssigner();
    assigner.assign('us-west', team, { pinnedOwner: null, account: 'a.example' });
    assigner.assign('us-west', team, { pinnedOwner: null, account: 'b.example' });
    const again = assigner.assign('us-west', team, { pinnedOwner: null, account: 'a.example' });
    expect(again).toMatchObject({ method: 'sticky', owner: { name: 'Casey' } });
    // The sticky hit does not consume a rotation slot.
    expect(assigner.assign('us-west', team, { pinnedOwner: null, account: 'c.example' }).owner.name).toBe('Casey');
  });

  it('persists the rotation to a JSON file and resumes from it', () => {
    const file = join(tempDir(), 'round-robin.json');
    new OwnerAssigner(file).assign('us-west', team, { pinnedOwner: null, account: 'a.example' });
    const restarted = new OwnerAssigner(file);
    expect(restarted.assign('us-west', team, { pinnedOwner: null, account: 'b.example' }).owner.name).toBe('Morgan');
    expect(restarted.assign('us-west', team, { pinnedOwner: null, account: 'a.example' }).method).toBe('sticky');
  });

  it('reassigns a sticky account whose owner left the team', () => {
    const assigner = new OwnerAssigner();
    assigner.assign('us-west', team, { pinnedOwner: null, account: 'a.example' });
    const smaller: Team = { ...team, members: [{ name: 'Morgan' }, { name: 'Jamie' }] };
    expect(assigner.assign('us-west', smaller, { pinnedOwner: null, account: 'a.example' }).method).toBe('round-robin');
  });

  it('gives every lead to the first member when round-robin is off', () => {
    const single: Team = { ...team, roundRobin: false };
    const assignment = new OwnerAssigner().assign('emea', single, { pinnedOwner: null, account: 'a.example' });
    expect(assignment).toMatchObject({ method: 'single-owner', owner: { name: 'Casey' } });
  });

  it('honours a pinned owner', () => {
    const assignment = new OwnerAssigner().assign('us-west', team, { pinnedOwner: 'Morgan', account: 'a.example' });
    expect(assignment).toMatchObject({ method: 'pinned', owner: { name: 'Morgan', slackUserId: 'U0MORGAN1' } });
  });
});
