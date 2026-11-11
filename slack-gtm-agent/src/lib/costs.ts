/**
 * Credit estimates for every tool the bot exposes, keyed by tool name.
 *
 * Each estimate is an upper bound for one call with the given arguments: a search is
 * priced as if it returns a full page. The real charge comes back from the API after
 * the call (see `chargedCredits` in toolbox.ts) and that is what the ledger records.
 *
 * Prices are taken from the CompanyEnrich MCP server's tool descriptions and checked
 * against the `x-credit-cost` header on live calls. A `search_companies` call with
 * `semanticQuery` costs 2 credits per company.
 *
 * A tool that is not in this table is never shown to Claude or callable by a command,
 * so a new tool added to the MCP server stays hidden until someone prices it here.
 */

type Args = Record<string, unknown>;

export interface CostRule {
  /** Pricing in words. Appended to the tool description Claude sees, and listed by `/ce help`. */
  pricing: string;
  /** Upper-bound credit estimate for one call with these arguments. */
  estimate(args: Args): number;
}

/** MCP search tools default to 20 results per page and allow at most 100. */
const MCP_DEFAULT_PAGE_SIZE = 20;
const MCP_MAX_PAGE_SIZE = 100;
/** The MCP server documents workforce insights as 5 extra credits per company. */
const WORKFORCE_CREDITS = 5;

export function pageSizeOf(args: Args): number {
  const raw = Number(args.pageSize ?? MCP_DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(raw)) return MCP_DEFAULT_PAGE_SIZE;
  return Math.min(MCP_MAX_PAGE_SIZE, Math.max(1, Math.floor(raw)));
}

function workforce(args: Args): number {
  return args.includeWorkforce === true ? WORKFORCE_CREDITS : 0;
}

const free: CostRule = { pricing: 'Free.', estimate: () => 0 };

const companyLookup: CostRule = {
  pricing: '1 credit, plus 5 with includeWorkforce.',
  estimate: (args) => 1 + workforce(args),
};

export const COST_RULES: Readonly<Record<string, CostRule>> = {
  // Free helpers
  get_current_user: free,
  count_companies: free,
  count_people: free,

  // Company lookups
  enrich_company: companyLookup,
  get_company_by_id: companyLookup,
  enrich_company_by_properties: companyLookup,
  get_company_workforce: { pricing: '5 credits.', estimate: () => 5 },

  // Searches, priced per returned result with a one-result minimum
  search_companies: {
    pricing:
      '1 credit per company returned (2 with semanticQuery), plus 5 per company with includeWorkforce. Estimated as a full page of pageSize results.',
    estimate: (args) => {
      const perCompany = (typeof args.semanticQuery === 'string' && args.semanticQuery.trim() ? 2 : 1) + workforce(args);
      return pageSizeOf(args) * perCompany;
    },
  },
  find_similar_companies: {
    pricing:
      '5 credits per company returned, plus 5 per company with includeWorkforce. Estimated as a full page of pageSize results.',
    estimate: (args) => pageSizeOf(args) * (5 + workforce(args)),
  },
  search_people: {
    pricing: '2 credits per person returned. Estimated as a full page of pageSize results.',
    estimate: (args) => pageSizeOf(args) * 2,
  },

  // Person lookups
  get_person_by_id: { pricing: '2 credits.', estimate: () => 2 },
  lookup_person_by_email: { pricing: '5 credits when a person is found.', estimate: () => 5 },
  enrich_person_email: { pricing: '10 credits per newly found email.', estimate: () => 10 },
};

export function costRuleFor(toolName: string): CostRule | undefined {
  return Object.hasOwn(COST_RULES, toolName) ? COST_RULES[toolName] : undefined;
}
