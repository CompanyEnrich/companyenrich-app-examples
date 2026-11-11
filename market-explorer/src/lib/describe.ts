/** Plain-English chips for a filter state and for a semantic interpretation. */
import type { CompanySearchCount } from '@companyenrich/sdk';
import { fromApiFilter, type FilterState, type Range, type TermLists } from './filter';
import {
  CATEGORY_LABELS,
  EMPLOYEE_LABELS,
  FUNDING_ROUND_LABELS,
  GROWTH_DEPARTMENT_LABELS,
  GROWTH_PERIOD_LABELS,
  REVENUE_LABELS,
  TYPE_LABELS,
  type Category,
  type RevenueRange,
} from './options';

export interface Chip {
  /** What the chip constrains, e.g. "Country". */
  group: string;
  /** The value in plain words, e.g. "Germany, France". */
  text: string;
}

export type Interpretation = NonNullable<CompanySearchCount['interpretation']>;

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}

function describeRange(range: Range, format: (n: number) => string = String): string | undefined {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return min === max ? format(min) : `${format(min)} to ${format(max)}`;
  if (min !== undefined) return `${format(min)} or more`;
  if (max !== undefined) return `up to ${format(max)}`;
  return undefined;
}

function yearRange(range: Range): string | undefined {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return min === max ? String(min) : `${min}-${max}`;
  if (min !== undefined) return `${min} or later`;
  if (max !== undefined) return `${max} or earlier`;
  return undefined;
}

function termChips(group: string, lists: TermLists): Chip[] {
  const chips: Chip[] = [];
  if (lists.all.length > 0) chips.push({ group: `${group}, all of`, text: lists.all.join(', ') });
  if (lists.any.length > 0) chips.push({ group: `${group}, any of`, text: lists.any.join(', ') });
  if (lists.exclude.length > 0) chips.push({ group: `${group}, none of`, text: lists.exclude.join(', ') });
  return chips;
}

export function describeState(state: FilterState): Chip[] {
  const chips: Chip[] = [];
  const list = (group: string, values: string[]) => {
    if (values.length > 0) chips.push({ group, text: values.join(', ') });
  };
  list('Country', state.countries.map((c) => c.label));
  list('Region', state.regions.map((r) => r.label));
  list('State', state.states.map((s) => s.label));
  list('City', state.cities.map((c) => c.label));
  list('Industry', state.industries.map((i) => i.name));
  list('Employees', state.employees.map((e) => EMPLOYEE_LABELS[e]));
  list('Revenue', state.revenue.map((r) => REVENUE_LABELS[r]));
  list('Type', state.types.map((t) => TYPE_LABELS[t]));
  if (state.categories.length > 0) {
    const match = state.categories.length > 1 ? (state.categoryMatch === 'any' ? ', any of' : ', all of') : '';
    chips.push({ group: `Category${match}`, text: state.categories.map((c) => CATEGORY_LABELS[c]).join(', ') });
  }
  chips.push(...termChips('Technologies', state.technologies));
  chips.push(...termChips('Keywords', state.keywords));
  const founded = yearRange(state.foundedYear);
  if (founded) chips.push({ group: 'Founded', text: founded });
  list('Funding round', state.fundingRounds.map((r) => FUNDING_ROUND_LABELS[r]));
  const fundingYear = yearRange(state.fundingYear);
  if (fundingYear) chips.push({ group: 'Last funding', text: fundingYear });
  const fundingAmount = describeRange(state.fundingAmount, formatUsd);
  if (fundingAmount) chips.push({ group: 'Funding amount', text: fundingAmount });
  if (state.workforceGrowth) {
    const { period, department, minPercent } = state.workforceGrowth;
    chips.push({
      group: 'Headcount growth',
      text: `${GROWTH_DEPARTMENT_LABELS[department]} +${minPercent}% or more, ${GROWTH_PERIOD_LABELS[period]}`,
    });
  }
  return chips;
}

export interface InterpretationChips {
  /** Filters the API inferred and applied. */
  filters: Chip[];
  /** Attributes the API inferred that only rank results higher. */
  boosts: Chip[];
  /** Parts of the inferred filter the builder cannot represent. */
  skipped: string[];
}

export function describeInterpretation(interpretation: Interpretation | undefined | null): InterpretationChips {
  const { state, skipped } = fromApiFilter(interpretation?.filter);
  const boost = interpretation?.boost;
  const boosts: Chip[] = [];
  if (boost?.names?.length) boosts.push({ group: 'Company name', text: boost.names.join(', ') });
  if (boost?.categories?.length) {
    boosts.push({ group: 'Category', text: boost.categories.map((c: Category) => CATEGORY_LABELS[c] ?? c).join(', ') });
  }
  if (boost?.revenue?.length) {
    boosts.push({ group: 'Revenue', text: boost.revenue.map((r: RevenueRange) => REVENUE_LABELS[r] ?? r).join(', ') });
  }
  return { filters: describeState(state), boosts, skipped };
}

/**
 * "Use as filters": the inferred filters become builder state. Boosted categories
 * and revenue only rank results, so they are added only when the user asks.
 */
export function interpretationToState(
  interpretation: Interpretation | undefined | null,
  options: { includeBoosts: boolean },
): { state: FilterState; skipped: string[] } {
  const { state, skipped } = fromApiFilter(interpretation?.filter);
  const boost = interpretation?.boost;
  if (options.includeBoosts && boost) {
    if (boost.categories?.length && state.categories.length === 0) {
      state.categories = [...boost.categories];
      state.categoryMatch = 'any';
    }
    if (boost.revenue?.length && state.revenue.length === 0) state.revenue = [...boost.revenue];
  }
  if (boost?.names?.length) skipped.push('company names (ranking only)');
  return { state, skipped };
}
