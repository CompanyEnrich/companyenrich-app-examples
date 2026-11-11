import { describe, expect, it } from 'vitest';
import { computeMetrics, metricsBy, scoreRecords, type ScoredRow } from '../src/lib/metrics.ts';
import { renderReport } from '../src/lib/report.ts';
import type { RunRecord } from '../src/lib/types.ts';

const row = (grade: ScoredRow['grade'], confidence: number | null = null, field = 'foundedYear'): ScoredRow => ({
  run: 'test-run',
  field,
  grade,
  confidence,
});

describe('computeMetrics', () => {
  it('computes each rate over graded answers, leaving errors out', () => {
    const m = computeMetrics([
      row('correct'),
      row('correct'),
      row('partial'),
      row('wrong', 0.9),
      row('wrong', 0.5),
      row('abstained'),
      row('abstained'),
      row('abstained'),
      row('error'),
    ]);
    expect(m).toEqual({
      n: 8,
      correct: 2,
      partial: 1,
      hallucinated: 2,
      abstained: 3,
      errors: 1,
      accuracy: 0.25,
      partialRate: 0.125,
      hallucinationRate: 0.25,
      abstentionRate: 0.375,
      confidenceWhenWrong: 0.7,
    });
    expect(m.accuracy + m.partialRate + m.hallucinationRate + m.abstentionRate).toBeCloseTo(1);
  });

  it('returns zero rates and no confidence for an empty group', () => {
    const m = computeMetrics([row('error')]);
    expect(m.n).toBe(0);
    expect(m.accuracy).toBe(0);
    expect(m.confidenceWhenWrong).toBeNull();
  });

  it('ignores missing confidence when averaging', () => {
    expect(computeMetrics([row('wrong', null), row('wrong', 0.4)]).confidenceWhenWrong).toBe(0.4);
  });

  it('groups by any key in first-seen order', () => {
    const grouped = metricsBy([row('correct', null, 'b'), row('wrong', null, 'a'), row('correct', null, 'b')], (r) => r.field);
    expect([...grouped.keys()]).toEqual(['b', 'a']);
    expect(grouped.get('b')?.accuracy).toBe(1);
  });
});

describe('scoreRecords', () => {
  const base: Omit<RunRecord, 'answer' | 'error'> = {
    adapter: 'claude-closed-book',
    model: 'claude-opus-5-5',
    toolCalls: 0,
    latencyMs: 10,
    question: {
      id: 'stripe.com#foundedYear',
      domain: 'stripe.com',
      company: 'Stripe',
      field: 'foundedYear',
      fieldPath: 'foundedYear',
      answerType: 'year',
      question: 'In what year was Stripe (stripe.com) founded?',
      gold: 2010,
      retrievedAt: '2026-11-11',
      sourceUpdatedAt: '2026-11-06T19:56:30Z',
    },
  };

  it('grades answers and marks failed questions as errors', () => {
    const rows = scoreRecords('run-a', [
      { ...base, answer: { value: '2011', confidence: 0.6 }, error: null },
      { ...base, answer: null, error: 'refused (cyber)' },
    ]);
    expect(rows).toEqual([
      { run: 'run-a', field: 'foundedYear', grade: 'partial', confidence: 0.6 },
      { run: 'run-a', field: 'foundedYear', grade: 'error', confidence: null },
    ]);
  });
});

describe('renderReport', () => {
  it('writes an overall table, field matrices and one table per run', () => {
    const rows: ScoredRow[] = [
      { run: 'oracle-2026-11-11', field: 'foundedYear', grade: 'correct', confidence: 1 },
      { run: 'abstain-2026-11-11', field: 'foundedYear', grade: 'abstained', confidence: 0 },
    ];
    const report = renderReport(rows, ['runs/oracle-2026-11-11.jsonl', 'runs/abstain-2026-11-11.jsonl'], '2026-11-11');
    expect(report).toContain('| oracle-2026-11-11 | 1 | 100.0% | 0.0% | 0.0% | 0.0% | - | 0 |');
    expect(report).toContain('| abstain-2026-11-11 | 1 | 0.0% | 0.0% | 0.0% | 100.0% | - | 0 |');
    expect(report).toContain('| Field | oracle-2026-11-11 | abstain-2026-11-11 |');
    expect(report).toContain('## oracle-2026-11-11 by field');
  });
});
