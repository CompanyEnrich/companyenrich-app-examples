import {
  balanceBasis,
  describeBalance,
  formatInt,
  formatPercent,
  formatReportWeight,
  formatSignedPercent,
  stateLabel,
  weightLabel,
} from './format.js';
import type { PlanReport, Territory } from './planner.js';
import { US_TILE_GRID_ROWS, US_TILE_POSITIONS } from './us-geo.js';

/** Lays out rows as aligned columns; columns listed in `rightAligned` are padded on the left. */
function columns(rows: string[][], rightAligned: ReadonlySet<number>): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => (rightAligned.has(column) ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** The heaviest states of a territory, in the units the plan balances. */
function largestStates(report: PlanReport, territory: Territory, limit = 3): string {
  const named = territory.states.filter((state) => state.companies > 0).slice(0, limit);
  const rest = territory.states.filter((state) => state.companies > 0).length - named.length;
  const list = named.map((state) => `${stateLabel(state)} ${formatReportWeight(report, state.weight)}`).join(', ');
  return rest > 0 ? `${list} +${rest} more` : list;
}

/** The territory table printed by the CLI and pasted into the README. */
export function territoryTable(report: PlanReport): string {
  const weighted = report.weightBy !== 'none';
  const header = ['#', 'Rep', 'States', 'ICP companies', ...(weighted ? [weightLabel(report)] : []), 'Share', 'vs even', 'Largest states'];
  const rows = report.territories.map((territory) => [
    String(territory.number),
    territory.rep ?? '-',
    String(territory.states.length),
    formatInt(territory.companies),
    ...(weighted ? [formatReportWeight(report, territory.weight)] : []),
    formatPercent(territory.share),
    formatSignedPercent(territory.vsEven),
    largestStates(report, territory),
  ]);
  const numeric = new Set(weighted ? [0, 2, 3, 4, 5, 6] : [0, 2, 3, 4, 5]);
  const balance = `Balance on ${balanceBasis(report)}: ${describeBalance(report)}.`;
  return `${columns([header, ...rows], numeric)}\n\n${balance}`;
}

/**
 * The US tile map as text: each tile shows the state code and its territory number.
 * States outside the grid (territories, minor islands) are listed underneath.
 */
export function textTileMap(report: PlanReport): string {
  const territoryOf = new Map<string, number>();
  const offGrid: { label: string; territory: number; companies: number }[] = [];
  for (const territory of report.territories) {
    for (const state of territory.states) {
      if (state.code && US_TILE_POSITIONS.has(state.code)) territoryOf.set(state.code, territory.number);
      else offGrid.push({ label: stateLabel(state), territory: territory.number, companies: state.companies });
    }
  }
  const lines = US_TILE_GRID_ROWS.map((cells) =>
    cells
      .map((code) => (code && territoryOf.has(code) ? `${code} ${territoryOf.get(code)}` : '').padEnd(5))
      .join(' ')
      .trimEnd(),
  );
  const withCompanies = offGrid.filter((area) => area.companies > 0);
  const empty = offGrid.length - withCompanies.length;
  const notes = withCompanies.map((area) => `${area.label} ${area.territory} (${formatInt(area.companies)})`);
  if (empty > 0) notes.push(`${empty} ${notes.length > 0 ? 'more ' : ''}areas with no ICP companies`);
  if (notes.length > 0) lines.push('', `Not on the grid: ${notes.join(', ')}`);
  return lines.join('\n');
}

/** One bar per territory, scaled to the largest, for countries without a tile map. */
export function textBars(report: PlanReport, width = 32): string {
  const max = Math.max(...report.territories.map((territory) => territory.weight));
  const labels = report.territories.map((territory) => `${territory.number} ${territory.rep ?? ''}`.trimEnd());
  const labelWidth = Math.max(...labels.map((label) => label.length));
  return report.territories
    .map((territory, index) => {
      const length = max > 0 ? Math.round((territory.weight / max) * width) : 0;
      const bar = '#'.repeat(length).padEnd(width);
      const states = territory.states.filter((state) => state.companies > 0).map(stateLabel).join(', ');
      return `${labels[index]!.padEnd(labelWidth)}  ${bar}  ${formatReportWeight(report, territory.weight).padStart(7)}  ${states}`;
    })
    .join('\n');
}

/** Example accounts per territory from --sample, one line each. Empty when no sample was fetched. */
export function textSamples(report: PlanReport): string {
  const lines = report.territories.flatMap((territory) =>
    (territory.samples ?? []).map((account) => {
      const place = [account.city, account.state].filter(Boolean).join(', ');
      const details = [place, account.employees ? `${account.employees} employees` : null].filter(Boolean).join(', ');
      return `${territory.number}  ${account.name} (${account.domain})${details ? `: ${details}` : ''}`;
    }),
  );
  return lines.length > 0 ? `Sample accounts:\n${lines.join('\n')}` : '';
}
