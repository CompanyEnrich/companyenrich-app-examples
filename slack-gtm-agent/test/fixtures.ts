import { Ledger, type Limits } from '../src/lib/budget.js';
import { errorResult, textResult, Toolbox, type LocalTool, type ToolClient, type ToolDefinition, type ToolResult } from '../src/lib/toolbox.js';

export const LIMITS: Limits = { approvalThreshold: 10, questionCap: 50, dailyUserCap: 200, dailyTotalCap: 1000 };

/** Company records in the shape the MCP server returns (snake_case). Fictional data. */
export function company(domain: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${domain}`,
    name,
    domain,
    industry: 'Software',
    employees: '51-200',
    revenue: '10m-50m',
    founded_year: 2015,
    type: 'private',
    description: `${name} makes example software.`,
    location: { country: { code: 'DE', name: 'Germany' }, city: { id: 37140, name: 'Berlin' } },
    financial: { funding_stage: 'series_b', total_funding: 42_000_000 },
    socials: { linkedin_url: `https://www.linkedin.com/company/${name.toLowerCase()}` },
    logo_url: `https://logos.example/${domain}.png`,
    ...extra,
  };
}

export function person(id: number, position: string, companyDomain = 'example.com'): Record<string, unknown> {
  return {
    id,
    name: `Person ${id}`,
    position,
    seniority: 'vp',
    department: 'sales',
    location: { country: { code: 'DE', name: 'Germany' } },
    socials: { linkedin_url: `https://www.linkedin.com/in/person-${id}` },
    experiences: [{ isCurrent: true, position, company: { id: 'c1', name: 'Example', domain: companyDomain } }],
  };
}

const schema = (properties: Record<string, unknown> = {}): ToolDefinition['inputSchema'] => ({ type: 'object', properties });

export const MCP_DEFINITIONS: ToolDefinition[] = [
  { name: 'enrich_company', description: 'Enriches a company by domain.', inputSchema: schema({ domain: { type: 'string' } }) },
  { name: 'search_people', description: 'Searches people.', inputSchema: schema({ pageSize: { type: 'integer' } }) },
  { name: 'find_similar_companies', description: 'Finds similar companies.', inputSchema: schema({ domains: { type: 'array' } }) },
  { name: 'get_current_user', description: 'Free.', inputSchema: schema() },
  { name: 'brand_new_tool', description: 'A tool added after the cost table was written.', inputSchema: schema() },
];

export interface FakeMcp extends ToolClient {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

/**
 * A fake MCP client with canned results. Paid results carry `creditInfo.cost`, like the
 * real server, computed from the number of items returned.
 */
export function fakeMcp(overrides: Partial<Record<string, (args: Record<string, unknown>) => ToolResult>> = {}): FakeMcp {
  const calls: FakeMcp['calls'] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => ToolResult> = {
    get_current_user: () => textResult({ credits: { used: 100, total: 1000 } }),
    enrich_company: (args) =>
      args.domain === 'missing.example'
        ? errorResult('Company with domain "missing.example" not found in the database.')
        : textResult({ ...company(String(args.domain), 'Acme'), creditInfo: { cost: 1 } }),
    search_people: (args) => {
      const items = Array.from({ length: Number(args.pageSize ?? 20) }, (_, i) => person(i + 1, 'VP Sales'));
      return textResult({ items, page: 1, totalPages: 1, totalItems: items.length, creditInfo: { cost: items.length * 2 } });
    },
    find_similar_companies: (args) => {
      const items = Array.from({ length: Number(args.pageSize ?? 20) }, (_, i) => company(`similar${i + 1}.example`, `Similar ${i + 1}`));
      const scores = Object.fromEntries(items.map((item, i) => [String(item.id), 0.9 - i / 100]));
      return textResult({ items, metadata: { scores }, creditInfo: { cost: items.length * 5 } });
    },
    ...overrides,
  };
  return {
    calls,
    listTools: async () => MCP_DEFINITIONS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake MCP has no tool ${name}`);
      return handler(args);
    },
  };
}

/** Free count tools with fixed answers, standing in for the SDK-backed ones. */
export function fakeCountTools(counts: { companies?: number; people?: number; interpretation?: unknown } = {}): LocalTool[] {
  const interpretation = counts.interpretation ?? { filter: { seniority: { in: ['vp'] }, department: { in: ['sales'] } } };
  return [
    {
      definition: { name: 'count_companies', description: 'Count companies.', inputSchema: schema({ semanticQuery: { type: 'string' } }) },
      run: async () => textResult({ count: counts.companies ?? 120, total: counts.companies ?? 120, interpretation: { filter: { city: { in: [37140] } } } }),
    },
    {
      definition: { name: 'count_people', description: 'Count people.', inputSchema: schema({ semanticQuery: { type: 'string' } }) },
      run: async () => textResult({ count: counts.people ?? 2, total: counts.people ?? 2, interpretation }),
    },
  ];
}

export async function makeToolbox(options: { mcp?: FakeMcp; localTools?: LocalTool[]; limits?: Partial<Limits>; ledger?: Ledger } = {}) {
  const mcp = options.mcp ?? fakeMcp();
  const ledger = options.ledger ?? new Ledger();
  const toolbox = await Toolbox.create({
    mcp,
    localTools: options.localTools ?? fakeCountTools(),
    ledger,
    limits: { ...LIMITS, ...options.limits },
  });
  return { toolbox, mcp, ledger };
}
