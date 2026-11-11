import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CompanySnapshot } from './snapshot.js';

export interface NewCompaniesState {
  type: 'new-companies';
  lastRunAt: string;
  /** Domains already reported, oldest first. */
  seenDomains: string[];
}

export interface SeenLeader {
  /** `${personId}:${position}`, so a promotion at the same company is reported again. */
  key: string;
  domain: string;
  /** "YYYY-MM-01": position start dates have month precision. */
  startMonth: string;
}

export interface NewLeadersState {
  type: 'new-leaders';
  lastRunAt: string;
  /** The next window starts `lookbackDays` before this time. Only moves forward after a complete run. */
  windowAnchor: string;
  /** Hash of domains, seniority and department; known-people counts are only trusted for the same query. */
  queryKey: string;
  seen: SeenLeader[];
}

export interface AccountChangesState {
  type: 'account-changes';
  lastRunAt: string;
  snapshots: Record<string, CompanySnapshot>;
}

export type WatcherState = NewCompaniesState | NewLeadersState | AccountChangesState;

export interface MonitorState {
  version: 1;
  watchers: Record<string, WatcherState>;
}

export class StateError extends Error {
  override name = 'StateError';
}

export function emptyState(): MonitorState {
  return { version: 1, watchers: {} };
}

export function loadState(path: string): MonitorState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateError(`${path} is not valid JSON. Delete it, or run with --reset-state (without --watcher) to start over.`);
  }
  if (!isMonitorState(parsed)) {
    throw new StateError(
      `${path} is not a state file from this version. Delete it, or run with --reset-state (without --watcher) to start over.`,
    );
  }
  return parsed;
}

/** Writes to a temporary file first, so an interrupted run never leaves a half-written state file. */
export function saveState(path: string, state: MonitorState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, path);
}

/** The stored state for a watcher, or undefined when there is none or it belongs to another watcher type. */
export function watcherState<T extends WatcherState['type']>(
  state: MonitorState,
  id: string,
  type: T,
): Extract<WatcherState, { type: T }> | undefined {
  const stored = state.watchers[id];
  return stored?.type === type ? (stored as Extract<WatcherState, { type: T }>) : undefined;
}

function isMonitorState(value: unknown): value is MonitorState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as MonitorState).version === 1 &&
    typeof (value as MonitorState).watchers === 'object' &&
    (value as MonitorState).watchers !== null
  );
}
