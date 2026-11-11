import { describe, expect, it } from 'vitest';
import { groupByCompany, rankCompanies, type CompanyRow } from '../src/lib/companies.js';
import { mergeDuplicates, type Candidate } from '../src/lib/shortlist.js';

const at = (id: number, company?: { id: string; name: string }): Candidate => ({ id, name: `Candidate ${id}`, title: 'Data Engineer', ...(company ? { company } : {}) });
const a = { id: 'a', name: 'Alpha' };
const b = { id: 'b', name: 'Beta' };
const c = { id: 'c', name: 'Gamma' };

describe('groupByCompany', () => {
  it('counts shortlisted people per current company in first-seen order and skips people without one', () => {
    const rows = groupByCompany([at(1, a), at(2, b), at(3, a), at(4)]);
    expect(rows).toEqual([
      { company: a, shortlisted: 2 },
      { company: b, shortlisted: 1 },
    ]);
  });
});

describe('rankCompanies', () => {
  it('ranks by matching pool, then shortlisted people, then name, with unknown pools last', () => {
    const rows: CompanyRow[] = [
      { company: a, shortlisted: 1, pool: 10 },
      { company: b, shortlisted: 3 },
      { company: c, shortlisted: 2, pool: 10 },
      { company: { id: 'd', name: 'Delta' }, shortlisted: 2, pool: 40 },
      { company: { id: 'e', name: 'Echo' }, shortlisted: 2, pool: 10 },
    ];
    expect(rankCompanies(rows).map((row) => row.company.name)).toEqual(['Delta', 'Echo', 'Gamma', 'Alpha', 'Beta']);
  });

  it('does not mutate its input', () => {
    const rows: CompanyRow[] = [{ company: a, shortlisted: 1, pool: 1 }, { company: b, shortlisted: 1, pool: 2 }];
    rankCompanies(rows);
    expect(rows[0]?.company).toBe(a);
  });
});

describe('mergeDuplicates', () => {
  const row = (id: number, name: string, companyId: string, joined: string): Candidate => ({
    id,
    name,
    title: 'Staff Data Engineer',
    company: { id: companyId, name: companyId },
    joinedCompany: joined,
  });

  it('keeps the first of two profiles with the same name, company and start date', () => {
    const { candidates, merged } = mergeDuplicates([
      row(1, 'Candidate A', 'co-1', '2021-12-01'),
      row(2, 'candidate a ', 'co-1', '2021-12-01'),
      row(3, 'Candidate A', 'co-2', '2021-12-01'), // same name, other company
      row(4, 'Candidate A', 'co-1', '2019-01-01'), // same company, other start date
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual([1, 3, 4]);
    expect(merged).toBe(1);
  });

  it('always merges the same person id, even without a company or start date', () => {
    const bare: Candidate = { id: 5, name: '', title: 'Data Engineer' };
    expect(mergeDuplicates([bare, { ...bare }, { ...bare, id: 6 }])).toEqual({ candidates: [bare, { ...bare, id: 6 }], merged: 1 });
  });

  it('does not guess when two different ids lack a company or start date', () => {
    const noCompany: Candidate = { id: 7, name: 'Candidate B', title: 'Data Engineer' };
    expect(mergeDuplicates([noCompany, { ...noCompany, id: 8 }]).merged).toBe(0);
  });
});
