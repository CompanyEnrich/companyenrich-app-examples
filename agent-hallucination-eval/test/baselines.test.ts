import { describe, expect, it } from 'vitest';
import { abstain, oracle } from '../src/lib/adapters/baselines.ts';
import type { Adapter } from '../src/lib/adapters/types.ts';
import { UsageError } from '../src/lib/errors.ts';
import { readJsonl } from '../src/lib/jsonl.ts';
import { computeMetrics, scoreRecords } from '../src/lib/metrics.ts';
import { runEval } from '../src/lib/run.ts';
import type { Question } from '../src/lib/types.ts';

const questions = await readJsonl<Question>('data/sample.jsonl');

describe('baselines end to end on data/sample.jsonl', () => {
  it('covers every answer type', () => {
    expect(new Set(questions.map((q) => q.answerType)).size).toBe(9);
  });

  it('oracle scores 100% accuracy', async () => {
    const records = await runEval({ adapter: oracle, questions });
    const m = computeMetrics(scoreRecords('oracle', records));
    expect(m).toMatchObject({ n: questions.length, accuracy: 1, hallucinationRate: 0, abstentionRate: 0, errors: 0 });
  });

  it('abstain scores 100% abstention and no hallucinations', async () => {
    const records = await runEval({ adapter: abstain, questions });
    const m = computeMetrics(scoreRecords('abstain', records));
    expect(m).toMatchObject({ n: questions.length, accuracy: 0, hallucinationRate: 0, abstentionRate: 1, errors: 0 });
  });

  it('writes one record per question with the question embedded', async () => {
    const records = await runEval({ adapter: oracle, questions });
    expect(records.map((r) => r.question.id)).toEqual(questions.map((q) => q.id));
    expect(records[0]).toMatchObject({ adapter: 'oracle', model: null, error: null, toolCalls: 0 });
  });
});

describe('runEval error handling', () => {
  it('records a failed question and carries on', async () => {
    const flaky: Adapter = {
      name: 'claude-closed-book',
      answer: async (q) => {
        if (q.field === 'hqCity') throw new Error('socket hang up');
        return oracle.answer(q);
      },
    };
    const records = await runEval({ adapter: flaky, questions });
    expect(records.filter((r) => r.error)).toEqual([
      expect.objectContaining({ answer: null, error: 'socket hang up' }),
    ]);
  });

  it('stops on a fatal error', async () => {
    const broken: Adapter = {
      name: 'claude-closed-book',
      answer: async () => {
        throw new UsageError('bad setup');
      },
    };
    await expect(runEval({ adapter: broken, questions })).rejects.toThrow('bad setup');
  });
});
