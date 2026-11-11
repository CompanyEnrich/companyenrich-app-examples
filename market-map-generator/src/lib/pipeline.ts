import { join, resolve } from 'node:path';
import type { CompanyEnrich, CompanySearchCount } from '@companyenrich/sdk';
import { categorize, type Category, type Method } from './categorize.ts';
import { applyClaudeNames, type CategoryNamer } from './claude.ts';
import { countCompanies, describeInterpretation, previewNames, searchCompanies } from './companyenrich.ts';
import { actualSearchCredits, assertWithinBudget, creditsPerCompany, estimateSearchCredits } from './credits.ts';
import { companiesCsv } from './csv.ts';
import { fetchLogos } from './logos.ts';
import { renderHtml } from './render/html.ts';
import type { MarketMap } from './render/markup.ts';
import { renderSvg } from './render/svg.ts';
import { loadSavedCompanies, prepareOutput, savePaidResults, writeFileAtomic, type SavedCompanies } from './storage.ts';
import type { Theme } from './theme.ts';

export interface RunOptions {
  theme: Theme;
  /** Companies to fetch (the paid search page size). */
  companies: number;
  withKeywords: boolean;
  maxCredits: number;
  dryRun: boolean;
  outDir: string;
  /** A companies.json from an earlier run. Skips every API call, so it is free. */
  from?: string;
  /** YYYY-MM-DD; defaults to today in local time. */
  today?: string;
}

export interface Dependencies {
  /** Required unless `from` is set. */
  client?: CompanyEnrich;
  /** Null when ANTHROPIC_API_KEY is not set. */
  namer: CategoryNamer | null;
  /** Used to download logos; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  log: (line: string) => void;
}

export type RunResult =
  | { kind: 'dry-run'; estimate: number; count: CompanySearchCount }
  | { kind: 'no-results'; creditsSpent: number }
  | { kind: 'map'; dir: string; files: string[]; creditsSpent: number; categories: Category[] };

export async function run(options: RunOptions, deps: Dependencies): Promise<RunResult> {
  const { theme, withKeywords, maxCredits } = options;
  const today = options.today ?? localDate();
  const log = deps.log;
  const dir = join(options.outDir, `${theme.slug}-${today}`);
  const savedPath = join(dir, 'companies.json');
  log(`Theme: ${theme.title}`);

  // Steps 1-3: get the companies, from a saved run or from the API (free count first, then the paid search).
  let source: SavedCompanies;
  let savedTo: string | null = savedPath;
  let creditsSpent = 0;
  if (options.from) {
    source = await loadSavedCompanies(options.from, theme.slug);
    log(`Loaded ${source.companies.length} companies from ${options.from}, fetched ${source.fetchedOn} (0 credits)`);
    if (source.query !== theme.semantic) log('Note: the theme\'s query has changed since then; the map footer shows the query this data came from.');
    await prepareOutput(dir);
  } else {
    const client = deps.client;
    if (!client) throw new Error('A CompanyEnrich client is required unless --from is used');
    log(`Semantic query: "${theme.semantic}"${theme.filter ? `\nFilter: ${JSON.stringify(theme.filter)}` : ''}`);

    const count = await countCompanies(client, theme);
    const beforeLimits = count.total !== count.count ? ` (${count.total.toLocaleString('en-US')} before plan limits)` : '';
    log(`Free count: ${count.count.toLocaleString('en-US')} companies in the candidate pool${beforeLimits}`);
    log(`API interpretation: ${describeInterpretation(count.interpretation)}`);
    if (count.count === 0) {
      log('Nothing matches this theme, so no paid search was made. 0 credits spent.');
      return { kind: 'no-results', creditsSpent: 0 };
    }

    const pageSize = Math.min(options.companies, count.count);
    const estimate = estimateSearchCredits(pageSize, withKeywords);
    log(`Estimate: ${pageSize} companies x ${creditsPerCompany(withKeywords)} credits = up to ${estimate} credits (--max-credits ${maxCredits})`);

    if (options.dryRun) {
      const names = await previewNames(client, theme);
      if (names) log(`Top matches (free preview, first ${Math.min(12, names.length)} of ${names.length}): ${names.slice(0, 12).join(', ')}`);
      else log('Free preview is not available on this plan; skipped.');
      if (estimate > maxCredits) log(`A real run would stop before searching: ${estimate} credits is over --max-credits ${maxCredits}.`);
      log('Dry run: 0 credits spent.');
      return { kind: 'dry-run', estimate, count };
    }

    assertWithinBudget(estimate, maxCredits, withKeywords);
    // Fail on a bad --out, or a file that cannot be written, before paying rather than after.
    await prepareOutput(dir);
    const companies = await searchCompanies(client, theme, { pageSize, withKeywords });
    creditsSpent = actualSearchCredits(companies.length, withKeywords);
    log(`Fetched the top ${companies.length} companies by relevance (${creditsSpent} credits)`);
    if (companies.length === 0) {
      log('The search returned no companies, so there is nothing to map.');
      return { kind: 'no-results', creditsSpent };
    }
    // Save what was paid for before anything else can fail. --from re-renders it for free.
    source = { theme: theme.slug, query: theme.semantic, fetchedOn: today, companies };
    savedTo = await savePaidResults(source, savedPath, log);
  }

  try {
    const { categories, files } = await buildMap(source, options, deps, dir, today);
    if (options.from && resolve(options.from) !== resolve(savedPath)) await writeFileAtomic(savedPath, `${JSON.stringify(source, null, 2)}\n`);
    return { kind: 'map', dir, files: [...files, ...(savedTo ? [savedTo] : [])], creditsSpent, categories };
  } catch (error) {
    if (creditsSpent > 0) {
      const recovery = savedTo ? `The companies are saved: rerun with --from ${savedTo} to finish for free.` : 'The companies are printed above.';
      log(`${creditsSpent} credits were spent. ${recovery}`);
    }
    throw error;
  }
}

/** Steps 4-6: categories, optional Claude names, logos, and the HTML, SVG and CSV files. */
async function buildMap(source: SavedCompanies, options: RunOptions, deps: Dependencies, dir: string, today: string) {
  const { theme } = options;
  const log = deps.log;
  const { companies } = source;

  const { categories: grouped, method } = categorize(companies, theme);
  log(describeMethod(method));

  let categories = grouped;
  let namedByClaude = false;
  if (method.kind === 'hints') {
    log('Category names: from the theme hints');
  } else if (deps.namer) {
    const result = await applyClaudeNames(theme.title, grouped, deps.namer);
    categories = result.categories;
    namedByClaude = result.named;
    log(result.note);
  } else {
    log('Claude naming: off (set ANTHROPIC_API_KEY to enable); using term-based names');
  }
  for (const category of categories) log(`  ${category.name} (${category.companies.length}): ${category.companies.map((c) => c.name ?? c.domain).join(', ')}`);

  const logos = await fetchLogos(companies, deps.fetch ? { fetch: deps.fetch } : {});
  log(`Logos: ${logos.size} embedded, ${companies.length - logos.size} shown as initials`);

  const map: MarketMap = { title: theme.title, query: source.query, generatedOn: today, categories, logos, method: methodSummary(method, namedByClaude) };
  const files = { 'map.html': renderHtml(map), 'map.svg': renderSvg(map), 'companies.csv': companiesCsv(categories) };
  for (const [name, content] of Object.entries(files)) await writeFileAtomic(join(dir, name), content);
  return { categories, files: Object.keys(files).map((name) => join(dir, name)) };
}

export function describeMethod(method: Method): string {
  switch (method.kind) {
    case 'hints':
      return `Grouping: by the theme's category hints${method.unmatched > 0 ? `, ${method.unmatched} unmatched in "Other"` : ''}${
        method.emptyHints.length > 0 ? `; no companies for: ${method.emptyHints.join(', ')}` : ''
      }`;
    case 'clusters': {
      const scores = method.scores.map(
        (score) => `k=${score.k}${score.clusters === score.k ? '' : ` -> ${score.clusters}`}: ${score.silhouette.toFixed(3)}`,
      );
      return `Grouping: k-means, ${method.clusters} clusters by best silhouette (${scores.join(', ')})`;
    }
    case 'single':
      return 'Grouping: too few companies to cluster, so they share one box';
  }
}

function methodSummary(method: Method, namedByClaude: boolean): string {
  switch (method.kind) {
    case 'hints':
      return "Grouped by the theme's category hints (TF-IDF cosine similarity)";
    case 'clusters':
      return `Grouped by TF-IDF k-means (${method.clusters} clusters, chosen by silhouette); names ${namedByClaude ? 'by Claude' : 'from distinctive terms'}`;
    case 'single':
      return 'Too few companies to cluster';
  }
}

function localDate(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
}
