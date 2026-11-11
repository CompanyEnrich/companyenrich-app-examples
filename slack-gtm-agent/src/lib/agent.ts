import Anthropic from '@anthropic-ai/sdk';
import { mcpTools, type MCPClientLike } from '@anthropic-ai/sdk/helpers/beta/mcp';
import type { BetaMessage, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta';
import type { Decision } from './approvals.js';
import { needsApproval } from './budget.js';
import { describeError } from './errors.js';
import { compactForModel, mergeRows, rowsFromResult, type Rows } from './rows.js';
import { errorResult, resultText, textResult, type SpendContext, type Toolbox } from './toolbox.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You answer go-to-market questions in a Slack channel, using CompanyEnrich company and people data through the tools provided.

How to work:
1. Size the request first with the free tools count_companies and count_people. Their "interpretation" shows how the API read the question. Reuse those values (seniority, department, country codes, city ids, funding rounds, employee ranges) as arguments to the search tools. If a count is 0, say so and do not run a paid search.
2. Paid tools spend the team's credits, and each tool description gives its price. Fetch only what the answer needs: use pageSize 5 to 10 unless the user asks for more, and do not page through results to be thorough.
3. Before any paid call, write one or two plain sentences saying what you will fetch and why. The bot shows those sentences and the credit estimate to the user as the plan, and steps above the approval threshold wait for a click.
4. If a paid call comes back declined, expired or blocked by a budget cap, do not repeat it. Answer with what you have and say what was skipped. Retrying with a smaller pageSize is fine when the message says it would fit.
5. The search tools take these parameter names: countries (2-letter codes), cities (CompanyEnrich city ids), domains, positionQuery, seniority, department, fundingRounds, employees, pageSize. To find people at a kind of company, call search_people once with companyFilter.search (a semanticQuery plus filters) instead of one search per company.

Answer in Slack-friendly Markdown, in about 150 words or fewer. Lead with the direct answer, then at most 5 short bullets. Do not use tables or headings. The bot shows the result rows under your answer and attaches a CSV, so do not list more than 5 rows yourself. Report counts as counts from the database, not as exact market sizes.`;

/** One assistant turn's paid tool calls, as shown to the user. */
export interface Plan {
  /** What Claude wrote before the calls: its reason for them. */
  note: string;
  steps: Array<{ tool: string; args: Record<string, unknown>; estimate: number }>;
  /** Upper-bound credits for all steps. */
  estimate: number;
  /** Credits this question had spent before this plan. */
  questionSpent: number;
  status: 'auto' | 'needs-approval' | 'blocked';
  blockedReason?: string;
}

export interface AgentHooks {
  /** Show a plan that runs without a click (status `auto`) or that the budget blocked. */
  showPlan(plan: Plan): Promise<void>;
  /** Show a plan above the approval threshold and wait for Approve, Cancel or expiry. */
  requestApproval(plan: Plan): Promise<Decision>;
}

export interface AgentAnswer {
  text: string;
  rows: Rows;
  /** Credits charged for this question, as reported by the API. */
  spent: number;
  outcome: 'answered' | 'refused' | 'incomplete';
}

/** What happens when the tool runner executes one tool call of the current turn. */
type Verdict = { run: true; approvedCredits: number } | { run: false; message: string };

export class GtmAgent {
  constructor(
    private readonly options: {
      anthropic: Anthropic;
      toolbox: Toolbox;
      model?: string;
      maxIterations?: number;
    },
  ) {}

  async answer(question: string, userId: string, hooks: AgentHooks): Promise<AgentAnswer> {
    const { anthropic, toolbox } = this.options;
    const maxIterations = this.options.maxIterations ?? MAX_ITERATIONS;
    const spend: SpendContext = { userId, question: { spent: 0 } };
    const rows: Rows = { companies: [], people: [] };
    const verdicts = new Map<string, Verdict>();
    const counts: CountMemory = {};

    // The SDK's mcpTools() turns each tool definition into a runnable tool that calls
    // `callTool` on the client it is given. Giving it this gated client instead of the
    // raw MCP client is what puts the budget and approval rules in front of every call.
    const gatedClient: MCPClientLike = {
      callTool: async ({ name, arguments: args = {} }) => {
        const verdict = verdicts.get(callKey(name, args));
        if (!verdict?.run) return errorResult(verdict?.message ?? 'This call was not part of an approved plan.');
        try {
          const { result } = await toolbox.call(name, args, { ...spend, approvedCredits: verdict.approvedCredits });
          if (result.isError) return result;
          rememberCount(counts, name, result.structuredContent);
          mergeRows(rows, rowsFromResult(name, result.structuredContent));
          return textResult(compactForModel(name, result.structuredContent));
        } catch (error) {
          return errorResult(describeError(error));
        }
      },
    };

    const runner = anthropic.beta.messages.toolRunner({
      model: this.options.model ?? DEFAULT_MODEL,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      tools: mcpTools(toolbox.definitions, gatedClient),
      messages: [{ role: 'user', content: question }],
      output_config: { effort: 'medium' },
      // Retry a policy decline on Anthropic's recommended fallback model, server side.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // The tool definitions are large and identical on every turn: cache them.
      cache_control: { type: 'ephemeral' },
      max_iterations: maxIterations,
      // An approval can pause the loop for many minutes, longer than a server-side
      // message thread lives, so send the full history on every turn.
      thread: false,
    });

    let last: BetaMessage | undefined;
    let turn = 0;
    // The runner yields each assistant message before it runs that message's tool calls,
    // so the loop body decides which calls may run.
    for await (const message of runner) {
      last = message;
      turn += 1;
      if (message.stop_reason === 'refusal') break;
      const calls = message.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (calls.length === 0) continue;
      verdicts.clear();
      // A tool input cut off at max_tokens can still parse, so never run it. On the last
      // allowed turn, Claude would never see the results, so do not pay for them.
      if (message.stop_reason === 'max_tokens' || turn >= maxIterations) {
        const reason = message.stop_reason === 'max_tokens' ? 'The tool input was cut off. Send a shorter call.' : 'Out of steps for this question.';
        for (const call of calls) verdicts.set(callKey(call.name, inputOf(call)), { run: false, message: reason });
        continue;
      }
      await this.decide(message, calls, { spend, counts }, hooks, verdicts);
    }

    if (!last) throw new Error('Claude returned no response.');
    const spent = spend.question.spent;
    if (last.stop_reason === 'refusal') {
      return { text: 'Claude declined to answer this question.', rows, spent, outcome: 'refused' };
    }
    const text = textOf(last);
    if (last.stop_reason === 'max_tokens' || last.content.some((block) => block.type === 'tool_use')) {
      const why = last.stop_reason === 'max_tokens' ? 'Claude ran out of output tokens' : `Stopped after ${maxIterations} steps`;
      return { text: `${text}\n\n_${why} before finishing._`.trim(), rows, spent, outcome: 'incomplete' };
    }
    return { text, rows, spent, outcome: 'answered' };
  }

  /** Estimate this turn's calls, check the count preflight, show the plan, and record a verdict for each call. */
  private async decide(
    message: BetaMessage,
    calls: BetaToolUseBlock[],
    question: { spend: SpendContext; counts: CountMemory },
    hooks: AgentHooks,
    verdicts: Map<string, Verdict>,
  ): Promise<void> {
    const { toolbox } = this.options;
    const { spend, counts } = question;
    const paid: Array<{ call: BetaToolUseBlock; estimate: number }> = [];
    for (const call of calls) {
      const args = inputOf(call);
      if (!toolbox.has(call.name)) continue; // The runner answers unknown tool names itself.
      const estimate = toolbox.estimate(call.name, args);
      if (estimate === 0) {
        verdicts.set(callKey(call.name, args), { run: true, approvedCredits: 0 });
        continue;
      }
      const refusal = await this.preflight(call.name, args, spend, counts);
      if (refusal) verdicts.set(callKey(call.name, args), { run: false, message: refusal });
      else paid.push({ call, estimate });
    }
    if (paid.length === 0) return;

    const estimate = paid.reduce((sum, step) => sum + step.estimate, 0);
    const check = toolbox.checkSpend(spend, estimate);
    const plan: Plan = {
      note: textOf(message),
      steps: paid.map(({ call, estimate: credits }) => ({ tool: call.name, args: inputOf(call), estimate: credits })),
      estimate,
      questionSpent: spend.question.spent,
      status: !check.ok ? 'blocked' : needsApproval(estimate, toolbox.limits) ? 'needs-approval' : 'auto',
      ...(check.ok ? {} : { blockedReason: check.reason }),
    };

    let decision: Decision | 'blocked' = 'approved';
    if (plan.status === 'needs-approval') decision = await hooks.requestApproval(plan);
    else {
      await hooks.showPlan(plan);
      if (plan.status === 'blocked') decision = 'blocked';
    }

    const refusals: Record<Exclude<Decision, 'approved'> | 'blocked', string> = {
      cancelled: 'The user declined this paid call. Do not call it again; answer with what you have and say what was skipped.',
      expired: 'Nobody approved this paid call within 15 minutes, so it did not run. Answer with what you have.',
      blocked: `Blocked by the budget: ${plan.blockedReason}. Do not repeat this call. Use a smaller pageSize if that would fit, or answer with what you have.`,
    };
    for (const { call, estimate: credits } of paid) {
      verdicts.set(
        callKey(call.name, inputOf(call)),
        decision === 'approved' ? { run: true, approvedCredits: credits } : { run: false, message: refusals[decision] },
      );
    }
  }

  /**
   * Enforce "count before you pay" in code, not only in the prompt. Returns why a paid
   * search may not run, or undefined when it may. When a matching free count exists,
   * run it here; otherwise require a count of the same kind earlier in the question.
   * A search never runs when the relevant count is 0.
   */
  private async preflight(
    toolName: string,
    args: Record<string, unknown>,
    spend: SpendContext,
    counts: CountMemory,
  ): Promise<string | undefined> {
    const rule = SEARCH_COUNTS[toolName];
    if (!rule) return undefined;
    const countArgs = matchingCount(toolName, args);
    if (countArgs) {
      const { result } = await this.options.toolbox.call(rule.countTool, countArgs, spend);
      if (result.isError) return `The free ${rule.countTool} check before this search failed, so it did not run: ${resultText(result)}`;
      rememberCount(counts, rule.countTool, result.structuredContent);
    }
    const latest = counts[rule.kind];
    if (latest === undefined) {
      return `Call ${rule.countTool} first. A paid search only runs after a free count of the same kind earlier in this question.`;
    }
    if (latest === 0) {
      return `The free ${rule.countTool} result was 0, so this paid search did not run. Broaden the count until it finds matches.`;
    }
    return undefined;
  }
}

/** The latest free count result of each kind in this question. */
type CountMemory = Partial<Record<'people' | 'companies', number>>;

/** Which free count a paid search needs before it may run. */
const SEARCH_COUNTS: Record<string, { kind: 'people' | 'companies'; countTool: string }> = {
  search_people: { kind: 'people', countTool: 'count_people' },
  search_companies: { kind: 'companies', countTool: 'count_companies' },
  find_similar_companies: { kind: 'companies', countTool: 'count_companies' },
};

function rememberCount(counts: CountMemory, toolName: string, structured: Record<string, unknown> | undefined): void {
  const kind = toolName === 'count_people' ? 'people' : toolName === 'count_companies' ? 'companies' : undefined;
  if (kind && typeof structured?.count === 'number') counts[kind] = structured.count;
}

/**
 * The free count that matches a paid search exactly, when one exists: lookalike seeds,
 * or a semantic description. Filters on the paid search only narrow it further, so a
 * count of 0 means the search would find nothing.
 */
function matchingCount(toolName: string, args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (toolName === 'find_similar_companies' && Array.isArray(args.domains)) return { lookalikeDomains: args.domains };
  if (toolName === 'search_companies' && typeof args.semanticQuery === 'string' && args.semanticQuery.trim()) {
    return { semanticQuery: args.semanticQuery };
  }
  return undefined;
}

/** One-line description of a Claude API failure, for posting in Slack. */
export function describeAgentError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'Anthropic rejected ANTHROPIC_API_KEY (401).';
  if (error instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now. Try again in a minute.';
  if (error instanceof Anthropic.APIError) return `Claude API error ${error.status ?? ''}: ${error.message}`.trim();
  return describeError(error);
}

function inputOf(call: BetaToolUseBlock): Record<string, unknown> {
  return call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
}

/**
 * Key for matching a planned tool_use block to the call the runner makes. The runner
 * passes the block's own input object to the tool, so serializing it gives the same key.
 */
function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

function textOf(message: BetaMessage): string {
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}
