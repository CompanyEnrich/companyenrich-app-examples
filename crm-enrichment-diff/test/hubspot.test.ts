import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runApply } from '../src/lib/apply.js';
import { loadMapping } from '../src/lib/config.js';
import { toCsv } from '../src/lib/csv.js';
import {
  buildHubSpotUpdates,
  HUBSPOT_BATCH_UPDATE_URL,
  HubSpotAuthError,
  sendHubSpotUpdates,
  type HubSpotUpdate,
} from '../src/lib/hubspot.js';
import { PATCH_COLUMNS, type PatchRow } from '../src/lib/patch.js';
import { exampleMappingPath } from './fake-api.js';

const mapping = await loadMapping(exampleMappingPath);

function patchRow(overrides: Partial<PatchRow>): PatchRow {
  return {
    record_id: '101',
    company: 'Twilio',
    domain: 'twilio.com',
    column: 'City',
    field: 'location.city.name',
    change: 'fill',
    action: 'update',
    crm_value: '',
    api_value: 'San Francisco',
    new_value: 'San Francisco',
    ...overrides,
  };
}

interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { inputs: HubSpotUpdate[] };
}

/** A fake HubSpot that answers each request with the next queued response. */
function fakeHubSpot(responses: ((inputs: HubSpotUpdate[]) => Response)[] = []) {
  const requests: SentRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    const respond = responses.shift();
    return respond
      ? respond(body.inputs)
      : Response.json({ status: 'COMPLETE', results: body.inputs.map((item: HubSpotUpdate) => ({ id: item.id })) });
  };
  return { fetch, requests };
}

describe('buildHubSpotUpdates', () => {
  it('groups rows per record and maps field paths to HubSpot property names', () => {
    const { updates, skipped } = buildHubSpotUpdates(
      [
        patchRow({}),
        patchRow({ column: 'Number of Employees', field: 'employees', new_value: '5000' }),
        patchRow({ record_id: '102', column: 'LinkedIn Company Page', field: 'socials.linkedinUrl', new_value: 'https://www.linkedin.com/company/atlassian' }),
      ],
      mapping,
    );
    expect(skipped).toEqual([]);
    expect(updates).toEqual([
      { id: '101', properties: { city: 'San Francisco', numberofemployees: '5000' } },
      { id: '102', properties: { linkedin_company_page: 'https://www.linkedin.com/company/atlassian' } },
    ]);
  });

  it('refuses rows it cannot write safely', () => {
    const { updates, skipped } = buildHubSpotUpdates(
      [
        patchRow({ field: 'categories' }),
        patchRow({ action: 'skip' }),
        patchRow({ record_id: 'abc' }),
        patchRow({ new_value: '  ' }),
      ],
      mapping,
    );
    expect(updates).toEqual([]);
    expect(skipped.map((item) => item.reason)).toEqual([
      'the mapping has no hubspotProperty for "categories"',
      'the action is "skip"',
      '"abc" is not a HubSpot Record ID',
      'new_value is empty, and this tool never clears a field',
    ]);
  });
});

describe('sendHubSpotUpdates', () => {
  const updates = Array.from({ length: 250 }, (_, index) => ({
    id: String(1000 + index),
    properties: { city: 'Berlin' },
  }));

  it('posts batch updates of at most 100 companies with the private app token', async () => {
    const hubspot = fakeHubSpot();
    const results = await sendHubSpotUpdates(updates, { token: 'pat-test', fetch: hubspot.fetch });

    expect(hubspot.requests.map((request) => request.body.inputs.length)).toEqual([100, 100, 50]);
    const [first] = hubspot.requests;
    expect(first).toMatchObject({
      url: HUBSPOT_BATCH_UPDATE_URL,
      method: 'POST',
      headers: { authorization: 'Bearer pat-test', 'content-type': 'application/json' },
    });
    expect(first?.body.inputs[0]).toEqual({ id: '1000', properties: { city: 'Berlin' } });
    expect(results.map((result) => result.updated)).toEqual([100, 100, 50]);
  });

  it('reports partial failures from a 207 response', async () => {
    const hubspot = fakeHubSpot([
      (inputs) =>
        Response.json(
          {
            status: 'COMPLETE',
            results: inputs.slice(1),
            errors: [{ status: 'error', message: 'Property values were not valid', context: { ids: ['1000'] } }],
          },
          { status: 207 },
        ),
    ]);
    const [result] = await sendHubSpotUpdates(updates.slice(0, 3), { token: 'pat-test', fetch: hubspot.fetch });
    expect(result).toMatchObject({ status: 207, updated: 2, errors: ['1000: Property values were not valid'] });
  });

  it('waits for Retry-After on 429 and tries again', async () => {
    const waits: number[] = [];
    const hubspot = fakeHubSpot([
      () => Response.json({ message: 'Too many requests' }, { status: 429, headers: { 'retry-after': '2' } }),
    ]);
    const [result] = await sendHubSpotUpdates(updates.slice(0, 1), {
      token: 'pat-test',
      fetch: hubspot.fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([2000]);
    expect(hubspot.requests).toHaveLength(2);
    expect(result?.updated).toBe(1);
  });

  it('stops on an invalid token', async () => {
    const hubspot = fakeHubSpot([() => Response.json({ message: 'Authentication credentials not found' }, { status: 401 })]);
    await expect(sendHubSpotUpdates(updates, { token: 'bad', fetch: hubspot.fetch })).rejects.toThrow(HubSpotAuthError);
    expect(hubspot.requests).toHaveLength(1);
  });
});

describe('runApply', () => {
  async function writePatch(rows: PatchRow[]): Promise<{ patchPath: string; outDir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'crm-diff-apply-'));
    const patchPath = join(dir, 'approved-patch.csv');
    await writeFile(patchPath, toCsv([...PATCH_COLUMNS], rows));
    return { patchPath, outDir: join(dir, 'output') };
  }

  it('only previews without --execute and never needs a token', async () => {
    const { patchPath, outDir } = await writePatch([patchRow({})]);
    const hubspot = fakeHubSpot();
    const lines: string[] = [];
    const result = await runApply(
      { patchPath, mappingPath: exampleMappingPath, execute: false, outDir },
      { token: undefined, fetch: hubspot.fetch, log: (line) => lines.push(line) },
    );
    expect(result.kind).toBe('preview');
    expect(hubspot.requests).toEqual([]);
    expect(lines).toContain('  101: city=San Francisco');
  });

  it('requires HUBSPOT_TOKEN with --execute', async () => {
    const { patchPath, outDir } = await writePatch([patchRow({})]);
    await expect(
      runApply({ patchPath, mappingPath: exampleMappingPath, execute: true, outDir }, { token: undefined, log: () => undefined }),
    ).rejects.toThrow(/HUBSPOT_TOKEN/);
  });

  it('sends the raw value of a cell that was neutralized for spreadsheets', async () => {
    const description = '=1+1 is how some descriptions start';
    const { patchPath, outDir } = await writePatch([patchRow({ field: 'description', column: 'Description', new_value: description })]);
    const hubspot = fakeHubSpot();
    await runApply(
      { patchPath, mappingPath: exampleMappingPath, execute: true, outDir },
      { token: 'pat-test', fetch: hubspot.fetch, log: () => undefined },
    );
    expect(hubspot.requests[0]?.body.inputs[0]?.properties).toEqual({ description });
  });

  it('sends the update and writes a log with --execute', async () => {
    const { patchPath, outDir } = await writePatch([patchRow({}), patchRow({ field: 'foundedYear', column: 'Year Founded', new_value: '2008' })]);
    const hubspot = fakeHubSpot();
    const result = await runApply(
      { patchPath, mappingPath: exampleMappingPath, execute: true, outDir },
      { token: 'pat-test', fetch: hubspot.fetch, log: () => undefined },
    );
    expect(hubspot.requests[0]?.body).toEqual({ inputs: [{ id: '101', properties: { city: 'San Francisco', founded_year: '2008' } }] });
    expect(result.kind === 'sent' && result.logFile.startsWith(outDir)).toBe(true);
  });
});
