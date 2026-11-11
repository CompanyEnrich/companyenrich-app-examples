import type { Adapter, AdapterResult } from './adapters/types.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { describeError, isFatal } from './errors.ts';
import type { Question, RunRecord } from './types.ts';

export interface RunOptions {
  adapter: Adapter;
  questions: Question[];
  concurrency?: number;
  /** Called as each record finishes, for example to append it to the run file. */
  onRecord?: (record: RunRecord) => Promise<void> | void;
}

/** Asks the adapter every question. A failed question is recorded with its error; a fatal error stops the run. */
export async function runEval({ adapter, questions, concurrency = 4, onRecord }: RunOptions): Promise<RunRecord[]> {
  return mapWithConcurrency(questions, concurrency, async (question) => {
    const started = performance.now();
    let result: AdapterResult;
    try {
      result = await adapter.answer(question);
    } catch (error) {
      if (isFatal(error)) throw error;
      result = { answer: null, error: describeError(error), model: null, toolCalls: 0 };
    }
    const record: RunRecord = {
      adapter: adapter.name,
      model: result.model,
      question,
      answer: result.answer,
      error: result.error,
      toolCalls: result.toolCalls,
      latencyMs: Math.round(performance.now() - started),
    };
    await onRecord?.(record);
    return record;
  });
}
