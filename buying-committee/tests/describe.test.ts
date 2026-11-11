import { describe, expect, it } from 'vitest';
import { blueprintFromDescription, chooseBlueprint, matchPresetByKeywords } from '../src/lib/describe';
import { createClaudeDrafter, type DraftBlueprint } from '../src/lib/llm';
import { fakeApi } from './fake-api';

const draft: DraftBlueprint = {
  name: 'Feature flags',
  summary: 'Feature flag and experimentation platform.',
  roles: [
    {
      key: 'economic-buyer', label: 'VP Engineering', why: 'Owns the budget.',
      department: ['engineering-technical', 'not-a-department'], seniority: ['vp', 'c-suite', 'boss'],
      position: ['vp engineering', 'galactic overlord'], limit: 5, priority: 1,
    },
    {
      key: 'Platform Lead', label: 'Platform lead', why: 'Runs the trial.',
      department: ['engineering-technical/devops'], seniority: ['manager'], position: ['head of platform'], limit: 2, priority: 2,
    },
    { key: 'ghost', label: 'Ghost', why: '', department: [], seniority: ['wizard'], position: [], limit: 1, priority: 3 },
  ],
};

/** A fake Anthropic Messages API: records the request and returns `reply`. */
function fakeClaude(reply: { stop_reason: string; text: string }) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: reply.text ? [{ type: 'text', text: reply.text }] : [],
        stop_reason: reply.stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { requests, drafter: createClaudeDrafter({ apiKey: 'test-key', fetch })! };
}

describe('matchPresetByKeywords', () => {
  it('picks the preset with the most keyword hits', () => {
    expect(matchPresetByKeywords('An observability platform for Kubernetes and CI/CD').preset.id).toBe('devtools');
    expect(matchPresetByKeywords('SOC 2 compliance automation').preset.id).toBe('security');
    expect(matchPresetByKeywords('Payroll and onboarding for small teams').preset.id).toBe('hr-tech');
  });

  it('falls back to the generic committee when nothing matches', () => {
    expect(matchPresetByKeywords('We make widgets').preset.id).toBe('generic');
  });
});

describe('blueprintFromDescription', () => {
  it('without an Anthropic key, says so and names the preset it used', async () => {
    const api = fakeApi([]);
    const choice = await blueprintFromDescription('A data warehouse with ELT pipelines', { client: api.client, drafter: null });
    expect(choice.source).toBe('keywords');
    expect(choice.blueprint.id).toBe('data');
    expect(choice.notes.join(' ')).toMatch(/ANTHROPIC_API_KEY is not set.*Data and analytics preset/);
  });

  it('createClaudeDrafter returns null when no key is configured', () => {
    expect(createClaudeDrafter({ apiKey: '' })).toBeNull();
  });

  it('validates a Claude draft against the v2 enums and positions.autocomplete', async () => {
    const api = fakeApi([]);
    const claude = fakeClaude({ stop_reason: 'end_turn', text: JSON.stringify(draft) });
    const choice = await blueprintFromDescription('Feature flags for engineering teams', { client: api.client, drafter: claude.drafter });

    expect(choice.source).toBe('claude');
    const [buyer, platform] = choice.blueprint.roles;
    expect(buyer).toMatchObject({ department: ['engineering-technical'], seniority: ['vp', 'c-suite'], position: ['vp engineering'], limit: 3 });
    expect(platform).toMatchObject({ key: 'platform-lead', position: ['head of platform'] });
    expect(choice.blueprint.roles).toHaveLength(2);

    const notes = choice.notes.join('\n');
    expect(notes).toMatch(/dropped unknown department "not-a-department"/);
    expect(notes).toMatch(/dropped unknown seniority "boss"/);
    expect(notes).toMatch(/dropped title phrase "galactic overlord"/);
    expect(notes).toMatch(/Ghost: dropped the role/);
  });

  it('says when title phrases were not checked because of the phrase limit', async () => {
    const api = fakeApi([]);
    const many: DraftBlueprint = {
      ...draft,
      roles: [{ ...draft.roles[0]!, position: [...Array.from({ length: 24 }, (_, i) => `junk ${i}`), 'vp engineering'] }],
    };
    const claude = fakeClaude({ stop_reason: 'end_turn', text: JSON.stringify(many) });
    const choice = await blueprintFromDescription('Feature flags', { client: api.client, drafter: claude.drafter });
    expect(choice.notes.join('\n')).toMatch(/"vp engineering" \(not checked: only the first 24 phrases are validated\)/);
    expect(api.calls.filter((call) => call.path === '/v2/positions/autocomplete')).toHaveLength(24);
  });

  it('sends the documented request shape to Claude', async () => {
    const claude = fakeClaude({ stop_reason: 'end_turn', text: JSON.stringify(draft) });
    await claude.drafter('Feature flags');
    const [request] = claude.requests;
    expect(request!.url).toContain('/v1/messages');
    expect(request!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request!.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(request!.body).not.toHaveProperty('temperature');
    expect(request!.body).not.toHaveProperty('thinking');
  });

  it('falls back to keywords when Claude refuses', async () => {
    const api = fakeApi([]);
    const claude = fakeClaude({ stop_reason: 'refusal', text: '' });
    const choice = await blueprintFromDescription('Sales engagement and CRM sync', { client: api.client, drafter: claude.drafter });
    expect(choice.source).toBe('keywords');
    expect(choice.blueprint.id).toBe('sales-tech');
    expect(choice.notes[0]).toMatch(/declined/);
  });

  it('treats a preset id as a preset and anything else as a description', async () => {
    const api = fakeApi([]);
    expect((await chooseBlueprint('security', { client: api.client, drafter: null })).source).toBe('preset');
    expect((await chooseBlueprint('security questionnaires', { client: api.client, drafter: null })).source).toBe('keywords');
  });
});
