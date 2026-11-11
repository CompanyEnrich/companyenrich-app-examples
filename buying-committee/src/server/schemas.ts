import { z } from 'zod';
import { MAX_DESCRIPTION_LENGTH } from '@/lib/describe';
import { MAX_ACCOUNTS, normalizeDomain } from '@/lib/domains';
import { PERSON_ID_PATTERN } from '@/lib/email';
import { EMPLOYEE_RANGES } from '@/lib/size';
import { DEPARTMENTS, SENIORITIES } from '@/lib/taxonomy';
import { MAX_CREDITS_PER_MAP_REQUEST } from './budgets';

/**
 * Request bodies, validated server-side. The paid step receives the plan back from
 * the browser, so every role filter is re-checked against the v2 enums and limits.
 * Paid routes also carry `confirmed`, which the route checks before any API call.
 */

const domain = z.string().max(253).refine((value) => normalizeDomain(value) === value, 'not a normalized domain');

const role = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().min(1).max(80),
  why: z.string().max(200),
  department: z.array(z.enum(DEPARTMENTS)).max(12),
  seniority: z.array(z.enum(SENIORITIES)).min(1).max(SENIORITIES.length),
  position: z.array(z.string().min(1).max(80)).max(8),
  limit: z.number().int().min(1).max(3),
  priority: z.number().int().min(1).max(20),
});

const account = z.object({
  domain,
  name: z.string().max(200),
  companyId: z.string().max(100),
  employees: z.enum(EMPLOYEE_RANGES).nullable(),
  band: z.enum(['small', 'mid', 'large', 'unknown']),
});

const plan = z.object({
  blueprint: z.object({
    id: z.string().max(40),
    name: z.string().max(80),
    summary: z.string().max(200),
    roles: z.array(role).min(1).max(10),
  }),
  accounts: z
    .array(
      z.object({
        account,
        adaptation: z.array(z.string().max(300)).max(10),
        roles: z.array(z.object({ role, count: z.number().int().min(0) })).max(10),
        singleThreaded: z.boolean(),
      }),
    )
    .min(1)
    .max(MAX_ACCOUNTS),
  unresolved: z.array(z.object({ domain: z.string().max(253), reason: z.string().max(300) })).max(MAX_ACCOUNTS),
});

export const coverageRequest = z
  .object({
    domains: z.array(z.string().max(253)).min(1).max(MAX_ACCOUNTS),
    preset: z.string().max(40).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  })
  .refine((body) => Boolean(body.preset) !== Boolean(body.description?.trim()), 'send either preset or description');

export const mapRequest = z.object({
  plan,
  workforce: z.boolean(),
  maxCredits: z.number().int().min(0).max(MAX_CREDITS_PER_MAP_REQUEST),
  confirmed: z.boolean().optional(),
});

export const revealRequest = z.object({
  personId: z.string().regex(PERSON_ID_PATTERN, 'must be a positive integer id'),
  domain,
  confirmed: z.boolean().optional(),
});
