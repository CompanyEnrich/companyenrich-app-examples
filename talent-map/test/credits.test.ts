import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CreditLedger, estimatePaidSteps, searchCharge, shortlistSize } from '../src/lib/credits.js';

describe('estimatePaidSteps', () => {
  it('prices the shortlist at 2 credits per profile and trends at 1 per company', () => {
    expect(estimatePaidSteps(20, 3)).toEqual([
      { step: 'shortlist', detail: '20 profiles x 2', credits: 40 },
      { step: 'team trends', detail: '3 companies x 1', credits: 3 },
    ]);
  });

  it('never sizes the page above the free count, or estimates more companies than profiles', () => {
    expect(shortlistSize(20, 2)).toBe(2);
    expect(shortlistSize(20, 5000)).toBe(20);
    expect(estimatePaidSteps(shortlistSize(20, 2), 3)).toEqual([
      { step: 'shortlist', detail: '2 profiles x 2', credits: 4 },
      { step: 'team trends', detail: '2 companies x 1', credits: 2 },
    ]);
  });

  it('leaves out trends when --trend-top is 0', () => {
    expect(estimatePaidSteps(10, 0)).toHaveLength(1);
  });
});

describe('searchCharge', () => {
  it('bills an empty page at one result', () => {
    expect(searchCharge(0, 2)).toBe(2);
    expect(searchCharge(7, 2)).toBe(14);
  });
});

describe('CreditLedger', () => {
  const shortlist = { step: 'shortlist', detail: '10 profiles x 2', credits: 20 };

  it('allows a plan that fits the cap exactly', () => {
    expect(() => new CreditLedger(20).check([shortlist])).not.toThrow();
  });

  it('stops before a step that would pass the cap, counting what is already spent', () => {
    const ledger = new CreditLedger(25);
    ledger.check([shortlist]);
    ledger.record(shortlist, 20);
    expect(ledger.spent).toBe(20);
    expect(() => ledger.check([{ step: 'team trends', detail: '6 companies', credits: 6 }])).toThrow(BudgetExceededError);
    expect(() => ledger.check([{ step: 'team trends', detail: '5 companies', credits: 5 }])).not.toThrow();
  });

  it('keeps the estimate next to what was billed', () => {
    const ledger = new CreditLedger(50);
    ledger.record(shortlist, 8);
    expect(ledger.entries).toEqual([{ ...shortlist, estimated: 20, credits: 8 }]);
  });
});
