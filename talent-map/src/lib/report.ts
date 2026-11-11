import { formatFilter, SEMANTIC_COMPANY_LIMIT } from './company-query.js';
import type { CompanyRow } from './companies.js';
import type { Candidate } from './shortlist.js';
import type { TalentMap } from './talent-map.js';
import { formatTenure } from './tenure.js';
import { describeTrend, type TeamTrend } from './trends.js';

// Renders the talent map as one self-contained HTML file: inline CSS, no scripts, no external assets.
// Every value from the API or the command line goes through escapeHtml or safeHref.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Only http(s) links make it into an href; anything else (javascript:, data:) is dropped. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? escapeHtml(parsed.href) : undefined;
  } catch {
    return undefined;
  }
}

const number = (value: number) => value.toLocaleString('en-US');
const percent = (value: number) => `${Math.round(value * 100)}%`;

function link(text: string, url: string | undefined): string {
  const href = safeHref(url);
  return href ? `<a href="${href}" rel="noopener noreferrer">${escapeHtml(text)}</a>` : escapeHtml(text);
}

function tile(label: string, value: string, note: string, hero = false): string {
  return `<div class="tile${hero ? ' hero' : ''}"><p class="label">${escapeHtml(label)}</p><p class="value">${escapeHtml(value)}</p><p class="note">${escapeHtml(note)}</p></div>`;
}

function companyTile(map: TalentMap): string {
  const { companies, query } = map.environment;
  if (!companies) return tile('Companies searched', 'any', 'no company filters');
  if (!query?.semantic) return tile('Companies searched', number(companies.total), 'matching the company filters');
  const searched = Math.min(companies.total, SEMANTIC_COMPANY_LIMIT);
  return tile('Companies searched', number(searched), `best matches from a semantic pool of ${number(companies.total)}`);
}

function funnel(map: TalentMap): string {
  const { sizing, role, options, environment } = map;
  const titles = role.titles.map((title) => `"${title}"`).join(' or ');
  const steps: [string, number][] = [[`Current title contains ${titles}`, sizing.withTitle]];
  if (role.departments.length > 0) steps.push([`In the ${role.departments.join(', ')} department`, sizing.market]);
  if (environment.query) steps.push(['At companies matching the environment', sizing.inEnvironment]);
  if (options.seniority.length > 0) steps.push([`At ${options.seniority.join(', ')} level`, sizing.selected]);
  if (sizing.joinedBefore) {
    steps.push([`At their company ${options.minTenureYears}+ years (joined on or before ${sizing.joinedBefore})`, sizing.target]);
  }
  const rows = steps.map(([label, value], index) => {
    const previous = index > 0 ? steps[index - 1]?.[1] : undefined;
    const kept = previous ? percent(value / previous) : '';
    return `<tr><td>${escapeHtml(label)}</td><td class="num">${number(value)}</td><td class="num muted">${kept}</td></tr>`;
  });
  return (
    '<table class="funnel"><thead><tr><th>Filter</th><th class="num">People</th><th class="num">Kept</th></tr></thead>' +
    `<tbody>${rows.join('')}</tbody></table><p class="muted small">Kept is the share of the row above that passes the filter.</p>`
  );
}

function seniorityChart(map: TalentMap): string {
  const { bySeniority, unclassified } = map.sizing;
  const anySelected = bySeniority.some((row) => row.selected);
  const rows: { label: string; people: number; accent: boolean; tag: string }[] = bySeniority
    .filter((row) => row.people > 0 || row.selected)
    .map((row) => ({ label: row.seniority, people: row.people, accent: !anySelected || row.selected, tag: row.selected ? 'selected' : '' }));
  if (unclassified > 0) rows.push({ label: 'no level listed', people: unclassified, accent: false, tag: '' });
  if (rows.length === 0) return '<p class="muted">No one in the environment has this role.</p>';

  const max = Math.max(1, ...rows.map((row) => row.people));
  const bars = rows.map((row) => {
    const width = row.people === 0 ? 0 : Math.max(0.5, (row.people / max) * 100);
    const tag = row.tag ? ` <span class="tag">${row.tag}</span>` : '';
    return (
      `<div class="bar-row" title="${escapeHtml(`${row.label}: ${number(row.people)} people`)}">` +
      `<span class="bar-label">${escapeHtml(row.label)}${tag}</span>` +
      `<span class="bar-track"><span class="bar${row.accent ? '' : ' dim'}" style="width:${width.toFixed(1)}%"></span>` +
      `<span class="bar-value">${number(row.people)}</span></span></div>`
    );
  });
  const hidden = bySeniority.filter((row) => row.people === 0 && !row.selected).map((row) => row.seniority);
  const footnote = hidden.length > 0 ? `<p class="muted small">No matching people at: ${escapeHtml(hidden.join(', '))}.</p>` : '';
  return `<div class="bars">${bars.join('')}</div>${footnote}`;
}

function trendCell(trend: TeamTrend | undefined): string {
  if (!trend) return '<span class="muted">-</span>';
  const text = describeTrend(trend);
  if (!text) return '<span class="muted">no history</span>';
  return `<span class="trend"><span aria-hidden="true">${text.arrow}</span> ${escapeHtml(text.change)}</span> <span class="muted small">${escapeHtml(text.since)}</span>`;
}

function companyTable(map: TalentMap): string {
  if (map.companies.length === 0) {
    return `<p class="muted">${map.status === 'dry-run' ? 'Dry run: companies come from the paid shortlist.' : 'No companies to rank.'}</p>`;
  }
  const row = (entry: CompanyRow) => {
    const site = entry.company.domain && /^[a-z0-9.-]+$/i.test(entry.company.domain) ? `https://${entry.company.domain}` : undefined;
    const domain = entry.company.domain ? ` <span class="muted small">${escapeHtml(entry.company.domain)}</span>` : '';
    return (
      `<tr><td>${link(entry.company.name, site)}${domain}</td>` +
      `<td class="num">${entry.pool === undefined ? '' : number(entry.pool)}</td>` +
      `<td class="num">${number(entry.shortlisted)}</td>` +
      `<td class="num">${entry.trend ? number(entry.trend.headcount) : ''}</td>` +
      `<td>${trendCell(entry.trend)}</td></tr>`
    );
  };
  return (
    '<div class="scroll"><table><thead><tr><th>Company</th><th class="num">Matching people</th><th class="num">Shortlisted</th>' +
    `<th class="num">Team now</th><th>12-month change</th></tr></thead><tbody>${map.companies.map(row).join('')}</tbody></table></div>` +
    `<p class="muted small">Matching people is a free count of everyone at the company who fits the shortlist filters. ` +
    `Team now and the change count the ${escapeHtml(map.role.trendScope)} team from the workforce endpoint, for the top ${map.options.trendTop} companies.</p>`
  );
}

function shortlistTable(map: TalentMap): string {
  if (map.shortlist.length === 0) {
    return `<p class="muted">${map.status === 'dry-run' ? 'Dry run: no profiles fetched.' : 'No profiles returned.'}</p>`;
  }
  const row = (person: Candidate) =>
    `<tr><td class="person">${link(person.name || 'Profile', person.linkedinUrl)}</td>` +
    `<td>${escapeHtml(person.title)}</td>` +
    `<td>${escapeHtml(person.seniority ?? '')}</td>` +
    `<td>${escapeHtml(person.company?.name ?? '')}</td>` +
    `<td class="num">${person.tenureYears === undefined ? '' : escapeHtml(formatTenure(person.tenureYears))}</td>` +
    `<td>${escapeHtml(person.location ?? '')}</td></tr>`;
  return (
    '<div class="scroll"><table><thead><tr><th>Name</th><th>Title</th><th>Seniority</th><th>Company</th>' +
    `<th class="num">Time at company</th><th>Location</th></tr></thead><tbody>${map.shortlist.map(row).join('')}</tbody></table></div>`
  );
}

function companyCount({ environment }: TalentMap): string {
  if (!environment.companies) return '';
  const total = number(environment.companies.total);
  return environment.query?.semantic ? ` (semantic pool of ${total})` : ` (${total} match)`;
}

function querySummary(map: TalentMap): string {
  const { role, environment } = map;
  const items = [
    `Titles: ${role.titles.join(', ')}`,
    role.departments.length > 0
      ? `Department: ${role.departments.join(', ')}${role.departmentCoverage !== undefined ? ` (keeps ${percent(role.departmentCoverage)} of people with these titles)` : ''}`
      : `Department: none${role.droppedDepartments.length > 0 ? ` (${role.droppedDepartments.join(', ')} kept too few of these titles)` : ''}`,
    `Companies: ${environment.description}${companyCount(map)}`,
    ...(environment.inferred?.filter ? [`Inferred from the description: ${formatFilter(environment.inferred.filter)}`] : []),
    ...map.notes,
  ];
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function creditSummary(map: TalentMap): string {
  const { credits } = map;
  const estimate = credits.estimate.reduce((sum, line) => sum + line.credits, 0);
  const text =
    map.status === 'dry-run'
      ? `Dry run: 0 credits spent. The paid steps would cost up to ${estimate} credits (cap ${credits.maxCredits}).`
      : `This run was charged ${credits.spent} credits (cap ${credits.maxCredits}). Sizing and company ranking used free counts.` +
        (credits.entries.length > 0 ? ` Paid calls: ${credits.entries.map((entry) => `${entry.step} (${entry.detail}) ${entry.credits}`).join('; ')}.` : '');
  return `<p>${escapeHtml(text)}</p>`;
}

const STYLE = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6b6a66;--line:#e1e0d9;--accent:#2a78d6;--dim:#c3c2b7;--tag:#e8f0fb}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#a3a29b;--line:#2c2c2a;--accent:#3987e5;--dim:#52514e;--tag:#16294a}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#a3a29b;--line:#2c2c2a;--accent:#3987e5;--dim:#52514e;--tag:#16294a}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:28px;margin:4px 0 4px;text-transform:capitalize}
h2{font-size:17px;margin:0 0 12px}
a{color:var(--accent)}
.eyebrow,.muted{color:var(--muted)}
.small{font-size:13px}
.lede{color:var(--ink-2);margin:0}
.banner{margin-top:16px;padding:10px 14px;border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--surface);border-radius:6px}
section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:20px;margin-top:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;background:none;border:0;padding:0}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px}
.tile p{margin:0}.tile .label{color:var(--ink-2);font-size:13px}.tile .value{font-size:28px;font-weight:600;margin:4px 0}
.tile.hero .value{font-size:48px;line-height:1.1}.tile .note{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink-2);font-weight:600;font-size:13px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.funnel td:first-child{width:60%}
.person{min-width:150px}
.scroll{overflow-x:auto}
.bars{display:grid;gap:6px}
.bar-row{display:grid;grid-template-columns:minmax(110px,180px) 1fr;align-items:center;gap:12px}
.bar-label{font-size:14px}
.bar-track{display:flex;align-items:center;gap:8px;min-width:0}
.bar{display:block;height:14px;background:var(--accent);border-radius:0 4px 4px 0;flex:none;max-width:calc(100% - 64px)}
.bar.dim{background:var(--dim)}
.bar-value{font-size:13px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.tag{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--tag);color:var(--ink);margin-left:4px}
.trend{white-space:nowrap;font-weight:600}
ul{margin:0;padding-left:20px}li{margin:4px 0}
footer{margin-top:24px;color:var(--muted);font-size:13px}
`;

export function renderReport(map: TalentMap): string {
  const role = map.options.roles.join(', ');
  const generated = new Date(map.generatedAt).toISOString().slice(0, 16).replace('T', ' ');
  const poolNote = map.sizing.targetAccessible < map.sizing.target ? `${number(map.sizing.targetAccessible)} reachable on your plan` : 'people who fit every filter';
  const banner =
    map.status === 'dry-run'
      ? '<p class="banner">Dry run: sizing only. Run without --dry-run to fetch the shortlist and team trends.</p>'
      : map.status === 'no-matches'
        ? '<p class="banner">Nobody matches every filter, so no paid calls were made. Loosen the seniority, tenure or company filters.</p>'
        : map.status === 'stopped'
          ? `<p class="banner">The run stopped early: ${escapeHtml(map.stoppedBecause ?? 'unknown error')} Results paid for before the stop are included.</p>`
          : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Talent map: ${escapeHtml(role)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<p class="eyebrow small">Talent map · generated ${escapeHtml(generated)} UTC</p>
<h1>${escapeHtml(role)}</h1>
<p class="lede">at ${escapeHtml(map.environment.description)}</p>
${banner}
</header>
<section class="tiles">
${tile('Shortlist pool', number(map.sizing.target), poolNote, true)}
${tile('In this environment', number(map.sizing.inEnvironment), 'people in the role at matching companies')}
${tile('Across all companies', number(map.sizing.market), 'people in the role anywhere')}
${companyTile(map)}
</section>
<section><h2>How the pool narrows</h2>${funnel(map)}</section>
<section><h2>Seniority in this environment</h2>${seniorityChart(map)}</section>
<section><h2>Companies holding matching people</h2>${companyTable(map)}</section>
<section><h2>Shortlist</h2>${shortlistTable(map)}</section>
<section><h2>Query</h2>${querySummary(map)}</section>
<section><h2>Credits</h2>${creditSummary(map)}</section>
<footer>
<p>Use this for sourcing outreach only. Respect opt-outs and local privacy law such as GDPR. Time at company is context, not a prediction that anyone will leave.</p>
<p>Data from the CompanyEnrich API. Counts are observed profiles, not official headcount.</p>
</footer>
</main>
</body>
</html>
`;
}
