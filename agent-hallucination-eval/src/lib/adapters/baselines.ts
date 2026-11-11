import { goldAsText } from '../match.ts';
import type { Adapter } from './types.ts';

/** Reads the gold answer. It should score 100%: anything less is a bug in the matchers. */
export const oracle: Adapter = {
  name: 'oracle',
  answer: async (question) => ({
    answer: { value: goldAsText(question.gold), confidence: 1 },
    error: null,
    model: null,
    toolCalls: 0,
  }),
};

/** Always says "unknown". It should score 100% abstention and 0% hallucination. */
export const abstain: Adapter = {
  name: 'abstain',
  answer: async () => ({
    answer: { value: 'unknown', confidence: 0 },
    error: null,
    model: null,
    toolCalls: 0,
  }),
};
