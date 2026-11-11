import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OutboxEntry } from './outbox.js';
import type { Baseline } from './profile.js';

export interface ChampionRecord {
  /** "id:<person id>" or "email:<sha256 of the email>", so init can recognise rows it already resolved. */
  key: string;
  personId: string;
  accountDomain: string;
  dealName: string;
  owner: string;
  baseline: Baseline;
  lastCheckedAt: string;
  /**
   * Set when a check was due but skipped (credit cap, early stop) or failed. The next run checks
   * these first, whatever the interval, so a capped run resumes instead of re-buying profiles.
   */
  pendingCheck?: boolean;
}

export interface TrackerState {
  version: 1;
  champions: ChampionRecord[];
  /** Digests not yet written or posted. They name people, so they leave state once delivered. */
  outbox?: OutboxEntry[];
}

export class StateError extends Error {}

export const DEFAULT_STATE_PATH = 'state/state.json';

export function loadState(path: string): TrackerState | null {
  if (!existsSync(path)) return null;
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new StateError(`State file ${path} is not valid JSON. Restore it from version control or delete it and run init again.`);
  }
  if (!isTrackerState(state)) {
    throw new StateError(`State file ${path} is not a champion-tracker state file (expected version 1 with a champions list).`);
  }
  return state;
}

/** Writes to a temporary file first so an interrupted run never leaves half a state file behind. */
export function saveState(path: string, state: TrackerState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

function isTrackerState(value: unknown): value is TrackerState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TrackerState).version === 1 &&
    Array.isArray((value as TrackerState).champions) &&
    ((value as TrackerState).outbox === undefined || Array.isArray((value as TrackerState).outbox))
  );
}
