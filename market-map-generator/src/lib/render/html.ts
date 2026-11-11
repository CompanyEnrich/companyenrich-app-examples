import type { Category } from '../categorize.ts';
import { layoutMap, type MapLayout } from '../layout.ts';
import { initials } from '../logos.ts';
import { accentVar, colorTokens, escapeXml as esc, methodLine, sourceLine, subtitle, truncate, type MarketMap } from './markup.ts';

const STYLE = `${colorTokens(':root')}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow-wrap: anywhere; }
main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 24px; }
h1 { margin: 0; font-size: 26px; line-height: 1.2; }
.subtitle { margin: 6px 0 20px; color: var(--ink-2); font-size: 13px; }
.columns { display: grid; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); gap: 16px; align-items: start; }
.column { display: flex; flex-direction: column; gap: 16px; }
.box { background: var(--surface); border: 1px solid var(--border); border-top: 5px solid var(--accent); border-radius: 10px; padding: 12px 14px 14px; }
.box h2 { display: flex; justify-content: space-between; gap: 8px; margin: 0; font-size: 15px; }
.box h2 .count { color: var(--muted); font-size: 12px; font-weight: 400; }
.box .description { margin: 2px 0 10px; color: var(--ink-2); font-size: 12px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px 4px; margin: 0; padding: 0; list-style: none; }
.tiles a { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 4px 2px; border-radius: 8px; color: inherit; text-decoration: none; }
.tiles a:hover, .tiles a:focus-visible { background: var(--page); outline: none; }
.logo, .initials { width: 44px; height: 44px; border-radius: 9px; flex: none; }
.logo { object-fit: contain; background: var(--tile); border: 1px solid var(--border); color-scheme: light; }
.initials { display: grid; place-items: center; background: var(--initials-bg); color: var(--ink-2); font-weight: 650; font-size: 15px; }
.name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
details { margin-top: 24px; }
summary { cursor: pointer; color: var(--ink-2); }
table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
th:nth-child(-n + 3) { width: 20%; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
footer { margin-top: 20px; color: var(--muted); font-size: 11px; }
footer p { margin: 2px 0; }
@media (max-width: 760px) { .columns { grid-template-columns: minmax(0, 1fr); } }`;

/** Renders the map as one self-contained HTML page (no scripts, no external requests). */
export function renderHtml(map: MarketMap, layout: MapLayout = layoutMap(map.categories)): string {
  const colors = new Map(layout.boxes.map((box) => [box.category, box.color]));
  const columns = layout.columns.map(
    (items) =>
      `<div class="column">\n${items
        .map((index) => {
          const category = map.categories[index]!;
          return renderBox(map, category, accentVar(colors.get(category) ?? null));
        })
        .join('\n')}\n</div>`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(map.title)}: market map</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<header>
<h1>${esc(map.title)}</h1>
<p class="subtitle">${esc(subtitle(map))}</p>
</header>
<div class="columns" style="--columns: ${layout.columns.length}">
${columns.join('\n')}
</div>
<details>
<summary>All companies as a table</summary>
${renderTable(map)}
</details>
<footer>
<p>${esc(sourceLine(map))}. <a href="https://companyenrich.com">companyenrich.com</a></p>
<p>${esc(methodLine(map))}</p>
</footer>
</main>
</body>
</html>
`;
}

function renderBox(map: MarketMap, category: Category, accent: string): string {
  const tiles = category.companies.map((company) => {
    const label = company.name ?? company.domain;
    const logo = map.logos.get(company.id);
    const mark = logo
      ? `<img class="logo" src="${esc(logo)}" alt="" width="44" height="44">`
      : `<span class="initials" aria-hidden="true">${esc(initials(label))}</span>`;
    const tooltip = truncate(`${label} (${company.domain})${company.description ? `: ${company.description}` : ''}`, 300);
    return `<li><a href="${esc(`https://${company.domain}`)}" title="${esc(tooltip)}" target="_blank" rel="noopener">${mark}<span class="name">${esc(label)}</span></a></li>`;
  });
  return `<section class="box" style="--accent: ${accent}">
<h2><span>${esc(category.name)}</span><span class="count">${category.companies.length}</span></h2>
<p class="description">${esc(category.description)}</p>
<ul class="tiles">
${tiles.join('\n')}
</ul>
</section>`;
}

function renderTable(map: MarketMap): string {
  const rows = map.categories.flatMap((category) =>
    category.companies.map(
      (company) =>
        `<tr><td>${esc(category.name)}</td><td>${esc(company.name ?? '')}</td><td>${esc(company.domain)}</td><td>${esc(company.description ?? '')}</td></tr>`,
    ),
  );
  return `<table>
<thead><tr><th>Category</th><th>Company</th><th>Domain</th><th>Description</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}
