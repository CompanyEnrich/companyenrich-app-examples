import type { ToolCallRecord } from './tools';

// A citation is a field path in square brackets, e.g. [company.financial.fundingStage]
// or [people[0].seniority]. Paths start at a tool result's top-level key. Several
// paths may share one bracket, separated by commas.

const ROOTS = ['company', 'workforce', 'people', 'lookalikes', 'person'];
const PATH = `(?:${ROOTS.join('|')})(?:\\.[A-Za-z_]\\w*|\\[\\d+\\])*`;
const CITATION = new RegExp(`\\[(${PATH}(?:\\s*,\\s*${PATH})*)\\](?!\\()`, 'g');

/** Fields that the tools compute instead of copying from the API. */
const DERIVED: Record<string, string> = {
  'workforce.departmentShare': 'derived: departmentHeadcount / observedEmployeeCount',
  'workforce.change12m': 'derived: oldest vs newest snapshot in workforce history',
  'workforce.departmentChange12m': 'derived: oldest vs newest snapshot in workforce history',
  'people.tenureYears': 'derived: years since experiences.startDate',
  'person.tenureYears': 'derived: years since experiences.startDate',
  'lookalikes.score': 'from the search response scores map',
  'company.technologiesTotal': 'derived: length of the technologies list the API returned',
  'company.financial.fundingRoundsTotal': 'derived: length of the fundingRounds list the API returned',
};

export interface Citation {
  path: string;
  /** The tool calls whose results contain this field. Empty means the citation could not be verified. */
  sources: ToolCallRecord[];
}

/** Every distinct field path cited in the text, in order of first appearance. */
export function extractCitations(markdown: string): string[] {
  const paths = new Set<string>();
  for (const match of markdown.matchAll(CITATION)) {
    for (const path of match[1]!.split(',')) paths.add(path.trim());
  }
  return [...paths];
}

export function resolveCitations(markdown: string, calls: ToolCallRecord[]): Citation[] {
  return extractCitations(markdown).map((path) => ({
    path,
    sources: calls.filter((call) => hasPath(call.result, parsePath(path))),
  }));
}

/** The Sources section: one row per cited field, with the call it came from and when. */
export function renderSources(citations: Citation[]): string {
  const lines = ['## Sources', ''];
  if (citations.length === 0) {
    lines.push('No fields were cited.');
    return lines.join('\n');
  }
  lines.push(
    'Every fact above cites a field of a CompanyEnrich tool result. Tool results are compact projections that keep the API field names.',
    '',
    '| Field | Tool and endpoint | Retrieved (UTC) |',
    '|---|---|---|',
  );
  for (const { path, sources } of citations) {
    const bare = stripIndexes(path);
    const note = Object.entries(DERIVED).find(([key]) => bare === key || bare.startsWith(`${key}.`))?.[1];
    const field = `\`${path}\`${note ? ` (${note})` : ''}`;
    if (sources.length === 0) {
      lines.push(`| ${field} | **not found in any tool result** | - |`);
      continue;
    }
    const tools = unique(sources.map((source) => `${source.tool} (\`${source.endpoint}\`)`)).join(', ');
    const times = unique(sources.map((source) => source.retrievedAt.slice(0, 19).replace('T', ' '))).join(', ');
    lines.push(`| ${field} | ${tools} | ${times} |`);
  }
  const unverified = citations.filter((citation) => citation.sources.length === 0).length;
  if (unverified > 0) {
    lines.push('', `Warning: ${unverified} cited field${unverified === 1 ? ' was' : 's were'} not found in any tool result. Treat those claims as unverified.`);
  }
  return lines.join('\n');
}

type Key = string | number;

function parsePath(path: string): Key[] {
  return [...path.matchAll(/([A-Za-z_]\w*)|\[(\d+)\]/g)].map((match) => (match[1] ?? Number(match[2])));
}

/** Like a JSON path lookup, but a missing array index means "any element". */
function hasPath(value: unknown, keys: Key[]): boolean {
  if (value === undefined || value === null) return false;
  const [key, ...rest] = keys;
  if (key === undefined) return true;
  if (Array.isArray(value)) {
    if (typeof key === 'number') return hasPath(value[key], rest);
    return value.some((item) => hasPath(item, keys));
  }
  if (typeof value === 'object' && typeof key === 'string') {
    return hasPath((value as Record<string, unknown>)[key], rest);
  }
  return false;
}

function stripIndexes(path: string): string {
  return path.replace(/\[\d+\]/g, '');
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
