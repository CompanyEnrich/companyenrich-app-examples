import type { OwnerAssigner } from './assign';
import type { Persona, RoutingConfig, ScoringConfig } from './config';
import { LeadBudget, type DailyCreditLedger } from './credits';
import { emailDomain, freeMailMatch } from './email';
import type { CompanyLookup, CompanyLookups } from './enrich';
import { describeApiError, toUpstreamError } from './errors';
import { evaluateCompany } from './evaluate';
import type { PeopleLookups } from './people';
import { requiredExpansions } from './score';
import { buildSlackMessage, postToSlack, type AlertInput } from './slack';
import type { AlertStep, DecisionTrace, EnrichStep, LeadStatus, PeopleStep } from './trace';

// The inbound pipeline: free-mail check -> enrich -> score -> tier -> route ->
// (tier A) people -> alert. Framework-free; the webhook route is a thin wrapper.

export interface Lead {
  email: string;
  name?: string | null;
  source?: string | null;
}

export interface PipelineConfig {
  scoring: ScoringConfig;
  routing: RoutingConfig;
}

export interface PipelineDeps {
  /** Company enrichment with the 24-hour cache and one in-flight call per domain. */
  companies: CompanyLookups;
  /** People lookups with their cache and one in-flight call per account. */
  people: PeopleLookups;
  assigner: OwnerAssigner;
  /** The daily cap shared by every request. */
  ledger: DailyCreditLedger;
  /** The most one lead may spend (MAX_CREDITS_PER_LEAD), checked before each paid call. */
  maxCreditsPerLead: number;
  slackWebhookUrl?: string;
  /** Used for the Slack post. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

export async function processLead(lead: Lead, config: PipelineConfig, deps: PipelineDeps): Promise<DecisionTrace> {
  const started = performance.now();
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console.log;
  const email = lead.email.trim();
  const domain = emailDomain(email) ?? email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const freeMail = freeMailMatch(domain);
  const budget = new LeadBudget(deps.ledger, deps.maxCreditsPerLead);

  // 1. Enrich, unless the domain is free-mail or a credit cap would be passed.
  const enrichStarted = performance.now();
  const { status, lookup, enrichment } = await enrichStep(domain, freeMail, config.scoring, deps.companies, budget);
  const enrichMs = Math.round(performance.now() - enrichStarted);
  const company = lookup?.status === 'found' ? lookup.company : null;

  // 2. Score, tier and route. Pure and instant.
  const { score, tier, route } = evaluateCompany(company, config.scoring, config.routing, now);
  const team = config.routing.teams[route.team];
  if (!team) throw new Error(`Routing config has no team "${route.team}"`);
  const assignment = deps.assigner.assign(route.team, team, { pinnedOwner: route.pinnedOwner, account: company?.domain ?? null });

  // 3. Tier A only: find two or three people matching the rule's persona.
  const peopleStarted = performance.now();
  const people =
    company && tier?.tier === 'A' ? await peopleStep(company.domain, route.persona, config.routing, deps.people, budget) : skippedPeople(tier?.tier ?? null);
  const peopleMs = Math.round(performance.now() - peopleStarted);

  const enrichCredits = 'credits' in enrichment ? enrichment.credits : 0;
  const peopleCredits = 'credits' in people ? people.credits : 0;
  const uncertainCredits = people.status === 'error' ? people.uncertainCredits : 0;
  const owner = assignment.owner.name;
  const result: AlertInput = {
    id: crypto.randomUUID().slice(0, 8),
    receivedAt: now.toISOString(),
    lead: { email, name: lead.name ?? null, source: lead.source ?? null, domain },
    status,
    decision: {
      tier: tier?.tier ?? null,
      score: score?.total ?? null,
      maxScore: score?.max ?? null,
      team: route.team,
      teamLabel: route.teamLabel,
      owner,
      summary: summarize(status, freeMail, score?.total ?? null, score?.max ?? null, tier?.tier ?? null, route.teamLabel, owner),
    },
    company,
    people: 'people' in people ? people.people : [],
    credits: {
      spent: enrichCredits + peopleCredits,
      uncertain: uncertainCredits,
      enrich: enrichCredits,
      people: peopleCredits,
      remainingToday: deps.ledger.remaining(),
    },
    trace: { freeMail: { isFreeMail: freeMail !== null, matched: freeMail }, enrichment, score, tier, routing: route, assignment, people },
    timings: { totalMs: 0, enrichMs, peopleMs },
  };
  result.timings.totalMs = Math.round(performance.now() - started);

  // 4. Alert the owner.
  const alertStarted = performance.now();
  const alert = await alertStep(result, config.routing, deps, log);
  const alertMs = Math.round(performance.now() - alertStarted);

  const trace: DecisionTrace = {
    ...result,
    trace: { ...result.trace, alert },
    timings: { ...result.timings, alertMs, totalMs: Math.round(performance.now() - started) },
  };
  const uncertain = trace.credits.uncertain ? `, up to ${trace.credits.uncertain} more uncertain` : '';
  log(`[lead ${trace.id}] ${email}: ${trace.decision.summary} (${trace.credits.spent} credits${uncertain}, ${trace.timings.totalMs} ms)`);
  return trace;
}

async function enrichStep(
  domain: string,
  freeMail: string | null,
  scoring: ScoringConfig,
  companies: CompanyLookups,
  budget: LeadBudget,
): Promise<{ status: LeadStatus; lookup: CompanyLookup | null; enrichment: EnrichStep }> {
  if (freeMail) {
    return {
      status: 'free-mail',
      lookup: null,
      enrichment: { status: 'skipped', reason: `${freeMail === domain ? domain : `${domain} (under ${freeMail})`} is a free-mail domain, so no credits were spent` },
    };
  }

  const expand = requiredExpansions(scoring);
  const result = await companies.enrich(domain, expand, budget);
  if (result.status === 'over-budget') {
    return { status: 'over-budget', lookup: null, enrichment: { status: 'skipped', reason: `${result.reason}; enrichment would cost ${result.cost}` } };
  }
  if (result.status === 'failed') toUpstreamError(result.error, result.uncertainCredits);

  const { lookup } = result;
  return {
    status: lookup.status === 'found' ? 'scored' : lookup.status,
    lookup,
    enrichment: { status: lookup.status, source: result.source, expand, credits: result.credits, cachedAt: result.cachedAt },
  };
}

function skippedPeople(tier: string | null): PeopleStep {
  const reason = tier ? `Tier ${tier}: the people lookup runs for tier A only` : 'Not scored: the people lookup runs for tier A only';
  return { status: 'skipped', reason };
}

async function peopleStep(domain: string, persona: Persona, routing: RoutingConfig, people: PeopleLookups, budget: LeadBudget): Promise<PeopleStep> {
  const found = await people.find({ domain, persona, pageSize: routing.people.pageSize }, budget);
  if (found.status === 'over-budget') return { status: 'skipped', reason: `${found.reason} (${found.matching} matching people)` };
  if (found.status === 'failed') {
    // A failed people lookup should not lose the lead: it is still scored, routed and alerted.
    const reason = describeApiError(found.error);
    if (!reason) throw found.error;
    return { status: 'error', reason, uncertainCredits: found.uncertainCredits };
  }
  return found;
}

async function alertStep(lead: AlertInput, routing: RoutingConfig, deps: PipelineDeps, log: (line: string) => void): Promise<AlertStep> {
  const tier = lead.decision.tier;
  if (!tier) return { channel: 'none', reason: 'Unscored leads are not alerted' };
  if (!routing.alertTiers.includes(tier)) return { channel: 'none', reason: `Tier ${tier} is not in alertTiers` };
  const message = buildSlackMessage(lead);
  if (deps.slackWebhookUrl) return postToSlack(deps.slackWebhookUrl, message, deps.fetch);
  log(`[alert] ${message.text}`);
  return { channel: 'log', reason: 'SLACK_WEBHOOK_URL is not set, so the alert went to the server log' };
}

function summarize(
  status: LeadStatus,
  freeMail: string | null,
  score: number | null,
  max: number | null,
  tier: string | null,
  teamLabel: string,
  owner: string,
): string {
  const route = `${teamLabel}, owner ${owner}`;
  switch (status) {
    case 'scored':
      return tier === 'unqualified' ? `Unqualified (${score}/${max}) -> ${route}` : `Tier ${tier} (${score}/${max}) -> ${route}`;
    case 'free-mail':
      return `Free-mail address (${freeMail}), not enriched -> ${route}`;
    case 'not-found':
      return `Company not found -> ${route}`;
    case 'invalid-domain':
      return `Email domain is not a valid company domain -> ${route}`;
    case 'over-budget':
      return `Credit cap reached, not enriched -> ${route}`;
  }
}
