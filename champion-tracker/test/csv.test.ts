import { describe, expect, it } from 'vitest';
import { CsvError, championKey, parseChampionsCsv, readChampionsCsv } from '../src/lib/csv.js';

describe('parseChampionsCsv', () => {
  it('reads the shipped example, skipping comment lines', () => {
    const rows = readChampionsCsv('examples/champions.example.csv');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ line: 8, email: 'jane.doe@example.com', accountDomain: 'example.com', dealName: 'Example Co platform rollout 2025', owner: 'alex@example.com' });
    expect(rows.every((row) => row.email?.endsWith('@example.com'))).toBe(true);
  });

  it('normalizes domains and prefers the cheaper person_id when both are given', () => {
    const [row] = parseChampionsCsv('email,person_id,account_domain,deal_name,owner\nA@Acme.example,42,https://www.Acme.example/,"Deal, with comma",Alex\n');
    expect(row).toEqual({ line: 2, personId: '42', accountDomain: 'acme.example', dealName: 'Deal, with comma', owner: 'Alex' });
  });

  it('accepts a person_id-only file without a deal_name column', () => {
    const [row] = parseChampionsCsv('person_id,account_domain,owner\n7,acme.example,Alex\n');
    expect(row).toMatchObject({ personId: '7', dealName: '' });
  });

  it('names missing columns', () => {
    expect(() => parseChampionsCsv('name,account_domain\nJane,acme.example\n')).toThrow(/email or person_id, owner/);
  });

  it('lists every invalid row', () => {
    const text = 'email,person_id,account_domain,owner\n,,acme.example,Alex\nnot-an-email,,acme.example,Alex\n,abc,,\n';
    expect(() => parseChampionsCsv(text)).toThrow(CsvError);
    expect(() => parseChampionsCsv(text)).toThrow(/line 2: needs an email or a person_id[\s\S]*line 3: "not-an-email"[\s\S]*line 4: person_id "abc"[\s\S]*line 4: account_domain is empty[\s\S]*line 4: owner is empty/);
  });
});

describe('championKey', () => {
  it('keys id rows by id and hashes emails', () => {
    expect(championKey({ line: 2, personId: '42', accountDomain: 'a.example', dealName: '', owner: 'x' })).toBe('id:42');
    const key = championKey({ line: 2, email: 'jane@acme.example', accountDomain: 'a.example', dealName: '', owner: 'x' });
    expect(key).toMatch(/^email:[0-9a-f]{64}$/);
    expect(key).not.toContain('jane');
  });
});
