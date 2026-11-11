import { describe, expect, it } from 'vitest';
import { loadMapping, parseMapping, parseRules } from '../src/lib/config.js';
import { readTable, restoreFormula, toCsv } from '../src/lib/csv.js';
import { classify, diffRecord, readPath } from '../src/lib/diff.js';
import { readCrmExport } from '../src/lib/input.js';
import { normalizers } from '../src/lib/normalizers.js';
import { applyRules, decide } from '../src/lib/rules.js';
import type { CrmRecord, Rules } from '../src/lib/types.js';
import { exampleMappingPath, fixtureCompanies } from './fake-api.js';

const twilio = fixtureCompanies.find((company) => company.domain === 'twilio.com')!;
const mapping = await loadMapping(exampleMappingPath);

describe('classify', () => {
  const text = normalizers.text;
  it('labels each kind of change', () => {
    expect(classify('', 'San Francisco', text).change).toBe('fill');
    expect(classify('n/a', 'San Francisco', text).change).toBe('fill');
    expect(classify('NA', 'United States', normalizers.country).change).toBe('conflict');
    expect(classify('SF', 'San Francisco', text).change).toBe('conflict');
    expect(classify('san francisco', 'San Francisco', text).change).toBe('same');
    expect(classify('SF', '', text).change).toBe('api-missing');
    expect(classify('', '', text).change).toBe('api-missing');
  });
});

describe('readPath', () => {
  it('reads nested fields and joins arrays', () => {
    expect(readPath(twilio, 'location.country.name')).toBe('United States');
    expect(readPath(twilio, 'categories')).toBe('b2b, service-provider');
    expect(readPath(twilio, 'location.nothing.here')).toBe('');
  });
});

describe('decide', () => {
  it('follows the decision table', () => {
    expect(decide('same', 'trustApi', true)).toEqual({ action: 'none', reason: 'match' });
    expect(decide('api-missing', 'trustApi', true)).toEqual({ action: 'none', reason: 'api-missing' });
    expect(decide('fill', 'neverOverwrite', true)).toEqual({ action: 'skip', reason: 'protected' });
    expect(decide('conflict', 'neverOverwrite', true)).toEqual({ action: 'skip', reason: 'protected' });
    expect(decide('fill', 'fillOnlyIfEmpty', true)).toEqual({ action: 'update', reason: 'fill-empty' });
    expect(decide('conflict', 'fillOnlyIfEmpty', true)).toEqual({ action: 'review', reason: 'crm-has-value' });
    expect(decide('conflict', 'trustApi', true)).toEqual({ action: 'update', reason: 'trust-api' });
    expect(decide('fill', 'unlisted', true)).toEqual({ action: 'review', reason: 'no-rule' });
    expect(decide('fill', 'trustApi', false)).toEqual({ action: 'skip', reason: 'not-writable' });
  });
});

describe('diffRecord with the example mapping', () => {
  const rules: Rules = {
    neverOverwrite: ['Industry'],
    fillOnlyIfEmpty: ['Number of Employees', 'City', 'Annual Revenue'],
    trustApi: ['LinkedIn Company Page'],
  };
  const row = Object.fromEntries(mapping.fields.map((field) => [field.column, '']));
  const record: CrmRecord = {
    recordId: '101',
    name: 'Twilio',
    domain: 'twilio.com',
    rawDomain: 'twilio.com',
    row: {
      ...row,
      'Company name': 'Twilio',
      'Company Domain Name': 'twilio.com',
      Industry: 'Telecom',
      'Number of Employees': '120',
      'Country/Region': 'USA',
      City: 'SF',
      'LinkedIn Company Page': 'http://linkedin.com/company/twilio',
    },
  };
  const cells = applyRules(diffRecord(record, twilio, mapping.fields), parseRules(rules, mapping));
  const cell = (column: string) => cells.find((item) => item.column === column)!;

  it('produces one cell per mapped field', () => {
    expect(cells).toHaveLength(mapping.fields.length);
  });

  it('classifies and decides each cell', () => {
    expect(cell('Company name')).toMatchObject({ change: 'same', action: 'none' });
    expect(cell('Country/Region')).toMatchObject({ change: 'same', action: 'none' });
    expect(cell('Industry')).toMatchObject({ change: 'conflict', action: 'skip', reason: 'protected' });
    expect(cell('Number of Employees')).toMatchObject({
      change: 'conflict',
      action: 'review',
      apiValue: '5K-10K',
      newValue: '5001',
    });
    expect(cell('Annual Revenue')).toMatchObject({ change: 'fill', action: 'update', newValue: '1000000000' });
    expect(cell('City')).toMatchObject({ change: 'conflict', action: 'review', newValue: 'San Francisco' });
    expect(cell('LinkedIn Company Page')).toMatchObject({ change: 'conflict', action: 'update', reason: 'trust-api' });
    expect(cell('Description')).toMatchObject({ change: 'fill', action: 'review', reason: 'no-rule' });
  });
});

describe('config validation', () => {
  const small = parseMapping({
    recordIdColumn: 'Record ID',
    nameColumn: 'Name',
    domainColumns: ['Domain'],
    fields: [{ column: 'City', path: 'location.city.name', normalizer: 'text' }],
  });

  it('rejects unknown normalizers and duplicate paths', () => {
    expect(() =>
      parseMapping({ ...small, fields: [{ column: 'A', path: 'a', normalizer: 'magic' }] }),
    ).toThrow(/normalizer must be one of/);
    expect(() =>
      parseMapping({ ...small, fields: [{ column: 'A', path: 'a' }, { column: 'B', path: 'a' }] }),
    ).toThrow(/path "a" twice/);
  });

  it('rejects rules for unmapped columns or columns in two lists', () => {
    expect(() => parseRules({ trustApi: ['Revenue'] }, small)).toThrow(/not a mapped column/);
    expect(() => parseRules({ trustApi: ['City'], neverOverwrite: ['City'] }, small)).toThrow(/in both/);
  });
});

describe('CSV and CRM export reading', () => {
  it('neutralizes formula cells for spreadsheets and restores them exactly', () => {
    const values = ['=HYPERLINK("http://x","y")', '+1 415 555 0100', '@SUM(A1)', '-', "'=already quoted", '\tcmd', '-5', '+12.5', 'plain'];
    const csv = toCsv(['v'], values.map((v) => ({ v })));
    expect(csv.split('\n').slice(1, 6)).toEqual([
      `"'=HYPERLINK(""http://x"",""y"")"`,
      "'+1 415 555 0100",
      "'@SUM(A1)",
      "'-",
      "''=already quoted",
    ]);
    expect(csv).toContain('\n-5\n+12.5\nplain\n');
    expect(readTable(csv).rows.map((row) => restoreFormula(row.v ?? ''))).toEqual(values);
  });

  it('round-trips quotes, commas and newlines', () => {
    const rows = [{ a: 'plain', b: 'with, comma' }, { a: 'say "hi"', b: 'two\nlines' }];
    expect(readTable(toCsv(['a', 'b'], rows)).rows).toEqual(rows);
  });

  it('reads a byte order mark, CRLF line endings and short rows', () => {
    const text = '\uFEFFRecord ID,Name,City\r\n1,"Acme, Inc.",Berlin\r\n2,Globex\r\n';
    expect(readTable(text)).toEqual({
      headers: ['Record ID', 'Name', 'City'],
      rows: [
        { 'Record ID': '1', Name: 'Acme, Inc.', City: 'Berlin' },
        { 'Record ID': '2', Name: 'Globex', City: '' },
      ],
    });
  });

  it('normalizes domains, falls back to the website column and finds duplicates', () => {
    const header = 'Record ID,Company name,Company Domain Name,Website URL,Industry,Number of Employees,Annual Revenue,Country/Region,City,Year Founded,LinkedIn Company Page,Description';
    const csv = [
      header,
      '1,Twilio,https://www.twilio.com/,,,,,,,,,',
      '2,GitLab,,https://www.gitlab.com/company/,,,,,,,,',
      '3,Twilio again,twilio.com,,,,,,,,,',
      '4,Nothing,,,,,,,,,,',
    ].join('\n');
    const { records, domains, duplicates } = readCrmExport(csv, mapping);
    expect(records.map((record) => record.domain)).toEqual(['twilio.com', 'gitlab.com', 'twilio.com', null]);
    expect(domains).toEqual(['twilio.com', 'gitlab.com']);
    expect(duplicates.get('twilio.com')).toEqual(['1', '3']);
  });

  it('names missing columns', () => {
    expect(() => readCrmExport('Record ID,Company name\n1,A', mapping)).toThrow(/no column named "Company Domain Name"/);
  });
});
