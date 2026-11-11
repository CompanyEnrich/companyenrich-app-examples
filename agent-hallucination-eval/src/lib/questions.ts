import type { Company } from '@companyenrich/sdk';
import type { AnswerType, Gold, Question } from './types.ts';

type EmployeeRange = NonNullable<Company['employees']>;
type RevenueRange = NonNullable<Company['revenue']>;
type Category = NonNullable<Company['categories']>[number];

// Ordered smallest to largest: adjacent buckets earn partial credit.
export const EMPLOYEE_RANGES = [
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1K',
  '1K-5K',
  '5K-10K',
  'over-10K',
] as const satisfies readonly EmployeeRange[];

export const REVENUE_RANGES = [
  'under-1m',
  '1m-10m',
  '10m-50m',
  '50m-100m',
  '100m-200m',
  '200m-1b',
  'over-1b',
] as const satisfies readonly RevenueRange[];

const CATEGORIES = [
  'b2b',
  'b2c',
  'b2g',
  'e-commerce',
  'media',
  'service-provider',
  'mobile',
  'saas',
  'local-business',
] as const satisfies readonly Category[];

/** The funding round types the search API filters on. Records can carry others, which `generate` adds. */
const BASE_FUNDING_STAGES = [
  'angel',
  'seed',
  'venture',
  'series_a',
  'series_b',
  'series_c',
  'series_d',
  'series_e',
  'series_f',
  'series_g',
  'series_h',
  'debt_financing',
  'other',
];

export interface QuestionContext {
  retrievedAt: string;
  /** Top-level industry names from the free `industries.list()` endpoint. */
  industries: string[];
  fundingStages: string[];
}

interface Template {
  field: string;
  fieldPath: string;
  answerType: AnswerType;
  gold: (company: Company) => Gold | null | undefined;
  options?: (context: QuestionContext) => readonly string[];
  ask: (subject: string, options: readonly string[]) => string;
}

// Semicolons, because some options contain commas ("Energy, Utilities & Waste").
const oneOf = (options: readonly string[]) => `Answer with exactly one of: ${options.join('; ')}.`;

/** Stage labels that mean "not known", so they make no sense as a gold answer. */
const UNINFORMATIVE_STAGES = ['undisclosed', 'series_unknown'];

/** Total funding under this amount is treated as missing. */
const MIN_PLAUSIBLE_FUNDING_USD = 1_000;

function informativeStage(stage: string | null | undefined): string | null {
  return stage && !UNINFORMATIVE_STAGES.includes(stage) ? stage : null;
}

function plausibleFunding(amount: number | null | undefined): number | null {
  return amount && amount >= MIN_PLAUSIBLE_FUNDING_USD ? amount : null;
}

/**
 * One template per field. Only fields whose answer changes slowly are asked about:
 * an eval over fast-moving facts would mostly measure how stale the model's training data is.
 */
export const TEMPLATES: Template[] = [
  {
    field: 'employees',
    fieldPath: 'employees',
    answerType: 'employee-range',
    gold: (c) => c.employees,
    options: () => EMPLOYEE_RANGES,
    ask: (s, o) => `How many employees does ${s} have? ${oneOf(o)}`,
  },
  {
    field: 'revenue',
    fieldPath: 'revenue',
    answerType: 'revenue-range',
    gold: (c) => c.revenue,
    options: () => REVENUE_RANGES,
    ask: (s, o) => `What is the annual revenue of ${s} in US dollars? ${oneOf(o)}`,
  },
  {
    field: 'foundedYear',
    fieldPath: 'foundedYear',
    answerType: 'year',
    gold: (c) => c.foundedYear,
    ask: (s) => `In what year was ${s} founded? Answer with a four-digit year.`,
  },
  {
    field: 'hqCountry',
    fieldPath: 'location.country.code',
    answerType: 'country',
    gold: (c) => c.location?.country?.code,
    ask: (s) => `In which country is ${s} headquartered? Answer with the country name.`,
  },
  {
    field: 'hqCity',
    fieldPath: 'location.city.name',
    answerType: 'city',
    gold: (c) => c.location?.city?.name,
    ask: (s) => `In which city is ${s} headquartered? Answer with the city name only.`,
  },
  {
    field: 'industry',
    fieldPath: 'industry',
    answerType: 'industry',
    gold: (c) => c.industry,
    options: (ctx) => ctx.industries,
    ask: (s, o) => `What is the primary industry of ${s}? ${oneOf(o)}`,
  },
  {
    field: 'fundingStage',
    fieldPath: 'financial.fundingStage',
    answerType: 'funding-stage',
    gold: (c) => informativeStage(c.financial?.fundingStage),
    options: (ctx) => ctx.fundingStages,
    ask: (s, o) => `What is the latest funding stage of ${s}? ${oneOf(o)}`,
  },
  {
    field: 'totalFunding',
    fieldPath: 'financial.totalFunding',
    answerType: 'money',
    gold: (c) => plausibleFunding(c.financial?.totalFunding),
    ask: (s) =>
      `How much disclosed funding has ${s} raised in total, in US dollars? Answer with a plain number, for example 25000000.`,
  },
  {
    field: 'categories',
    fieldPath: 'categories',
    answerType: 'categories',
    gold: (c) => c.categories,
    options: () => CATEGORIES,
    ask: (s, o) =>
      `Which of these business categories apply to ${s}: ${o.join('; ')}? Answer with a comma-separated list.`,
  },
];

function hasValue(gold: Gold | null | undefined): gold is Gold {
  if (gold === null || gold === undefined) return false;
  if (typeof gold === 'string') return gold.trim() !== '';
  if (Array.isArray(gold)) return gold.length > 0;
  return gold > 0;
}

/** Turns one enriched company into questions, skipping every field whose gold value is missing. */
export function buildQuestions(company: Company, context: QuestionContext): Question[] {
  const name = company.name ?? company.domain;
  const subject = `${name} (${company.domain})`;
  const questions: Question[] = [];

  for (const template of TEMPLATES) {
    const gold = template.gold(company);
    if (!hasValue(gold)) continue;
    const options = template.options?.(context);
    questions.push({
      id: `${company.domain}#${template.field}`,
      domain: company.domain,
      company: name,
      field: template.field,
      fieldPath: template.fieldPath,
      answerType: template.answerType,
      question: template.ask(subject, options ?? []),
      ...(options ? { options: [...options] } : {}),
      gold: Array.isArray(gold) ? [...gold] : gold,
      retrievedAt: context.retrievedAt,
      sourceUpdatedAt: company.updatedAt,
    });
  }
  return questions;
}

/** Standard stages first, then any other stage seen in the records, so every gold value is a listed option. */
export function fundingStageOptions(companies: Company[]): string[] {
  const seen = companies
    .map((c) => informativeStage(c.financial?.fundingStage))
    .filter((stage): stage is string => stage !== null && stage.trim() !== '');
  const extra = [...new Set(seen)].filter((stage) => !BASE_FUNDING_STAGES.includes(stage)).sort();
  return [...BASE_FUNDING_STAGES, ...extra];
}

/** Keeps top-level industries only ("Finance", not "Finance/Credit Cards & Transaction Processing"). */
export function topLevelIndustries(names: string[]): string[] {
  return [...new Set(names.filter((name) => !name.includes('/')))].sort();
}
