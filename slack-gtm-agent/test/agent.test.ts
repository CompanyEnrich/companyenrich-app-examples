import { describe, expect, it, vi } from 'vitest';
import { GtmAgent, type AgentHooks, type Plan } from '../src/lib/agent.js';
import type { Decision } from '../src/lib/approvals.js';
import { scriptedClaude, text, toolResults, toolUse } from './claude-mock.js';
import { fakeCountTools, fakeMcp, makeToolbox } from './fixtures.js';
import { textResult } from '../src/lib/toolbox.js';

function hooks(decision: Decision = 'approved') {
  const shown: Plan[] = [];
  const asked: Plan[] = [];
  const value: AgentHooks = {
    showPlan: vi.fn(async (plan: Plan) => {
      shown.push(plan);
    }),
    requestApproval: vi.fn(async (plan: Plan) => {
      asked.push(plan);
      return decision;
    }),
  };
  return { hooks: value, shown, asked };
}

describe('GtmAgent', () => {
  it('counts for free, asks before a paid step above the threshold, and answers', async () => {
    const { toolbox, mcp, ledger } = await makeToolbox();
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'count_people', { semanticQuery: 'VPs of sales at Acme' })], stop_reason: 'tool_use' }),
      () => ({
        content: [text('Two match; I will fetch 6 to be safe.'), toolUse('t2', 'search_people', { seniority: ['vp'], department: ['sales'], pageSize: 6 })],
        stop_reason: 'tool_use',
      }),
      () => ({ content: [text('Acme has **6** sales VPs.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, asked, shown } = hooks('approved');

    const answer = await new GtmAgent({ anthropic, toolbox }).answer('VPs of sales at Acme?', 'U1', agentHooks);

    expect(answer).toMatchObject({ text: 'Acme has **6** sales VPs.', outcome: 'answered', spent: 12 });
    expect(answer.rows.people).toHaveLength(6);
    expect(ledger.spentToday('U1')).toBe(12);

    // The free count ran without a plan; the paid step waited for approval.
    expect(shown).toHaveLength(0);
    expect(asked).toEqual([
      {
        note: 'Two match; I will fetch 6 to be safe.',
        steps: [{ tool: 'search_people', args: { seniority: ['vp'], department: ['sales'], pageSize: 6 }, estimate: 12 }],
        estimate: 12,
        questionSpent: 0,
        status: 'needs-approval',
      },
    ]);
    expect(mcp.calls).toEqual([{ name: 'search_people', args: { seniority: ['vp'], department: ['sales'], pageSize: 6 } }]);

    // Claude saw the count, then compact rows with the real charge, not raw records.
    expect(toolResults(requests[1]!)).toEqual([{ tool_use_id: 't1', text: expect.stringContaining('"count":2') }]);
    const [people] = toolResults(requests[2]!);
    expect(people?.text).toContain('"creditsCharged":12');
    expect(people?.text).not.toContain('experiences');
  });

  it('sends the request shape the brief requires', async () => {
    const { toolbox } = await makeToolbox();
    const { anthropic, requests } = scriptedClaude([() => ({ content: [text('Hello.')], stop_reason: 'end_turn' })]);
    await new GtmAgent({ anthropic, toolbox }).answer('hi', 'U1', hooks().hooks);

    const [request] = requests;
    expect(request?.url).toContain('/v1/messages');
    expect(request?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request?.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(request?.body).not.toHaveProperty('temperature');
    expect(request?.body).not.toHaveProperty('tool_choice');
    expect(request?.body).not.toHaveProperty('thinking');
    expect(request?.body).not.toHaveProperty('thread');
    const tools = request?.body.tools as Array<{ name: string; description: string }>;
    expect(tools.map((tool) => tool.name)).toContain('find_similar_companies');
    expect(tools.map((tool) => tool.name)).not.toContain('brand_new_tool');
    expect(tools.find((tool) => tool.name === 'search_people')?.description).toContain('Credit cost (enforced by this bot): 2 credits per person');
  });

  it('honours a model override', async () => {
    const { toolbox } = await makeToolbox();
    const { anthropic, requests } = scriptedClaude([() => ({ content: [text('ok')], stop_reason: 'end_turn' })]);
    await new GtmAgent({ anthropic, toolbox, model: 'claude-sonnet-5-5' }).answer('hi', 'U1', hooks().hooks);
    expect(requests[0]?.body.model).toBe('claude-sonnet-5-5');
  });

  it('runs a small paid step without a click, but still shows the plan', async () => {
    const { toolbox, mcp } = await makeToolbox();
    const { anthropic } = scriptedClaude([
      () => ({ content: [toolUse('t0', 'count_people', { semanticQuery: 'vp sales at acme' })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Fetching 2.'), toolUse('t1', 'search_people', { pageSize: 2 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Done.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, shown, asked } = hooks();
    const answer = await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', agentHooks);
    expect(shown.map((plan) => [plan.status, plan.estimate])).toEqual([['auto', 4]]);
    expect(asked).toHaveLength(0);
    expect(mcp.calls).toHaveLength(1);
    expect(answer.spent).toBe(4);
  });

  it('does not call the tool when the user cancels, and tells Claude why', async () => {
    const { toolbox, mcp } = await makeToolbox();
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'find_similar_companies', { domains: ['acme.example'], pageSize: 5 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Skipped the lookalike fetch.')], stop_reason: 'end_turn' }),
    ]);
    const answer = await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', hooks('cancelled').hooks);
    expect(mcp.calls).toHaveLength(0);
    expect(answer).toMatchObject({ spent: 0, outcome: 'answered' });
    expect(toolResults(requests[1]!)).toEqual([{ tool_use_id: 't1', is_error: true, text: expect.stringContaining('The user declined this paid call') }]);
  });

  it('blocks a plan over the per-question cap without asking', async () => {
    const { toolbox, mcp } = await makeToolbox({ limits: { questionCap: 30 } });
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'find_similar_companies', { domains: ['acme.example'], pageSize: 10 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Too expensive.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, shown, asked } = hooks('approved');
    await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', agentHooks);
    expect(asked).toHaveLength(0);
    expect(shown[0]).toMatchObject({ status: 'blocked', estimate: 50, blockedReason: expect.stringContaining('per-question cap of 30') });
    expect(mcp.calls).toHaveLength(0);
    expect(toolResults(requests[1]!)[0]?.text).toContain('Blocked by the budget');
  });

  it('counts parallel paid calls of one turn as one plan', async () => {
    const { toolbox, mcp } = await makeToolbox();
    const { anthropic } = scriptedClaude([
      () => ({
        content: [toolUse('t1', 'enrich_company', { domain: 'a.example' }), toolUse('t2', 'enrich_company', { domain: 'b.example' }), toolUse('t3', 'count_companies', { semanticQuery: 'x' })],
        stop_reason: 'tool_use',
      }),
      () => ({ content: [text('Both enriched.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, shown } = hooks();
    const answer = await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', agentHooks);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.steps.map((step) => step.args.domain)).toEqual(['a.example', 'b.example']);
    expect(shown[0]?.estimate).toBe(2);
    expect(mcp.calls.map((call) => call.args.domain)).toEqual(['a.example', 'b.example']);
    expect(answer.rows.companies).toHaveLength(2);
  });

  it('refuses a paid people search that no free count came before', async () => {
    const { toolbox, mcp } = await makeToolbox();
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'search_people', { seniority: ['vp'], pageSize: 2 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('I need to count first.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, shown, asked } = hooks();
    await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', agentHooks);
    expect(mcp.calls).toHaveLength(0);
    expect(shown).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(toolResults(requests[1]!)[0]).toMatchObject({ is_error: true, text: expect.stringContaining('Call count_people first') });
  });

  it('refuses a paid search when the latest count was 0', async () => {
    const { toolbox, mcp } = await makeToolbox({ localTools: fakeCountTools({ people: 0 }) });
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'count_people', { semanticQuery: 'chief vibes officers' })], stop_reason: 'tool_use' }),
      () => ({ content: [toolUse('t2', 'search_people', { positionQuery: ['chief vibes officer'], pageSize: 2 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Nobody matches.')], stop_reason: 'end_turn' }),
    ]);
    await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', hooks().hooks);
    expect(mcp.calls).toHaveLength(0);
    expect(toolResults(requests[2]!)[0]?.text).toContain('result was 0');
  });

  it('runs the matching lookalike count itself and skips the paid search at 0', async () => {
    const { toolbox, mcp } = await makeToolbox({ localTools: fakeCountTools({ companies: 0 }) });
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'find_similar_companies', { domains: ['acme.example'], pageSize: 5 })], stop_reason: 'tool_use' }),
      () => ({ content: [text('No lookalikes.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, shown, asked } = hooks();
    await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', agentHooks);
    expect(mcp.calls).toHaveLength(0);
    expect(shown).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(toolResults(requests[1]!)[0]?.text).toContain('count_companies result was 0');
  });

  it('never has more than 4 tool calls in flight, however many Claude asks for', async () => {
    let active = 0;
    let peak = 0;
    const base = fakeMcp({ enrich_company: (args) => textResult({ name: String(args.domain), domain: args.domain, creditInfo: { cost: 1 } }) });
    const mcp = {
      ...base,
      callTool: async (name: string, args: Record<string, unknown>) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return base.callTool(name, args);
      },
    };
    const { toolbox } = await makeToolbox({ mcp });
    const domains = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => `${letter}.example`);
    const { anthropic } = scriptedClaude([
      () => ({ content: domains.map((domain, i) => toolUse(`t${i}`, 'enrich_company', { domain })), stop_reason: 'tool_use' }),
      () => ({ content: [text('Six enriched.')], stop_reason: 'end_turn' }),
    ]);
    const answer = await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', hooks().hooks);
    expect(base.calls).toHaveLength(6);
    expect(peak).toBe(4);
    expect(answer.spent).toBe(6);
  });

  it('reports a refusal instead of reading the content', async () => {
    const { toolbox } = await makeToolbox();
    const { anthropic } = scriptedClaude([() => ({ content: [], stop_reason: 'refusal' })]);
    const answer = await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', hooks().hooks);
    expect(answer).toMatchObject({ outcome: 'refused', text: 'Claude declined to answer this question.' });
  });

  it('never pays for tool calls on the last allowed turn', async () => {
    const { toolbox, mcp } = await makeToolbox();
    const { anthropic, requests } = scriptedClaude([
      () => ({ content: [toolUse('t1', 'count_people', { semanticQuery: 'cto' })], stop_reason: 'tool_use' }),
      () => ({ content: [text('Now fetching.'), toolUse('t2', 'search_people', { pageSize: 2 })], stop_reason: 'tool_use' }),
    ]);
    const { hooks: agentHooks, shown, asked } = hooks();
    const answer = await new GtmAgent({ anthropic, toolbox, maxIterations: 2 }).answer('q', 'U1', agentHooks);
    expect(requests).toHaveLength(2);
    expect(mcp.calls).toHaveLength(0);
    expect(shown).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(answer.outcome).toBe('incomplete');
    expect(answer.text).toContain('Stopped after 2 steps');
  });

  it('does not run a tool input that was cut off at max_tokens', async () => {
    const { toolbox, mcp } = await makeToolbox();
    const { anthropic } = scriptedClaude([
      () => ({ content: [text('Fetching'), toolUse('t1', 'search_people', { pageSize: 2 })], stop_reason: 'max_tokens' }),
      () => ({ content: [text('Sorry.')], stop_reason: 'end_turn' }),
    ]);
    const { hooks: agentHooks, shown, asked } = hooks();
    const answer = await new GtmAgent({ anthropic, toolbox }).answer('q', 'U1', agentHooks);
    expect(mcp.calls).toHaveLength(0);
    expect(shown).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(answer).toMatchObject({ outcome: 'incomplete', spent: 0, text: expect.stringContaining('ran out of output tokens') });
  });
});
