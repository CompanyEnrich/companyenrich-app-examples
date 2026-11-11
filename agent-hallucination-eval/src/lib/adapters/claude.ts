import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat, betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Question } from '../types.ts';
import type { CompanyLookup } from './company-lookup.ts';
import type { Adapter, AdapterResult } from './types.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The structured answer every Claude adapter must return. */
const AnswerSchema = z.object({
  answer: z.string().describe('The answer in the format the question asks for, or exactly "unknown".'),
  confidence: z.number().min(0).max(1).describe('Your probability, from 0 to 1, that the answer is correct.'),
});

export interface ClaudeOptions {
  client: Anthropic;
  model: string;
  effort: Effort;
}

const ANSWER_RULES = `Reply with JSON: "answer" in the format the question asks for, or exactly "unknown" if you do not know, and "confidence", your probability from 0 to 1 that the answer is correct.
A wrong answer counts against you and "unknown" does not, so answer "unknown" rather than guess.`;

export const CLOSED_BOOK_SYSTEM = `You answer factual questions about real companies from your own knowledge. You have no tools and no internet access.
${ANSWER_RULES}`;

const GROUNDED_SYSTEM = `You answer factual questions about real companies. You have one tool, enrich_company, which returns the CompanyEnrich record for a company domain.
Call enrich_company with the domain given in the question before you answer, and base your answer on the record. If the record does not contain the fact, answer from your own knowledge only if you are sure, otherwise answer "unknown".
${ANSWER_RULES}`;

/** Request fields shared by both adapters: structured output, explicit effort, and the server-side refusal fallback. */
function requestParams(options: ClaudeOptions, system: string, question: Question) {
  return {
    model: options.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
    output_config: { effort: options.effort, format: betaZodOutputFormat(AnswerSchema) },
    system,
    messages: [{ role: 'user' as const, content: question.question }],
  };
}

/** Checks why the model stopped before reading its answer, then validates the JSON against the schema. */
function readAnswer(message: Anthropic.Beta.BetaMessage): Pick<AdapterResult, 'answer' | 'error'> {
  if (message.stop_reason === 'refusal') {
    return { answer: null, error: `refused (${message.stop_details?.category ?? 'no category'})` };
  }
  if (message.stop_reason !== 'end_turn') {
    return { answer: null, error: `stopped with stop_reason ${message.stop_reason}` };
  }
  const text = message.content.findLast((block) => block.type === 'text');
  if (!text || text.type !== 'text') return { answer: null, error: 'no text in the response' };

  let json: unknown;
  try {
    json = JSON.parse(text.text);
  } catch {
    return { answer: null, error: 'the response was not valid JSON' };
  }
  const parsed = AnswerSchema.safeParse(json);
  if (!parsed.success) return { answer: null, error: 'the response did not match the answer schema' };
  return { answer: { value: parsed.data.answer.trim(), confidence: parsed.data.confidence }, error: null };
}

/** Claude with no tools: what the model believes from training data alone. */
export function claudeClosedBook(options: ClaudeOptions): Adapter {
  return {
    name: 'claude-closed-book',
    async answer(question) {
      const message = await options.client.beta.messages.create(requestParams(options, CLOSED_BOOK_SYSTEM, question));
      return { ...readAnswer(message), model: message.model, toolCalls: 0 };
    },
  };
}

/** The same model with an `enrich_company` tool backed by the CompanyEnrich SDK. */
export function claudeWithCompanyEnrich(options: ClaudeOptions & { lookup: CompanyLookup }): Adapter {
  return {
    name: 'claude-with-companyenrich',
    async answer(question) {
      let toolCalls = 0;
      const enrichCompany = betaZodTool({
        name: 'enrich_company',
        description:
          'Look up a company by its website domain and get its CompanyEnrich record: employee range, revenue range, founding year, ' +
          'headquarters, primary industry, business categories and funding. Call it before answering any question about a company, ' +
          'with the domain given in the question.',
        inputSchema: z.object({ domain: z.string().describe('The company website domain, for example stripe.com') }),
        strict: true,
        run: async ({ domain }) => {
          toolCalls += 1;
          return options.lookup.lookup(domain);
        },
      });

      const message = await options.client.beta.messages.toolRunner({
        ...requestParams(options, GROUNDED_SYSTEM, question),
        tools: [enrichCompany],
        max_iterations: 4,
      });
      // A bad key or an empty balance would fail every later lookup too; stop the run instead.
      if (options.lookup.fatal) throw options.lookup.fatal;
      return { ...readAnswer(message), model: message.model, toolCalls };
    },
  };
}
