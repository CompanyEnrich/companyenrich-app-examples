import type { CompanyFacts } from './company';
import type { Persona, RoutingConfig, RoutingRule, RuleConditions } from './config';
import { EMPLOYEE_RANGES, type Tier } from './enums';

// First-match routing. Every rule is evaluated so the trace can show why each
// one did or did not match; the first rule that matches decides the team.
// Pure: runs in the browser too. Owner assignment (round-robin) lives in assign.ts.

export interface ConditionCheck {
  field: keyof RuleConditions;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface RuleEvaluation {
  name: string;
  team: string;
  /** `shadowed`: it matches too, but an earlier rule already fired. */
  outcome: 'fired' | 'shadowed' | 'no-match';
  checks: ConditionCheck[];
}

export interface RouteDecision {
  rules: RuleEvaluation[];
  firedRule: string | null;
  team: string;
  teamLabel: string;
  /** Set when the rule (or fallback) pins the lead to one member. */
  pinnedOwner: string | null;
  persona: Persona;
  reason: string;
}

export interface RoutingInput {
  /** Null when the lead could not be scored (free-mail, company not found, budget). */
  tier: Tier | null;
  company: CompanyFacts | null;
}

export function routeLead(input: RoutingInput, config: RoutingConfig): RouteDecision {
  const rules: RuleEvaluation[] = [];
  let firedRule: RoutingRule | null = null;
  for (const rule of config.rules) {
    const checks = checkConditions(rule.when, input);
    let outcome: RuleEvaluation['outcome'] = 'no-match';
    if (checks.every((check) => check.pass)) {
      outcome = firedRule ? 'shadowed' : 'fired';
      firedRule ??= rule;
    }
    rules.push({ name: rule.name, team: rule.team, outcome, checks });
  }

  const team = firedRule?.team ?? config.fallback.team;
  return {
    rules,
    firedRule: firedRule?.name ?? null,
    team,
    teamLabel: config.teams[team]?.label ?? team,
    pinnedOwner: (firedRule ? firedRule.owner : config.fallback.owner) ?? null,
    persona: firedRule?.persona ?? config.people.persona,
    reason: firedRule
      ? `Rule "${firedRule.name}" matched first`
      : `No rule matched, so the lead goes to the fallback team`,
  };
}

function checkConditions(when: RuleConditions, { tier, company }: RoutingInput): ConditionCheck[] {
  const checks: ConditionCheck[] = [];

  if (when.tier) {
    checks.push({
      field: 'tier',
      expected: oneOf(when.tier),
      actual: tier ?? 'not scored',
      pass: tier !== null && when.tier.includes(tier),
    });
  }

  if (when.country) {
    const code = company?.country?.code ?? null;
    checks.push({
      field: 'country',
      expected: oneOf(when.country),
      actual: code ?? 'unknown',
      pass: code !== null && when.country.includes(code),
    });
  }

  if (when.state) {
    const state = company?.state ?? null;
    const wanted = when.state.map((value) => value.toLowerCase());
    checks.push({
      field: 'state',
      expected: oneOf(when.state),
      actual: state ? [state.code, state.name].filter(Boolean).join(' / ') : 'unknown',
      pass: state !== null && [state.code, state.name].some((value) => value !== null && wanted.includes(value.toLowerCase())),
    });
  }

  if (when.employees) {
    const { min, max } = when.employees;
    const employees = company?.employees ?? null;
    const position = employees ? EMPLOYEE_RANGES.indexOf(employees) : -1;
    const aboveMin = min === undefined || position >= EMPLOYEE_RANGES.indexOf(min);
    const belowMax = max === undefined || position <= EMPLOYEE_RANGES.indexOf(max);
    checks.push({
      field: 'employees',
      expected: [min && `at least ${min}`, max && `at most ${max}`].filter(Boolean).join(' and '),
      actual: employees ?? 'unknown',
      pass: position >= 0 && aboveMin && belowMax,
    });
  }

  return checks;
}

function oneOf(values: readonly string[]): string {
  return values.length === 1 ? (values[0] ?? '') : `one of ${values.join(', ')}`;
}
