import type { ChampionAlert, CheckReport } from './check.js';
import type { CriterionScore } from './icp.js';
import { companyLabel } from './profile.js';

const KIND_ORDER = { moved: 0, promoted: 1, left: 2 } as const;

/** One line for the top of the digest and the Slack notification text. */
export function summarize(report: CheckReport): string {
  const count = (kind: keyof typeof KIND_ORDER) => report.alerts.filter((alert) => alert.change.kind === kind).length;
  return (
    `Checked ${report.checked} of ${report.due} due champions (${report.tracked} tracked): ` +
    `${count('moved')} moved, ${count('promoted')} promoted, ${count('left')} left, ${report.unchanged} unchanged. ` +
    `Spent ${report.spent} credits.`
  );
}

/** Alerts per owner, owners alphabetically; moves first (best ICP fit first), then promotions, then departures. */
export function groupByOwner(alerts: ChampionAlert[]): [string, ChampionAlert[]][] {
  const groups = new Map<string, ChampionAlert[]>();
  for (const alert of alerts) groups.set(alert.owner, [...(groups.get(alert.owner) ?? []), alert]);
  const rank = (alert: ChampionAlert) => KIND_ORDER[alert.change.kind] * 1000 - (alert.research?.icp?.score ?? 0);
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, list]) => [owner, list.sort((a, b) => rank(a) - rank(b))]);
}

export function headline(alert: ChampionAlert): string {
  const { change, name } = alert;
  switch (change.kind) {
    case 'moved':
      return `Moved: ${name} is now at ${companyLabel(change.to)}`;
    case 'promoted':
      return `Promoted: ${name} is now ${change.to.position ?? 'in a new role'} at ${change.from.companyName}`;
    case 'left':
      return `Left, destination unknown: ${name} no longer lists ${change.from.companyName} as current`;
  }
}

/** Plain-text facts under a headline, shared by the Markdown digest and the Slack message. */
export function facts(alert: ChampionAlert): string[] {
  const { change } = alert;
  const lines = [`Deal: ${alert.dealName || '(no deal name)'} (${alert.accountDomain})`];
  const before = `${change.from.position ?? 'role unknown'} at ${change.from.companyName}${since(change.from.positionStartDate)}`;

  if (change.kind === 'moved') {
    const domain = change.to.company?.domain ? ` (${change.to.company.domain})` : '';
    lines.push(`Before: ${before}`, `Now: ${change.to.position ?? 'role unknown'} at ${companyLabel(change.to)}${domain}${since(change.to.startDate)}`);
    if (change.confidence === 'likely') {
      lines.push(`Still listed at ${change.from.companyName} too, so the old role may not be closed yet. Worth confirming before reaching out.`);
    }
    const research = alert.research;
    if (research?.company) {
      const company = research.company;
      const about = [company.location?.country?.name, company.employees && `${company.employees} employees`, company.revenue && `${company.revenue} revenue`, company.industry]
        .filter(Boolean)
        .join(', ');
      if (about) lines.push(`Company: ${about}`);
    }
    if (research?.icp) {
      lines.push(`ICP fit: ${research.icp.score}/100, ${research.icp.fit} (${research.icp.parts.map(describePart).join('; ')})`);
    }
    if (research?.persona) {
      const { total, accessible } = research.persona;
      const plan = accessible < total ? ` (${accessible.toLocaleString('en-US')} accessible on your plan)` : '';
      const listed = research.contacts.length > 0 ? `; ${research.contacts.length} of them listed below` : '';
      lines.push(`Buyer persona there: ${total.toLocaleString('en-US')} other ${total === 1 ? 'person matches' : 'people match'}${plan}${listed}`);
    }
    for (const contact of research?.contacts ?? []) {
      const champion = contact.isChampion ? ' (already one of your tracked champions)' : '';
      lines.push(`Contact: ${contact.name}, ${contact.position ?? 'position unknown'}${contact.linkedinUrl ? `, ${contact.linkedinUrl}` : ''}${champion}`);
    }
    for (const note of research?.notes ?? []) lines.push(`Note: ${note}`);
  } else if (change.kind === 'promoted') {
    lines.push(
      `Before: ${change.from.position ?? 'role unknown'}${seniority(change.from.seniority)}${since(change.from.positionStartDate)}`,
      `Now: ${change.to.position ?? 'role unknown'}${seniority(change.to.seniority)}${since(change.to.startDate)}`,
    );
  } else {
    lines.push(`Last seen: ${before}`);
    const others = change.otherRoles.map((role) => `${role.position ?? 'role unknown'} at ${companyLabel(role)}`);
    if (others.length > 0) lines.push(`Still lists roles they already had: ${others.join('; ')}`);
    lines.push('Still tracked: the next check reports where they land.');
  }

  if (alert.linkedinUrl) lines.push(`Profile: ${alert.linkedinUrl}${alert.profileUpdatedAt ? ` (data updated ${alert.profileUpdatedAt.slice(0, 10)})` : ''}`);
  return lines;
}

/** Things the reader should know that are not alerts: failed lookups, deferred checks, an early stop. */
export function attentionItems(report: CheckReport): string[] {
  const items = report.problems.map((problem) => `${problem.owner}, ${problem.dealName || 'no deal name'}: ${problem.champion}: ${problem.reason}`);
  if (report.stoppedBy) items.push(`Stopped early: ${report.stoppedBy}`);
  if (report.deferred > 0) {
    const why = report.stoppedBy ? 'the run stopped early' : `of the ${report.cap}-credit cap`;
    const now = report.stoppedBy ? 'Once that is fixed, run' : 'To check them now, run';
    items.push(`${report.deferred} due champions were not checked because ${why}. ${now} "${report.resumeCommand}"; otherwise they go first on the next run.`);
  }
  return items;
}

export function renderDigest(report: CheckReport): string {
  const lines = [`# Champion digest, ${report.date}`, '', summarize(report), ''];
  if (report.alerts.length === 0) lines.push('No changes: nobody moved, got promoted or left.', '');
  for (const [owner, alerts] of groupByOwner(report.alerts)) {
    lines.push(`## Owner: ${owner}`, '');
    for (const alert of alerts) {
      lines.push(`### ${headline(alert)}`, '', ...facts(alert).map((fact) => `- ${fact}`), '');
    }
  }
  const attention = attentionItems(report);
  if (attention.length > 0) lines.push('## Needs attention', '', ...attention.map((item) => `- ${item}`), '');
  return lines.join('\n');
}

function describePart(part: CriterionScore): string {
  return `${part.criterion} ${part.value ?? 'unknown'}: ${part.verdict}`;
}

function since(date: string | null | undefined): string {
  return date ? `, since ${date.slice(0, 7)}` : '';
}

function seniority(value: string | null | undefined): string {
  return value ? ` (${value})` : '';
}
