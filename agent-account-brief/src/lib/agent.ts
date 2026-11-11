import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Target } from './input';
import type { Depth } from './pipeline';
import {
  DEPARTMENTS,
  MAX_RESULTS,
  SENIORITIES,
  enrichCompany,
  findLookalikes,
  findPeople,
  getWorkforce,
  lookupPersonByEmail,
  type ToolContext,
  type ToolOutcome,
} from './tools';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Upper bound on model requests in one run. A brief needs 3 to 8. */
const MAX_TURNS = 15;

export class AgentError extends Error {
  override name = 'AgentError';
}

// Kept free of run-specific values (date, budget, domain) so the prompt prefix is identical,
// and cacheable, across runs. Those go in the user message.
export const SYSTEM_PROMPT = `You research one B2B company and write a one-page account brief for a salesperson. Your only source is the CompanyEnrich tools you are given. You cannot browse the web.

Rules:
- Use only facts that appear in tool results. Do not add anything from your own knowledge of the company, even if you are confident.
- Cite the field path right after every fact, in square brackets, for example "Series B [company.financial.fundingStage]". A path starts at a top-level key of a tool result (company, workforce, people, lookalikes, person) and follows the JSON keys. Array indexes are optional: [people.seniority] or [people[0].seniority]. Put one path in each bracket.
- If a fact is not in the tool results, write "not available". Never guess or estimate.
- Ground every observation and talking point in cited facts, and cite the fields it rests on.
- Every tool call spends credits from a fixed budget, and each result reports creditsRemaining. If a tool returns "budget exceeded", do not retry it: write the brief with what you have and say what is missing.
- Stay within the requested depth. Do not make calls the depth does not ask for.

Depth:
- quick: enrich_company with include_funding=true, then find_people for up to 3 leaders with seniority c-suite, founder and vp. Nothing else.
- full: enrich_company with include_funding=true and include_tech=true; get_workforce; find_people for up to 3 executives (seniority c-suite, founder, vp; exclude_department sales, engineering-technical, marketing) and up to 2 leaders each in sales, engineering-technical and marketing (seniority vp, head, director); find_lookalikes with limit 3.

Output: reply with only the Markdown brief, no preamble, using these sections in this order:
# Account brief: <company name> (<domain>)
## Snapshot (name, domain, industry, size range, revenue range, founded, HQ)
## Funding
## Team and growth
## People to talk to (for each person: name, role, title, seniority, tenure, LinkedIn URL; take title, role and seniority from people.experiences, which describes the role at this company)
## Lookalikes (full depth only: name, domain and score in the order returned; scores are not probabilities)
## Observations and talking points
Do not write Sources or Credits sections. The application adds them from its own tool log.`;

export interface AgentOptions {
  anthropic: Anthropic;
  ctx: ToolContext;
  target: Target;
  depth: Depth;
  model?: string;
  today: string;
}

/** Runs Claude with the CompanyEnrich tools until it returns the brief. Returns the brief body as Markdown. */
export async function runAgent(options: AgentOptions): Promise<string> {
  const { anthropic, ctx, target, depth, today } = options;

  // Errors the model can act on (nothing found, budget exceeded) go back to it as tool errors.
  // Anything else (bad key, out of credits) aborts the loop and is rethrown here.
  const controller = new AbortController();
  let fatal: unknown;
  const respond = async <T>(pending: Promise<ToolOutcome<T>>): Promise<string> => {
    let outcome: ToolOutcome<T>;
    try {
      outcome = await pending;
    } catch (error) {
      fatal ??= error;
      controller.abort();
      throw error;
    }
    // Thrown errors become is_error tool results. Agent mode never runs dry, so 'dry-run' cannot occur here.
    if (outcome.status !== 'ok') throw new Error(outcome.status === 'error' ? outcome.error : 'dry run: no data');
    return JSON.stringify({ ...outcome.data, creditsRemaining: ctx.budget.remaining });
  };

  const runner = anthropic.beta.messages.toolRunner(
    {
      model: options.model ?? DEFAULT_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      // Server-side refusal fallback: a declined request is retried on Anthropic's recommended model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      tools: accountTools(ctx, respond),
      messages: [{ role: 'user', content: userPrompt(target, depth, ctx.budget.maxCredits, today) }],
      max_iterations: MAX_TURNS,
    },
    { signal: controller.signal },
  );

  let message;
  try {
    message = await runner.runUntilDone();
  } catch (error) {
    throw fatal ?? error;
  }

  switch (message.stop_reason) {
    case 'end_turn':
      break;
    case 'refusal':
      throw new AgentError('Claude declined to write this brief (stop_reason: refusal). Try --mode pipeline.');
    case 'max_tokens':
      throw new AgentError('The brief was cut off at max_tokens. Try again, or use --mode pipeline.');
    default:
      throw new AgentError(
        `The agent stopped before finishing (stop_reason: ${message.stop_reason}; limit ${MAX_TURNS} turns). Try --mode pipeline.`,
      );
  }

  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  if (!text) throw new AgentError('The agent finished without writing a brief.');
  return text;
}

type Respond = <T>(pending: Promise<ToolOutcome<T>>) => Promise<string>;

/** The five tools, each a thin wrapper over the shared functions in tools.ts. */
export function accountTools(ctx: ToolContext, respond: Respond) {
  const domain = z.string().describe('Company domain, for example stripe.com');
  return [
    betaZodTool({
      name: 'enrich_company',
      description:
        'Company profile: name, description, industry, size and revenue ranges, founded year, HQ. Call it first for the account. ' +
        'Costs 1 credit, plus 1 for include_funding (company.financial: stage, date, total, rounds, stock symbol) and 1 for include_tech (company.technologies).',
      inputSchema: z.object({
        domain,
        include_funding: z.boolean().optional().describe('Add funding and listing data (+1 credit).'),
        include_tech: z.boolean().optional().describe('Add the tracked technology list (+1 credit).'),
      }),
      run: (input) =>
        respond(enrichCompany(ctx, { domain: input.domain, includeFunding: input.include_funding, includeTech: input.include_tech })),
    }),
    betaZodTool({
      name: 'get_workforce',
      description:
        'Observed headcount, headcount by department with each share, and the 12-month change (overall and by department) computed from monthly history. ' +
        'Observed headcount counts people visible in the people data, not an official figure. Costs 1 credit.',
      inputSchema: z.object({ domain }),
      run: (input) => respond(getWorkforce(ctx, { domain: input.domain })),
    }),
    betaZodTool({
      name: 'find_people',
      description:
        'Current employees of a company filtered by seniority and department, with title, department, tenure and LinkedIn URL. ' +
        'Runs a free count first and skips the paid search when nothing matches. Costs 2 credits per person returned.',
      inputSchema: z.object({
        domain,
        seniority: z.array(z.enum(SENIORITIES)).min(1).describe('Seniority levels to include.'),
        department: z
          .array(z.enum(DEPARTMENTS))
          .describe('Departments to include; each includes its sub-departments. Use [] for any department.'),
        exclude_department: z
          .array(z.enum(DEPARTMENTS))
          .optional()
          .describe('Departments to leave out, for example ones another find_people call covers, so no person is paid for twice.'),
        position: z.array(z.string()).optional().describe('Title phrases to match, for example ["revenue operations"].'),
        limit: z.number().int().min(1).max(MAX_RESULTS).describe(`People to return, 1 to ${MAX_RESULTS}.`),
      }),
      run: (input) =>
        respond(
          findPeople(ctx, {
            domain: input.domain,
            seniority: input.seniority,
            department: input.department,
            excludeDepartment: input.exclude_department,
            position: input.position,
            limit: input.limit,
          }),
        ),
    }),
    betaZodTool({
      name: 'find_lookalikes',
      description:
        'Companies most similar to the given one, in ranked order with a similarity score (not a probability). ' +
        'Runs a free count first. Costs 5 credits per company returned.',
      inputSchema: z.object({
        domain,
        limit: z.number().int().min(1).max(MAX_RESULTS).describe(`Companies to return, 1 to ${MAX_RESULTS}.`),
      }),
      run: (input) => respond(findLookalikes(ctx, { domain: input.domain, limit: input.limit })),
    }),
    betaZodTool({
      name: 'lookup_person_by_email',
      description:
        'Finds the person behind a work email, with their current role and company (person.experiences[].company.domain). ' +
        'Use it only when the input is an email. Costs 5 credits when a person is found.',
      inputSchema: z.object({ email: z.string().describe('Work email address.') }),
      run: (input) => respond(lookupPersonByEmail(ctx, { email: input.email })),
    }),
  ];
}

function userPrompt(target: Target, depth: Depth, maxCredits: number, today: string): string {
  const subject =
    target.kind === 'domain'
      ? `Research the company at ${target.domain}.`
      : `The input is an email address: ${target.email}. Call lookup_person_by_email first, then research the company of that person's current role. List that person first under People to talk to.`;
  return `${subject}\nDepth: ${depth}\nCredit budget for this run: ${maxCredits} credits\nToday's date: ${today}`;
}
