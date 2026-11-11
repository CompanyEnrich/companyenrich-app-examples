import { describe, expect, it } from 'vitest';
import { CreditBudget } from '../src/lib/budget';

describe('CreditBudget', () => {
  it('holds reservations against the cap', () => {
    const budget = new CreditBudget(10);
    const first = budget.reserve('enrich_company', 'acme.example +financial', 2);
    const second = budget.reserve('find_people', 'acme.example limit=3', 6);

    expect(first.ok && second.ok).toBe(true);
    expect(budget.reserved).toBe(8);
    expect(budget.remaining).toBe(2);
  });

  it('allows a reservation that uses the exact remaining credits', () => {
    const budget = new CreditBudget(6);
    expect(budget.reserve('find_people', 'x', 6).ok).toBe(true);
    expect(budget.remaining).toBe(0);
  });

  it('refuses a call that would exceed the cap, and records the refusal', () => {
    const budget = new CreditBudget(10);
    budget.reserve('enrich_company', 'acme.example', 3);
    const refused = budget.reserve('find_lookalikes', 'acme.example limit=3', 15);

    expect(refused).toEqual({ ok: false, error: 'budget exceeded: this call needs 15 credits, 7 remaining' });
    expect(budget.reserved).toBe(3);
    expect(budget.ledger.at(-1)).toMatchObject({ tool: 'find_lookalikes', reserved: 0, estimated: 0, refused: refused.ok ? undefined : refused.error });
  });

  it('keeps reservations in place after settling, so the cap stays a hard upper bound', () => {
    const budget = new CreditBudget(10);
    const hold = budget.reserve('enrich_company', 'nope.example', 2);
    if (!hold.ok) throw new Error('expected a reservation');
    budget.settle(hold.entry, 0); // e.g. a 404, which is not billed

    expect(budget.estimated).toBe(0);
    expect(budget.reserved).toBe(2);
    expect(budget.remaining).toBe(8);
  });

  it('sums estimated and reserved across the ledger', () => {
    const budget = new CreditBudget(40);
    for (const [credits, estimated] of [[3, 3], [6, 4], [15, 15]] as const) {
      const hold = budget.reserve('tool', 'args', credits);
      if (hold.ok) budget.settle(hold.entry, estimated);
    }
    budget.recordFree('find_people', 'count only');

    expect(budget.reserved).toBe(24);
    expect(budget.estimated).toBe(22);
    expect(budget.ledger).toHaveLength(4);
  });

  it('with a zero cap, refuses every paid call but still records free ones', () => {
    const budget = new CreditBudget(0);
    expect(budget.reserve('enrich_company', 'acme.example', 1).ok).toBe(false);
    budget.recordFree('find_people', 'count only');
    expect(budget.reserved).toBe(0);
    expect(budget.ledger.map((entry) => entry.reserved)).toEqual([0, 0]);
  });
});
