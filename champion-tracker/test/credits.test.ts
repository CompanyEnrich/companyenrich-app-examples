import { describe, expect, it } from 'vitest';
import { CreditLedger, planCheck } from '../src/lib/credits.js';

describe('planCheck', () => {
  it('checks everyone when the cap allows it, keeping 1 credit back for a move', () => {
    expect(planCheck(10, 40, false)).toEqual({ due: 10, toCheck: 10, deferred: 0, reservePerMove: 1, estimate: 20, worstCase: 30 });
  });

  it('defers champions that do not fit under the cap', () => {
    // 19 checks (38 credits) leave 2, which still covers one move; a 20th check would not.
    expect(planCheck(20, 40, false)).toMatchObject({ toCheck: 19, deferred: 1, estimate: 38, worstCase: 40 });
  });

  it('reserves room for contacts with --with-contacts', () => {
    expect(planCheck(20, 40, true)).toMatchObject({ reservePerMove: 7, toCheck: 16, deferred: 4 });
  });

  it('checks nobody when the cap cannot cover one check and one move', () => {
    expect(planCheck(5, 2, false)).toMatchObject({ toCheck: 0, deferred: 5, estimate: 0, worstCase: 0 });
  });
});

describe('CreditLedger', () => {
  it('tracks spend per call and refuses anything over the cap', () => {
    const ledger = new CreditLedger(5);
    ledger.record('people.get', 2);
    ledger.record('people.get', 2);
    expect(ledger.canAfford(1)).toBe(true);
    expect(ledger.canAfford(2)).toBe(false);
    ledger.record('companies.enrich', 1);
    expect(ledger.spent).toBe(5);
    expect(ledger.remaining).toBe(0);
    expect(ledger.breakdown()).toBe('people.get x2 = 4, companies.enrich x1 = 1');
  });
});
