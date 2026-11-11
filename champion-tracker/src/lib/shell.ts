import { DEFAULT_STATE_PATH } from './state.js';

/** Quotes a value for a POSIX shell, so a suggested command works with any path. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The --state part of a suggested command, empty for the default path. */
export function stateFlag(statePath: string): string {
  return statePath === DEFAULT_STATE_PATH ? '' : ` --state ${shellQuote(statePath)}`;
}
