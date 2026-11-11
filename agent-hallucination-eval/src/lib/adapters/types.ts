import type { Answer, Question } from '../types.ts';

export const ADAPTER_NAMES = ['claude-closed-book', 'claude-with-companyenrich', 'oracle', 'abstain'] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export interface AdapterResult {
  answer: Answer | null;
  error: string | null;
  /** The model that answered, or null for the baselines. */
  model: string | null;
  toolCalls: number;
}

/** Anything that can answer an eval question. */
export interface Adapter {
  name: AdapterName;
  answer(question: Question): Promise<AdapterResult>;
}
