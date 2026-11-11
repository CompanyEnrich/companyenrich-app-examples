import Anthropic from '@anthropic-ai/sdk';
import { PaymentRequiredError } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { AgentError, runAgent } from '../src/lib/agent';
import { resolveCitations } from '../src/lib/citations';
import { parseTarget } from '../src/lib/input';
import { acmeRoutes, fakeApi, problem, testContext } from './fakes';

// A fake Claude API: each request gets the next canned message. The real SDK and its tool
// runner run on top, so the loop, tool execution and tool_result plumbing are all exercised.

type Block = Record<string, unknown>;
const message = (id: string, content: Block[], stopReason: string) => ({
  id,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 300 },
});

const callEnrich = message(
  'msg_1',
  [
    { type: 'text', text: 'Starting with the company profile.' },
    { type: 'tool_use', id: 'toolu_1', name: 'enrich_company', input: { domain: 'acme.example', include_funding: true } },
  ],
  'tool_use',
);

const BRIEF = `# Account brief: Acme Cloud (acme.example)

## Snapshot
- Industry: Software [company.industry]
- Size range: 201-500 employees [company.employees]

## Funding
- Latest stage: Series B [company.financial.fundingStage]

## Team and growth
- Observed headcount: not available

## People to talk to
- not available

## Observations and talking points
- Raised a Series B on 2025-06-15 [company.financial.fundingDate].
- CEO since 2016 [company.ceo]`;

function fakeClaude(replies: object[]) {
  const requests: { body: any; headers: Headers }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    const reply = replies[requests.length - 1];
    if (!reply) throw new Error(`unexpected request ${requests.length} to ${String(input)}`);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const anthropic = new Anthropic({ apiKey: 'test', fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
  return { anthropic, requests };
}

/** The tool_result blocks the runner sent back in a request. */
function toolResults(body: any): Block[] {
  return body.messages.flatMap((entry: any) =>
    Array.isArray(entry.content) ? entry.content.filter((block: Block) => block.type === 'tool_result') : [],
  );
}

describe('agent mode', () => {
  it('runs a tool_use turn through the budgeted tools, then returns the final brief', async () => {
    const companyApi = fakeApi(acmeRoutes());
    const ctx = testContext(companyApi.client, 40);
    const claude = fakeClaude([callEnrich, message('msg_2', [{ type: 'text', text: BRIEF }], 'end_turn')]);

    const brief = await runAgent({ anthropic: claude.anthropic, ctx, target: parseTarget('acme.example'), depth: 'quick', today: '2026-11-11' });

    expect(brief).toBe(BRIEF);
    expect(claude.requests).toHaveLength(2);

    const [first, second] = claude.requests;
    expect(first?.body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, fallbacks: 'default' });
    expect(first?.body).not.toHaveProperty('thinking');
    expect(first?.body).not.toHaveProperty('tool_choice');
    expect(first?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(first?.body.tools.map((tool: Block) => tool.name)).toEqual([
      'enrich_company',
      'get_workforce',
      'find_people',
      'find_lookalikes',
      'lookup_person_by_email',
    ]);
    expect(first?.body.messages[0].content).toContain('Research the company at acme.example.\nDepth: quick\nCredit budget for this run: 40 credits');

    // The tool ran against CompanyEnrich, under the budget, and its compact JSON went back to Claude.
    expect(companyApi.calls('GET /v2/companies/enrich')[0]?.query.getAll('expand')).toEqual(['financial']);
    expect(ctx.budget.ledger).toEqual([{ tool: 'enrich_company', args: 'acme.example +financial', reserved: 2, estimated: 2 }]);
    const [result] = toolResults(second?.body);
    expect(result).toMatchObject({ tool_use_id: 'toolu_1' });
    expect(result).not.toHaveProperty('is_error');
    const payload = JSON.parse(String(Array.isArray(result?.content) ? (result.content[0] as Block).text : result?.content));
    expect(payload.company.financial.fundingStage).toBe('series_b');
    expect(payload.creditsRemaining).toBe(38);

    // Citations are checked against the tool log: the invented [company.ceo] is flagged.
    const unresolved = resolveCitations(brief, ctx.calls).filter((citation) => citation.sources.length === 0);
    expect(unresolved.map((citation) => citation.path)).toEqual(['company.ceo']);
  });

  it('sends a budget refusal back to Claude as a tool error, without calling CompanyEnrich', async () => {
    const companyApi = fakeApi(acmeRoutes());
    const ctx = testContext(companyApi.client, 1);
    const claude = fakeClaude([callEnrich, message('msg_2', [{ type: 'text', text: BRIEF }], 'end_turn')]);

    await runAgent({ anthropic: claude.anthropic, ctx, target: parseTarget('acme.example'), depth: 'quick', today: '2026-11-11' });

    const [result] = toolResults(claude.requests[1]?.body);
    expect(result).toMatchObject({ tool_use_id: 'toolu_1', is_error: true });
    expect(JSON.stringify(result?.content)).toContain('budget exceeded: this call needs 2 credits, 1 remaining');
    expect(companyApi.calls('GET /v2/companies/enrich')).toHaveLength(0);
  });

  it('stops the loop on an error the model cannot fix, such as running out of credits', async () => {
    const companyApi = fakeApi(acmeRoutes({ 'GET /v2/companies/enrich': () => problem(402, 'Insufficient credits') }));
    const claude = fakeClaude([callEnrich, message('msg_2', [{ type: 'text', text: BRIEF }], 'end_turn')]);

    const run = runAgent({ anthropic: claude.anthropic, ctx: testContext(companyApi.client), target: parseTarget('acme.example'), depth: 'quick', today: '2026-11-11' });

    await expect(run).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(claude.requests).toHaveLength(1);
  });

  it('checks stop_reason before reading the content', async () => {
    const companyApi = fakeApi(acmeRoutes());
    const claude = fakeClaude([message('msg_1', [], 'refusal')]);

    const run = runAgent({ anthropic: claude.anthropic, ctx: testContext(companyApi.client), target: parseTarget('acme.example'), depth: 'quick', today: '2026-11-11' });

    await expect(run).rejects.toBeInstanceOf(AgentError);
    await expect(run).rejects.toThrow('stop_reason: refusal');
  });
});
