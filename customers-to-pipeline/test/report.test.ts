import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CreditLedger, searchCharge } from '../src/lib/credits.js';
import { parseCsv } from '../src/lib/csv.js';
import { accountsCsv, contactsCsv } from '../src/lib/report.js';
import { makeCompany, makePerson } from './fake-api.js';

describe('CSV output', () => {
  it('writes accounts.csv with the documented columns and escapes commas and quotes', () => {
    const company = makeCompany('kilo.example', {
      name: 'Kilo, "the" company',
      industry: 'Software',
      employees: '201-500',
      location: { country: { code: 'US', name: 'United States' } },
    });
    const csv = accountsCsv([{ rank: 1, company, score: 0.98765, matched: ['industry', 'employees'] }]);
    expect(csv.split('\n')[0]).toBe('rank,domain,name,score,industry,employees,country,matched_icp_dimensions');
    expect(parseCsv(csv)[1]).toEqual(['1', 'kilo.example', 'Kilo, "the" company', '0.988', 'Software', '201-500', 'US', 'industry; employees']);
  });

  it('writes contacts.csv with one row per person', () => {
    const csv = contactsCsv([{ account: 'kilo.example', person: makePerson(7, 'kilo.example') }]);
    expect(parseCsv(csv)).toEqual([
      ['account', 'name', 'title', 'seniority', 'department', 'linkedin_url'],
      ['kilo.example', 'Person 7', 'VP Sales', 'vp', 'sales', 'https://www.linkedin.com/in/person-7'],
    ]);
  });
});

describe('budget guard', () => {
  it('passes when spent plus the remaining estimate fits under the cap', () => {
    const ledger = new CreditLedger(40);
    ledger.record('enrich', '12 customers x 1', 12, 12);
    const lines: string[] = [];
    ledger.check([{ step: 'lookalikes', detail: '5 accounts x 5', credits: 25 }], (line) => lines.push(line));
    expect(lines.join('\n')).toMatch(/total \.+ +37 {2}\(cap 40\)/);
  });

  it('throws before a step that would take the run past --max-credits', () => {
    const ledger = new CreditLedger(30);
    ledger.record('enrich', '12 customers x 1', 12, 12);
    expect(() => ledger.check([{ step: 'lookalikes', detail: '5 accounts x 5', credits: 25 }], () => {})).toThrow(BudgetExceededError);
  });

  it('bills an empty paid page at one result', () => {
    expect(searchCharge(0, 5)).toBe(5);
    expect(searchCharge(3, 2)).toBe(6);
  });
});
