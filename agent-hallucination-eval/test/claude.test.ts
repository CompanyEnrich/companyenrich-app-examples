import { describe, expect, it } from 'vitest';
import { claudeClosedBook, claudeWithCompanyEnrich, CLOSED_BOOK_SYSTEM } from '../src/lib/adapters/claude.ts';
import { CompanyLookup } from '../src/lib/adapters/company-lookup.ts';
import { runEval } from '../src/lib/run.ts';
import type { Question } from '../src/lib/types.ts';
import { answerText, fakeAnthropic, fakeCompanyEnrich, jsonResponse } from './fakes.ts';
import { stripe } from './fixtures.ts';

const question: Question = {
  id: 'stripe.com#foundedYear',
  domain: 'stripe.com',
  company: 'Stripe',
  field: 'foundedYear',
  fieldPath: 'foundedYear',
  answerType: 'year',
  question: 'In what year was Stripe (stripe.com) founded? Answer with a four-digit year.',
  gold: 2010,
  retrievedAt: '2026-11-11',
  sourceUpdatedAt: stripe.updatedAt,
};

const toolCall = (domain: string, id = 'toolu_1') => ({
  content: [{ type: 'tool_use' as const, id, name: 'enrich_company', input: { domain }, caller: { type: 'direct' as const } }],
  stop_reason: 'tool_use' as const,
});

describe('claude-closed-book', () => {
  it('sends a structured-output request with explicit effort and the refusal fallback, and no tools', async () => {
    const { client, requests } = fakeAnthropic([answerText('2010', 0.95)]);
    const adapter = claudeClosedBook({ client, model: 'claude-opus-5-5', effort: 'medium' });

    const result = await adapter.answer(question);

    expect(result).toEqual({
      answer: { value: '2010', confidence: 0.95 },
      error: null,
      model: 'claude-opus-5-5',
      toolCalls: 0,
    });
    const [request] = requests;
    expect(request?.path).toBe('/v1/messages');
    expect(request?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(request?.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      system: CLOSED_BOOK_SYSTEM,
      messages: [{ role: 'user', content: question.question }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(Object.keys(request?.body.output_config.format.schema.properties)).toEqual(['answer', 'confidence']);
    expect(request?.body).not.toHaveProperty('tools');
    expect(request?.body).not.toHaveProperty('thinking');
    expect(request?.body).not.toHaveProperty('temperature');
  });

  it('records a refusal as an error instead of reading the content', async () => {
    const { client } = fakeAnthropic([
      {
        content: [],
        stop_reason: 'refusal',
        stop_details: {
          type: 'refusal',
          category: 'cyber',
          explanation: 'declined',
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        },
      },
    ]);
    const result = await claudeClosedBook({ client, model: 'claude-opus-5-5', effort: 'low' }).answer(question);
    expect(result.answer).toBeNull();
    expect(result.error).toBe('refused (cyber)');
  });

  it('records output that is not valid JSON, or not the schema, as an error', async () => {
    const { client } = fakeAnthropic([
      { content: [{ type: 'text', text: 'It was 2010.', citations: null }], stop_reason: 'end_turn' },
      answerText('2010', 7),
    ]);
    const adapter = claudeClosedBook({ client, model: 'claude-opus-5-5', effort: 'low' });
    expect((await adapter.answer(question)).error).toBe('the response was not valid JSON');
    expect((await adapter.answer(question)).error).toBe('the response did not match the answer schema');
  });

  it('records a response cut off at max_tokens as an error', async () => {
    const { client } = fakeAnthropic([{ content: [], stop_reason: 'max_tokens' }]);
    const result = await claudeClosedBook({ client, model: 'claude-opus-5-5', effort: 'low' }).answer(question);
    expect(result.error).toBe('stopped with stop_reason max_tokens');
  });
});

describe('claude-with-companyenrich', () => {
  function companyEnrich(status = 200) {
    return fakeCompanyEnrich({
      'GET /v2/companies/enrich': () => (status === 200 ? jsonResponse(stripe) : jsonResponse({ title: 'Unauthorized' }, status)),
    });
  }

  it('calls enrich_company, sends the record back to Claude and reads the final answer', async () => {
    const ce = companyEnrich();
    const { client, requests } = fakeAnthropic([toolCall('stripe.com'), answerText('2010', 0.99)]);
    const lookup = new CompanyLookup(ce.client, { maxCredits: 10 });
    const adapter = claudeWithCompanyEnrich({ client, model: 'claude-opus-5-5', effort: 'medium', lookup });

    const result = await adapter.answer(question);

    expect(result).toEqual({
      answer: { value: '2010', confidence: 0.99 },
      error: null,
      model: 'claude-opus-5-5',
      toolCalls: 1,
    });
    expect(requests[0]?.body.tools).toEqual([expect.objectContaining({ name: 'enrich_company', strict: true })]);
    expect(requests[0]?.body).toMatchObject({ fallbacks: 'default', output_config: { effort: 'medium' } });

    const toolResult = requests[1]?.body.messages
      .flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []))
      .find((block: { type: string }) => block.type === 'tool_result');
    expect(toolResult).toMatchObject({ tool_use_id: 'toolu_1' });
    expect(JSON.parse(toolResult.content)).toMatchObject({ found: true, foundedYear: 2010 });

    expect(ce.requests).toHaveLength(1);
    expect(ce.requests[0]?.query.get('domain')).toBe('stripe.com');
    expect(ce.requests[0]?.query.getAll('expand')).toEqual(['financial']);
    expect(lookup.creditsSpent).toBe(2);
  });

  it('looks each domain up once across questions', async () => {
    const ce = companyEnrich();
    const { client } = fakeAnthropic([
      toolCall('stripe.com', 'toolu_1'),
      answerText('2010', 0.9),
      toolCall('https://www.stripe.com', 'toolu_2'),
      answerText('San Francisco', 0.9),
    ]);
    const lookup = new CompanyLookup(ce.client, { maxCredits: 10 });
    const adapter = claudeWithCompanyEnrich({ client, model: 'claude-opus-5-5', effort: 'low', lookup });

    await runEval({ adapter, questions: [question, { ...question, id: 'stripe.com#hqCity' }], concurrency: 1 });

    expect(ce.requests).toHaveLength(1);
    expect(lookup.creditsSpent).toBe(2);
  });

  it('stops the whole run when the CompanyEnrich key is rejected', async () => {
    const ce = companyEnrich(401);
    const { client } = fakeAnthropic([toolCall('stripe.com'), answerText('unknown', 0)]);
    const adapter = claudeWithCompanyEnrich({
      client,
      model: 'claude-opus-5-5',
      effort: 'low',
      lookup: new CompanyLookup(ce.client, { maxCredits: 10 }),
    });
    await expect(runEval({ adapter, questions: [question] })).rejects.toThrow('Unauthorized');
  });

  it('keeps paid lookups at 4 in flight when 4 questions each make 3 parallel tool calls', async () => {
    let inFlight = 0;
    let peak = 0;
    const ce = fakeCompanyEnrich({
      'GET /v2/companies/enrich': async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return jsonResponse({ ...stripe, domain: request.query.get('domain') });
      },
    });
    // First turn: three tool calls on domains unique to the question. Second turn: the answer.
    const { client } = fakeAnthropic((body) => {
      const answered = JSON.stringify(body.messages).includes('tool_result');
      if (answered) return answerText('2010', 0.9);
      const id = /q(\d)\.example/.exec(JSON.stringify(body.messages))![1];
      return {
        content: [1, 2, 3].map((n) => ({
          type: 'tool_use' as const,
          id: `toolu_${id}_${n}`,
          name: 'enrich_company',
          input: { domain: `d${n}.q${id}.example` },
          caller: { type: 'direct' as const },
        })),
        stop_reason: 'tool_use',
      };
    });
    const lookup = new CompanyLookup(ce.client, { maxCredits: 100 });
    const adapter = claudeWithCompanyEnrich({ client, model: 'claude-opus-5-5', effort: 'low', lookup });
    const questions = [1, 2, 3, 4].map((n) => ({ ...question, id: `q${n}`, question: `When was q${n}.example founded?` }));

    const records = await runEval({ adapter, questions, concurrency: 4 });

    expect(records.every((r) => r.toolCalls === 3 && r.error === null)).toBe(true);
    expect(ce.requests).toHaveLength(12);
    expect(peak).toBe(4);
  });
});
