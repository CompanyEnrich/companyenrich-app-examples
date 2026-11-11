/** How an answer is normalized and matched against the gold value. */
export type AnswerType =
  | 'employee-range'
  | 'revenue-range'
  | 'year'
  | 'country'
  | 'city'
  | 'industry'
  | 'funding-stage'
  | 'money'
  | 'categories';

export type Gold = string | number | string[];

/** One eval question with its gold answer, as stored in `data/*.jsonl`. */
export interface Question {
  /** Stable id: `<domain>#<field>`. */
  id: string;
  domain: string;
  company: string;
  /** Short field name used in reports, e.g. `hqCity`. */
  field: string;
  /** Where the gold value lives in the CompanyEnrich company record. */
  fieldPath: string;
  answerType: AnswerType;
  question: string;
  /** Allowed answers, when the question is multiple choice. */
  options?: string[];
  gold: Gold;
  /** The day the gold value was fetched (YYYY-MM-DD). */
  retrievedAt: string;
  /** The record's own `updatedAt`, so stale gold can be spotted later. */
  sourceUpdatedAt: string;
}

/** What an adapter returns for one question. */
export interface Answer {
  /** The answer text, or "unknown". */
  value: string;
  /** Self-reported probability that the answer is correct, when the adapter gives one. */
  confidence: number | null;
}

/** One line of `runs/<adapter>-<date>.jsonl`. It embeds the question so scoring needs nothing else. */
export interface RunRecord {
  adapter: string;
  /** The model that actually answered (it can differ from the requested one after a fallback). */
  model: string | null;
  question: Question;
  answer: Answer | null;
  /** Set when no answer could be produced (refusal, API error, unparseable output). */
  error: string | null;
  toolCalls: number;
  latencyMs: number;
}
