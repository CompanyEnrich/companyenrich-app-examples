import type { CompanyEnrich, CompanySearchQuery, PersonSearchQuery } from '@companyenrich/sdk';
import { describeError } from './errors.js';
import { errorResult, textResult, type LocalTool, type ToolResult } from './toolbox.js';

/**
 * Free count tools, built on the CompanyEnrich SDK.
 *
 * The MCP server leaves count helpers out on purpose, but a free count before every
 * paid search is the core of this bot's cost safety, so these two tools run in-process
 * against the v2 count endpoints. Their `interpretation` shows how the API read a
 * plain-English question, in the same filter vocabulary the MCP search tools accept.
 */
export function countTools(sdk: CompanyEnrich): LocalTool[] {
  return [
    {
      definition: {
        name: 'count_companies',
        description:
          'Count companies for free. Pass either a plain-English description (semanticQuery) or seed domains (lookalikeDomains). ' +
          'Returns count, total and, for a description, the interpretation: the filters the API inferred, such as country, city ids, employee ranges and funding rounds. ' +
          'Call this before any paid company search to size it, and skip the paid search when the count is 0.',
        inputSchema: {
          type: 'object',
          properties: {
            semanticQuery: {
              type: 'string',
              description: 'Plain-English description of the companies, for example "Series B fintech startups in Berlin".',
            },
            lookalikeDomains: {
              type: 'array',
              items: { type: 'string' },
              description: 'One to ten seed company domains. Counts companies similar to them.',
            },
          },
          additionalProperties: false,
        },
      },
      run: (args) => {
        const semanticQuery = stringArg(args.semanticQuery);
        const domains = stringArrayArg(args.lookalikeDomains);
        if (Boolean(semanticQuery) === domains.length > 0) {
          return Promise.resolve(errorResult('Provide exactly one of semanticQuery or lookalikeDomains.'));
        }
        const query: CompanySearchQuery = semanticQuery
          ? { semantic: { query: semanticQuery } }
          : { lookalike: { domains: domains.slice(0, 10) } };
        return countWith(() => sdk.companies.count(query));
      },
    },
    {
      definition: {
        name: 'count_people',
        description:
          'Count people for free from a plain-English description, optionally limited to people currently at given company domains. ' +
          'Returns count, total and the interpretation: person filters (seniority, department, position, country) and, when the description mentions companies, a company query with its inferred filters. ' +
          'Call this before search_people, and reuse the interpreted values as search_people arguments.',
        inputSchema: {
          type: 'object',
          properties: {
            semanticQuery: {
              type: 'string',
              description:
                'Plain-English description of the people, for example "VPs of sales at Series B fintechs in Berlin". Must name something concrete such as a role, seniority or location.',
            },
            domains: {
              type: 'array',
              items: { type: 'string' },
              description: 'Only count people currently at these company domains.',
            },
          },
          required: ['semanticQuery'],
          additionalProperties: false,
        },
      },
      run: (args) => {
        const semanticQuery = stringArg(args.semanticQuery);
        if (!semanticQuery) return Promise.resolve(errorResult('semanticQuery is required.'));
        const domains = stringArrayArg(args.domains);
        const query: PersonSearchQuery = {
          semantic: { query: semanticQuery },
          ...(domains.length > 0 ? { filter: { domain: domains } } : {}),
        };
        return countWith(() => sdk.people.count(query));
      },
    },
  ];
}

async function countWith(
  count: () => Promise<{ count: number; total: number; interpretation?: unknown }>,
): Promise<ToolResult> {
  try {
    const { count: matches, total, interpretation } = await count();
    return textResult({ count: matches, total, ...(interpretation ? { interpretation } : {}) });
  } catch (error) {
    return errorResult(describeError(error));
  }
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArrayArg(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}
