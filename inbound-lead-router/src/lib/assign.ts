import type { Team, TeamMember } from './config';
import { readJsonFile, writeJsonFile } from './json-file';

// Picks the owner inside a team. Round-robin teams rotate new accounts through
// their members, and an account that comes back keeps its owner (sticky), so
// two signups from the same company never land with two different reps.
// State lives in a small JSON file so a restart keeps the rotation.

export interface Assignment {
  team: string;
  owner: TeamMember;
  method: 'pinned' | 'single-owner' | 'round-robin' | 'sticky';
  reason: string;
}

interface TeamState {
  /** Rotation counter: the next new account goes to members[next % members.length]. */
  next: number;
  /** Account domain -> owner name. */
  accounts: Record<string, string>;
}

type State = Record<string, TeamState>;

const MAX_ACCOUNTS_PER_TEAM = 5_000;

export class OwnerAssigner {
  private state: State;

  constructor(private readonly file?: string) {
    this.state = (file && readJsonFile<State>(file)) || {};
  }

  assign(teamKey: string, team: Team, options: { pinnedOwner: string | null; account: string | null }): Assignment {
    const { pinnedOwner, account } = options;
    if (pinnedOwner) {
      const owner = team.members.find((member) => member.name === pinnedOwner) ?? { name: pinnedOwner };
      return { team: teamKey, owner, method: 'pinned', reason: `The rule pins ${pinnedOwner}` };
    }

    const first = team.members[0] as TeamMember;
    if (!team.roundRobin || team.members.length === 1) {
      return { team: teamKey, owner: first, method: 'single-owner', reason: `${first.name} owns every lead for this team` };
    }

    const state = (this.state[teamKey] ??= { next: 0, accounts: {} });
    const previous = account ? state.accounts[account] : undefined;
    const sticky = previous ? team.members.find((member) => member.name === previous) : undefined;
    if (sticky && account) {
      return { team: teamKey, owner: sticky, method: 'sticky', reason: `${account} already belongs to ${sticky.name}` };
    }

    const slot = state.next % team.members.length;
    const owner = team.members[slot] as TeamMember;
    state.next = slot + 1;
    if (account) {
      state.accounts[account] = owner.name;
      const keys = Object.keys(state.accounts);
      if (keys.length > MAX_ACCOUNTS_PER_TEAM) delete state.accounts[keys[0] as string];
    }
    if (this.file) writeJsonFile(this.file, this.state);
    return {
      team: teamKey,
      owner,
      method: 'round-robin',
      reason: `Round-robin slot ${slot + 1} of ${team.members.length}`,
    };
  }
}
