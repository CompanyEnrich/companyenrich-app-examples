import type { CompanyEnrich } from '@companyenrich/sdk';
import type { Signal } from '../digest.js';
import type { WatcherState } from '../state.js';

export interface WatcherContext {
  client: CompanyEnrich;
  now: Date;
}

/**
 * The result of a watcher's free checks: what it found and what it would buy.
 * Nothing is spent until `execute` runs.
 */
export interface WatcherPlan {
  /** What the free calls found, for the printed plan. */
  finding: string;
  /** What one paid unit is, singular and plural: ["person", "people"]. */
  unit: [string, string];
  unitCost: number;
  /** Most paid units this run wants. 0 means there is nothing to buy. */
  units: number;
  /** For watchers that buy in indivisible chunks: the most units of a grant they can really use. */
  fit?(granted: number): number;
  /**
   * Makes the paid calls for up to `granted` units and returns the signals and the next state.
   * Calls `checkpoint` after every paid call with the progress so far, so a later failure
   * cannot lose what was already bought.
   */
  execute(granted: number, checkpoint: Checkpoint): Promise<WatcherRun>;
}

export type Checkpoint = (progress: WatcherRun) => void;

export interface WatcherRun {
  signals: Signal[];
  notes: string[];
  creditsCharged: number;
  nextState: WatcherState;
}
