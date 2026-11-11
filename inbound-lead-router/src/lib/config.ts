import { z } from 'zod';
import { CATEGORIES, DEPARTMENTS, EMPLOYEE_RANGES, REVENUE_RANGES, SENIORITIES, TIERS } from './enums';

// Schemas for config/scoring.json and config/routing.json. Parsing fills in
// defaults and fails with a readable message that names the bad field.

const fraction = z.number().min(0).max(1);
const weight = z.number().min(0).max(100);
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter ISO country code such as "US"');

function tableDimension<Key extends z.ZodType<string>>(key: Key) {
  return z.strictObject({
    label: z.string().min(1),
    weight,
    /** Match (0 to 1) for each value. Values left out get `other`. */
    match: z.partialRecord(key, fraction),
    /** Match for a known value that is not listed in `match`. */
    other: fraction.default(0),
    /** Match when the company has no value for this field. */
    unknown: fraction.default(0),
  });
}

const yearBand = z.strictObject({
  min: z.int().optional(),
  max: z.int().optional(),
  match: fraction,
});

export const scoringConfigSchema = z
  .strictObject({
    description: z.string().optional(),
    tiers: z.strictObject({ A: weight, B: weight, C: weight }),
    dimensions: z.strictObject({
      employees: tableDimension(z.enum(EMPLOYEE_RANGES)),
      revenue: tableDimension(z.enum(REVENUE_RANGES)),
      categories: tableDimension(z.enum(CATEGORIES)),
      country: tableDimension(countryCode),
      foundedYear: z.strictObject({
        label: z.string().min(1),
        weight,
        bands: z.array(yearBand),
        other: fraction.default(0),
        unknown: fraction.default(0),
      }),
      funding: z.strictObject({
        label: z.string().min(1),
        weight,
        /** Match for each `financial.fundingStage` value, such as `series_b`. */
        stages: z.record(z.string(), fraction),
        otherStage: fraction.default(0),
        /** A round older than this many months is multiplied by `staleMultiplier`. */
        recentMonths: z.int().positive(),
        staleMultiplier: fraction,
        unknown: fraction.default(0),
      }),
      technologies: z.strictObject({
        label: z.string().min(1),
        weight,
        /** Match added for each detected technology. The total is capped at 1. */
        match: z.record(z.string().min(1), fraction),
        unknown: fraction.default(0),
      }),
    }),
  })
  .refine((config) => config.tiers.A >= config.tiers.B && config.tiers.B >= config.tiers.C, {
    message: 'Tier thresholds must satisfy A >= B >= C',
    path: ['tiers'],
  });

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;
export type DimensionKey = keyof ScoringConfig['dimensions'];

const member = z.strictObject({
  name: z.string().min(1),
  /** Slack member ID such as U012AB3CD. When set, the alert @-mentions the owner. */
  slackUserId: z
    .string()
    .regex(/^[UW][A-Z0-9]{4,}$/, 'Use a Slack member ID such as U012AB3CD')
    .optional(),
});
export type TeamMember = z.infer<typeof member>;

const team = z.strictObject({
  label: z.string().optional(),
  /** Rotate new accounts through the members. Otherwise the first member owns every lead. */
  roundRobin: z.boolean().default(false),
  members: z.array(member).min(1),
});
export type Team = z.infer<typeof team>;

// Both are checked against the full v2 value lists, so a typo fails at load time,
// not on the first tier A lead after a paid enrichment.
const persona = z.strictObject({
  seniority: z.array(z.enum(SENIORITIES)).optional(),
  department: z.array(z.enum(DEPARTMENTS)).optional(),
  position: z.array(z.string().min(1)).optional(),
});
export type Persona = z.infer<typeof persona>;

const conditions = z.strictObject({
  tier: z.array(z.enum(TIERS)).optional(),
  country: z.array(countryCode).optional(),
  /** State or province code ("CA") or name ("California"). */
  state: z.array(z.string().min(1)).optional(),
  employees: z
    .strictObject({ min: z.enum(EMPLOYEE_RANGES).optional(), max: z.enum(EMPLOYEE_RANGES).optional() })
    .optional(),
});
export type RuleConditions = z.infer<typeof conditions>;

const rule = z.strictObject({
  name: z.string().min(1),
  when: conditions,
  team: z.string().min(1),
  /** Pin the lead to one team member instead of the team's assignment method. */
  owner: z.string().optional(),
  /** Who to look up at tier A accounts routed by this rule. Defaults to people.persona. */
  persona: persona.optional(),
});
export type RoutingRule = z.infer<typeof rule>;

export const routingConfigSchema = z
  .strictObject({
    description: z.string().optional(),
    alertTiers: z.array(z.enum(TIERS)).default(['A', 'B', 'C']),
    people: z.strictObject({
      pageSize: z.int().min(1).max(5).default(3),
      persona,
    }),
    teams: z.record(z.string(), team),
    rules: z.array(rule),
    fallback: z.strictObject({ team: z.string().min(1), owner: z.string().optional() }),
  })
  .superRefine((config, ctx) => {
    const targets = [
      ...config.rules.map((r, index) => ({ team: r.team, owner: r.owner, path: ['rules', index] })),
      { team: config.fallback.team, owner: config.fallback.owner, path: ['fallback'] },
    ];
    for (const target of targets) {
      const found = config.teams[target.team];
      if (!found) {
        ctx.addIssue({ code: 'custom', message: `Unknown team "${target.team}"`, path: [...target.path, 'team'] });
      } else if (target.owner && !found.members.some((m) => m.name === target.owner)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${target.owner}" is not a member of team "${target.team}"`,
          path: [...target.path, 'owner'],
        });
      }
    }
  });

export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigError(`${label} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function parseScoringConfig(raw: unknown, label = 'Scoring config'): ScoringConfig {
  return parseWith(scoringConfigSchema, raw, label);
}

export function parseRoutingConfig(raw: unknown, label = 'Routing config'): RoutingConfig {
  return parseWith(routingConfigSchema, raw, label);
}
