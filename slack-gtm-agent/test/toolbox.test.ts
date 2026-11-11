import { describe, expect, it } from 'vitest';
import { ApprovalRequiredError, BudgetError } from '../src/lib/errors.js';
import { chargedCredits, errorResult, isUnbilledError, textResult, type SpendContext, type ToolResult } from '../src/lib/toolbox.js';
import { fakeMcp, makeToolbox } from './fixtures.js';

const context = (userId = 'U1'): SpendContext => ({ userId, question: { spent: 0 } });

describe('Toolbox', () => {
  it('exposes priced MCP tools plus the local count tools, with pricing in each description', async () => {
    const { toolbox } = await makeToolbox();
    expect(toolbox.definitions.map((definition) => definition.name)).toEqual([
      'enrich_company',
      'search_people',
      'find_similar_companies',
      'get_current_user',
      'count_companies',
      'count_people',
    ]);
    const enrich = toolbox.definitions.find((definition) => definition.name === 'enrich_company');
    expect(enrich?.description).toBe('Enriches a company by domain.\n\nCredit cost (enforced by this bot): 1 credit, plus 5 with includeWorkforce.');
  });

  it('hides an MCP tool that has no cost rule, and refuses to call it', async () => {
    const { toolbox, mcp } = await makeToolbox();
    expect(toolbox.hidden).toEqual(['brand_new_tool']);
    await expect(toolbox.call('brand_new_tool', {}, context())).rejects.toThrow('not available');
    expect(mcp.calls).toHaveLength(0);
  });

  it('calls the MCP tool and records the credits the API reported', async () => {
    const { toolbox, mcp, ledger } = await makeToolbox();
    const spend = context();
    const { result, credits } = await toolbox.call('enrich_company', { domain: 'acme.example' }, spend);
    expect(result.structuredContent?.name).toBe('Acme');
    expect(credits).toBe(1);
    expect(spend.question.spent).toBe(1);
    expect(ledger.spentToday('U1')).toBe(1);
    expect(mcp.calls).toEqual([{ name: 'enrich_company', args: { domain: 'acme.example' } }]);
  });

  it('charges the real cost when a search returns fewer results than the estimate', async () => {
    const mcp = fakeMcp({ search_people: () => textResult({ items: [], creditInfo: { cost: 2 } }) });
    const { toolbox, ledger } = await makeToolbox({ mcp });
    const { credits } = await toolbox.call('search_people', { pageSize: 5 }, context());
    expect(credits).toBe(2);
    expect(ledger.spentToday('U1')).toBe(2);
  });

  it('charges nothing for a not-found error', async () => {
    const { toolbox, ledger } = await makeToolbox();
    const { result, credits } = await toolbox.call('enrich_company', { domain: 'missing.example' }, context());
    expect(result.isError).toBe(true);
    expect(credits).toBe(0);
    expect(ledger.spentToday('U1')).toBe(0);
  });

  it('runs free tools without an approval or a budget', async () => {
    const { toolbox } = await makeToolbox({ limits: { questionCap: 0, dailyUserCap: 0, dailyTotalCap: 0 } });
    const { result, credits } = await toolbox.call('count_people', { semanticQuery: 'vp sales' }, context());
    expect(result.structuredContent?.count).toBe(2);
    expect(credits).toBe(0);
  });

  it('refuses a call above the approval threshold unless that amount was approved', async () => {
    const { toolbox, mcp } = await makeToolbox();
    await expect(toolbox.call('search_people', { pageSize: 6 }, context())).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(toolbox.call('search_people', { pageSize: 6 }, { ...context(), approvedCredits: 11 })).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(mcp.calls).toHaveLength(0);
    const { credits } = await toolbox.call('search_people', { pageSize: 6 }, { ...context(), approvedCredits: 12 });
    expect(credits).toBe(12);
  });

  it('enforces the per-question cap across calls of one question', async () => {
    const { toolbox } = await makeToolbox({ limits: { questionCap: 20 } });
    const spend = context();
    await toolbox.call('search_people', { pageSize: 5 }, spend);
    await toolbox.call('search_people', { pageSize: 5 }, spend);
    await expect(toolbox.call('enrich_company', { domain: 'acme.example' }, spend)).rejects.toBeInstanceOf(BudgetError);
  });

  it('enforces the per-user and total daily caps across questions', async () => {
    const { toolbox } = await makeToolbox({ limits: { dailyUserCap: 3, dailyTotalCap: 4 } });
    await toolbox.call('search_people', { pageSize: 1 }, context('U1'));
    await expect(toolbox.call('search_people', { pageSize: 1 }, context('U1'))).rejects.toThrow('your daily cap of 3');
    await toolbox.call('search_people', { pageSize: 1 }, context('U2'));
    await expect(toolbox.call('enrich_company', { domain: 'acme.example' }, context('U3'))).rejects.toThrow('everyone together');
  });

  it('reserves the estimate during a call so parallel calls cannot overshoot a cap', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mcp = fakeMcp({ search_people: () => textResult({ items: [], creditInfo: { cost: 8 } }) });
    const slowMcp = { ...mcp, callTool: async (name: string, args: Record<string, unknown>) => (await gate, mcp.callTool(name, args)) };
    const { toolbox } = await makeToolbox({ mcp: { ...slowMcp, calls: mcp.calls }, limits: { dailyUserCap: 10 } });

    const first = toolbox.call('search_people', { pageSize: 4 }, context());
    await expect(toolbox.call('search_people', { pageSize: 4 }, context())).rejects.toBeInstanceOf(BudgetError);
    release();
    await expect(first).resolves.toMatchObject({ credits: 8 });
  });

  it('keeps the reservation when the call throws, because it may have been billed', async () => {
    const mcp = fakeMcp({
      search_people: () => {
        throw new Error('MCP server exited');
      },
    });
    const { toolbox, ledger } = await makeToolbox({ mcp });
    const spend = context();
    const { result, credits } = await toolbox.call('search_people', { pageSize: 2 }, spend);
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('may have been billed: MCP server exited') }] });
    expect(credits).toBe(4);
    expect(ledger.spentToday('U1')).toBe(4);
    expect(spend.question.spent).toBe(4);
  });

  it('stops at the cap when an endpoint charges and then the connection drops', async () => {
    // The MCP server turns a network failure after the request was sent into this text.
    const mcp = fakeMcp({ enrich_company: () => errorResult('Error calling CompanyEnrich API: fetch failed') });
    const { toolbox, ledger } = await makeToolbox({ mcp, limits: { dailyUserCap: 1 } });
    await expect(toolbox.call('enrich_company', { domain: 'a.example' }, context())).resolves.toMatchObject({ credits: 1 });
    await expect(toolbox.call('enrich_company', { domain: 'a.example' }, context())).rejects.toBeInstanceOf(BudgetError);
    await expect(toolbox.call('enrich_company', { domain: 'a.example' }, context())).rejects.toBeInstanceOf(BudgetError);
    expect(mcp.calls).toHaveLength(1);
    expect(ledger.spentToday('U1')).toBe(1);
  });

  it('releases the reservation only for failures that cannot have been billed', async () => {
    const outcomes: Array<[ToolResult, number]> = [
      [errorResult('Input validation error: Invalid arguments for tool search_people: pageSize: Too small'), 0],
      [errorResult('Provide exactly one lookup parameter: id or domain.'), 0],
      [errorResult('Invalid request: domains: too many'), 0],
      [errorResult('Authentication failed. Please check your API key.'), 0],
      [errorResult('Insufficient credits. Please check your account balance.'), 0],
      [errorResult('Rate limit exceeded. Please try again later.'), 0],
      [errorResult('Error 422: Unprocessable'), 0],
      [{ ...errorResult('Error 500'), structuredContent: { creditInfo: { cost: 0 } } }, 0],
      [errorResult('Error 502: Bad gateway'), 4],
      [errorResult('Error calling CompanyEnrich API: The operation was aborted due to timeout'), 4],
      [errorResult('Something new and unexpected'), 4],
    ];
    for (const [response, expected] of outcomes) {
      const { toolbox, ledger } = await makeToolbox({ mcp: fakeMcp({ search_people: () => response }) });
      const { credits } = await toolbox.call('search_people', { pageSize: 2 }, context());
      expect([resultLabel(response), credits]).toEqual([resultLabel(response), expected]);
      expect(ledger.spentToday('U1')).toBe(expected);
    }
  });

  it('runs at most 4 tool calls at once across callers', async () => {
    let active = 0;
    let peak = 0;
    const mcp = fakeMcp({ enrich_company: () => textResult({ name: 'Acme', creditInfo: { cost: 1 } }) });
    const slow = {
      ...mcp,
      callTool: async (name: string, args: Record<string, unknown>) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return mcp.callTool(name, args);
      },
    };
    const { toolbox } = await makeToolbox({ mcp: slow });
    const calls = Array.from({ length: 9 }, (_, i) => toolbox.call('enrich_company', { domain: `d${i}.example` }, context(`U${i % 3}`)));
    await Promise.all(calls);
    expect(peak).toBe(4);
  });
});

function resultLabel(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

describe('chargedCredits', () => {
  it('prefers the reported cost, then zero for known-unbilled errors, then the estimate', () => {
    expect(chargedCredits(textResult({ creditInfo: { cost: 3 } }), 10)).toBe(3);
    expect(chargedCredits(textResult({}), 10)).toBe(10);
    expect(chargedCredits(errorResult('Company with domain "x.example" not found in the database.'), 10)).toBe(0);
    expect(chargedCredits(errorResult('Error calling CompanyEnrich API: socket hang up'), 10)).toBe(10);
  });

  it('never treats a success as an unbilled error', () => {
    expect(isUnbilledError(textResult({ note: 'Invalid request' }))).toBe(false);
  });
});
