import {
  balanceBasis,
  describeBalance,
  formatInt,
  formatPercent,
  formatReportWeight,
  formatSignedPercent,
  placedShare,
  stateLabel,
  territoryName,
  weightLabel,
} from './format.js';
import type { PlanReport, Territory } from './planner.js';
import { DEFAULT_REGION_TOLERANCE } from './territories.js';
import { US_TILE_GRID_COLUMNS, US_TILE_POSITIONS } from './us-geo.js';
import { formatWeight } from './weights.js';

/** Most territories the report can color distinctly. The CLI enforces the same limit. */
export const MAX_TERRITORIES = 8;

/** Bar segments narrower than this share of the track are grouped, so the bar does not turn into a comb. */
const MIN_SEGMENT_PERCENT = 1.5;

// Categorical palette (light, dark), in a fixed order that keeps neighbouring slots distinct under
// color-vision deficiency. Tiles also print their territory number, so color never carries identity alone.
const PALETTE: readonly { light: string; dark: string; ink: string; darkInk: string }[] = [
  { light: '#2a78d6', dark: '#3987e5', ink: '#ffffff', darkInk: '#ffffff' },
  { light: '#eb6834', dark: '#d95926', ink: '#ffffff', darkInk: '#ffffff' },
  { light: '#1baf7a', dark: '#199e70', ink: '#ffffff', darkInk: '#ffffff' },
  { light: '#eda100', dark: '#c98500', ink: '#0b0b0b', darkInk: '#ffffff' },
  { light: '#e87ba4', dark: '#d55181', ink: '#ffffff', darkInk: '#ffffff' },
  { light: '#008300', dark: '#008300', ink: '#ffffff', darkInk: '#ffffff' },
  { light: '#6250d6', dark: '#9085e9', ink: '#ffffff', darkInk: '#ffffff' },
  { light: '#e34948', dark: '#e66767', ink: '#ffffff', darkInk: '#ffffff' },
];

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function paletteCss(): string {
  const light = PALETTE.map((slot, i) => `--t${i + 1}: ${slot.light}; --t${i + 1}-ink: ${slot.ink};`).join('\n  ');
  const dark = PALETTE.map((slot, i) => `--t${i + 1}: ${slot.dark}; --t${i + 1}-ink: ${slot.darkInk};`).join('\n    ');
  const darkTokens = `--page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --accent-bg: #10243d;
    ${dark}`;
  return `:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10); --accent-bg: #e8f1fc;
  ${light}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark; ${darkTokens} }
}
:root[data-theme="dark"] { color-scheme: dark; ${darkTokens} }`;
}

const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 4px 0 8px; }
h2 { font-size: 18px; margin: 0 0 12px; }
h3 { font-size: 15px; margin: 0; }
p { margin: 0 0 8px; }
.eyebrow { color: var(--muted); font-size: 13px; margin: 0; }
.lede { color: var(--ink-2); }
.cost { display: inline-block; background: var(--accent-bg); border-radius: 6px; padding: 6px 10px; font-weight: 600; margin-top: 4px; }
section { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 20px; margin-top: 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 16px; }
.kpi .label { color: var(--ink-2); font-size: 13px; }
.kpi .value { font-size: 26px; font-weight: 600; }
.kpi .note { color: var(--muted); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0 0 16px; padding: 0; list-style: none; font-size: 13px; color: var(--ink-2); }
.legend li { display: flex; align-items: center; gap: 6px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.tilemap { display: grid; grid-template-columns: repeat(${US_TILE_GRID_COLUMNS}, minmax(0, 1fr)); gap: 2px; }
.tile { aspect-ratio: 1; border-radius: 4px; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: clamp(9px, 1.5vw, 14px); line-height: 1.15; }
.tile b { font-weight: 700; }
.tile .n { font-size: 0.8em; font-variant-numeric: tabular-nums; }
.tile .t { position: absolute; top: 3px; right: 5px; font-size: 0.7em; opacity: 0.85; }
.tile.empty { opacity: 0.45; }
.tile:hover, .seg:hover { outline: 2px solid var(--ink); outline-offset: 1px; z-index: 1; }
.off-grid { margin-top: 12px; color: var(--ink-2); font-size: 13px; }
.bars { display: grid; gap: 10px; }
.bar-row { display: grid; grid-template-columns: minmax(90px, 160px) 1fr auto; gap: 12px; align-items: center; }
.bar-label { font-size: 13px; color: var(--ink-2); overflow-wrap: anywhere; }
.track { position: relative; height: 28px; }
.stack { display: flex; gap: 2px; height: 100%; }
.seg { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; min-width: 1px; }
.even { position: absolute; top: -5px; bottom: -5px; border-left: 2px dashed var(--ink); z-index: 2; }
.bar-value { font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; min-width: 92px; }
.caption { color: var(--muted); font-size: 12px; margin-top: 10px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; font-size: 13px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
details { border-top: 1px solid var(--grid); padding: 10px 0; }
details:first-of-type { border-top: 0; }
summary { cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 600; }
summary .meta { color: var(--muted); font-weight: 400; font-size: 13px; }
details table { margin-top: 8px; }
td.muted { color: var(--muted); font-size: 13px; }
ul.notes { margin: 0; padding-left: 20px; color: var(--ink-2); }
ul.notes li { margin-bottom: 6px; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (max-width: 640px) {
  /* Counts give way on small tiles, but the territory number stays: it is the non-color identifier. */
  .tile .n, .id { display: none; }
  .tile .t { position: static; font-size: 0.85em; opacity: 1; }
  .bar-row { grid-template-columns: 1fr auto; }
  .bar-label { grid-column: 1 / -1; }
  h1 { font-size: 23px; }
}
`;

function slot(territory: Territory): number {
  return ((territory.number - 1) % PALETTE.length) + 1;
}

function fill(territory: Territory): string {
  return `background: var(--t${slot(territory)}); color: var(--t${slot(territory)}-ink);`;
}

function legend(report: PlanReport): string {
  const items = report.territories
    .map((territory) => `<li><span class="swatch" style="background: var(--t${slot(territory)})"></span>${escapeHtml(territoryName(territory))}: ${escapeHtml(formatReportWeight(report, territory.weight))}</li>`)
    .join('');
  return `<ul class="legend">${items}</ul>`;
}

function tileMap(report: PlanReport): string {
  const tiles: string[] = [];
  const offGrid: string[] = [];
  for (const territory of report.territories) {
    for (const state of territory.states) {
      const tooltip = `${state.name}: ${formatInt(state.companies)} ICP companies, ${territoryName(territory)}`;
      const position = state.code ? US_TILE_POSITIONS.get(state.code) : undefined;
      if (!position) {
        const count = state.companies > 0 ? ` (${formatInt(state.companies)})` : '';
        offGrid.push(`<span title="${escapeHtml(tooltip)}">${escapeHtml(stateLabel(state))} &rarr; ${territory.number}${count}</span>`);
        continue;
      }
      tiles.push(
        `<div class="tile${state.companies === 0 ? ' empty' : ''}" data-state="${escapeHtml(state.code!)}" style="grid-row: ${position.row + 1}; grid-column: ${position.col + 1}; ${fill(territory)}" title="${escapeHtml(tooltip)}" role="img" aria-label="${escapeHtml(tooltip)}">` +
          `<b>${escapeHtml(state.code!)}</b><span class="n">${formatInt(state.companies)}</span><span class="t">${territory.number}</span></div>`,
      );
    }
  }
  const off = offGrid.length > 0
    ? `<p class="off-grid">Not on the grid (state &rarr; territory, with ICP companies where any): ${offGrid.join(', ')}.</p>`
    : '';
  return `<section aria-labelledby="map-title">
<h2 id="map-title">Map</h2>
${legend(report)}
<div class="tilemap">${tiles.join('\n')}</div>
${off}
<p class="caption">One tile per state, colored by territory. Each tile shows the state code, its ICP company count and its territory number (top right; under the code on narrow screens, where counts are in the tables). Faded tiles have no ICP companies.</p>
</section>`;
}

function bars(report: PlanReport): string {
  const max = Math.max(...report.territories.map((territory) => territory.weight));
  const scale = (value: number) => (max > 0 ? (value / max) * 100 : 0);
  const segment = (territory: Territory, width: number, label: string, tooltip: string) =>
    `<div class="seg" style="flex: 0 0 calc(${width.toFixed(3)}% - 2px); ${fill(territory)}" title="${escapeHtml(tooltip)}">${escapeHtml(label)}</div>`;
  const rows = report.territories.map((territory) => {
    const withWeight = territory.states.filter((state) => state.weight > 0);
    // States too thin to see on their own are drawn as one "smaller states" segment at the end.
    const large = withWeight.filter((state) => scale(state.weight) >= MIN_SEGMENT_PERCENT);
    const small = withWeight.filter((state) => scale(state.weight) < MIN_SEGMENT_PERCENT);
    const parts = large.map((state) => {
      const width = scale(state.weight);
      // Print the state code only where it fits comfortably; the table below has every value.
      const label = width >= 6 ? stateLabel(state) : '';
      return segment(territory, width, label, `${state.name}: ${formatReportWeight(report, state.weight)} (${formatInt(state.companies)} ICP companies)`);
    });
    if (small.length > 0) {
      const weight = small.reduce((sum, state) => sum + state.weight, 0);
      const names = small.map(stateLabel).join(', ');
      parts.push(segment(territory, scale(weight), '', `${small.length} smaller states, ${formatReportWeight(report, weight)} together: ${names}`));
    }
    const segments = parts.join('');
    return `<div class="bar-row">
<div class="bar-label">${escapeHtml(territoryName(territory))}</div>
<div class="track"><div class="stack">${segments}</div><div class="even" style="left: ${scale(report.balance.mean).toFixed(3)}%" title="Even split"></div></div>
<div class="bar-value">${escapeHtml(formatReportWeight(report, territory.weight))} · ${formatPercent(territory.share)}</div>
</div>`;
  });
  return `<section aria-labelledby="bars-title">
<h2 id="bars-title">${escapeHtml(weightLabel(report))} by territory</h2>
<div class="bars">${rows.join('\n')}</div>
<p class="caption">Each bar is one territory, split into its states (largest first; the last segment groups states too small to show alone). The dashed line marks an even split.</p>
</section>`;
}

function territoryTable(report: PlanReport): string {
  const weighted = report.weightBy !== 'none';
  const head = `<tr><th>Territory</th><th>Rep</th><th class="num">States</th><th class="num">ICP companies</th>${weighted ? `<th class="num">${escapeHtml(weightLabel(report))}</th>` : ''}<th class="num">Share</th><th class="num">vs even split</th></tr>`;
  const rows = report.territories.map(
    (territory) => `<tr><td><span class="swatch" style="display:inline-block; vertical-align:-1px; margin-right:6px; background: var(--t${slot(territory)})"></span>${territory.number}</td><td>${escapeHtml(territory.rep ?? '-')}</td><td class="num">${territory.states.length}</td><td class="num">${formatInt(territory.companies)}</td>${weighted ? `<td class="num">${escapeHtml(formatReportWeight(report, territory.weight))}</td>` : ''}<td class="num">${formatPercent(territory.share)}</td><td class="num">${formatSignedPercent(territory.vsEven)}</td></tr>`,
  );
  return `<section aria-labelledby="table-title">
<h2 id="table-title">Territories</h2>
<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>
<p class="caption">Balance on ${escapeHtml(balanceBasis(report))}: ${escapeHtml(describeBalance(report))}.</p>
</section>`;
}

function stateLists(report: PlanReport): string {
  const weighted = report.weightBy !== 'none';
  const blocks = report.territories.map((territory) => {
    const rows = territory.states
      .filter((state) => state.companies > 0)
      .map((state) => `<tr><td>${escapeHtml(state.name)}</td><td>${escapeHtml(state.code ?? '')}</td><td class="num id">${state.id}</td><td class="num">${formatInt(state.companies)}</td>${weighted ? `<td class="num">${escapeHtml(formatReportWeight(report, state.weight))}</td>` : ''}</tr>`)
      .join('');
    const empty = territory.states.filter((state) => state.companies === 0);
    const emptyRow = empty.length > 0
      ? `<tr><td colspan="${weighted ? 5 : 4}" class="muted">Also owns, with no ICP companies: ${escapeHtml(empty.map((state) => state.name).join(', '))}</td></tr>`
      : '';
    return `<details${report.territories.length <= 4 ? ' open' : ''}>
<summary><span class="swatch" style="background: var(--t${slot(territory)})"></span>${escapeHtml(territoryName(territory))}<span class="meta">${territory.states.length} states · ${formatInt(territory.companies)} ICP companies</span></summary>
<div class="table-wrap"><table><thead><tr><th>State</th><th>Code</th><th class="num id">State id</th><th class="num">ICP companies</th>${weighted ? `<th class="num">${escapeHtml(weightLabel(report))}</th>` : ''}</tr></thead><tbody>${rows}${emptyRow}</tbody></table></div>
</details>`;
  });
  return `<section aria-labelledby="states-title">
<h2 id="states-title">States by territory</h2>
${blocks.join('\n')}
</section>`;
}

function samples(report: PlanReport): string {
  if (!report.territories.some((territory) => territory.samples)) return '';
  const rows = report.territories.flatMap((territory) =>
    (territory.samples ?? []).map(
      (account) => `<tr><td>${territory.number}</td><td>${escapeHtml(account.name)}<br><span style="color: var(--muted)">${escapeHtml(account.domain)}</span></td><td>${escapeHtml([account.city, account.state].filter(Boolean).join(', '))}</td><td>${escapeHtml(account.employees ?? '')}</td><td>${escapeHtml(account.revenue ?? '')}</td><td>${escapeHtml(account.industry ?? '')}</td></tr>`,
    ),
  );
  return `<section aria-labelledby="samples-title">
<h2 id="samples-title">Sample accounts</h2>
<div class="table-wrap"><table><thead><tr><th>Territory</th><th>Company</th><th>Location</th><th>Employees</th><th>Revenue</th><th>Industry</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<p class="caption">Fetched with paid company searches (1 credit per company): ${report.credits.spent} credits in this run${report.credits.sampleReused > 0 ? `, plus ${report.credits.sampleReused} territories reused from an earlier run's saved results at no cost` : ''}.${report.credits.sampleNote ? ` ${escapeHtml(report.credits.sampleNote)}` : ''}</p>
</section>`;
}

function methodNotes(report: PlanReport): string {
  const notes = [
    ...report.warnings.map(escapeHtml),
    `Counts come from free <code>companies.count</code> calls with the ICP filter plus the country and one state: ${formatInt(report.counts.requests)} requests, ${formatInt(report.counts.fromCache)} answered from the local one-day cache.`,
    `${formatInt(report.coverage.placed)} of ${formatInt(report.coverage.countryTotal)} ICP companies in ${escapeHtml(report.country.name)} (${formatPercent(placedShare(report))}) have a state on file and are placed. The rest cannot be routed by state.`,
    'States are assigned heaviest first to the lightest territory, then single moves and swaps between territories narrow the gaps until none helps. Territories are numbered west to east.',
    'States with no ICP companies go to the territory of the nearest state, so every state has an owner for routing.',
  ];
  if (report.weighting) {
    const unit = report.weightBy === 'revenue' ? ' (USD millions)' : '';
    const midpoints = Object.entries(report.weighting.midpoints).map(([band, value]) => `${escapeHtml(band)}: ${value}`).join(', ');
    notes.push(
      `Weighted by ${report.weightBy}: each state counts its ICP companies per band and multiplies by the band midpoint${unit} (${midpoints}). Companies with no ${report.weightBy} band on file count at the country-wide average, ${escapeHtml(formatWeight(report.weighting.fallbackMidpoint, report.weightBy))}.`,
    );
  }
  if (report.keepRegions) {
    const split = report.splitRegions.length > 0 ? `Split to keep the plan even: ${escapeHtml(report.splitRegions.join(', '))}.` : 'No division had to be split.';
    notes.push(`US Census divisions are kept in one territory where the plan stays within max/min ${DEFAULT_REGION_TOLERANCE} (or the unconstrained plan's ratio, if higher). ${split}`);
  }
  return `<section aria-labelledby="notes-title">
<h2 id="notes-title">How this was built</h2>
<ul class="notes">${notes.map((note) => `<li>${note}</li>`).join('')}</ul>
</section>`;
}

function kpis(report: PlanReport): string {
  const ratio = report.balance.maxMinRatio === null ? 'n/a' : `${report.balance.maxMinRatio.toFixed(3)}x`;
  const tiles = [
    ['ICP companies placed', formatInt(report.coverage.placed), `${formatPercent(placedShare(report))} of ${formatInt(report.coverage.countryTotal)} in the country`],
    ['Even split per territory', formatReportWeight(report, report.balance.mean), weightLabel(report)],
    ['Largest / smallest', ratio, 'max/min ratio'],
    ['Std deviation', formatPercent(report.balance.coefficientOfVariation), `of the mean (${formatReportWeight(report, report.balance.stdDev)})`],
  ];
  return `<section class="kpis" aria-label="Summary">${tiles
    .map(([label, value, note]) => `<div class="kpi"><div class="label">${escapeHtml(label!)}</div><div class="value">${escapeHtml(value!)}</div><div class="note">${escapeHtml(note!)}</div></div>`)
    .join('')}</section>`;
}

/** The self-contained HTML report: no scripts, no external assets, light and dark themes. */
export function renderHtml(report: PlanReport): string {
  const count = report.territories.length;
  const title = `${count} sales territories: ${report.country.name}`;
  const basis = report.weightBy === 'none' ? 'ICP company count' : `estimated ${report.weightBy} at ICP companies`;
  const cost = report.credits.spent === 0
    ? 'Built from free company counts: this plan cost 0 credits.'
    : `Built from free company counts; the sample accounts cost ${report.credits.spent} credits.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${paletteCss()}
${STYLES}
</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">Territory plan · run ${escapeHtml(report.runId)} · ${escapeHtml(report.generatedAt.slice(0, 16).replace('T', ' '))} UTC</p>
<h1>${escapeHtml(title)}</h1>
<p class="lede">ICP: ${escapeHtml(report.icpSummary)}. Balanced on ${escapeHtml(basis)}.</p>
<p class="cost">${escapeHtml(cost)}</p>
</header>
${kpis(report)}
${report.country.code === 'US' ? tileMap(report) : ''}
${bars(report)}
${territoryTable(report)}
${stateLists(report)}
${samples(report)}
${methodNotes(report)}
</main>
</body>
</html>
`;
}
