import { policyFor } from './config.js';
import type { CellDiff } from './diff.js';
import type { Action, ChangeType, DiffCell, Policy, Reason, Rules } from './types.js';

export const REASON_LABELS: Record<Reason, string> = {
  match: 'values match',
  'api-missing': 'no value from the API',
  protected: 'protected: never overwritten',
  'fill-empty': 'fills an empty field',
  'crm-has-value': 'CRM already has a value',
  'trust-api': 'API is trusted for this field',
  'no-rule': 'no rule for this field',
  'not-writable': 'API value cannot be written to this field',
};

/**
 * The decision table:
 *
 * | change   | neverOverwrite | fillOnlyIfEmpty | trustApi | not listed |
 * | -------- | -------------- | --------------- | -------- | ---------- |
 * | fill     | skip           | update          | update   | review     |
 * | conflict | skip           | review          | update   | review     |
 *
 * `same` and `api-missing` never change anything.
 */
export function decide(change: ChangeType, policy: Policy, writable: boolean): { action: Action; reason: Reason } {
  if (change === 'same') return { action: 'none', reason: 'match' };
  if (change === 'api-missing') return { action: 'none', reason: 'api-missing' };
  if (policy === 'neverOverwrite') return { action: 'skip', reason: 'protected' };
  if (!writable) return { action: 'skip', reason: 'not-writable' };
  if (policy === 'trustApi') return { action: 'update', reason: 'trust-api' };
  if (policy === 'fillOnlyIfEmpty') {
    return change === 'fill' ? { action: 'update', reason: 'fill-empty' } : { action: 'review', reason: 'crm-has-value' };
  }
  return { action: 'review', reason: 'no-rule' };
}

export function applyRules(cells: CellDiff[], rules: Rules): DiffCell[] {
  return cells.map((cell) => ({
    ...cell,
    ...decide(cell.change, policyFor(cell.column, rules), cell.newValue !== ''),
  }));
}
