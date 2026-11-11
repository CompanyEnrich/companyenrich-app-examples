import { parse, type ParserError } from 'parse5';
import { describe, expect, it } from 'vitest';
import { FileCache } from '../src/lib/file-cache.js';
import type { SampleResult } from '../src/lib/sample.js';
import { assignmentJson, territoriesCsv } from '../src/lib/outputs.js';
import { runPlanner, type PlanReport, type PlannerOptions } from '../src/lib/planner.js';
import { renderHtml } from '../src/lib/report-html.js';
import { territoryTable, textBars, textSamples, textTileMap } from '../src/lib/report-text.js';
import { US_CENSUS_DIVISIONS, US_TILE_GRID_ROWS, US_TILE_POSITIONS } from '../src/lib/us-geo.js';
import { createFakeApi, loadFixture } from './fake-api.js';

async function plan(code: 'us' | 'de', overrides: Partial<PlannerOptions> = {}): Promise<PlanReport> {
  const fixture = loadFixture(code);
  return runPlanner(createFakeApi([fixture]).client, {
    icp: { categories: ['b2b', 'saas'], employees: ['51-200', '201-500'] },
    country: fixture.country.code,
    territories: 4,
    reps: ['Ana', 'Ben', 'Chen', 'Dee'],
    weightBy: 'none',
    keepRegions: false,
    sample: 0,
    maxCredits: 20,
    dryRun: false,
    cache: FileCache.inMemory<number>(),
    sampleStore: FileCache.inMemory<SampleResult>(),
    runId: 'test-run',
    now: new Date('2026-11-11T10:00:00Z'),
    ...overrides,
  });
}

function parseErrors(html: string): string[] {
  const errors: string[] = [];
  parse(html, { onParseError: (error: ParserError) => errors.push(`${error.code} at line ${error.startLine}`) });
  return errors;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('US tile grid layout', () => {
  it('has one unique tile for each of the 50 states, DC and Puerto Rico', () => {
    const codes = US_TILE_GRID_ROWS.flat().filter((code): code is string => code !== null);
    expect(codes).toHaveLength(52);
    expect(new Set(codes).size).toBe(52);
    expect(US_TILE_POSITIONS.size).toBe(52);
    const divisionStates = Object.values(US_CENSUS_DIVISIONS).flat();
    expect(divisionStates).toHaveLength(51);
    for (const code of divisionStates) expect(US_TILE_POSITIONS.has(code), code).toBe(true);
  });
});

describe('renderHtml', () => {
  it('uses a parser that does report broken markup', () => {
    expect(parseErrors('<p>no doctype</p></div>')).not.toEqual([]);
  });

  it('produces valid HTML with every US state exactly once on the map', async () => {
    const report = await plan('us');
    const html = renderHtml(report);
    expect(parseErrors(html)).toEqual([]);
    expect(html).not.toMatch(/<script|<link|src="http/);

    const map = html.slice(html.indexOf('id="map-title"'), html.indexOf('id="bars-title"'));
    for (const state of loadFixture('us').states) {
      if (state.code && US_TILE_POSITIONS.has(state.code)) {
        expect(occurrences(map, `data-state="${state.code}"`), state.code).toBe(1);
      } else {
        expect(occurrences(map, `title="${state.name}:`), state.name).toBe(1);
      }
    }
  });

  it('colors each tile by its territory and prints the territory number', async () => {
    const report = await plan('us');
    const html = renderHtml(report);
    for (const territory of report.territories) {
      for (const state of territory.states.filter((s) => s.code && US_TILE_POSITIONS.has(s.code))) {
        const tile = new RegExp(`data-state="${state.code}"[^>]*background: var\\(--t${territory.number}\\)[^>]*>.*?<span class="t">${territory.number}</span>`);
        expect(html).toMatch(tile);
      }
    }
  });

  it('draws bars but no tile map for other countries', async () => {
    const html = renderHtml(await plan('de', { territories: 3, reps: [] }));
    expect(parseErrors(html)).toEqual([]);
    expect(html).not.toContain('class="tilemap"');
    expect(occurrences(html, 'class="bar-row"')).toBe(3);
  });

  it('escapes user-supplied text such as rep names', async () => {
    const html = renderHtml(await plan('us', { reps: ['<script>alert(1)</script>', 'Ben', 'Chen', 'Dee'] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(parseErrors(html)).toEqual([]);
  });

  it('keeps territory numbers on tiles at phone width, hiding only the counts', async () => {
    const html = renderHtml(await plan('us'));
    const phone = html.slice(html.indexOf('@media (max-width: 640px)'));
    const hidden = /([^{}]+)\{ display: none; \}/.exec(phone)![1]!;
    expect(hidden).toContain('.tile .n');
    expect(hidden).not.toContain('.tile .t');
    expect(phone).toMatch(/\.tile \.t \{ position: static;/);
  });

  it('says prominently that the plan cost 0 credits', async () => {
    expect(renderHtml(await plan('us'))).toContain('this plan cost 0 credits');
  });
});

describe('text output', () => {
  it('renders every grid state once in the text tile map', async () => {
    const map = textTileMap(await plan('us'));
    for (const code of US_TILE_POSITIONS.keys()) {
      expect(map.match(new RegExp(`\\b${code} [1-4]\\b`, 'g')), code).toHaveLength(1);
    }
    expect(map).toContain('Not on the grid: 14 areas with no ICP companies');
  });

  it('prints one table row per territory and the balance', async () => {
    const table = territoryTable(await plan('us'));
    expect(table.split('\n')[0]).toMatch(/^#\s+Rep\s+States\s+ICP companies\s+Share\s+vs even\s+Largest states$/);
    expect(table).toMatch(/^1\s+Ana\s+1\s+1,593\s+25\.4%/m);
    expect(table).toMatch(/Balance on ICP companies: max\/min 1\.022/);
  });

  it('lists sample accounts only when a sample was fetched', async () => {
    expect(textSamples(await plan('us'))).toBe('');
    const samples = textSamples(await plan('us', { sample: 1 }));
    expect(samples.split('\n')).toHaveLength(5);
    expect(samples).toContain('1  Example Co 1 (example1.com): Springfield, SW, 51-200 employees');
  });

  it('prints bars scaled to the largest territory', async () => {
    const bars = textBars(await plan('de', { territories: 3, reps: [] }));
    expect(bars.split('\n')).toHaveLength(3);
    expect(bars).toMatch(/^1\s+#{30,}/);
  });
});

describe('assignment.json and territories.csv', () => {
  it('lists territory -> rep -> states with ids and counts', async () => {
    const report = await plan('us');
    const json = JSON.parse(assignmentJson(report));
    expect(json.territories[0]).toMatchObject({ territory: 1, rep: 'Ana', companies: 1593 });
    expect(json.territories[0].states[0]).toEqual({ id: 4845, code: 'CA', name: 'California', companies: 1593, weight: 1593 });
    expect(json.creditsSpent).toBe(0);
  });

  it('has one CSV row per state and quotes values that need it', async () => {
    const report = await plan('us', { reps: ['Ana', 'Ben', 'Chen', 'Dee, Jr.'] });
    const lines = territoriesCsv(report).trimEnd().split('\n');
    expect(lines[0]).toBe('territory,rep,state_id,state_code,state_name,icp_companies,weight');
    expect(lines).toHaveLength(1 + loadFixture('us').states.length);
    expect(lines.some((line) => line.startsWith('4,"Dee, Jr.",'))).toBe(true);
  });
});
