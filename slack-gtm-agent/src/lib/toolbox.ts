import { checkSpend, needsApproval, type Ledger, type Limits, type SpendCheck } from './budget.js';
import { costRuleFor } from './costs.js';
import { ApprovalRequiredError, BudgetError, describeError } from './errors.js';
import { Limiter } from './limiter.js';

/** Most tool calls in flight at once, across all commands and questions. */
export const MAX_CONCURRENT_CALLS = 4;

/** A tool as `tools/list` describes it: the MCP shape, also used for the local tools. */
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** A tool call result in the MCP `tools/call` shape. CompanyEnrich tools return text only. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The two MCP client calls the toolbox needs. `mcp.ts` adapts the real client to it. */
export interface ToolClient {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** A tool implemented in this process instead of on the MCP server. */
export interface LocalTool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface SpendContext {
  /** Slack user the credits are charged to. */
  userId: string;
  /** Running total for the current command or agent question, updated in place. */
  question: { spent: number };
  /** Credits the user approved for this call with a click. */
  approvedCredits?: number;
}

export interface ToolCallOutcome {
  result: ToolResult;
  /** Credits charged as the API reported them, or the estimate when a failure may have been billed. */
  credits: number;
}

export function textResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text).join('\n');
}

/**
 * Error texts from the MCP server for failures the API cannot have billed: input
 * validation inside the server, and 4xx responses (bad request, bad key, no credits,
 * forbidden, not found, rate limited). Anything else, such as a 5xx or a network error
 * after the request was sent, may have been billed.
 */
const UNBILLED_ERRORS = [
  /^Input validation error:/,
  /^Provide (exactly one|at least one)/,
  /^Invalid request/,
  /^Authentication failed/,
  /^Insufficient credits/,
  /^Forbidden/,
  /^Rate limit exceeded/,
  /^Resource not found/,
  /not found in the database\.?$/,
  /^Error 4\d\d\b/,
];

export function isUnbilledError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const message = resultText(result).trim();
  return UNBILLED_ERRORS.some((pattern) => pattern.test(message));
}

/**
 * The credits a call cost. The MCP server copies the API's `x-credit-cost` header into
 * `creditInfo.cost`, and that number wins. Without it, a failure that is known to be
 * unbilled costs nothing, and anything else (a success, or a failure after the request
 * may have reached the API) is counted at the estimate, so caps never undercount.
 */
export function chargedCredits(result: ToolResult, estimate: number): number {
  const creditInfo = result.structuredContent?.creditInfo as { cost?: unknown } | undefined;
  if (typeof creditInfo?.cost === 'number' && Number.isFinite(creditInfo.cost)) return creditInfo.cost;
  return isUnbilledError(result) ? 0 : estimate;
}

/**
 * Every CompanyEnrich tool the bot can use: the MCP server's tools plus the local free
 * count tools, each wrapped with its credit estimate and the budget checks. Commands and
 * the agent both call tools through `call()`, so the rules hold for both.
 */
export class Toolbox {
  private constructor(
    /** Tools callers may use, with pricing appended to each description. */
    readonly definitions: ToolDefinition[],
    /** MCP tools hidden because they have no entry in the cost table. */
    readonly hidden: string[],
    private readonly mcp: ToolClient,
    private readonly local: Map<string, LocalTool>,
    private readonly ledger: Ledger,
    readonly limits: Limits,
    private readonly limiter: Limiter,
  ) {}

  static async create(options: {
    mcp: ToolClient;
    localTools: LocalTool[];
    ledger: Ledger;
    limits: Limits;
    maxConcurrentCalls?: number;
  }): Promise<Toolbox> {
    const remote = await options.mcp.listTools();
    const all = [...remote, ...options.localTools.map((tool) => tool.definition)];
    const definitions: ToolDefinition[] = [];
    const hidden: string[] = [];
    for (const definition of all) {
      const rule = costRuleFor(definition.name);
      if (!rule) {
        hidden.push(definition.name);
        continue;
      }
      const description = [definition.description, `Credit cost (enforced by this bot): ${rule.pricing}`]
        .filter(Boolean)
        .join('\n\n');
      definitions.push({ ...definition, description });
    }
    const local = new Map(options.localTools.map((tool) => [tool.definition.name, tool]));
    const limiter = new Limiter(options.maxConcurrentCalls ?? MAX_CONCURRENT_CALLS);
    return new Toolbox(definitions, hidden, options.mcp, local, options.ledger, options.limits, limiter);
  }

  has(name: string): boolean {
    return this.definitions.some((definition) => definition.name === name);
  }

  estimate(name: string, args: Record<string, unknown>): number {
    const rule = costRuleFor(name);
    if (!rule || !this.has(name)) throw new Error(`Tool "${name}" is not available.`);
    return rule.estimate(args);
  }

  /** Check the caps for a planned spend without calling anything. */
  checkSpend(context: SpendContext, estimate: number): SpendCheck {
    return checkSpend({
      estimate,
      questionSpent: context.question.spent,
      userSpentToday: this.ledger.spentToday(context.userId),
      totalSpentToday: this.ledger.totalToday(),
      limits: this.limits,
    });
  }

  spentToday(userId: string): number {
    return this.ledger.spentToday(userId);
  }

  async call(name: string, args: Record<string, unknown>, context: SpendContext): Promise<ToolCallOutcome> {
    const estimate = this.estimate(name, args);

    if (estimate > 0) {
      const check = this.checkSpend(context, estimate);
      if (!check.ok) throw new BudgetError(check.reason);
      if (needsApproval(estimate, this.limits) && (context.approvedCredits ?? 0) < estimate) {
        throw new ApprovalRequiredError(
          `${name} is estimated at ${estimate} credits, above the ${this.limits.approvalThreshold}-credit approval threshold, and was not approved.`,
        );
      }
    }

    // Reserve the estimate before the call (and before waiting for a free slot), so that
    // parallel calls cannot overshoot a cap. Then settle the reservation to the charge.
    const reservation = this.ledger.reserve(context.userId, estimate);
    context.question.spent += estimate;
    let result: ToolResult;
    try {
      const localTool = this.local.get(name);
      result = await this.limiter.run(() => (localTool ? localTool.run(args) : this.mcp.callTool(name, args)));
    } catch (error) {
      // The request may have reached the API before the failure, so keep the reservation.
      result = errorResult(`The ${name} call failed and may have been billed: ${describeError(error)}`);
    }
    const credits = chargedCredits(result, estimate);
    this.ledger.settle(reservation, credits);
    context.question.spent = Math.max(0, context.question.spent + credits - estimate);
    return { result, credits };
  }
}
