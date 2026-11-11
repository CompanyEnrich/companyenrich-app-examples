import { DEFAULT_PRESET_ID, findPreset, PRESETS } from './blueprints';
import type { EnrichClient } from './client';
import { MAX_CONCURRENCY, mapWithConcurrency } from './concurrency';
import { UserFacingError } from './user-error';
import type { BlueprintDrafter, DraftBlueprint } from './llm';
import { isDepartment, isSeniority } from './taxonomy';
import type { Blueprint, RoleSpec } from './types';

export interface BlueprintChoice {
  blueprint: Blueprint;
  /** `preset` = picked by id, `keywords` = matched from text, `claude` = drafted by Claude. */
  source: 'preset' | 'keywords' | 'claude';
  /** What happened, in plain words: which preset, what was dropped, why Claude was not used. */
  notes: string[];
}

const MAX_ROLES = 8;
const MAX_PHRASES = 24;
export const MAX_DESCRIPTION_LENGTH = 500;

const KEYWORDS: Record<string, string[]> = {
  security: ['security', 'compliance', 'soc 2', 'soc2', 'grc', 'vulnerability', 'siem', 'identity', 'iam', 'threat', 'pentest', 'privacy', 'zero trust', 'endpoint', 'firewall', 'secrets'],
  devtools: ['developer', 'developers', 'engineering', 'engineers', 'feature flags', 'devops', 'ci/cd', 'infrastructure', 'observability', 'monitoring', 'api', 'sdk', 'cloud', 'kubernetes', 'deployment', 'testing', 'code', 'git', 'logging', 'incident', 'hosting', 'database'],
  data: ['data', 'analytics', 'warehouse', 'etl', 'elt', 'pipelines', 'bi', 'dashboards', 'reporting', 'sql', 'machine learning', 'ml'],
  'sales-tech': ['sales', 'crm', 'outbound', 'prospecting', 'leads', 'revenue', 'quota', 'deals', 'sdr', 'cold email', 'enrichment', 'forecasting', 'revops'],
  'marketing-tech': ['marketing', 'seo', 'ads', 'advertising', 'campaigns', 'email marketing', 'content', 'social media', 'brand', 'attribution', 'landing pages', 'webinars'],
  'hr-tech': ['hr', 'recruiting', 'hiring', 'applicant', 'ats', 'payroll', 'onboarding', 'employee', 'employees', 'talent', 'benefits', 'performance reviews', 'learning'],
  'finance-tech': ['finance', 'accounting', 'invoices', 'invoicing', 'expense', 'expenses', 'spend', 'procurement', 'accounts payable', 'budgeting', 'fp&a', 'erp', 'billing', 'tax'],
};

export function choosePreset(id: string): BlueprintChoice {
  const preset = findPreset(id);
  if (!preset) throw new UserFacingError(`Unknown preset "${id}". Choose one of: ${PRESETS.map((p) => p.id).join(', ')}.`);
  return { blueprint: preset, source: 'preset', notes: [`Using the ${preset.name} preset.`] };
}

/** A preset id picks that preset; anything else is treated as a description of what you sell. */
export async function chooseBlueprint(
  product: string,
  deps: { client: EnrichClient; drafter: BlueprintDrafter | null },
): Promise<BlueprintChoice> {
  return findPreset(product) ? choosePreset(product) : blueprintFromDescription(product, deps);
}

/** Deterministic, offline: the preset whose keywords appear most often in the text. */
export function matchPresetByKeywords(text: string): { preset: Blueprint; matched: string[] } {
  const lower = text.toLowerCase();
  let best = { id: DEFAULT_PRESET_ID, matched: [] as string[] };
  for (const [id, keywords] of Object.entries(KEYWORDS)) {
    const matched = keywords.filter((keyword) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}($|[^a-z0-9])`).test(lower));
    if (matched.length > best.matched.length) best = { id, matched };
  }
  return { preset: findPreset(best.id)!, matched: best.matched };
}

/**
 * Free-text "what you sell" to a blueprint. With a drafter (ANTHROPIC_API_KEY set),
 * Claude drafts a custom committee that we validate; otherwise, or if Claude fails,
 * we fall back to the nearest preset by keywords.
 */
export async function blueprintFromDescription(
  description: string,
  deps: { client: EnrichClient; drafter: BlueprintDrafter | null },
): Promise<BlueprintChoice> {
  const text = description.trim();
  if (!text) throw new UserFacingError('Describe what you sell, or pick a preset.');
  if (text.length > MAX_DESCRIPTION_LENGTH) throw new UserFacingError(`Keep the description under ${MAX_DESCRIPTION_LENGTH} characters.`);

  if (!deps.drafter) return keywordChoice(text, 'ANTHROPIC_API_KEY is not set, so no custom committee was drafted.');

  const result = await deps.drafter(text);
  if (!result.ok) return keywordChoice(text, result.reason);

  const { blueprint, dropped } = await validateDraft(result.draft, deps.client);
  if (blueprint.roles.length === 0) return keywordChoice(text, 'None of the roles Claude drafted passed validation.');
  return { blueprint, source: 'claude', notes: ['Committee drafted by Claude from your description and checked against the v2 people taxonomy.', ...dropped] };
}

function keywordChoice(text: string, why: string): BlueprintChoice {
  const { preset, matched } = matchPresetByKeywords(text);
  const how = matched.length > 0 ? `matched keywords: ${matched.join(', ')}` : 'no keywords matched, so the generic committee is used';
  return { blueprint: preset, source: 'keywords', notes: [why, `Using the ${preset.name} preset (${how}).`] };
}

/**
 * Keep only what the API will accept: v2 departments and seniorities, title phrases
 * that `positions.autocomplete` (free) recognises, limits of 1-3. Every drop is reported.
 */
export async function validateDraft(draft: DraftBlueprint, client: EnrichClient): Promise<{ blueprint: Blueprint; dropped: string[] }> {
  const dropped: string[] = [];
  if (draft.roles.length > MAX_ROLES) dropped.push(`Kept the first ${MAX_ROLES} of ${draft.roles.length} roles.`);

  const allPhrases = [...new Set(draft.roles.slice(0, MAX_ROLES).flatMap((role) => role.position.map((phrase) => phrase.trim())).filter(Boolean))];
  const phrases = allPhrases.slice(0, MAX_PHRASES);
  const checked = new Set(phrases);
  const known = new Set<string>();
  await mapWithConcurrency(phrases, MAX_CONCURRENCY, async (phrase) => {
    const { items } = await client.positions.autocomplete(phrase);
    if (items.length > 0) known.add(phrase);
  });

  const usedKeys = new Set<string>();
  const roles: RoleSpec[] = [];
  draft.roles.slice(0, MAX_ROLES).forEach((draftRole, index) => {
    const label = draftRole.label.trim().slice(0, 80) || `Role ${index + 1}`;
    const department = draftRole.department.filter(isDepartment);
    const seniority = draftRole.seniority.filter(isSeniority);
    const position = draftRole.position.map((phrase) => phrase.trim()).filter((phrase) => known.has(phrase));

    const badDepartments = draftRole.department.filter((value) => !isDepartment(value));
    const badSeniorities = draftRole.seniority.filter((value) => !isSeniority(value));
    const rejected = draftRole.position.map((phrase) => phrase.trim()).filter((phrase) => phrase && !known.has(phrase));
    const unknownPhrases = rejected.filter((phrase) => checked.has(phrase));
    const uncheckedPhrases = rejected.filter((phrase) => !checked.has(phrase));
    if (badDepartments.length) dropped.push(`${label}: dropped unknown department ${badDepartments.map(quote).join(', ')}.`);
    if (badSeniorities.length) dropped.push(`${label}: dropped unknown seniority ${badSeniorities.map(quote).join(', ')}.`);
    if (unknownPhrases.length) dropped.push(`${label}: dropped title phrase ${unknownPhrases.map(quote).join(', ')} (no matching titles).`);
    if (uncheckedPhrases.length) {
      dropped.push(`${label}: dropped title phrase ${uncheckedPhrases.map(quote).join(', ')} (not checked: only the first ${MAX_PHRASES} phrases are validated).`);
    }

    if (seniority.length === 0) {
      dropped.push(`${label}: dropped the role because it has no valid seniority.`);
      return;
    }
    const key = uniqueKey(slugify(draftRole.key) || slugify(label) || `role-${index + 1}`, usedKeys);
    roles.push({
      key,
      label,
      why: draftRole.why.trim().slice(0, 200),
      department,
      seniority,
      position,
      limit: Math.min(3, Math.max(1, Math.round(draftRole.limit) || 1)),
      priority: Number.isFinite(draftRole.priority) && draftRole.priority > 0 ? Math.round(draftRole.priority) : index + 1,
    });
  });

  return {
    blueprint: { id: 'custom', name: draft.name.trim().slice(0, 80) || 'Custom committee', summary: draft.summary.trim().slice(0, 200), roles },
    dropped,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  used.add(key);
  return key;
}

function quote(value: string): string {
  return `"${value}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
