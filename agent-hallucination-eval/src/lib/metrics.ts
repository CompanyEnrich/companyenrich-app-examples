import { grade, type Grade } from './match.ts';
import type { RunRecord } from './types.ts';

export interface ScoredRow {
  /** The run label, usually the run file name such as `oracle-2026-11-11`. */
  run: string;
  field: string;
  grade: Grade | 'error';
  confidence: number | null;
}

export interface Metrics {
  /** Graded answers. Rows that errored are counted in `errors` and left out of every rate. */
  n: number;
  correct: number;
  partial: number;
  hallucinated: number;
  abstained: number;
  errors: number;
  accuracy: number;
  partialRate: number;
  /** Wrong while not "unknown". With accuracy, partial and abstention this sums to 1. */
  hallucinationRate: number;
  abstentionRate: number;
  /** Mean self-reported confidence on hallucinated answers, when the adapter reports confidence. */
  confidenceWhenWrong: number | null;
}

export function scoreRecords(run: string, records: RunRecord[]): ScoredRow[] {
  return records.map((record) => ({
    run,
    field: record.question.field,
    grade: record.answer && !record.error ? grade(record.question, record.answer) : 'error',
    confidence: record.answer?.confidence ?? null,
  }));
}

const rate = (count: number, n: number) => (n === 0 ? 0 : count / n);

export function computeMetrics(rows: ScoredRow[]): Metrics {
  const count = (g: ScoredRow['grade']) => rows.filter((row) => row.grade === g).length;
  const correct = count('correct');
  const partial = count('partial');
  const hallucinated = count('wrong');
  const abstained = count('abstained');
  const n = correct + partial + hallucinated + abstained;

  const wrongConfidences = rows
    .filter((row) => row.grade === 'wrong' && row.confidence !== null)
    .map((row) => row.confidence!);

  return {
    n,
    correct,
    partial,
    hallucinated,
    abstained,
    errors: count('error'),
    accuracy: rate(correct, n),
    partialRate: rate(partial, n),
    hallucinationRate: rate(hallucinated, n),
    abstentionRate: rate(abstained, n),
    confidenceWhenWrong:
      wrongConfidences.length === 0 ? null : wrongConfidences.reduce((a, b) => a + b, 0) / wrongConfidences.length,
  };
}

/** Groups rows by a key, keeping first-seen order, and computes metrics per group. */
export function metricsBy(rows: ScoredRow[], key: (row: ScoredRow) => string): Map<string, Metrics> {
  const groups = new Map<string, ScoredRow[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return new Map([...groups].map(([k, group]) => [k, computeMetrics(group)]));
}
