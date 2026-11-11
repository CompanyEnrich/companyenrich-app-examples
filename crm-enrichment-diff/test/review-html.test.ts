import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { parsePatchCsv, renderPatchCsv } from '../src/lib/patch.js';
import { renderReviewHtml } from '../src/lib/review-html.js';
import type { DiffCell, RecordSummary } from '../src/lib/types.js';

function cell(overrides: Partial<DiffCell>): DiffCell {
  return {
    recordId: '101',
    company: 'Twilio',
    domain: 'twilio.com',
    column: 'City',
    field: 'location.city.name',
    change: 'fill',
    crmValue: '',
    apiValue: 'San Francisco',
    newValue: 'San Francisco',
    action: 'update',
    reason: 'fill-empty',
    ...overrides,
  };
}

const cells: DiffCell[] = [
  cell({}),
  cell({ column: 'Number of Employees', field: 'employees', change: 'conflict', crmValue: '120', apiValue: '5K-10K', newValue: '5000', action: 'review', reason: 'crm-has-value' }),
  cell({ column: 'Industry', field: 'industry', change: 'conflict', crmValue: 'Telecom', apiValue: 'Telecommunications', newValue: 'Telecommunications', action: 'skip', reason: 'protected' }),
  cell({ column: 'Country/Region', field: 'location.country.name', change: 'same', crmValue: 'USA', apiValue: 'United States', newValue: '', action: 'none', reason: 'match' }),
  cell({ recordId: '102', company: 'Atlassian', domain: 'atlassian.com', column: 'Description', field: 'description', apiValue: 'Says "hi", with commas\nand a new line </script><img src=x onerror=alert(1)>', newValue: 'Says "hi", with commas\nand a new line </script><img src=x onerror=alert(1)>' }),
  cell({ recordId: '102', company: 'Atlassian', domain: 'atlassian.com', column: 'City', change: 'conflict', crmValue: 'Sydney', action: 'review', reason: 'crm-has-value' }),
  cell({ recordId: '102', company: 'Atlassian', domain: 'atlassian.com', column: 'Year Founded', field: 'foundedYear', change: 'conflict', crmValue: '-5', apiValue: '=HYPERLINK("http://evil.example","2002")', newValue: '=HYPERLINK("http://evil.example","2002")', reason: 'trust-api' }),
];

const records: RecordSummary[] = [
  { recordId: '101', company: 'Twilio', domain: 'twilio.com', status: 'found', duplicateOf: [] },
  { recordId: '102', company: 'Atlassian', domain: 'atlassian.com', status: 'found', duplicateOf: [] },
  { recordId: '105', company: 'No Domain Ltd', domain: '', status: 'no-domain', duplicateOf: [] },
];

/** Loads review.html in jsdom with scripts enabled and captures the exported CSV. */
function openPage() {
  const html = renderReviewHtml({
    runId: '20261111-090000',
    generatedAt: '2026-11-11T09:00:00.000Z',
    input: 'examples/crm-export.csv',
    columns: ['City', 'Number of Employees', 'Industry', 'Country/Region', 'Description'],
    cells,
    records,
  });
  const errors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    // Clicking a download link asks jsdom to navigate, which it does not implement.
    if (!/navigation/i.test(error.message)) errors.push(error);
  });
  const exported: Blob[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.URL.createObjectURL = (blob: Blob) => {
        exported.push(blob);
        return 'blob:review-test';
      };
      window.URL.revokeObjectURL = () => undefined;
    },
  });
  const document = dom.window.document;
  const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
  const visibleRows = () => [...document.querySelectorAll('#rows tr:not(.record)')];
  const exportCsv = async () => {
    click('#export');
    return exported.at(-1)!.text();
  };
  return { dom, document, errors, click, visibleRows, exportCsv };
}

describe('review.html', () => {
  it('is one self-contained file that parses and runs without errors', () => {
    const { document, errors } = openPage();
    expect(errors).toEqual([]);
    expect(document.querySelectorAll('script[src], link[rel="stylesheet"]')).toHaveLength(0);
    expect(document.title).toBe('Enrichment review 20261111-090000');
  });

  it('keeps hostile API text as text, never as markup', () => {
    const { document } = openPage();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('#rows')?.textContent).toContain('</script><img src=x onerror=alert(1)>');
  });

  it('shows fills and conflicts by default and filters by change type and field', () => {
    const { document, visibleRows } = openPage();
    expect(visibleRows()).toHaveLength(6);

    const same = document.querySelector('#filter-change input[value="same"]') as HTMLInputElement;
    same.click();
    expect(visibleRows()).toHaveLength(7);

    const field = document.querySelector('#filter-column') as HTMLSelectElement;
    field.value = 'City';
    field.dispatchEvent(new document.defaultView!.Event('change'));
    expect(visibleRows()).toHaveLength(2);
  });

  it('exports exactly patch.csv when nothing has been changed', async () => {
    const { exportCsv } = openPage();
    expect(await exportCsv()).toBe(renderPatchCsv(cells));
  });

  it('neutralizes formula cells in the export but keeps plain negative numbers', async () => {
    const { exportCsv } = openPage();
    const csv = await exportCsv();
    expect(csv).toContain(`,-5,"'=HYPERLINK(""http://evil.example"",""2002"")",`);
    expect(parsePatchCsv(csv).at(-1)?.new_value).toBe('=HYPERLINK("http://evil.example","2002")');
  });

  it('adds approved review items and drops rejected updates', async () => {
    const { document, click, exportCsv } = openPage();
    (document.querySelector('input[aria-label="Approve Number of Employees for Twilio"]') as HTMLInputElement).click();
    click('button[data-record="102"][data-approve="false"]');

    const rows = parsePatchCsv(await exportCsv());
    expect(rows.map((row) => `${row.record_id} ${row.field} ${row.action}`)).toEqual([
      '101 location.city.name update',
      '101 employees review',
    ]);
    expect(document.querySelector('#approved-count')?.textContent).toBe('2 approved changes (1 from review)');
  });

  it('cannot approve protected cells, even with approve visible', async () => {
    const { document, click, exportCsv } = openPage();
    const industry = document.querySelector('input[aria-label="Approve Industry for Twilio"]') as HTMLInputElement;
    expect(industry.disabled).toBe(true);

    click('#approve-visible');
    const rows = parsePatchCsv(await exportCsv());
    expect(rows).toHaveLength(5);
    expect(rows.some((row) => row.action === 'skip')).toBe(false);
  });

  it('lists records that could not be diffed', () => {
    const { document } = openPage();
    expect(document.querySelector('#unmatched')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#unmatched-list')?.textContent).toContain('105 No Domain Ltd (no domain)');
  });
});
