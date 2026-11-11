import type { CreditEstimate } from '../lib/credits';
import { personLine, type EmailBook } from '../lib/export';
import { coverageMatrix } from '../lib/matrix';
import type { CommitteeMap, CoveragePlan } from '../lib/types';

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: string[]) => cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ');
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

export function formatCoverage(plan: CoveragePlan): string {
  const matrix = coverageMatrix(plan);
  const rows = matrix.rows.map(({ account, cells, singleThreaded }) => [
    `${singleThreaded ? '! ' : '  '}${account.domain}`,
    account.employees ?? '?',
    ...cells.map((cell) => (cell === null ? '-' : String(cell))),
  ]);
  const lines = [table(['  Account', 'Employees', ...matrix.columns.map((column) => column.label)], rows), ''];
  if (matrix.rows.some((row) => row.singleThreaded)) lines.push('! = single-threaded: at most one role has anyone matching.');
  lines.push('- = role not part of the committee at this company size.', '');
  for (const { account, adaptation } of plan.accounts) lines.push(`${account.domain}: ${adaptation.join(' ')}`);
  for (const { domain, reason } of plan.unresolved) lines.push(`Skipped ${domain}: ${reason}`);
  return lines.join('\n');
}

export function formatEstimate(estimate: CreditEstimate): string {
  const people = estimate.searches.reduce((total, line) => total + line.people, 0);
  const parts = [`${people} people across ${estimate.searches.length} role searches = ${estimate.searchCredits} credits`];
  if (estimate.workforceCredits > 0) parts.push(`workforce check = ${estimate.workforceCredits}`);
  if (estimate.relabelReserve > 0) parts.push(`up to ${estimate.relabelReserve} more if empty roles are relabeled`);
  return `Mapping people costs up to ${estimate.maxCredits} credits (${parts.join('; ')}).`;
}

export function formatCommittee(map: CommitteeMap, emails: EmailBook = {}): string {
  const lines: string[] = [];
  for (const { account, adaptation, roles, gaps, singleThreaded } of map.accounts) {
    lines.push('', `== ${account.name} (${account.domain}), ${account.employees ?? 'size unknown'} employees${singleThreaded ? '  [single-threaded]' : ''}`);
    for (const note of adaptation) lines.push(`   ${note}`);
    for (const { role, count, people, notes } of roles) {
      lines.push('', `   ${role.label}  [${count} matching]`);
      for (const person of people) lines.push(`     - ${personLine(person, emails[person.id])}  (id ${person.id})`);
      const gap = gaps.find((candidate) => candidate.roleKey === role.key);
      if (gap) lines.push(`     GAP: ${gap.reason}`, `     Next step: ${gap.suggestion}`);
      for (const note of notes.filter((note) => !gap?.reason.includes(note))) lines.push(`     note: ${note}`);
    }
  }
  return lines.join('\n');
}
