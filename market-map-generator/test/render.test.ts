import { XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { companiesCsv, csvCell } from '../src/lib/csv.ts';
import { layoutColumns, layoutMap, packColumns, SIZES } from '../src/lib/layout.ts';
import { renderHtml } from '../src/lib/render/html.ts';
import { escapeXml, type MarketMap } from '../src/lib/render/markup.ts';
import { renderSvg } from '../src/lib/render/svg.ts';
import { category, COMPANIES, makeCompany } from './fixtures.ts';

const tricky = makeCompany('<script>alert("x")</script> & Co', 'Says "hi" & <b>bold</b> things.', { domain: 'tricky.example' });

function sampleMap(overrides: Partial<MarketMap> = {}): MarketMap {
  return {
    title: 'AI agents for "finance" <teams>',
    query: 'AI agents & copilots',
    generatedOn: '2026-11-11',
    categories: [
      category('Payables & Invoices', COMPANIES.slice(0, 4)),
      category('Close', [...COMPANIES.slice(4, 7), tricky]),
      category('Other', COMPANIES.slice(7), 'other'),
    ],
    logos: new Map([[COMPANIES[0]!.id, 'data:image/png;base64,iVBORw0KGgo=']]),
    method: 'Grouped by TF-IDF k-means',
    ...overrides,
  };
}

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;');
  });
});

describe('renderSvg', () => {
  const svg = renderSvg(sampleMap());

  it('is well-formed XML', () => {
    expect(XMLValidator.validate(svg)).toBe(true);
  });

  it('escapes company data and titles', () => {
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('AI agents for &quot;finance&quot; &lt;teams&gt;');
  });

  it('embeds logos as data URIs and falls back to initials', () => {
    expect(svg).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(svg).toContain('>CL</text>'); // Closebook has no logo in the map
    expect(svg).not.toMatch(/href="https:\/\/api\.companyenrich\.com/);
  });

  it('has one box per category, a footer with the source and date, and dark-mode colors', () => {
    expect(svg.match(/class="box-title"/g)).toHaveLength(3);
    expect(svg).toContain('Data: CompanyEnrich API (companyenrich.com), semantic company search for &quot;AI agents &amp; copilots&quot;');
    expect(svg).toContain('Generated 2026-11-11');
    expect(svg).toContain('@media (prefers-color-scheme: dark)');
  });

  it('clips every label to its tile or box, so wide letters cannot spill over', () => {
    const wide = makeCompany('W'.repeat(40), 'x');
    const map = sampleMap({ categories: [category('W'.repeat(200), [wide])] });
    const output = renderSvg(map);
    expect(XMLValidator.validate(output)).toBe(true);
    const tiles = output.match(/<g clip-path="url\(#tile-clip\)">.*?<\/g>/g) ?? [];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContain('class="tile-name"');
    expect(output).toMatch(/<text class="box-title"[^>]*clip-path="url\(#box-0-title\)"/);
    expect(output).toMatch(/<text class="box-desc"[^>]*clip-path="url\(#box-0-text\)"/);
    expect(output).toContain('<clipPath id="tile-clip"><rect x="2" width="88" height="86"/></clipPath>');
  });

  it('is still valid with no categories', () => {
    expect(XMLValidator.validate(renderSvg(sampleMap({ categories: [] })))).toBe(true);
  });
});

describe('renderHtml', () => {
  const html = renderHtml(sampleMap());

  it('is a complete page with no scripts and no external resources', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="viewport"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)="https?:\/\/(?!companyenrich\.com|[a-z0-9-]+\.example)/);
  });

  it('escapes company data in text and attributes', () => {
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co');
    expect(html).toContain('title="&lt;script&gt;');
  });

  it('renders every category, every company, the table view and the footer', () => {
    expect(html.match(/<section class="box"/g)).toHaveLength(3);
    expect(html.match(/<li><a /g)).toHaveLength(COMPANIES.length + 1);
    expect(html.match(/<tr><td>/g)).toHaveLength(COMPANIES.length + 1);
    expect(html).toContain('The 10 companies most relevant to the theme, in 3 categories');
    expect(html).toContain('Generated 2026-11-11 · Grouped by TF-IDF k-means');
  });

  it('wraps long unbroken text instead of widening the page', () => {
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('table-layout: fixed');
  });

  it('uses the same columns as the layout', () => {
    expect(html).toContain(`--columns: ${layoutMap(sampleMap().categories).columns.length}`);
  });
});

describe('layout', () => {
  it('packs the tallest boxes first into the shortest column', () => {
    // 5 -> A, 4 -> B, 3 -> B (7), 3 -> A (8), 2 -> B (9), 1 -> A (9)
    expect(packColumns([5, 4, 3, 3, 2, 1], 2)).toEqual([
      [0, 3, 5],
      [1, 2, 4],
    ]);
  });

  it('picks the column count that gives the shortest map', () => {
    const categories = [category('A', COMPANIES), category('B', COMPANIES.slice(0, 5)), category('C', COMPANIES.slice(0, 4))];
    const best = layoutMap(categories);
    for (const columns of [1, 2, 3]) expect(best.height).toBeLessThanOrEqual(layoutColumns(categories, columns).height);
  });

  it('keeps boxes inside the page and gives "Other" a neutral color at the bottom of a column', () => {
    const layout = layoutColumns(sampleMap().categories, 2);
    for (const box of layout.boxes) {
      expect(box.x + box.width).toBeLessThanOrEqual(SIZES.width - SIZES.margin + 0.01);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height - SIZES.footerHeight);
    }
    const other = layout.boxes.find((box) => box.category.kind === 'other')!;
    expect(other.color).toBeNull();
    const column = layout.columns.find((items) => items.includes(2))!;
    expect(column.at(-1)).toBe(2);
    expect(layout.boxes.filter((box) => box.color !== null).map((box) => box.color).sort()).toEqual([0, 1]);
  });
});

describe('companiesCsv', () => {
  it('writes one row per company with a header', () => {
    const lines = companiesCsv(sampleMap().categories).trimEnd().split('\r\n');
    expect(lines[0]).toBe('category,name,domain,website,description,industry,employees,founded_year,country,keywords,logo_url');
    expect(lines).toHaveLength(COMPANIES.length + 2);
    expect(lines[1]).toMatch(/^Payables & Invoices,Ledgerly,ledgerly\.example,/);
  });

  it('quotes commas, quotes and newlines, and defuses spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('plain')).toBe('plain');
  });
});
