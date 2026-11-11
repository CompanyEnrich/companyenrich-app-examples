import {
  cleanAnswer,
  employeeRangeIndex,
  isAbstention,
  normalizeCity,
  normalizeCountry,
  normalizeFundingStage,
  normalizeIndustry,
  parseCategories,
  parseInterval,
  parseYear,
  revenueRangeIndex,
} from './normalize.ts';
import type { Answer, Gold, Question } from './types.ts';

/** `wrong` is a hallucination: a confident answer that does not match the gold value. */
export type Grade = 'correct' | 'partial' | 'wrong' | 'abstained';

/** Money answers within this fraction of the gold amount count as correct. */
const MONEY_TOLERANCE = 0.25;

/** Renders a gold value as answer text: the oracle baseline answers with exactly this. */
export function goldAsText(gold: Gold): string {
  return Array.isArray(gold) ? gold.join(', ') : String(gold);
}

function byDistance(distance: number | null): Grade {
  if (distance === null) return 'wrong';
  if (distance === 0) return 'correct';
  return distance === 1 ? 'partial' : 'wrong';
}

function indexDistance(gold: number | null, answer: number | null): number | null {
  return gold === null || answer === null ? null : Math.abs(gold - answer);
}

function sameValue<T>(gold: T | null, answer: T | null): Grade {
  return gold !== null && answer !== null && gold === answer ? 'correct' : 'wrong';
}

function overlap(gold: Set<string>, answer: Set<string>): Grade {
  const shared = [...answer].filter((item) => gold.has(item)).length;
  if (shared === 0) return 'wrong';
  return shared === gold.size && shared === answer.size ? 'correct' : 'partial';
}

/** Grades one answer: exact range bucket or year is correct, an adjacent one partial; see the README for every rule. */
export function grade(question: Question, answer: Answer): Grade {
  if (isAbstention(answer.value)) return 'abstained';
  const gold = goldAsText(question.gold);
  const value = cleanAnswer(answer.value);

  switch (question.answerType) {
    case 'employee-range':
      return byDistance(indexDistance(employeeRangeIndex(gold), employeeRangeIndex(value)));
    case 'revenue-range':
      return byDistance(indexDistance(revenueRangeIndex(gold), revenueRangeIndex(value)));
    case 'year':
      return byDistance(indexDistance(parseYear(gold), parseYear(value)));
    case 'country':
      return sameValue(normalizeCountry(gold), normalizeCountry(value));
    case 'city':
      return sameValue(normalizeCity(gold), normalizeCity(value));
    case 'industry':
      return sameValue(normalizeIndustry(gold), normalizeIndustry(value));
    case 'funding-stage':
      return sameValue(normalizeFundingStage(gold), normalizeFundingStage(value));
    case 'money': {
      // A range counts only when both ends are close: "$0-$17.6B" is not an answer to "$8.8B".
      const expected = Number(question.gold);
      const actual = parseInterval(value, { usd: true });
      const close = (amount: number) => Math.abs(amount - expected) <= MONEY_TOLERANCE * expected;
      return actual && close(actual.lo) && close(actual.hi) ? 'correct' : 'wrong';
    }
    case 'categories':
      return overlap(parseCategories(gold), parseCategories(value));
  }
}
