import type { CompanyExpansion } from '@companyenrich/sdk';
import type { CompanyFacts } from './company';
import type { DimensionKey, ScoringConfig } from './config';
import { fundingStageLabel, monthsSince, round1 } from './format';

// ICP scoring. Every dimension earns `weight x match` points, where match is
// between 0 and 1, and reports how it got there. Pure: runs in the browser too.

export interface Factor {
  dimension: DimensionKey;
  label: string;
  /** The company's value, ready to display. */
  value: string;
  match: number;
  weight: number;
  points: number;
  reason: string;
}

export interface ScoreResult {
  total: number;
  max: number;
  factors: Factor[];
}

interface Match {
  value: string;
  match: number;
  reason: string;
}

export function scoreCompany(company: CompanyFacts, config: ScoringConfig, now: Date): ScoreResult {
  const d = config.dimensions;
  const matches: Record<DimensionKey, Match> = {
    employees: lookup(company.employees, d.employees),
    revenue: lookup(company.revenue, d.revenue),
    categories: bestCategory(company.categories, d.categories),
    country: lookup(company.country?.code ?? null, d.country),
    foundedYear: foundedYear(company.foundedYear, d.foundedYear),
    funding: funding(company.funding, d.funding, now),
    technologies: technologies(company.technologies, d.technologies),
  };

  const factors = (Object.keys(matches) as DimensionKey[]).map((dimension): Factor => {
    const { label, weight } = d[dimension];
    const { value, match, reason } = matches[dimension];
    return { dimension, label, value, match: Math.round(match * 100) / 100, weight, points: round1(weight * match), reason };
  });

  return {
    total: round1(factors.reduce((sum, factor) => sum + factor.points, 0)),
    max: round1(factors.reduce((sum, factor) => sum + factor.weight, 0)),
    factors,
  };
}

/** Paid expansions the scoring config needs. A dimension with weight 0 does not pay for its data. */
export function requiredExpansions(config: ScoringConfig): CompanyExpansion[] {
  const expand: CompanyExpansion[] = [];
  if (config.dimensions.funding.weight > 0) expand.push('financial');
  if (config.dimensions.technologies.weight > 0) expand.push('technologies');
  return expand;
}

interface Table {
  match: Partial<Record<string, number>>;
  other: number;
  unknown: number;
}

function lookup(value: string | null, table: Table): Match {
  if (!value) return { value: 'unknown', match: table.unknown, reason: `No data, scored as unknown (${table.unknown})` };
  const listed = table.match[value];
  if (listed !== undefined) return { value, match: listed, reason: `${value} is listed at ${listed}` };
  return { value, match: table.other, reason: `${value} is not listed, scored as other (${table.other})` };
}

function bestCategory(categories: string[], table: Table): Match {
  if (categories.length === 0) return lookup(null, table);
  const scored = categories.map((category) => ({ category, match: table.match[category] ?? table.other }));
  const best = scored.reduce((a, b) => (b.match > a.match ? b : a));
  return {
    value: categories.join(', '),
    match: best.match,
    reason: `Best category is ${best.category} (${best.match})`,
  };
}

function foundedYear(year: number | null, config: ScoringConfig['dimensions']['foundedYear']): Match {
  if (year === null) return { value: 'unknown', match: config.unknown, reason: `No data, scored as unknown (${config.unknown})` };
  const band = config.bands.find((b) => (b.min === undefined || year >= b.min) && (b.max === undefined || year <= b.max));
  if (!band) return { value: String(year), match: config.other, reason: `${year} is outside every band, scored as other (${config.other})` };
  const range = band.min !== undefined && band.max !== undefined ? `${band.min}-${band.max}` : band.min !== undefined ? `${band.min} or later` : `${band.max} or earlier`;
  return { value: String(year), match: band.match, reason: `${year} falls in ${range} (${band.match})` };
}

function funding(data: CompanyFacts['funding'], config: ScoringConfig['dimensions']['funding'], now: Date): Match {
  const unknown = (reason: string): Match => ({ value: 'unknown', match: config.unknown, reason: `${reason}, scored as unknown (${config.unknown})` });
  if (data === undefined) return unknown('Not fetched: the financial expansion was off');
  if (!data?.stage) return unknown('No disclosed funding');

  const stageMatch = config.stages[data.stage] ?? config.otherStage;
  const stage = fundingStageLabel(data.stage);
  const months = data.date ? monthsSince(data.date, now) : null;
  const recent = months !== null && months <= config.recentMonths;
  const multiplier = recent ? 1 : config.staleMultiplier;
  const when = months === null ? 'date unknown' : `${months} months ago`;
  const recency = recent
    ? `within ${config.recentMonths} months`
    : `older than ${config.recentMonths} months or undated, x${config.staleMultiplier}`;
  return {
    value: `${stage}, ${when}`,
    match: stageMatch * multiplier,
    reason: `${stage} is ${config.stages[data.stage] !== undefined ? 'listed' : 'not listed, other'} at ${stageMatch}; ${recency}`,
  };
}

/** "Next-Js", "next.js" and "NextJS" all compare equal. */
function techKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function technologies(detected: CompanyFacts['technologies'], config: ScoringConfig['dimensions']['technologies']): Match {
  if (detected === undefined) {
    return { value: 'unknown', match: config.unknown, reason: `Not fetched: the technologies expansion was off, scored as unknown (${config.unknown})` };
  }
  if (!detected || detected.length === 0) {
    return { value: 'none detected', match: config.unknown, reason: `No technologies detected, scored as unknown (${config.unknown})` };
  }
  const listed = new Map(Object.entries(config.match).map(([name, match]) => [techKey(name), { name, match }]));
  const hits = detected.flatMap((tech) => {
    const entry = listed.get(techKey(tech));
    return entry ? [entry] : [];
  });
  if (hits.length === 0) {
    return { value: `${detected.length} detected`, match: 0, reason: `None of the ${listed.size} listed technologies detected` };
  }
  const sum = hits.reduce((total, hit) => total + hit.match, 0);
  return {
    value: hits.map((hit) => hit.name).join(', '),
    match: Math.min(1, sum),
    reason: `${hits.map((hit) => `${hit.name} ${hit.match}`).join(' + ')}${sum > 1 ? ', capped at 1' : ''}`,
  };
}
